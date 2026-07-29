'use strict';

const { normalizeName } = require('../normalize/name');

/**
 * Classic Levenshtein edit distance with an optional ceiling.
 * When `maxDistance` is given the walk abandons a row once every cell exceeds
 * it and returns `maxDistance + 1`, which is all a caller comparing against a
 * threshold needs to know.
 */
function levenshtein(a, b, maxDistance = Infinity) {
  const left = String(a == null ? '' : a);
  const right = String(b == null ? '' : b);
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let current = new Array(right.length + 1);

  for (let i = 1; i <= left.length; i++) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      if (current[j] < rowMin) rowMin = current[j];
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    [previous, current] = [current, previous];
  }
  return previous[right.length];
}

/** Cheap similarity in [0,1], used for ranking rather than for decisions. */
function similarity(a, b) {
  const longest = Math.max(String(a || '').length, String(b || '').length);
  if (!longest) return 1;
  return 1 - levenshtein(a, b) / longest;
}

// A single-letter token is an initial. "K" matching "KUNHAMMED" would be far too
// loose, so an initial only matches another initial, or is treated as an
// unmatched-but-forgivable token when the other name simply omits it.
const isInitial = token => token.length === 1;

/**
 * Compare two names as token *sets*, so word order never registers as a
 * difference. Returns `{ distance, sameTokens, pairs, unmatched }` where
 * `pairs` aligns each token of `a` with its best match in `b` for diffing.
 */
function tokenSetDistance(a, b) {
  const left = normalizeName(a);
  const right = normalizeName(b);

  if (left.empty || right.empty) {
    return { distance: Infinity, sameTokens: false, pairs: [], unmatched: [], missing: true };
  }
  if (left.sorted === right.sorted) {
    return { distance: 0, sameTokens: true, pairs: [], unmatched: [], missing: false };
  }
  // An abbreviation expansion on either side counts as a match, not a fix.
  const leftForms = [left.ordered, ...left.alternates].map(form => form.split(' ').sort().join(' '));
  const rightForms = [right.ordered, ...right.alternates].map(form => form.split(' ').sort().join(' '));
  if (leftForms.some(form => rightForms.includes(form))) {
    return { distance: 0, sameTokens: true, pairs: [], unmatched: [], expanded: true, missing: false };
  }

  // Word boundaries are the first thing a reader loses on a printed card:
  // "MUHAMMED SAKIR K" comes back as "MUHAMMEDSAKIR K". Token-by-token that
  // looks like a completely different name (distance 26 on a real example),
  // when the only difference is a missing space. Compare the whitespace-free
  // forms too and take whichever reading is kinder, since a dropped space is
  // an artefact of the scan rather than a difference between two people.
  const leftGlued = left.tokens.join('');
  const rightGlued = right.tokens.join('');
  const gluedDistance = levenshtein(leftGlued, rightGlued);
  if (leftGlued === rightGlued) {
    return { distance: 0, sameTokens: true, pairs: [], unmatched: [], spacing: true, missing: false };
  }

  // Greedily pair each left token with its closest unused right token.
  const remaining = right.tokens.map((token, index) => ({ token, index, used: false }));
  const pairs = [];
  const unmatched = [];
  let distance = 0;

  for (const token of left.tokens) {
    let best = null;
    let bestDistance = Infinity;
    for (const candidate of remaining) {
      if (candidate.used) continue;
      // Initials only ever pair with initials.
      if (isInitial(token) !== isInitial(candidate.token)) continue;
      const d = levenshtein(token, candidate.token);
      if (d < bestDistance) { bestDistance = d; best = candidate; }
    }
    if (best && bestDistance <= Math.max(2, Math.floor(token.length / 3))) {
      best.used = true;
      pairs.push({ left: token, right: best.token, distance: bestDistance });
      distance += bestDistance;
    } else {
      unmatched.push({ side: 'left', token });
      // A dropped middle name or absent initial is a smaller offence than a
      // wholly different word.
      distance += isInitial(token) ? 1 : token.length;
    }
  }
  for (const candidate of remaining) {
    if (candidate.used) continue;
    unmatched.push({ side: 'right', token: candidate.token });
    distance += isInitial(candidate.token) ? 1 : candidate.token.length;
  }

  // Only the tokenised walk knows which words differ, so it supplies the pairs
  // used for diffing — but if it was thrown off by spacing alone, the glued
  // comparison is the honest measure of how far apart these two names are.
  if (gluedDistance < distance) {
    return { distance: gluedDistance, sameTokens: false, pairs, unmatched, spacing: true, missing: false };
  }

  return { distance, sameTokens: false, pairs, unmatched, missing: false };
}

module.exports = { levenshtein, similarity, tokenSetDistance, isInitial };
