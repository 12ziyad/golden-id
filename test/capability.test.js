'use strict';

// The second test that was missing.
//
// The live database contained a passport extraction carrying a father_name, a
// mother_name AND an address. A passport bio page prints none of those. Worse,
// the comparison matrix listed the passport as a legitimate voter on parent
// names, so a hallucinated value could become the consensus value on an issued
// credential. Nothing in the suite forbade it.

const os = require('os');
const path = require('path');
const fs = require('fs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-capability-'));
process.env.NODE_ENV = 'test';
process.env.UPLOAD_DIR = path.join(scratch, 'uploads');
process.env.GOLDEN_ID_KEY_PATH = path.join(scratch, 'key.pem');
process.env.CF_ACCOUNT_ID = '';
process.env.CF_API_TOKEN = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../lib/schemas/registry');
const { validateExtraction, parseAndValidate, plainValues, SchemaError } = require('../lib/extract/schema');
const { extractionPrompt } = require('../lib/extract/prompts');
const matrix = require('../lib/compare/matrix');
const { compareDocuments } = require('../lib/compare');
const { buildConsensus } = require('../lib/record/consensus');
const { harness, fixture, seed } = require('./helpers/harness');

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

// --- the registry -----------------------------------------------------------

test('a passport bio page cannot carry parents, spouse or a residential address', () => {
  for (const field of ['father_name', 'mother_name', 'spouse_name', 'address']) {
    assert.equal(registry.isImpossible('passport', field, 'front'), true, `${field} must be impossible on a passport bio page`);
    assert.equal(registry.canCarry('passport', field, 'front'), false);
  }
  // The BACK page does carry them.
  assert.equal(registry.canCarry('passport', 'father_name', 'back'), true);
  assert.equal(registry.canCarry('passport', 'address', 'back'), true);
});

test('a PAN card cannot carry a gender or an address', () => {
  assert.equal(registry.isImpossible('pan', 'gender', 'front'), true);
  assert.equal(registry.isImpossible('pan', 'address', 'front'), true);
  assert.equal(registry.canCarry('pan', 'father_name', 'front'), true);
});

test("an Aadhaar carries a father's name only with an explicit relationship marker", () => {
  assert.equal(registry.isImpossible('aadhaar', 'mother_name', 'front'), true);
  // Conditionally allowed, not freely allowed.
  assert.ok(registry.conditionalRule('aadhaar', 'father_name', 'front'));
  assert.equal(registry.canCarry('aadhaar', 'gender', 'front'), true);
});

// --- schema enforcement -----------------------------------------------------

test('a passport emitting a father name has it REJECTED, not stored', () => {
  const result = validateExtraction({
    document_type: 'passport',
    holder_name: 'MUHAMMED MISHAB SULAIMAN',
    father_name: 'MUHAMMED MISHAB SULAIMAN',   // the holder's own name, mis-mapped
    mother_name: 'MUHAMMED MISHAB SULAIMAN',
    address: 'PARATHODI',                       // actually a place of birth
    dob: '02/02/1998',
    document_number: 'M7654321'
  }, { docType: 'passport', pageRole: 'front', trustValues: true });

  assert.equal(result.fields.father_name.status, 'invalid');
  assert.equal(result.fields.mother_name.status, 'invalid');
  assert.equal(result.fields.address.status, 'invalid');
  assert.equal(result.fields.father_name.normalized_value, null);

  // The raw value is retained so the hallucination is auditable, not vanished.
  assert.equal(result.fields.father_name.raw_value, 'MUHAMMED MISHAB SULAIMAN');
  assert.equal(result.rejected.length, 3);
  assert.ok(result.rejected.every(item => item.reason === 'field_impossible_for_document'));

  // Legitimate fields are untouched.
  assert.equal(result.fields.holder_name.status, 'present_verified');
  assert.equal(result.fields.holder_name.normalized_value, 'MUHAMMED MISHAB SULAIMAN');
});

test('a PAN emitting a gender or address has them rejected', () => {
  const result = validateExtraction({
    document_type: 'pan', holder_name: 'ASHA DEVI', gender: 'Female',
    address: '12 MG ROAD', document_number: 'BQIPS8241E'
  }, { docType: 'pan', pageRole: 'front', trustValues: true });

  assert.equal(result.fields.gender.status, 'invalid');
  assert.equal(result.fields.address.status, 'invalid');
  assert.equal(result.fields.holder_name.status, 'present_verified');
});

test('an unsupported field never reaches the comparison layer', () => {
  const result = validateExtraction({
    document_type: 'passport', holder_name: 'A PERSON', father_name: 'SOMEONE ELSE', dob: '01/01/1990'
  }, { docType: 'passport', pageRole: 'front', trustValues: true });

  const values = plainValues(result.fields);
  assert.equal(values.father_name, null, 'an invalid field collapses to null for comparison');
  assert.equal(values.holder_name, 'A PERSON');
});

test('an Aadhaar father name is rejected without a visible S/O marker, kept with one', () => {
  const without = validateExtraction(
    { document_type: 'aadhaar', holder_name: 'ASHA DEVI', father_name: 'RAM KUMAR', document_number: '234123412346' },
    { docType: 'aadhaar', pageRole: 'front', trustValues: true, pageText: 'GOVERNMENT OF INDIA ASHA DEVI DOB 01/01/1990' }
  );
  assert.equal(without.fields.father_name.status, 'invalid');

  const withMarker = validateExtraction(
    { document_type: 'aadhaar', holder_name: 'ASHA DEVI', father_name: 'RAM KUMAR', document_number: '234123412346' },
    { docType: 'aadhaar', pageRole: 'front', trustValues: true, pageText: 'ASHA DEVI S/O RAM KUMAR, 12 MG ROAD' }
  );
  assert.equal(withMarker.fields.father_name.status, 'present_verified');
});

// --- prompts ----------------------------------------------------------------

test('the passport prompt never asks for parents or an address', () => {
  const prompt = extractionPrompt('passport', 'front');
  assert.ok(!/"father_name"/.test(prompt), 'the model is not even offered a father_name slot');
  assert.ok(!/"mother_name"/.test(prompt));
  assert.ok(!/"address"/.test(prompt));
  assert.match(prompt, /place_of_birth/);
  assert.match(prompt, /does NOT print/i);
  assert.match(prompt, /place of birth is NOT an address/i);
});

test('the PAN prompt asks for a father name but not a gender or address', () => {
  const prompt = extractionPrompt('pan', 'front');
  assert.match(prompt, /"father_name"/);
  assert.ok(!/"gender"/.test(prompt));
  assert.ok(!/"address"/.test(prompt));
});

// --- the comparison matrix --------------------------------------------------

test('a passport abstains from the guardian and address comparisons', () => {
  assert.equal(matrix.participates('passport', 'father_name', 'front'), false);
  assert.equal(matrix.participates('passport', 'mother_name', 'front'), false);
  assert.equal(matrix.participates('passport', 'guardian_name', 'front'), false);
  assert.equal(matrix.participates('pan', 'gender', 'front'), false);
  assert.equal(matrix.participates('pan', 'address', 'front'), false);

  // But it does vote on the fields it genuinely carries.
  assert.equal(matrix.participates('passport', 'holder_name', 'front'), true);
  assert.equal(matrix.participates('passport', 'dob', 'front'), true);
});

test('a hallucinated passport parent name cannot become the consensus value', () => {
  // Even if a value somehow got past the schema, the matrix makes the passport
  // abstain, so it never votes on a parent name.
  const verdict = compareDocuments([
    { id: 'd1', type: 'pan', pageRole: 'front', fields: { holder_name: 'ASHA DEVI', dob: '01/01/1990', father_name: 'RAM KUMAR' }, source: 'vision', status: 'ready' },
    { id: 'd2', type: 'passport', pageRole: 'front', fields: { holder_name: 'ASHA DEVI', dob: '01/01/1990', gender: 'F', father_name: 'ASHA DEVI' }, source: 'vision', status: 'ready' }
  ]);

  const guardian = verdict.fields.find(field => field.label === 'guardian_name');
  assert.equal(guardian.value, 'RAM KUMAR');
  assert.deepEqual(guardian.agreeing, ['pan']);
  assert.deepEqual(guardian.dissenting, [], 'the passport abstained rather than dissenting');
  assert.ok(guardian.abstained.some(item => item.type === 'passport'));

  const consensus = buildConsensus(verdict, { documents: [] });
  assert.equal(consensus.fields.guardian_name.value, 'RAM KUMAR');
  assert.ok(!consensus.fields.guardian_name.sources.includes('passport'));
});

test("a passport's place of birth is never compared against an address", () => {
  assert.ok(matrix.NEVER_COMPARED.has('place_of_birth'));
  assert.ok(!matrix.COMPARABLE_FIELDS.includes('place_of_birth'));

  const verdict = compareDocuments([
    { id: 'd1', type: 'aadhaar', pageRole: 'front', fields: { holder_name: 'ASHA DEVI', dob: '01/01/1990', gender: 'F', address: '12 MG ROAD BENGALURU' }, source: 'vision', status: 'ready' },
    { id: 'd2', type: 'passport', pageRole: 'front', fields: { holder_name: 'ASHA DEVI', dob: '01/01/1990', gender: 'F', place_of_birth: 'PARATHODI' }, source: 'vision', status: 'ready' }
  ]);

  const address = verdict.fields.find(field => field.label === 'address');
  assert.deepEqual(address.agreeing, ['aadhaar']);
  assert.deepEqual(address.dissenting, []);
  assert.deepEqual(verdict.blocking, []);
});

// --- end to end through the real pipeline -----------------------------------

test('a hallucinating passport is sanitised end to end and never blocks', async () => {
  const { store, workflow, cleanup } = harness();

  // A model that mis-maps the holder's name into both parent slots and puts a
  // place of birth into the address — exactly what was observed live.
  const files = await Promise.all([
    fixture('passport.jpg', {
      document_type: 'passport',
      holder_name: 'MUHAMMED MISHAB SULAIMAN',
      father_name: 'MUHAMMED MISHAB SULAIMAN',
      mother_name: 'MUHAMMED MISHAB SULAIMAN',
      address: 'PARATHODI',
      dob: '02/02/1998', gender: 'M', document_number: 'M7654321'
    }),
    fixture('voter.jpg', {
      document_type: 'voter',
      holder_name: 'MUHAMMED MISHAB SULAIMAN',
      dob: '02/02/1998', gender: 'M', document_number: 'XYZ7654321'
    })
  ]);

  const { application, user } = await seed(workflow, store, 'mishab@example.com', files);
  const documents = store.listDocuments(application.id);
  const passport = documents.find(document => document.type === 'passport');

  assert.ok(passport, 'the passport was recognised');
  assert.equal(passport.rawFields.father_name.status, 'invalid');
  assert.equal(passport.rawFields.mother_name.status, 'invalid');
  assert.equal(passport.rawFields.address.status, 'invalid');
  assert.equal(passport.fields.father_name, null);
  assert.equal(passport.fields.address, null);

  const comparison = await workflow.compare({ applicationId: application.id, userId: user.id });
  const serialised = JSON.stringify(comparison.verdict);
  assert.ok(!serialised.includes('PARATHODI'), 'the fabricated address never reaches the verdict');

  const guardian = comparison.verdict.fields.find(field => field.label === 'guardian_name');
  if (guardian) assert.ok(!guardian.agreeing.includes('passport'));
  cleanup();
});
