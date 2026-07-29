'use strict';

// Verhoeff (dihedral group D5) — the checksum UIDAI uses on Aadhaar numbers.
// A 12-digit read that fails Verhoeff is overwhelmingly likely to be an OCR
// misread rather than a forged card, so callers should attempt repair before
// drawing any conclusion about the document.

// Multiplication table for D5.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
];

// Permutation table, applied by position.
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
];

// Multiplicative inverse in D5.
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

const digitsOf = value => String(value == null ? '' : value).replace(/\D/g, '');

/** True when the full number (payload + trailing check digit) is Verhoeff-valid. */
function verhoeffValid(value) {
  const digits = digitsOf(value);
  if (!digits.length) return false;
  let checksum = 0;
  const reversed = digits.split('').reverse();
  for (let i = 0; i < reversed.length; i++) {
    checksum = D[checksum][P[i % 8][Number(reversed[i])]];
  }
  return checksum === 0;
}

/** The check digit that makes `payload` Verhoeff-valid when appended. */
function verhoeffDigit(payload) {
  const digits = digitsOf(payload);
  let checksum = 0;
  const reversed = digits.split('').reverse();
  for (let i = 0; i < reversed.length; i++) {
    checksum = D[checksum][P[(i + 1) % 8][Number(reversed[i])]];
  }
  return INV[checksum];
}

// ---------------------------------------------------------------------------
// MRZ (ICAO 9303 TD3) — the two 44-character lines at the foot of a passport.
// This zone is machine-printed in a fixed font and is by far the most reliable
// region on the document, so it is preferred over the visual zone.

const MRZ_WEIGHTS = [7, 3, 1];

/** Character value for MRZ arithmetic: digits as-is, A=10..Z=35, filler '<'=0. */
function mrzCharValue(character) {
  if (character === '<') return 0;
  if (character >= '0' && character <= '9') return Number(character);
  if (character >= 'A' && character <= 'Z') return character.charCodeAt(0) - 55;
  return -1;
}

/** ICAO 7-3-1 weighted check digit over a field. */
function mrzCheckDigit(field) {
  let sum = 0;
  const text = String(field || '').toUpperCase();
  for (let i = 0; i < text.length; i++) {
    const value = mrzCharValue(text[i]);
    if (value < 0) return -1;
    sum += value * MRZ_WEIGHTS[i % 3];
  }
  return sum % 10;
}

/** True when `field` is followed by the correct check digit. */
const mrzFieldValid = (field, checkDigit) =>
  String(checkDigit).length === 1 && mrzCheckDigit(field) === Number(checkDigit);

/** YYMMDD from an MRZ to ISO, pivoting two-digit years the ICAO way. */
function mrzDateToIso(yymmdd, { future = false } = {}) {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const month = Number(yymmdd.slice(2, 4));
  const day = Number(yymmdd.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Expiry dates are in the future; dates of birth are in the past.
  const pivot = new Date().getFullYear() % 100;
  const year = future ? 2000 + yy : (yy > pivot ? 1900 + yy : 2000 + yy);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Parse a TD3 machine-readable zone.
 * Accepts the raw text of a scan and locates the two MRZ lines within it.
 * Returns null when no MRZ is present — that is normal, not an error.
 */
function parseMrz(text) {
  const raw = String(text || '').toUpperCase().replace(/«|≪|«/g, '<');
  const candidates = raw
    .split(/\r?\n/)
    .map(line => line.replace(/\s/g, ''))
    .filter(line => line.length >= 40 && /^[A-Z0-9<]+$/.test(line));

  const first = candidates.find(line => /^P[A-Z<]/.test(line));
  const second = candidates.find(line => line !== first && /^[A-Z0-9<]{9}\d/.test(line));
  if (!first || !second) return null;

  const line1 = first.padEnd(44, '<').slice(0, 44);
  const line2 = second.padEnd(44, '<').slice(0, 44);

  // Line 1: P<ISSUER + SURNAME<<GIVEN<NAMES
  const nameZone = line1.slice(5);
  const [surnameRaw = '', givenRaw = ''] = nameZone.split('<<');
  const surname = surnameRaw.replace(/</g, ' ').trim();
  const given = givenRaw.replace(/</g, ' ').trim();

  const number = line2.slice(0, 9).replace(/<+$/, '');
  const numberCheck = line2[9];
  const nationality = line2.slice(10, 13).replace(/</g, '');
  const dobRaw = line2.slice(13, 19);
  const dobCheck = line2[19];
  const sex = line2[20];
  const expiryRaw = line2.slice(21, 27);
  const expiryCheck = line2[27];
  const personalNumber = line2.slice(28, 42).replace(/<+$/, '');
  const personalCheck = line2[42];
  const finalCheck = line2[43];

  // The composite check covers the number, DOB, expiry and personal-number
  // fields together with their individual check digits.
  const composite = line2.slice(0, 10) + line2.slice(13, 20) + line2.slice(21, 43);

  const checks = {
    number: mrzFieldValid(line2.slice(0, 9), numberCheck),
    dob: mrzFieldValid(dobRaw, dobCheck),
    expiry: mrzFieldValid(expiryRaw, expiryCheck),
    personal: personalCheck === '<' || mrzFieldValid(line2.slice(28, 42), personalCheck),
    composite: mrzFieldValid(composite, finalCheck)
  };

  return {
    documentType: 'passport',
    surname,
    given,
    name: [given, surname].filter(Boolean).join(' '),
    number,
    nationality,
    dob: mrzDateToIso(dobRaw),
    sex: sex === 'M' ? 'M' : sex === 'F' ? 'F' : '',
    expiry: mrzDateToIso(expiryRaw, { future: true }),
    personalNumber,
    checks,
    valid: Object.values(checks).every(Boolean),
    lines: [line1, line2]
  };
}

module.exports = {
  verhoeffValid,
  verhoeffDigit,
  mrzCheckDigit,
  mrzFieldValid,
  mrzCharValue,
  mrzDateToIso,
  parseMrz,
  D,
  P,
  INV
};
