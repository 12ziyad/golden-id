'use strict';

// Enhancement variants for MARGINAL images.
//
// The original upload is immutable and these derivatives exist only in
// memory, only for reading. Each variant targets the metric that actually
// failed — contrast problems get local equalisation, softness gets a mild
// sharpen and (for small scans) a 2x upscale — because blanket filtering
// degrades as often as it helps. Deliberately mild: an aggressive sharpen
// invents strokes, and an invented stroke read with confidence is worse
// than an honest "unreadable".

let sharp = null;
try { sharp = require('sharp'); } catch { /* enhancement simply unavailable */ }

const VARIANTS = [
  {
    name: 'gray-normalize',
    when: () => true, // cheap, safe baseline for every marginal image
    ops: image => image.greyscale().normalise()
  },
  {
    name: 'clahe',
    when: metrics => (metrics.contrast ?? 99) < 18 || (metrics.glare ?? 0) > 0.10 || (metrics.dark ?? 0) > 0.55,
    ops: image => image.greyscale().clahe({ width: 64, height: 64, maxSlope: 3 })
  },
  {
    name: 'sharpen',
    when: metrics => (metrics.sharpness ?? 99) < 55,
    ops: image => image.greyscale().normalise().sharpen({ sigma: 1.2 })
  },
  {
    name: 'upscale2x',
    when: metrics => (metrics.width || 0) > 0 && metrics.width < 1100 && (metrics.sharpness ?? 99) < 55,
    ops: (image, meta) => image.resize((meta.width || 550) * 2).greyscale().normalise()
  }
];

/**
 * Produce at most `cap` in-memory enhancement variants for the failing
 * metrics. Returns `[{ name, buffer }]`; the input buffer is never modified.
 */
async function variantsFor(buffer, metrics = {}, { cap = 3 } = {}) {
  if (!sharp) return [];
  const chosen = VARIANTS.filter(variant => {
    try { return variant.when(metrics); } catch { return false; }
  }).slice(0, cap);

  const produced = [];
  for (const variant of chosen) {
    try {
      const meta = await sharp(buffer, { failOn: 'none' }).metadata();
      const output = await variant.ops(sharp(buffer, { failOn: 'none' }), meta)
        .jpeg({ quality: 92 })
        .toBuffer();
      produced.push({ name: variant.name, buffer: output });
    } catch { /* a variant that cannot be produced is skipped, never fatal */ }
  }
  return produced;
}

module.exports = { variantsFor, VARIANTS };
