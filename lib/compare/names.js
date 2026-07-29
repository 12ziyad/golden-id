'use strict';

const { normalizeName } = require('../normalize/name');
const { levenshtein } = require('./levenshtein');

// Multi-signal, explainable name comparison.
//
// A single similarity score cannot distinguish the cases that matter here:
//
//   MUHAMMEDSAKIR K  vs  MUHAMMAD SAKIR K
//     -> a lost space plus a one-letter transliteration difference. Same person.
//
//   MUHAMMED MISHAB SULAIMAN P  vs  surname PARATHODI + given MUHAMMED MISHAB SULAIMAN
//     -> the "P" is almost certainly the initial of the surname. Plausible, but
//        it is an inference, so it must be CONFIRMED rather than assumed.
//
//   RAJESH KUMAR  vs  ASHA DEVI
//     -> genuinely different people.
//
// So we compute several independent signals and report which ones fired. Each
// difference is classified as safe-to-normalise, needs-confirmation, or
// genuinely different — and a single low-confidence OCR read never hard-rejects.

// --- individual similarity measures -----------------------------------------

/** Damerau-Levenshtein: like Levenshtein but counts a transposition as one edit. */
function damerauLevenshtein(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  const rows = left.length;
  const columns = right.length;
  const d = Array.from({ length: rows + 1 }, () => new Array(columns + 1).fill(0));
  for (let i = 0; i <= rows; i++) d[i][0] = i;
  for (let j = 0; j <= columns; j++) d[0][j] = j;

  for (let i = 1; i <= rows; i++) {
    for (let j = 1; j <= columns; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[rows][columns];
}

/**
 * Jaro-Winkler. Rewards a shared prefix, which suits personal names where the
 * beginning is usually read correctly and the tail degrades.
 */
function jaroWinkler(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left.length && !right.length) return 1;
  if (!left.length || !right.length) return 0;
  if (left === right) return 1;

  const window = Math.max(0, Math.floor(Math.max(left.length, right.length) / 2) - 1);
  const leftFlags = new Array(left.length).fill(false);
  const rightFlags = new Array(right.length).fill(false);
  let matches = 0;

  for (let i = 0; i < left.length; i++) {
    const start = Math.max(0, i - window);
    const end = Math.min(i + window + 1, right.length);
    for (let j = start; j < end; j++) {
      if (rightFlags[j] || left[i] !== right[j]) continue;
      leftFlags[i] = true;
      rightFlags[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < left.length; i++) {
    if (!leftFlags[i]) continue;
    while (!rightFlags[k]) k++;
    if (left[i] !== right[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  const jaro = (matches / left.length + matches / right.length + (matches - transpositions) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * A compact phonetic key, tuned for the romanisation of Indic names where the
 * same sound is spelled many ways (MUHAMMED / MOHAMMAD / MUHAMMAD).
 */
function phoneticKey(token) {
  let text = String(token || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!text) return '';
  text = text
    .replace(/PH/g, 'F')
    .replace(/GH/g, 'G')
    .replace(/KH/g, 'K')
    .replace(/BH/g, 'B')
    .replace(/DH/g, 'D')
    .replace(/TH/g, 'T')
    .replace(/CH/g, 'C')
    .replace(/SH/g, 'S')
    .replace(/CK/g, 'K')
    .replace(/Q/g, 'K')
    .replace(/X/g, 'KS')
    .replace(/W/g, 'V')
    .replace(/Y/g, 'I')
    .replace(/J/g, 'Z');
  const first = text[0];
  // Drop vowels after the first letter; they carry least information across
  // transliterations.
  text = first + text.slice(1).replace(/[AEIOU]/g, '');
  return text.replace(/(.)\1+/g, '$1');
}

/** Character n-gram overlap (Dice coefficient). */
function nGramSimilarity(a, b, n = 2) {
  const grams = value => {
    const text = String(value || '').toUpperCase().replace(/\s/g, '');
    const set = new Set();
    for (let i = 0; i <= text.length - n; i++) set.add(text.slice(i, i + n));
    return set;
  };
  const left = grams(a);
  const right = grams(b);
  if (!left.size && !right.size) return 1;
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared++;
  return (2 * shared) / (left.size + right.size);
}

// --- token relationships ----------------------------------------------------

const isInitial = token => token.length === 1;

/** Does a single letter plausibly stand for this word? */
const initialMatches = (initial, word) => word.length > 1 && word[0] === initial;

/**
 * Align two token lists, recognising initials, expansions and reordering.
 * Returns pairs plus the tokens nothing could be matched to.
 */
function alignTokens(leftTokens, rightTokens) {
  const remaining = rightTokens.map((token, index) => ({ token, index, used: false }));
  const pairs = [];
  const unmatchedLeft = [];

  for (const token of leftTokens) {
    let best = null;
    let bestScore = -1;
    let bestKind = '';

    for (const candidate of remaining) {
      if (candidate.used) continue;
      let score = -1;
      let kind = '';

      if (token === candidate.token) {
        score = 1; kind = 'exact';
      } else if (isInitial(token) && isInitial(candidate.token)) {
        score = token === candidate.token ? 1 : 0; kind = 'initial';
      } else if (isInitial(token) && initialMatches(token, candidate.token)) {
        score = 0.9; kind = 'initial_expansion';
      } else if (isInitial(candidate.token) && initialMatches(candidate.token, token)) {
        score = 0.9; kind = 'initial_expansion';
      } else if (phoneticKey(token) && phoneticKey(token) === phoneticKey(candidate.token)) {
        score = 0.88; kind = 'phonetic';
      } else {
        const jw = jaroWinkler(token, candidate.token);
        if (jw >= 0.86) { score = jw * 0.86; kind = 'fuzzy'; }
      }

      if (score > bestScore) { bestScore = score; best = candidate; bestKind = kind; }
    }

    if (best && bestScore > 0) {
      best.used = true;
      pairs.push({
        left: token, right: best.token, kind: bestKind,
        distance: damerauLevenshtein(token, best.token),
        similarity: Number(jaroWinkler(token, best.token).toFixed(4))
      });
    } else {
      unmatchedLeft.push(token);
    }
  }

  const unmatchedRight = remaining.filter(candidate => !candidate.used).map(candidate => candidate.token);
  return { pairs, unmatchedLeft, unmatchedRight };
}

// --- the comparison ---------------------------------------------------------

const VERDICTS = {
  IDENTICAL: 'identical',
  SAFE_VARIANT: 'safe_variant',           // normalise silently: case/space/order/honorific
  NEEDS_CONFIRMATION: 'needs_confirmation', // plausible but inferred; ask the holder
  DIFFERENT: 'different'                  // genuinely not the same name
};

/**
 * Compare two printed names.
 *
 * Returns `{ verdict, score, signals, explanation, pairs, glued }`, where
 * `signals` names every measure that fired so a decision can be explained to a
 * human rather than asserted.
 */
function compareNames(a, b) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  const signals = [];

  if (left.empty || right.empty) {
    return {
      verdict: VERDICTS.NEEDS_CONFIRMATION, score: 0, signals: ['missing_value'],
      explanation: 'One of the two names could not be read.', pairs: [], missing: true
    };
  }

  // 1. Exact, once case/punctuation/honorifics are normalised.
  if (left.ordered === right.ordered) {
    return { verdict: VERDICTS.IDENTICAL, score: 1, signals: ['exact'], explanation: 'The names are identical.', pairs: [] };
  }

  // 2. Same tokens, different order. Aadhaar prints "MUHAMMED SAKIR K";
  //    the electoral roll prints "K MUHAMMED SAKIR". Same person.
  if (left.sorted === right.sorted) {
    signals.push('token_order');
    return { verdict: VERDICTS.SAFE_VARIANT, score: 1, signals, explanation: 'Same words in a different order.', pairs: [] };
  }

  // 3. An abbreviation expansion on either side (MD -> MUHAMMED).
  const leftForms = [left.ordered, ...left.alternates].map(form => form.split(' ').sort().join(' '));
  const rightForms = [right.ordered, ...right.alternates].map(form => form.split(' ').sort().join(' '));
  if (leftForms.some(form => rightForms.includes(form))) {
    signals.push('abbreviation_expansion');
    return { verdict: VERDICTS.SAFE_VARIANT, score: 0.97, signals, explanation: 'One name uses a common abbreviation of the other.', pairs: [] };
  }

  // 4. Word boundaries lost by the reader.
  const leftGlued = left.tokens.join('');
  const rightGlued = right.tokens.join('');
  const gluedDistance = damerauLevenshtein(leftGlued, rightGlued);
  const glued = leftGlued === rightGlued;
  if (glued) {
    signals.push('spacing_only');
    return { verdict: VERDICTS.SAFE_VARIANT, score: 1, signals, explanation: 'Identical apart from where the spaces fell.', pairs: [], glued: true };
  }

  // 5. Token-level alignment.
  const alignment = alignTokens(left.tokens, right.tokens);
  const matched = alignment.pairs.length;
  const totalTokens = Math.max(left.tokens.length, right.tokens.length);
  const exactPairs = alignment.pairs.filter(pair => pair.kind === 'exact').length;
  const closePairs = alignment.pairs.filter(pair => pair.distance <= 2 && pair.kind !== 'exact').length;

  if (alignment.pairs.some(pair => pair.kind === 'phonetic')) signals.push('phonetic_match');
  if (alignment.pairs.some(pair => pair.kind === 'initial_expansion')) signals.push('initial_expansion');
  if (closePairs) signals.push('close_spelling');
  if (gluedDistance <= 2) signals.push('glued_form_close');

  const jw = jaroWinkler(left.ordered, right.ordered);
  const nGram = nGramSimilarity(left.ordered, right.ordered);
  const score = Number(((jw + nGram + matched / totalTokens) / 3).toFixed(4));

  // 6. The surname-initial relationship. A passport splits surname and given
  //    names; other documents append the surname's initial. That is a plausible
  //    and common relationship — but it is an inference, so it is confirmed,
  //    never assumed.
  const surnameInitial = detectSurnameInitial(left, right);
  if (surnameInitial) {
    signals.push('surname_initial');
    return {
      verdict: VERDICTS.NEEDS_CONFIRMATION, score: Math.max(score, 0.9), signals,
      explanation: surnameInitial, pairs: alignment.pairs
    };
  }

  // 7. Every token matched and every difference is small: an OCR-grade variant.
  const allMatched = !alignment.unmatchedLeft.length && !alignment.unmatchedRight.length;
  const totalDistance = alignment.pairs.reduce((sum, pair) => sum + pair.distance, 0);

  if (allMatched && totalDistance === 0) {
    return { verdict: VERDICTS.SAFE_VARIANT, score: 1, signals, explanation: 'The same name written slightly differently.', pairs: alignment.pairs };
  }
  if (allMatched && totalDistance <= 2) {
    return {
      verdict: VERDICTS.NEEDS_CONFIRMATION, score, signals,
      explanation: `The names differ by ${totalDistance} character${totalDistance === 1 ? '' : 's'} — consistent with a misread or a spelling variation.`,
      pairs: alignment.pairs
    };
  }

  // 8. One name simply has fewer parts (a dropped middle name or initial).
  const droppedOnly = (!alignment.unmatchedLeft.length || !alignment.unmatchedRight.length)
    && totalDistance <= 2
    && matched >= Math.min(left.tokens.length, right.tokens.length);
  if (droppedOnly) {
    signals.push('token_dropped');
    return {
      verdict: VERDICTS.NEEDS_CONFIRMATION, score, signals,
      explanation: 'One document omits a name part the other includes.',
      pairs: alignment.pairs
    };
  }

  // 9. The glued forms are still very close: spacing plus a small misread.
  if (gluedDistance <= 2) {
    return {
      verdict: VERDICTS.NEEDS_CONFIRMATION, score: Math.max(score, 0.9), signals,
      explanation: `Once spacing is set aside the names differ by ${gluedDistance} character${gluedDistance === 1 ? '' : 's'}.`,
      pairs: alignment.pairs, glued: true
    };
  }

  // 10. Strong overall similarity but nothing above explains it cleanly.
  if (score >= 0.86 && matched >= totalTokens - 1) {
    return {
      verdict: VERDICTS.NEEDS_CONFIRMATION, score, signals,
      explanation: 'The names are similar but not clearly the same. Please confirm.',
      pairs: alignment.pairs
    };
  }

  return {
    verdict: VERDICTS.DIFFERENT, score, signals,
    explanation: 'These are different names.',
    pairs: alignment.pairs,
    unmatched: [...alignment.unmatchedLeft, ...alignment.unmatchedRight]
  };
}

/**
 * Detect the surname-initial relationship, in either direction:
 *   "MUHAMMED MISHAB SULAIMAN P"  <->  given "MUHAMMED MISHAB SULAIMAN", surname "PARATHODI"
 */
function detectSurnameInitial(left, right) {
  const check = (withInitial, withFull) => {
    const initials = withInitial.tokens.filter(isInitial);
    if (!initials.length) return null;
    const body = withInitial.tokens.filter(token => !isInitial(token));
    const fullBody = withFull.tokens.filter(token => !isInitial(token));

    // The non-initial parts must line up.
    const bodyMatches = body.length && body.every(token =>
      fullBody.some(other => other === token || jaroWinkler(token, other) >= 0.9));
    if (!bodyMatches) return null;

    // A token in the fuller name must start with one of the initials and not
    // otherwise appear in the shorter one.
    for (const initial of initials) {
      const candidate = fullBody.find(token => initialMatches(initial, token) && !body.includes(token));
      if (candidate) {
        return `"${initial}" appears to be the initial of "${candidate}". Please confirm these are the same person.`;
      }
    }
    return null;
  };

  return check(left, right) || check(right, left);
}

module.exports = {
  compareNames, VERDICTS, alignTokens, detectSurnameInitial,
  damerauLevenshtein, jaroWinkler, phoneticKey, nGramSimilarity, isInitial
};
