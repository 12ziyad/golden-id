'use strict';

const { detectFaces } = require('./detect');

// One embedding per document. The strongest detected face wins — an ID card
// carries one portrait, and a second detection is usually a printed watermark
// or a ghost image of the same person.

/**
 * Produce the face embedding for one document image.
 * Returns `{ available, face, reason }`. A null `face` is recorded and excluded
 * from comparison; it is never treated as a failed application.
 */
async function embedDocument(buffer) {
  const result = await detectFaces(buffer);
  if (!result.available) return { available: false, face: null, reason: result.reason };
  if (!result.faces.length) return { available: true, face: null, reason: result.reason || 'no_face_detected' };

  const best = result.faces.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  const quality = result.quality || {};

  // A crop too small or too soft to mean anything is reported as such rather
  // than silently producing a misleading similarity score.
  if (quality.usable === false) {
    return {
      available: true, face: null,
      reason: 'insufficient_quality',
      quality
    };
  }

  return {
    available: true,
    face: {
      embedding: best.embedding,
      box: best.box,
      confidence: Number((best.confidence ?? 0).toFixed(4)),
      dimensions: best.embedding.length,
      rotation: result.rotation ?? 0,
      quality
    },
    reason: ''
  };
}

/**
 * Embed a batch of documents, reusing any cached embedding so an image is only
 * ever processed once.
 *
 * `documents` is `[{ type, documentId, contentHash, buffer, face }]`.
 * `onEmbedded(key, face)` receives newly computed embeddings so the caller can
 * store them against the OWNED document row and delete the source scan.
 */
async function embedAll(documents, { onEmbedded, embedder = embedDocument, keyBy = 'contentHash' } = {}) {
  const results = [];

  for (const document of documents) {
    const key = document[keyBy] ?? document.documentId ?? document.contentHash;
    const base = { type: document.type, documentId: document.documentId, contentHash: document.contentHash };

    if (document.face && Array.isArray(document.face.embedding) && document.face.embedding.length) {
      results.push({ ...base, face: document.face, available: true, cached: true });
      continue;
    }
    if (!document.buffer) {
      results.push({ ...base, face: null, available: true, reason: 'image_not_retained', cached: false });
      continue;
    }

    try {
      const outcome = await embedder(document.buffer);
      if (outcome.face && onEmbedded) onEmbedded(key, outcome.face);
      results.push({
        ...base, face: outcome.face, available: outcome.available,
        reason: outcome.reason, quality: outcome.quality, cached: false
      });
    } catch (error) {
      results.push({ ...base, face: null, available: true, reason: error.message, cached: false });
    }
  }

  return results;
}

module.exports = { embedDocument, embedAll };
