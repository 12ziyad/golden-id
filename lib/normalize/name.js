'use strict';

// Indian IDs disagree about name *order* constantly: Aadhaar prints
// "MUHAMMED SAKIR K", the Voter roll prints "K MUHAMMED SAKIR". Both are the
// same person. We therefore keep an ordered form for display and a sorted token
// set for comparison, and never let ordering alone count as a mismatch.

const HONORIFICS = new Set([
  'MR', 'MRS', 'MS', 'MISS', 'SHRI', 'SRI', 'SMT', 'SMTH', 'KUM', 'KUMARI',
  'DR', 'PROF', 'ER', 'ADV', 'LATE', 'M/S', 'SH'
]);

// Abbreviations that are genuinely ambiguous in Indian names. These produce an
// ALTERNATE candidate spelling; the printed form is never overwritten, because
// "MD" on one card and "MOHAMMED" on another are a real difference worth showing.
const ABBREVIATIONS = {
  MD: ['MUHAMMED', 'MOHAMMED', 'MOHAMMAD', 'MUHAMMAD'],
  MOHD: ['MUHAMMED', 'MOHAMMED', 'MOHAMMAD', 'MUHAMMAD'],
  MUHD: ['MUHAMMED', 'MUHAMMAD'],
  ABD: ['ABDUL'],
  SK: ['SHAIKH', 'SHEIKH'],
  KR: ['KUMAR'],
  SGH: ['SINGH'],
  RAJ: ['RAJU']
};

/**
 * Normalize a printed name.
 * Returns `{ ordered, tokens, sorted, initials, alternates, empty }`.
 *  - `ordered`   display/comparison form in printed order
 *  - `tokens`    cleaned word list
 *  - `sorted`    token set joined in sorted order — order-insensitive key
 *  - `initials`  tokens that are a single letter (K, S) — matched loosely
 *  - `alternates`additional whole-name spellings from abbreviation expansion
 */
function normalizeName(value) {
  const raw = String(value == null ? '' : value);
  const cleaned = raw
    .normalize('NFKC')
    .toUpperCase()
    // Keep letters (any script), digits and spaces; punctuation and dots go.
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let tokens = cleaned ? cleaned.split(' ') : [];
  tokens = tokens.filter(token => !HONORIFICS.has(token));
  // A name that was nothing but an honorific is not a name.
  if (!tokens.length) {
    return { ordered: '', tokens: [], sorted: '', initials: [], alternates: [], empty: true };
  }

  const ordered = tokens.join(' ');
  const sorted = [...tokens].sort().join(' ');
  const initials = tokens.filter(token => token.length === 1);

  // Build alternate whole-name spellings, one substitution position at a time.
  const alternates = new Set();
  tokens.forEach((token, index) => {
    for (const expansion of ABBREVIATIONS[token] || []) {
      const variant = [...tokens];
      variant[index] = expansion;
      alternates.add(variant.join(' '));
    }
  });
  alternates.delete(ordered);

  return { ordered, tokens, sorted, initials, alternates: [...alternates], empty: false };
}

/** Convenience: the ordered comparison form, or '' when absent. */
const toComparable = value => normalizeName(value).ordered;

module.exports = { normalizeName, toComparable, HONORIFICS, ABBREVIATIONS };
