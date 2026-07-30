'use strict';

// Presence versus capability.
//
// A Voter ID *may* print a date of birth. The card actually uploaded printed
// none — but because the type was allowed to carry one, a model-invented
// "2010-01-15" was accepted and then treated as contradicting the Aadhaar. The
// card was blamed for a disagreement it never took part in.
//
// The rule these tests hold the system to: compare what documents actually
// contain, and never treat what a document does not contain as a mismatch.

const os = require('os');
const path = require('path');
const fs = require('fs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-presence-'));
process.env.NODE_ENV = 'test';
process.env.UPLOAD_DIR = path.join(scratch, 'uploads');
process.env.GOLDEN_ID_KEY_PATH = path.join(scratch, 'key.pem');
process.env.CF_ACCOUNT_ID = '';
process.env.CF_API_TOKEN = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const { compareDocuments } = require('../lib/compare');
const { DECISIONS } = require('../lib/compare/decision');
const { validateExtraction, plainValues, fieldStates, STATUS } = require('../lib/extract/schema');
const { assessField } = require('../lib/extract/evidence');
const { createStore } = require('../lib/db');

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** A document whose fields carry explicit presence states. */
const doc = (type, fields, states = {}, extra = {}) => ({
  id: `doc-${type}-${Math.random().toString(36).slice(2, 7)}`,
  type, pageRole: 'front', fields,
  fieldStates: Object.fromEntries(Object.entries(states).map(([field, status]) =>
    [field, typeof status === 'string' ? { status, verified: status === STATUS.PRESENT_VERIFIED } : status])),
  source: 'vision', status: 'ready', ...extra
});

const verified = fields => Object.fromEntries(Object.keys(fields).map(field => [field, STATUS.PRESENT_VERIFIED]));

// --- 1 ----------------------------------------------------------------------

test('1. a Voter ID with no printed DOB does not mismatch an Aadhaar that has one', () => {
  const voterFields = { holder_name: 'MUHAMMED MISHAB SULAIMAN P', gender: 'M', father_name: 'SULAIMAN P' };
  const aadhaarFields = { holder_name: 'Muhammed Mishab Sulaiman P', dob: '07/05/2002', gender: 'Male' };

  const verdict = compareDocuments([
    doc('voter', { ...voterFields, dob: null }, { ...verified(voterFields), dob: STATUS.NOT_PRESENT }),
    doc('aadhaar', aadhaarFields, verified(aadhaarFields))
  ]);

  const dob = verdict.fields.find(field => field.label === 'dob');
  assert.equal(dob.value, '2002-05-07');
  assert.deepEqual(dob.agreeing, ['aadhaar'], 'only the Aadhaar supplied it');
  assert.deepEqual(dob.dissenting, [], 'the Voter ID cannot dissent about a field it never showed');
  assert.equal(dob.status, 'single_source');
  assert.ok(dob.abstained.some(item => item.type === 'voter'));

  assert.equal(verdict.issuable, true);
  assert.deepEqual(verdict.blocking, []);
  assert.notEqual(verdict.decision, DECISIONS.DOCUMENT_CONFLICT);
});

// --- 2 ----------------------------------------------------------------------

test('2. a Voter ID that DOES print the same DOB agrees with the Aadhaar', () => {
  const fields = { holder_name: 'MUHAMMED MISHAB SULAIMAN P', dob: '07/05/2002', gender: 'M' };
  const verdict = compareDocuments([
    doc('voter', fields, verified(fields)),
    doc('aadhaar', { ...fields, holder_name: 'Muhammed Mishab Sulaiman P' }, verified(fields))
  ]);

  const dob = verdict.fields.find(field => field.label === 'dob');
  assert.deepEqual(dob.agreeing.sort(), ['aadhaar', 'voter']);
  assert.equal(dob.status, 'agreement');
  assert.equal(verdict.decision, DECISIONS.VERIFIED_MATCH);
});

// --- 3 ----------------------------------------------------------------------

test('3. a Voter ID printing a DIFFERENT DOB is a real mismatch', () => {
  const voterFields = { holder_name: 'MUHAMMED MISHAB SULAIMAN P', dob: '15/01/2010', gender: 'M' };
  const aadhaarFields = { holder_name: 'Muhammed Mishab Sulaiman P', dob: '07/05/2002', gender: 'Male' };

  const verdict = compareDocuments([
    doc('voter', voterFields, verified(voterFields)),
    doc('aadhaar', aadhaarFields, verified(aadhaarFields))
  ]);

  const dob = verdict.fields.find(field => field.label === 'dob');
  assert.equal(dob.dissenting.length, 1, 'two documents genuinely showed different dates');
  assert.equal(dob.severity, 'reject');
  assert.equal(verdict.issuable, false);
  assert.ok([DECISIONS.DOCUMENT_CONFLICT, DECISIONS.SUSPECTED_CROSS_IDENTITY].includes(verdict.decision));
});

// --- 4 ----------------------------------------------------------------------

test('4. a hallucinated DOB with no evidence is discarded before comparison', () => {
  // The model returns a date but offers no printed text supporting it, and the
  // independent page text has no date-of-birth label anywhere.
  const pageText = 'ELECTION COMMISSION OF INDIA\nELECTOR PHOTO IDENTITY CARD\nZKV2498574\n'
    + "Elector's Name: MUHAMMED MISHAB SULAIMAN P\nFather's Name: SULAIMAN P\nSex: M";

  const result = validateExtraction({
    document_type: 'voter',
    holder_name: 'MUHAMMED MISHAB SULAIMAN P',
    father_name: 'SULAIMAN P',
    gender: 'M',
    dob: '2010-01-15',
    document_number: 'ZKV2498574',
    evidence: {
      holder_name: "Elector's Name: MUHAMMED MISHAB SULAIMAN P",
      father_name: "Father's Name: SULAIMAN P",
      gender: 'Sex: M'
      // no dob evidence — the model could not point at one, because there is none
    }
  }, { docType: 'voter', pageRole: 'front', pageText });

  assert.equal(result.fields.dob.status, STATUS.NOT_PRESENT);
  assert.equal(result.fields.dob.normalized_value, null, 'the invented value never becomes comparable');
  assert.equal(result.fields.dob.raw_value, '2010-01-15', 'but it is retained, so the hallucination is auditable');
  assert.equal(plainValues(result.fields).dob, null);

  // The fields it COULD evidence are unaffected.
  assert.equal(result.fields.holder_name.status, STATUS.PRESENT_VERIFIED);
  assert.equal(result.fields.father_name.status, STATUS.PRESENT_VERIFIED);
});

test('4b. a value whose evidence exists and is corroborated IS accepted', () => {
  const pageText = 'GOVERNMENT OF INDIA\nMuhammed Mishab Sulaiman P\nDOB: 07/05/2002\nMale\n9580 6990 9200';
  const result = validateExtraction({
    document_type: 'aadhaar',
    holder_name: 'Muhammed Mishab Sulaiman P',
    dob: '07/05/2002',
    gender: 'Male',
    document_number: '9580 6990 9200',
    evidence: { holder_name: 'Muhammed Mishab Sulaiman P', dob: 'DOB: 07/05/2002', gender: 'Male' }
  }, { docType: 'aadhaar', pageRole: 'front', pageText });

  assert.equal(result.fields.dob.status, STATUS.PRESENT_VERIFIED);
  assert.equal(result.fields.dob.normalized_value, '07/05/2002');
  assert.match(result.fields.dob.evidence_text, /DOB/);
});

test('4c. a date on the page under the WRONG label is not a date of birth', () => {
  // The card prints an issue date. It is not a DOB and must not become one.
  const pageText = 'ELECTION COMMISSION OF INDIA\nZKV2498574\nDate of Issue: 15/01/2010\nSex: M';
  const result = validateExtraction({
    document_type: 'voter',
    holder_name: 'SOMEONE',
    dob: '15/01/2010',
    evidence: { dob: 'Date of Issue: 15/01/2010' }
  }, { docType: 'voter', pageRole: 'front', pageText });

  assert.notEqual(result.fields.dob.status, STATUS.PRESENT_VERIFIED);
  assert.equal(plainValues(result.fields).dob, null);
});

// --- 5 ----------------------------------------------------------------------

test('5. a field only one document supplies is single-source, not agreement', () => {
  const voterFields = { holder_name: 'MUHAMMED MISHAB SULAIMAN P', gender: 'M', father_name: 'SULAIMAN P' };
  const aadhaarFields = { holder_name: 'MUHAMMED MISHAB SULAIMAN P', dob: '07/05/2002', gender: 'M' };

  const verdict = compareDocuments([
    doc('voter', voterFields, verified(voterFields)),
    doc('aadhaar', aadhaarFields, verified(aadhaarFields))
  ]);

  const dob = verdict.fields.find(field => field.label === 'dob');
  assert.equal(dob.status, 'single_source');
  assert.equal(dob.corroboration, 1);

  const guardian = verdict.fields.find(field => field.label === 'guardian_name');
  assert.equal(guardian.status, 'single_source');
  assert.deepEqual(guardian.agreeing, ['voter']);

  // The name, which BOTH documents show, is genuine agreement.
  const name = verdict.fields.find(field => field.label === 'holder_name');
  assert.equal(name.status, 'agreement');
  assert.equal(name.corroboration, 2);

  assert.ok(verdict.singleSourced.includes('dob'));
  assert.ok(verdict.multiSourced.includes('holder_name'));
});

// --- 6 ----------------------------------------------------------------------

test('6. a missing field creates neither a confirmation nor a rejection', () => {
  const fields = { holder_name: 'ASHA DEVI', dob: '01/01/1990' };
  const verdict = compareDocuments([
    doc('pan', fields, verified(fields)),
    doc('passport', { ...fields, gender: null }, { ...verified(fields), gender: STATUS.NOT_PRESENT })
  ]);

  assert.deepEqual(verdict.blocking, []);
  assert.deepEqual(verdict.confirmations, []);
  assert.equal(verdict.issuable, true);
});

// --- 7 ----------------------------------------------------------------------

test('7. five documents compare only on their pairwise intersections', () => {
  const name = 'MUHAMMED SAKIR K';
  const verdict = compareDocuments([
    doc('pan', { holder_name: name, dob: '12/08/1997', father_name: 'ABDUL RAHMAN K' },
      verified({ holder_name: 1, dob: 1, father_name: 1 })),
    doc('aadhaar', { holder_name: name, dob: '12/08/1997', gender: 'M' },
      verified({ holder_name: 1, dob: 1, gender: 1 })),
    doc('passport', { holder_name: name, dob: '12/08/1997', gender: 'M' },
      verified({ holder_name: 1, dob: 1, gender: 1 })),
    doc('voter', { holder_name: name, gender: 'M', father_name: 'ABDUL RAHMAN K' },
      verified({ holder_name: 1, gender: 1, father_name: 1 })),
    doc('birth_certificate', { holder_name: name, dob: '12/08/1997', gender: 'Male', father_name: 'ABDUL RAHMAN K', mother_name: 'FATHIMA BEEVI' },
      verified({ holder_name: 1, dob: 1, gender: 1, father_name: 1, mother_name: 1 }))
  ]);

  const dob = verdict.fields.find(field => field.label === 'dob');
  assert.deepEqual(dob.agreeing.sort(), ['aadhaar', 'birth_certificate', 'pan', 'passport']);
  assert.ok(dob.abstained.some(item => item.type === 'voter'), 'the Voter ID abstains, it does not dissent');
  assert.deepEqual(dob.dissenting, []);

  const gender = verdict.fields.find(field => field.label === 'gender');
  assert.ok(!gender.agreeing.includes('pan'), 'a PAN prints no gender');
  assert.ok(gender.abstained.some(item => item.type === 'pan'));

  const mother = verdict.fields.find(field => field.label === 'mother_name');
  assert.deepEqual(mother.agreeing, ['birth_certificate']);

  assert.equal(verdict.issuable, true);
  assert.deepEqual(verdict.blocking, []);
});

// --- 8 ----------------------------------------------------------------------

test('8. no document is required to carry every identity field', () => {
  // A PAN and a passport: no shared gender, no shared address, no shared parent.
  const shared = { holder_name: 'ASHA DEVI', dob: '01/01/1990' };
  const verdict = compareDocuments([
    doc('pan', { ...shared, father_name: 'RAM KUMAR' }, verified({ ...shared, father_name: 1 })),
    doc('passport', { ...shared, gender: 'F' }, verified({ ...shared, gender: 1 }))
  ]);

  assert.equal(verdict.issuable, true);
  assert.ok([
    DECISIONS.VERIFIED_MATCH,
    DECISIONS.VERIFIED_NO_CONFLICT,
    DECISIONS.VERIFIED_WITH_PARTIAL_OVERLAP
  ].includes(verdict.decision), `unexpected decision: ${verdict.decision}`);
  assert.deepEqual(verdict.blocking, []);
});

// --- 9 ----------------------------------------------------------------------

test('9. raw extraction stays null for a field the document does not print', () => {
  const result = validateExtraction({
    document_type: 'voter', holder_name: 'SOMEONE', document_number: 'ABC1234567',
    evidence: { holder_name: "Elector's Name: SOMEONE" }
  }, { docType: 'voter', pageRole: 'front', pageText: "Elector's Name: SOMEONE\nABC1234567" });

  assert.equal(result.fields.dob.raw_value, null);
  assert.equal(result.fields.dob.normalized_value, null);
  assert.equal(result.fields.dob.status, STATUS.NOT_PRESENT);

  const states = fieldStates(result.fields);
  assert.equal(states.dob.status, STATUS.NOT_PRESENT);
  assert.equal(states.dob.verified, false);
});

// --- 10 ---------------------------------------------------------------------

test('10. a correction supplies a value but cannot claim the document printed it', () => {
  const store = createStore(':memory:');
  const user = store.upsertUser('holder@example.com');
  const application = store.createApplication(user.id);
  const batchId = store.createBatch(application.id);

  const extraction = {
    contentHash: 'hash-1', extractor: '3.0.0', promptVersion: '3.0.0', schemaVersion: '3.0.0',
    modelIds: ['m'], type: 'voter', source: 'vision',
    rawFields: {
      holder_name: { raw_value: 'SOMEONE', normalized_value: 'SOMEONE', status: STATUS.PRESENT_VERIFIED, verified: true, evidence_text: "Name: SOMEONE" },
      dob: { raw_value: null, normalized_value: null, status: STATUS.NOT_PRESENT, verified: false, evidence_text: null }
    },
    fieldStates: {
      holder_name: { status: STATUS.PRESENT_VERIFIED, verified: true, rawValue: 'SOMEONE' },
      dob: { status: STATUS.NOT_PRESENT, verified: false, rawValue: null }
    }
  };
  const key = store.extractionKey(extraction);
  store.saveExtraction({ ...extraction, extractionKey: key });

  const documentId = store.createDocument({
    applicationId: application.id, uploadBatchId: batchId,
    contentHash: 'hash-1', extractionKey: key, docType: 'voter', status: 'ready'
  });

  const updated = store.setCorrection(documentId, application.id, 'dob', '07/05/2002', 'holder');

  // The value is usable...
  assert.equal(updated.fields.dob, '07/05/2002');
  assert.equal(updated.fieldStates.dob.source, 'user');
  // ...but the record is explicit that the DOCUMENT did not show it.
  assert.equal(updated.fieldStates.dob.reason, 'user_supplied_value_not_printed_on_document');
  assert.equal(updated.fieldStates.dob.documentStatus, STATUS.NOT_PRESENT);
  assert.equal(updated.fieldStates.dob.documentValue, null);
  // And the immutable extraction is untouched.
  assert.equal(updated.rawFields.dob.raw_value, null);
  assert.equal(updated.rawFields.dob.status, STATUS.NOT_PRESENT);

  // Correcting a field the document DID print is recorded differently.
  const corrected = store.setCorrection(documentId, application.id, 'holder_name', 'SOMEONE ELSE', 'holder');
  assert.equal(corrected.fieldStates.holder_name.reason, 'user_corrected_printed_value');
  assert.equal(corrected.fieldStates.holder_name.documentValue, 'SOMEONE');

  store.close();
});

// --- the evidence rule itself ------------------------------------------------

test('evidence: a value with no field label anywhere on the page is not present', () => {
  const result = assessField({
    field: 'dob', value: '2010-01-15', evidenceText: null,
    pageText: 'ELECTION COMMISSION OF INDIA\nZKV2498574\nSex: M', source: 'vision'
  });
  assert.equal(result.status, STATUS.NOT_PRESENT);
  assert.equal(result.reason, 'no_label_for_field_on_page');
});

test('evidence: garbage OCR cannot witness absence — the read value stays visible', () => {
  // A real phone photo of a guilloche-background PAN card produces OCR noise
  // in which no field label survives. That noise proved nothing, yet it was
  // turning correctly read DOBs into "not present" on real documents.
  const garbage = 'xj93 kf0a 02kd 0a9d jf93 kdle 03kd 9dk3 lsdk 300a qwer zxcv';
  const result = assessField({
    field: 'dob', value: '19/05/2003', evidenceText: '19/05/2003', pageText: garbage, source: 'vision'
  });
  assert.equal(result.status, STATUS.PRESENT_UNCERTAIN, 'kept visible and re-readable, not erased');
  assert.equal(result.reason, 'no_local_corroboration_available');

  // But OCR that demonstrably READ the page still witnesses absence — the
  // hallucinated-date guard is intact.
  const readable = 'ELECTION COMMISSION OF INDIA\nElector Name: SOMEONE\nFather Name: OTHER PERSON';
  const hallucinated = assessField({
    field: 'dob', value: '2010-01-15', evidenceText: null, pageText: readable, source: 'vision'
  });
  assert.equal(hallucinated.status, STATUS.NOT_PRESENT);
});

test('evidence: a checksummed machine-readable source needs no corroboration', () => {
  const fromQr = assessField({ field: 'dob', value: '07/05/2002', source: 'barcode' });
  assert.equal(fromQr.status, STATUS.PRESENT_VERIFIED);
  const fromMrz = assessField({ field: 'holder_name', value: 'ASHA DEVI', source: 'mrz' });
  assert.equal(fromMrz.status, STATUS.PRESENT_VERIFIED);
});

test('evidence: without page text, a matching evidence snippet is enough', () => {
  const result = assessField({
    field: 'dob', value: '07/05/2002', evidenceText: 'DOB: 07/05/2002', pageText: null, source: 'vision'
  });
  assert.equal(result.status, STATUS.PRESENT_VERIFIED);
});

test('evidence: a snippet that does not contain the value does not support it', () => {
  const result = assessField({
    field: 'dob', value: '07/05/2002', evidenceText: 'Date of Birth', pageText: null, source: 'vision'
  });
  assert.notEqual(result.status, STATUS.PRESENT_VERIFIED);
});

test('evidence: dates match across formats', () => {
  const result = assessField({
    field: 'dob', value: '2002-05-07', evidenceText: 'DOB: 07/05/2002', pageText: 'DOB: 07/05/2002', source: 'vision'
  });
  assert.equal(result.status, STATUS.PRESENT_VERIFIED);
});
