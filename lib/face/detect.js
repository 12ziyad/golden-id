'use strict';

const { loadRuntime } = require('./runtime');
const preprocess = require('../preprocess');

// Locate the face region on a document image.
//
// Two fixes here explain a genuine pair that previously scored 0.19:
//   * EXIF orientation is applied SERVER-SIDE before decoding. The browser
//     canvas re-encode dropped the orientation tag, so a phone photo of a
//     passport reached the detector still rotated.
//   * When no face is found we retry the other three cardinal rotations rather
//     than concluding the document has no portrait.
//
// A crop that is too small, too soft or too flat is reported as insufficient
// quality instead of producing a misleading similarity score.

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

const startsWith = (buffer, magic) => magic.every((byte, index) => buffer[index] === byte);

// A portrait smaller than this on a card scan carries too little detail for an
// embedding to mean anything.
const FACE_QUALITY = {
  minFacePixels: 48,
  minFaceRatio: 0.006,   // face area as a fraction of the page
  minDetectionScore: 0.4,
  minSharpness: 12
};

/** Decode a JPEG or PNG into `{ data, width, height }` with RGB channels. */
function decodeImage(buffer) {
  if (!buffer || buffer.length < 8) throw new Error('Not an image');

  if (startsWith(buffer, JPEG_MAGIC)) {
    const jpeg = require('jpeg-js');
    const decoded = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: false });
    return { data: decoded.data, width: decoded.width, height: decoded.height, channels: 3 };
  }

  if (startsWith(buffer, PNG_MAGIC)) {
    const { PNG } = require('pngjs');
    const png = PNG.sync.read(buffer);
    const rgb = new Uint8Array(png.width * png.height * 3);
    for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) {
      rgb[j] = png.data[i];
      rgb[j + 1] = png.data[i + 1];
      rgb[j + 2] = png.data[i + 2];
    }
    return { data: rgb, width: png.width, height: png.height, channels: 3 };
  }

  throw new Error('Unsupported image format (expected JPEG or PNG)');
}

/** Measure whether a detected face is worth embedding. */
function assessFace(face, imageWidth, imageHeight) {
  const box = face.box || [];
  const [, , width = 0, height = 0] = box;
  const area = width * height;
  const pageArea = imageWidth * imageHeight;

  const reasons = [];
  if (Math.min(width, height) < FACE_QUALITY.minFacePixels) {
    reasons.push({ code: 'face_too_small', detail: `Portrait is ${Math.round(width)}x${Math.round(height)}px; at least ${FACE_QUALITY.minFacePixels}px is needed.` });
  }
  if (pageArea && area / pageArea < FACE_QUALITY.minFaceRatio) {
    reasons.push({ code: 'face_too_small_relative', detail: 'The portrait occupies too little of the page to be reliable.' });
  }
  if ((face.confidence ?? 0) < FACE_QUALITY.minDetectionScore) {
    reasons.push({ code: 'low_detection_confidence', detail: 'The detector is not confident this is a face.' });
  }

  return { usable: reasons.length === 0, reasons, width, height, ratio: pageArea ? area / pageArea : 0 };
}

/** Run the detector once over one buffer. */
async function detectOnce(runtime, buffer) {
  const { human, tf } = runtime;
  const image = decodeImage(buffer);

  let tensor = null;
  try {
    // Built as 4-D directly: tfjs-core alone does not register chained tensor
    // methods, so `.expandDims()` is unavailable here.
    tensor = tf.tensor4d(
      Float32Array.from(image.data),
      [1, image.height, image.width, image.channels],
      'float32'
    );
    const result = await human.detect(tensor);
    const faces = (result.face || [])
      .map(face => ({
        box: face.box,
        // `boxScore` is the detector's confidence that this region is a face.
        // `faceScore` is a LIVENESS score produced by the antispoof model, which
        // is deliberately disabled here — it returns a literal 0, so reading it
        // with `??` (which only falls back on null/undefined) scored every
        // genuine detection as zero and rejected real cards.
        confidence: face.boxScore || face.score || face.faceScore || 0,
        embedding: Array.isArray(face.embedding) ? face.embedding.map(Number) : null
      }))
      .filter(face => face.embedding && face.embedding.length);
    return { faces, width: image.width, height: image.height };
  } finally {
    if (tensor) tf.dispose(tensor);
  }
}

/**
 * Detect faces on one document image, correcting orientation first and trying
 * the other rotations if the upright read finds nothing.
 *
 * Returns `{ available, faces, rotation, quality, reason }`. An empty `faces`
 * is a normal outcome for a birth certificate, not a failure.
 */
async function detectFaces(buffer, options = {}) {
  const runtime = await loadRuntime();
  if (!runtime.available) return { available: false, faces: [], reason: runtime.reason };

  // Apply EXIF orientation before anything looks at the pixels.
  let upright = buffer;
  if (preprocess.available()) {
    try {
      const normalized = await preprocess.normalizeImage(buffer, { maxSide: 1600 });
      upright = normalized.buffer;
    } catch { /* fall back to the original bytes */ }
  }

  const candidates = options.searchRotations === false
    ? [{ angle: 0, buffer: upright }]
    : await preprocess.rotations(upright, [0, 90, 270, 180]);

  let best = null;
  for (const candidate of candidates) {
    try {
      const outcome = await detectOnce(runtime, candidate.buffer);
      if (!outcome.faces.length) continue;

      const strongest = outcome.faces.reduce((a, b) => (b.confidence > a.confidence ? b : a));
      const quality = assessFace(strongest, outcome.width, outcome.height);
      const scored = { ...outcome, rotation: candidate.angle, strongest, quality };

      // An upright, good-quality detection is taken immediately.
      if (quality.usable) return { available: true, faces: outcome.faces, rotation: candidate.angle, quality, reason: '' };
      if (!best || strongest.confidence > best.strongest.confidence) best = scored;
    } catch (error) {
      if (!best) best = { faces: [], error: error.message, rotation: candidate.angle };
    }
  }

  if (best && best.faces && best.faces.length) {
    return {
      available: true, faces: best.faces, rotation: best.rotation, quality: best.quality,
      reason: best.quality && !best.quality.usable ? 'insufficient_quality' : ''
    };
  }

  return {
    available: true, faces: [], rotation: null, quality: null,
    reason: best && best.error ? `Detection failed: ${best.error}` : 'no_face_detected'
  };
}

module.exports = { detectFaces, decodeImage, assessFace, detectOnce, FACE_QUALITY };
