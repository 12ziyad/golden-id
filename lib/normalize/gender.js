'use strict';

// Indian cards print gender in English, in Hindi, or as a bare initial, and the
// same person's PAN may omit it entirely. Everything folds to M / F / O.

const MALE = new Set(['M', 'MALE', 'MAN', 'पुरुष', 'पुुरुष', 'पु', 'ಪುರುಷ', 'ஆண்', 'పురుషుడు', 'പുരുഷൻ']);
const FEMALE = new Set(['F', 'FEMALE', 'WOMAN', 'महिला', 'स्त्री', 'ಮಹಿಳೆ', 'பெண்', 'స్త్రీ', 'സ്ത്രീ']);
const OTHER = new Set(['O', 'OTHER', 'T', 'TG', 'TRANSGENDER', 'THIRD GENDER', 'अन्य', 'ट्रांसजेंडर']);

/**
 * Normalize a printed gender to 'M', 'F' or 'O'.
 * Returns '' for a genuinely absent value — absent is not the same as "other",
 * and the comparison layer must be able to tell them apart.
 */
function normalizeGender(value) {
  const text = String(value == null ? '' : value)
    .normalize('NFKC')
    // \p{M} matters: Devanagari vowel signs are combining marks, not letters,
    // so stripping them would reduce पुरुष to परष and lose the match entirely.
    .replace(/[^\p{L}\p{M}\s/|,]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  if (!text) return '';
  if (MALE.has(text)) return 'M';
  if (FEMALE.has(text)) return 'F';
  if (OTHER.has(text)) return 'O';
  // Bilingual cards print "पुरुष / MALE" on one line.
  for (const part of text.split(/[/|,\s]+/).filter(Boolean)) {
    if (MALE.has(part)) return 'M';
    if (FEMALE.has(part)) return 'F';
    if (OTHER.has(part)) return 'O';
  }
  return 'O';
}

module.exports = { normalizeGender };
