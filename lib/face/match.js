'use strict';

const { config } = require('../config');

// Pairwise face comparison across the documents that carry a photo.
//
// Text agreement proves the NAMES match. It does not prove one person holds all
// five cards. Face comparison is the only signal here that speaks to that — but
// it is a weak one: card photos are printed, low-resolution, often monochrome
// and sometimes decades apart in age.
//
// Therefore, and deliberately:
//   * the threshold is conservative and configurable, and needs tuning against
//     real samples before its numbers mean much;
//   * a mismatch is a WARNING and never an automatic rejection. A false reject
//     here is far more damaging to a real person than a missed match.

/** Cosine similarity of two equal-length vectors, in [-1, 1]. */
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return null;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return null;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Compare every pair of detected faces.
 *
 * `faces` is `[{ type, face }]`; entries with a null face are excluded from
 * comparison and reported separately.
 *
 * Returns a result shaped for the comparison layer, always advisory.
 */
function matchFaces(faces, options = {}) {
  const threshold = options.threshold == null ? config.face.threshold : options.threshold;
  const available = options.available !== false;

  const withFace = (faces || []).filter(item => item.face && Array.isArray(item.face.embedding));
  const withoutFace = (faces || []).filter(item => !item.face || !Array.isArray(item.face.embedding)).map(item => item.type);

  if (!available) {
    return {
      available: false, compared: 0, pairs: [], withFace: [], withoutFace,
      threshold, confidence: 0, advisory: true,
      note: options.reason || 'Face matching is unavailable in this environment.'
    };
  }

  if (withFace.length === 0) {
    return {
      available: true, compared: 0, pairs: [], withFace: [], withoutFace,
      threshold, confidence: 0, advisory: true,
      note: 'No photograph could be located on any uploaded document.'
    };
  }

  if (withFace.length === 1) {
    return {
      available: true, compared: 0, pairs: [], withFace: [withFace[0].type], withoutFace,
      threshold, confidence: 0, advisory: true,
      note: `Only one document carried a usable photograph (${withFace[0].type}), so no comparison is possible.`
    };
  }

  const pairs = [];
  for (let i = 0; i < withFace.length; i++) {
    for (let j = i + 1; j < withFace.length; j++) {
      const similarity = cosineSimilarity(withFace[i].face.embedding, withFace[j].face.embedding);
      if (similarity == null) continue;
      pairs.push({
        a: withFace[i].type,
        b: withFace[j].type,
        similarity: Number(similarity.toFixed(4)),
        match: similarity >= threshold
      });
    }
  }

  const matching = pairs.filter(pair => pair.match).length;

  return {
    available: true,
    compared: pairs.length,
    pairs,
    withFace: withFace.map(item => item.type),
    withoutFace,
    threshold,
    confidence: pairs.length ? Number((matching / pairs.length).toFixed(2)) : 0,
    advisory: true,
    note: `Indicative only. Card photographs are low-resolution and may be decades apart; the ${threshold} similarity threshold needs tuning against real samples. A face mismatch never blocks a Golden ID.`
  };
}

module.exports = { matchFaces, cosineSimilarity };
