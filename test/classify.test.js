'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyDocument } = require('../lib/extract/classify');
const { compareNames, VERDICTS } = require('../lib/compare/names');
const { renderNameDiff } = require('../lib/compare/diff');
const { compareDocuments } = require('../lib/compare');

// Captured verbatim from a live Moondream read of two real cards. The model
// labelled the AADHAAR as a "pan" while simultaneously extracting a 12-digit
// Verhoeff-valid Aadhaar number, a gender, and no father's name — three facts
// that are each incompatible with a PAN card.
const REAL_AADHAAR_READ = {
  document_type: 'pan',
  holder_name: 'Muhammad Sakir K',
  father_name: null,
  mother_name: null,
  spouse_name: null,
  dob: '19/05/2003',
  gender: 'male',
  address: null,
  document_number: '3204 3976 7873',
  issue_date: '17/12/2012',
  expiry_date: null
};

const REAL_PAN_READ = {
  document_type: 'pan',
  holder_name: 'MUHAMMEDSAKIR K',
  father_name: 'RAHEEM KOTTAKANDI',
  mother_name: null,
  spouse_name: null,
  dob: '19/05/2003',
  gender: null,
  address: null,
  document_number: 'MPWPK2241E',
  issue_date: '19/05/2003',
  expiry_date: null
};

test('the Aadhaar mislabelled "pan" by the model is corrected to aadhaar', () => {
  const result = classifyDocument(REAL_AADHAAR_READ, 'pan');

  assert.equal(result.type, 'aadhaar');
  assert.equal(result.claimed, 'pan');
  assert.equal(result.corrected, true);
  assert.match(result.reason, /Verhoeff/i);
});

test('the real PAN is left alone — a correct label is not second-guessed', () => {
  const result = classifyDocument(REAL_PAN_READ, 'pan');

  assert.equal(result.type, 'pan');
  assert.equal(result.corrected, false);
});

test('the two real cards no longer collapse into the same type', () => {
  const aadhaar = classifyDocument(REAL_AADHAAR_READ, 'pan');
  const pan = classifyDocument(REAL_PAN_READ, 'pan');
  assert.notEqual(aadhaar.type, pan.type);
  assert.deepEqual([pan.type, aadhaar.type].sort(), ['aadhaar', 'pan']);
});

test('the document number outweighs the model when they disagree', () => {
  assert.equal(classifyDocument({ document_number: 'MPWPK2241E' }, 'aadhaar').type, 'pan');
  assert.equal(classifyDocument({ document_number: 'M1234567', expiry_date: '01/01/2030' }, 'voter').type, 'passport');
  assert.equal(classifyDocument({ document_number: 'ABC1234567' }, 'pan').type, 'voter');
});

test('field presence alone identifies a card when the number is unreadable', () => {
  // No number, but a gender and an address rule out a PAN.
  const result = classifyDocument({ gender: 'MALE', address: '12 MG ROAD', father_name: null }, 'pan');
  assert.notEqual(result.type, 'pan');
});

test("an Aadhaar never carries a father's name, and that counts against it", () => {
  const result = classifyDocument({ father_name: 'RAHEEM KOTTAKANDI', document_number: 'MPWPK2241E' }, 'aadhaar');
  assert.equal(result.type, 'pan');
  assert.equal(result.corrected, true);
});

test('with no evidence at all the model\'s label stands rather than being invented over', () => {
  const result = classifyDocument({ holder_name: 'ASHA DEVI' }, 'passport');
  assert.equal(result.type, 'passport');
  assert.equal(result.corrected, false);
});

test('an unknown document stays unknown when nothing identifies it', () => {
  const result = classifyDocument({ holder_name: 'ASHA DEVI' }, 'unknown');
  assert.equal(result.type, 'unknown');
});

test('a birth certificate number does not masquerade as another type', () => {
  const result = classifyDocument(
    { document_number: 'BLR/1997/44821', mother_name: 'FATHIMA BEEVI', father_name: 'ABDUL RAHMAN K' },
    'birth_certificate'
  );
  assert.equal(result.type, 'birth_certificate');
});

test('every correction explains itself', () => {
  const result = classifyDocument(REAL_AADHAAR_READ, 'pan');
  assert.ok(result.evidence.length > 1);
  assert.ok(result.evidence.some(item => item.signal === 'document_number_format'));
  assert.ok(result.evidence.some(item => item.signal === 'document_number_contradiction'));
  assert.ok(result.evidence.some(item => item.signal === 'gender_present'));
  assert.ok(result.reason.length > 20);
});

// --- the second bug these same two cards exposed ---------------------------

test('a name run together by the reader is not a different person', () => {
  // The PAN was read as "MUHAMMEDSAKIR K" — the space was lost in the scan.
  const result = compareNames('MUHAMMEDSAKIR K', 'Muhammad Sakir K');
  assert.equal(result.verdict, VERDICTS.NEEDS_CONFIRMATION);
  assert.notEqual(result.verdict, VERDICTS.DIFFERENT, 'never a hard rejection');
});

test('lost spacing alone is treated as the same name', () => {
  const result = compareNames('MUHAMMED SAKIR K', 'MUHAMMEDSAKIR K');
  assert.equal(result.verdict, VERDICTS.SAFE_VARIANT);
  assert.ok(result.signals.includes('spacing_only'));
});

test('the spacing diff shows the real difference, not phantom word changes', () => {
  const diff = renderNameDiff('MUHAMMEDSAKIR K', 'Muhammad Sakir K');
  assert.equal(diff, 'MUHAMM[E→A]DSAKIRK');
  assert.ok(!diff.includes('[MUHAMMEDSAKIR→]'), 'no phantom whole-word deletion');
});

test('spacing tolerance does not make two different people match', () => {
  assert.equal(compareNames('RAJESH KUMAR', 'ASHA DEVI').verdict, VERDICTS.DIFFERENT);
  assert.equal(compareNames('ANIL SHARMA', 'SUNITA PATEL').verdict, VERDICTS.DIFFERENT);
});

// --- the two real cards, end to end ----------------------------------------

test('the two real cards compare as one person once both bugs are fixed', () => {
  const aadhaarType = classifyDocument(REAL_AADHAAR_READ, 'pan').type;
  const panType = classifyDocument(REAL_PAN_READ, 'pan').type;

  const verdict = compareDocuments([
    { id: 'p', type: panType, pageRole: 'front', status: 'ready', source: 'vision', fields: REAL_PAN_READ },
    { id: 'a', type: aadhaarType, pageRole: 'front', status: 'ready', source: 'vision', fields: REAL_AADHAAR_READ }
  ]);

  // MUHAMMED vs MUHAMMAD is a genuine one-letter difference between the two
  // printed cards, so it asks for confirmation rather than rejecting outright.
  assert.equal(verdict.status, 'needs_confirmation');
  assert.deepEqual(verdict.blocking, [], 'nothing blocks issuance');

  const name = verdict.fields.find(field => field.label === 'holder_name');
  assert.equal(name.dissenting.length, 1);
  assert.equal(name.dissenting[0].needsConfirmation, true);

  // The date of birth matches exactly across both cards.
  const dob = verdict.fields.find(field => field.label === 'dob');
  assert.equal(dob.value, '2003-05-19');
  assert.deepEqual(dob.dissenting, []);

  // The PAN's absent gender must not count against the Aadhaar's.
  const gender = verdict.fields.find(field => field.label === 'gender');
  assert.deepEqual(gender.agreeing, ['aadhaar']);
  assert.deepEqual(gender.dissenting, []);
});
