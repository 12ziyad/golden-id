'use strict';

const { verhoeffValid } = require('./checksums');

// Per-document number formats. These validate a single card in isolation.
// Numbers are NEVER compared across documents — each card carries its own, so
// a cross-document comparison would be meaningless by construction.

const FORMATS = {
  pan: {
    label: 'PAN',
    pattern: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
    length: 10,
    // Positional layout drives OCR repair: five letters, four digits, a letter.
    slots: ['alpha', 'alpha', 'alpha', 'alpha', 'alpha', 'digit', 'digit', 'digit', 'digit', 'alpha']
  },
  aadhaar: {
    label: 'Aadhaar',
    pattern: /^[2-9][0-9]{11}$/,
    length: 12,
    slots: new Array(12).fill('digit')
  },
  passport: {
    label: 'Passport',
    pattern: /^[A-Z][0-9]{7}$/,
    length: 8,
    slots: ['alpha', 'digit', 'digit', 'digit', 'digit', 'digit', 'digit', 'digit']
  },
  voter: {
    label: 'Voter ID (EPIC)',
    pattern: /^[A-Z]{3}[0-9]{7}$/,
    length: 10,
    slots: ['alpha', 'alpha', 'alpha', 'digit', 'digit', 'digit', 'digit', 'digit', 'digit', 'digit']
  },
  birth_certificate: {
    // Birth certificates are issued by thousands of local registrars with no
    // national format. Accept whatever is printed; do not pretend to validate.
    label: 'Birth certificate',
    pattern: null,
    length: null,
    slots: null
  }
};

/** Strip the spacing and separators cards print for legibility. */
const canonical = value => String(value == null ? '' : value)
  .toUpperCase()
  .replace(/[\s\-/]/g, '')
  .trim();

/**
 * Validate a document number against its type's format.
 * Returns `{ valid, value, type, reason, checksum }`.
 *
 * `reason` distinguishes a wrong shape from a right shape that fails its
 * checksum, because only the latter is worth attempting to repair digit by digit.
 */
function validateNumber(documentType, value) {
  const format = FORMATS[documentType];
  const clean = canonical(value);

  if (!format) return { valid: false, value: clean, type: documentType, reason: 'unknown_document_type', checksum: null };
  if (!clean) return { valid: false, value: '', type: documentType, reason: 'empty', checksum: null };

  // No national format to check against — accepted as printed.
  if (!format.pattern) {
    return { valid: true, value: clean, type: documentType, reason: 'not_validated', checksum: null };
  }

  if (clean.length !== format.length) {
    return { valid: false, value: clean, type: documentType, reason: 'wrong_length', checksum: null };
  }
  if (!format.pattern.test(clean)) {
    return { valid: false, value: clean, type: documentType, reason: 'pattern_mismatch', checksum: null };
  }

  if (documentType === 'aadhaar') {
    const checksum = verhoeffValid(clean);
    return {
      valid: checksum,
      value: clean,
      type: documentType,
      reason: checksum ? '' : 'checksum_failed',
      checksum
    };
  }

  return { valid: true, value: clean, type: documentType, reason: '', checksum: null };
}

/** Guess the document type from the shape of a number alone. */
function inferType(value) {
  const clean = canonical(value);
  for (const type of ['pan', 'passport', 'voter']) {
    if (FORMATS[type].pattern.test(clean)) return type;
  }
  if (FORMATS.aadhaar.pattern.test(clean) && verhoeffValid(clean)) return 'aadhaar';
  return '';
}

module.exports = { FORMATS, validateNumber, inferType, canonical };
