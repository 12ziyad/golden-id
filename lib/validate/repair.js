'use strict';

const { FORMATS, validateNumber, canonical } = require('./formats');

// Positional OCR repair. Because we know the format of each document number, we
// know which slots must be letters and which must be digits — so a "0" sitting
// in a letter slot is almost certainly an O that the reader misclassified.
//
// A repaired value is always surfaced as repaired. We never silently rewrite a
// document number and present it as if it had been read cleanly.

// Glyph confusions, keyed by the slot the character is sitting in.
const TO_ALPHA = { 0: 'O', 1: 'I', 2: 'Z', 5: 'S', 8: 'B', 6: 'G', 4: 'A', 7: 'T', 9: 'G' };
const TO_DIGIT = { O: '0', Q: '0', D: '0', I: '1', L: '1', J: '1', Z: '2', S: '5', B: '8', G: '6', A: '4', T: '7' };

const isAlpha = character => character >= 'A' && character <= 'Z';
const isDigit = character => character >= '0' && character <= '9';

/**
 * Rewrite characters that sit in the wrong kind of slot for the format.
 * Returns `{ value, changes }` where `changes` lists every substitution made.
 */
function repairPositional(documentType, value) {
  const format = FORMATS[documentType];
  const clean = canonical(value);
  if (!format || !format.slots || clean.length !== format.length) {
    return { value: clean, changes: [] };
  }

  const characters = clean.split('');
  const changes = [];

  format.slots.forEach((slot, index) => {
    const character = characters[index];
    if (slot === 'alpha' && !isAlpha(character)) {
      const replacement = TO_ALPHA[character];
      if (replacement) {
        characters[index] = replacement;
        changes.push({ index, from: character, to: replacement, slot });
      }
    } else if (slot === 'digit' && !isDigit(character)) {
      const replacement = TO_DIGIT[character];
      if (replacement) {
        characters[index] = replacement;
        changes.push({ index, from: character, to: replacement, slot });
      }
    }
  });

  return { value: characters.join(''), changes };
}

/**
 * Aadhaar-specific second pass: the shape is right and every character is a
 * digit, but Verhoeff fails. Try the handful of digit confusions one position at
 * a time and accept a repair only when exactly one candidate validates —
 * ambiguity here means we must ask rather than guess.
 */
const DIGIT_CONFUSIONS = { 0: ['8'], 8: ['0', '6'], 1: ['7'], 7: ['1'], 5: ['6'], 6: ['5', '8'], 3: ['9'], 9: ['3'], 2: ['7'], 4: ['9'] };

function repairChecksum(documentType, value) {
  if (documentType !== 'aadhaar') return null;
  const clean = canonical(value);
  const candidates = new Set();

  for (let index = 0; index < clean.length; index++) {
    for (const replacement of DIGIT_CONFUSIONS[clean[index]] || []) {
      const candidate = clean.slice(0, index) + replacement + clean.slice(index + 1);
      if (validateNumber(documentType, candidate).valid) candidates.add(candidate);
    }
  }

  const unique = [...candidates];
  return unique.length === 1 ? unique[0] : null;
}

/**
 * Validate a document number, attempting OCR repair when the raw read fails.
 *
 * Returns `{ valid, value, original, repaired, changes, reason, needsManualEntry }`.
 * When repair cannot rescue the value, `needsManualEntry` is set so the UI can
 * offer an inline correction instead of rejecting the whole application.
 */
function validateWithRepair(documentType, value) {
  const original = canonical(value);
  const direct = validateNumber(documentType, original);
  if (direct.valid) {
    return { ...direct, original, repaired: false, changes: [], needsManualEntry: false };
  }

  // Pass 1 — characters in the wrong kind of slot.
  const positional = repairPositional(documentType, original);
  if (positional.changes.length) {
    const result = validateNumber(documentType, positional.value);
    if (result.valid) {
      return { ...result, original, repaired: true, changes: positional.changes, needsManualEntry: false };
    }
  }

  // Pass 2 — right shape, wrong checksum (Aadhaar only).
  const base = positional.changes.length ? positional.value : original;
  const checksumFixed = repairChecksum(documentType, base);
  if (checksumFixed) {
    const result = validateNumber(documentType, checksumFixed);
    if (result.valid) {
      const changes = [...positional.changes];
      for (let index = 0; index < base.length; index++) {
        if (base[index] !== checksumFixed[index]) {
          changes.push({ index, from: base[index], to: checksumFixed[index], slot: 'digit' });
        }
      }
      return { ...result, original, repaired: true, changes, needsManualEntry: false };
    }
  }

  return {
    ...direct,
    value: original,
    original,
    repaired: false,
    changes: [],
    needsManualEntry: true
  };
}

module.exports = { repairPositional, repairChecksum, validateWithRepair, TO_ALPHA, TO_DIGIT };
