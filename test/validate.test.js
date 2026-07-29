'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { verhoeffValid, verhoeffDigit, mrzCheckDigit, parseMrz } = require('../lib/validate/checksums');
const { validateNumber, inferType } = require('../lib/validate/formats');
const { validateWithRepair, repairPositional } = require('../lib/validate/repair');

// A Verhoeff-valid Aadhaar built from its own check digit, so the fixture
// cannot drift away from the algorithm it is testing.
const AADHAAR_PAYLOAD = '23412341234';
const VALID_AADHAAR = AADHAAR_PAYLOAD + verhoeffDigit(AADHAAR_PAYLOAD);

test('verhoeff: a generated check digit validates, and every single-digit change breaks it', () => {
  assert.equal(VALID_AADHAAR.length, 12);
  assert.ok(verhoeffValid(VALID_AADHAAR));

  for (let index = 0; index < VALID_AADHAAR.length; index++) {
    for (let digit = 0; digit <= 9; digit++) {
      if (String(digit) === VALID_AADHAAR[index]) continue;
      const mutated = VALID_AADHAAR.slice(0, index) + digit + VALID_AADHAAR.slice(index + 1);
      assert.equal(verhoeffValid(mutated), false, `${mutated} should fail Verhoeff`);
    }
  }
});

test('verhoeff: catches adjacent transpositions, which is the point of the algorithm', () => {
  const swapped = VALID_AADHAAR.slice(0, 3) + VALID_AADHAAR[4] + VALID_AADHAAR[3] + VALID_AADHAAR.slice(5);
  if (swapped !== VALID_AADHAAR) assert.equal(verhoeffValid(swapped), false);
});

test('aadhaar: rejects numbers starting 0 or 1 before it even reaches the checksum', () => {
  assert.equal(validateNumber('aadhaar', '0' + VALID_AADHAAR.slice(1)).reason, 'pattern_mismatch');
  assert.equal(validateNumber('aadhaar', '1' + VALID_AADHAAR.slice(1)).reason, 'pattern_mismatch');
});

test('aadhaar: a right-shaped number that fails Verhoeff is reported as a checksum failure', () => {
  const broken = validateNumber('aadhaar', '234123412341');
  assert.equal(broken.valid, false);
  assert.equal(broken.reason, 'checksum_failed');
});

test('formats: PAN, passport and EPIC patterns', () => {
  assert.equal(validateNumber('pan', 'BQIPS8241E').valid, true);
  assert.equal(validateNumber('pan', 'BQIP8241E').valid, false);
  assert.equal(validateNumber('passport', 'M1234567').valid, true);
  assert.equal(validateNumber('passport', 'MM234567').valid, false);
  assert.equal(validateNumber('voter', 'ABC1234567').valid, true);
  assert.equal(validateNumber('voter', 'AB12345678').valid, false);
});

test('formats: birth certificates are accepted without a format claim', () => {
  const result = validateNumber('birth_certificate', 'BLR/2019/44821');
  assert.equal(result.valid, true);
  assert.equal(result.reason, 'not_validated');
});

test('formats: spacing as printed on the card is tolerated', () => {
  assert.equal(validateNumber('pan', 'BQIPS 8241 E').valid, true);
  assert.equal(validateNumber('aadhaar', VALID_AADHAAR.replace(/(\d{4})(\d{4})(\d{4})/, '$1 $2 $3')).valid, true);
});

test('repair: PAN letter slots recover digits the reader misclassified', () => {
  // Positions 1-5 and 10 must be letters: 0→O, 1→I, 5→S, 8→B, 2→Z.
  const result = validateWithRepair('pan', 'BQ1PS8241E');
  assert.equal(result.valid, true);
  assert.equal(result.repaired, true);
  assert.equal(result.value, 'BQIPS8241E');
  assert.deepEqual(result.changes, [{ index: 2, from: '1', to: 'I', slot: 'alpha' }]);
});

test('repair: PAN digit slots recover letters the reader misclassified', () => {
  // Positions 6-9 must be digits, so O→0 and S→5 in that window.
  const result = validateWithRepair('pan', 'BQIPSB241E');
  assert.equal(result.valid, true);
  assert.equal(result.repaired, true);
  assert.equal(result.value, 'BQIPS8241E');
});

test('repair: several substitutions at once', () => {
  const result = validateWithRepair('pan', 'BQ1P58241E');
  assert.equal(result.valid, true);
  assert.equal(result.value, 'BQIPS8241E');
  assert.equal(result.changes.length, 2);
});

test('repair: a clean number is not marked as repaired', () => {
  const result = validateWithRepair('pan', 'BQIPS8241E');
  assert.equal(result.valid, true);
  assert.equal(result.repaired, false);
  assert.deepEqual(result.changes, []);
});

test('repair: only touches characters sitting in the wrong kind of slot', () => {
  // The B in position 1 is already a letter and must be left alone.
  const { value, changes } = repairPositional('pan', 'BQIPS8241E');
  assert.equal(value, 'BQIPS8241E');
  assert.deepEqual(changes, []);
});

test('repair: an unrecoverable number is flagged for manual entry, not rejected outright', () => {
  const result = validateWithRepair('pan', 'XX');
  assert.equal(result.valid, false);
  assert.equal(result.needsManualEntry, true);
  assert.equal(result.repaired, false);
});

test('repair: passport and EPIC use their own positional layouts', () => {
  assert.equal(validateWithRepair('passport', 'MI234567').value, 'M1234567');
  assert.equal(validateWithRepair('voter', 'ABC12345G7').value, 'ABC1234567');
});

test('mrz: ICAO 7-3-1 check digit', () => {
  assert.equal(mrzCheckDigit('L898902C3'), 6);
  assert.equal(mrzCheckDigit('740812'), 2);
  assert.equal(mrzCheckDigit('120415'), 9);
});

test('mrz: a TD3 zone parses and cross-checks name, DOB, sex and number', () => {
  const mrz = [
    'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<',
    'L898902C36UTO7408122F1204159ZE184226B<<<<<10'
  ].join('\n');

  const parsed = parseMrz(`some visual zone text\n${mrz}`);
  assert.ok(parsed, 'MRZ should be located inside surrounding scan text');
  assert.equal(parsed.number, 'L898902C3');
  assert.equal(parsed.surname, 'ERIKSSON');
  assert.equal(parsed.given, 'ANNA MARIA');
  assert.equal(parsed.dob, '1974-08-12');
  assert.equal(parsed.sex, 'F');
  assert.equal(parsed.expiry, '2012-04-15');
  assert.equal(parsed.checks.number, true);
  assert.equal(parsed.checks.dob, true);
  assert.equal(parsed.checks.expiry, true);
  assert.equal(parsed.valid, true);
});

test('mrz: a corrupted number fails its check digit rather than being trusted', () => {
  const mrz = [
    'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<',
    'L898902C46UTO7408122F1204159ZE184226B<<<<<10'
  ].join('\n');
  const parsed = parseMrz(mrz);
  assert.equal(parsed.checks.number, false);
  assert.equal(parsed.valid, false);
});

test('mrz: absent machine-readable zone is normal, not an error', () => {
  assert.equal(parseMrz('INCOME TAX DEPARTMENT\nASHA DEVI\n21/05/1990'), null);
  assert.equal(parseMrz(''), null);
});

test('inferType: recognises a document from the shape of its number', () => {
  assert.equal(inferType('BQIPS8241E'), 'pan');
  assert.equal(inferType('M1234567'), 'passport');
  assert.equal(inferType('ABC1234567'), 'voter');
  assert.equal(inferType(VALID_AADHAAR), 'aadhaar');
  assert.equal(inferType('nonsense'), '');
});
