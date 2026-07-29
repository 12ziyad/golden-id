'use strict';

// THE test that was missing.
//
// The live system let one applicant's PAN and Aadhaar appear inside another
// applicant's comparison, contributing to name agreement, DOB agreement,
// guardian comparison, face comparison and consensus. The whole suite passed
// throughout, because nothing asserted that two applications cannot see each
// other's data. The acceptable result here is ZERO leakage — not "few", zero.

const os = require('os');
const path = require('path');
const fs = require('fs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-isolation-'));
process.env.NODE_ENV = 'test';
process.env.UPLOAD_DIR = path.join(scratch, 'uploads');
process.env.GOLDEN_ID_KEY_PATH = path.join(scratch, 'key.pem');
process.env.CF_ACCOUNT_ID = '';
process.env.CF_API_TOKEN = '';
process.env.FACE_MATCH_ENABLED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');

const { harness, fixture, seed } = require('./helpers/harness');
const { DECISIONS } = require('../lib/compare/decision');

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

// Two distinct people, each with their own documents.
const SAKIR = {
  pan: { document_type: 'pan', holder_name: 'MUHAMMED SAKIR K', father_name: 'RAHEEM KOTTAKANDI', dob: '19/05/2003', document_number: 'MPWPK2241E' },
  aadhaar: { document_type: 'aadhaar', holder_name: 'MUHAMMED SAKIR K', dob: '19/05/2003', gender: 'Male', document_number: '3204 3976 7873', address: '12 MG ROAD, BENGALURU 560001' }
};
const MISHAB = {
  passport: { document_type: 'passport', holder_name: 'MUHAMMED MISHAB SULAIMAN', dob: '02/02/1998', gender: 'M', document_number: 'M7654321' },
  voter: { document_type: 'voter', holder_name: 'MUHAMMED MISHAB SULAIMAN', dob: '02/02/1998', gender: 'M', document_number: 'XYZ7654321' }
};

const sakirFiles = () => Promise.all([
  fixture('sakir-pan.jpg', SAKIR.pan),
  fixture('sakir-aadhaar.jpg', SAKIR.aadhaar)
]);
const mishabFiles = () => Promise.all([
  fixture('mishab-passport.jpg', MISHAB.passport),
  fixture('mishab-voter.jpg', MISHAB.voter)
]);

test("two users on one server never see each other's documents", async () => {
  const { store, workflow, cleanup } = harness();
  const a = await seed(workflow, store, 'sakir@example.com', await sakirFiles());
  const b = await seed(workflow, store, 'mishab@example.com', await mishabFiles());

  const docsA = store.listDocuments(a.application.id);
  const docsB = store.listDocuments(b.application.id);
  assert.equal(docsA.length, 2);
  assert.equal(docsB.length, 2);

  const idsA = new Set(docsA.map(document => document.id));
  for (const document of docsB) assert.ok(!idsA.has(document.id), 'document leaked between applications');

  const comparison = await workflow.compare({
    applicationId: b.application.id, userId: b.user.id, documentIds: docsB.map(document => document.id)
  });
  const serialised = JSON.stringify(comparison);

  assert.ok(!serialised.includes('SAKIR'), "Sakir's name leaked into Mishab's comparison");
  assert.ok(!serialised.includes('MPWPK2241E'), "Sakir's PAN number leaked");
  assert.ok(!serialised.includes('RAHEEM'), "Sakir's father's name leaked");
  assert.equal(comparison.documents.length, 2);

  const name = comparison.verdict.fields.find(field => field.label === 'holder_name');
  assert.ok(name.agreeing.every(type => ['passport', 'voter'].includes(type)));
  cleanup();
});

// The exact reported reproduction: one operator, no logout, second applicant.
test('the reported reproduction: a second application never inherits the first', async () => {
  const { store, workflow, cleanup } = harness();
  const user = store.upsertUser('operator@example.com');

  const first = workflow.startApplication(user.id);
  await workflow.ingest({ applicationId: first.id, userId: user.id, files: await sakirFiles() });
  await workflow.compare({
    applicationId: first.id, userId: user.id,
    documentIds: store.listDocuments(first.id).map(document => document.id)
  });

  // Same signed-in user, brand new application.
  const second = workflow.startApplication(user.id);
  await workflow.ingest({ applicationId: second.id, userId: user.id, files: await mishabFiles() });
  const comparison = await workflow.compare({
    applicationId: second.id, userId: user.id,
    documentIds: store.listDocuments(second.id).map(document => document.id)
  });

  assert.equal(comparison.documents.length, 2);
  const serialised = JSON.stringify(comparison.verdict);
  assert.ok(!serialised.includes('SAKIR'));
  assert.ok(!serialised.includes('2003-05-19'), "Sakir's DOB leaked");
  cleanup();
});

test('a document id from another application is refused and blocks issuance', async () => {
  const { store, workflow, cleanup } = harness();
  const a = await seed(workflow, store, 'sakir@example.com', await sakirFiles());
  const b = await seed(workflow, store, 'mishab@example.com', await mishabFiles());

  const foreignId = store.listDocuments(a.application.id)[0].id;
  const ownIds = store.listDocuments(b.application.id).map(document => document.id);

  const comparison = await workflow.compare({
    applicationId: b.application.id, userId: b.user.id, documentIds: [...ownIds, foreignId]
  });

  assert.equal(comparison.integrity.ok, false, 'the foreign reference must be caught');
  assert.equal(comparison.decision, DECISIONS.BLOCKED_SECURITY_INTEGRITY);
  assert.equal(comparison.verdict.issuable, false);
  assert.ok(!JSON.stringify(comparison.verdict).includes('SAKIR'));

  const audit = store.auditForApplication(b.application.id).map(row => row.action);
  assert.ok(audit.includes('integrity_block'), 'the refusal is recorded, not silently dropped');
  cleanup();
});

test("one user cannot read another user's application at all", async () => {
  const { store, workflow, cleanup } = harness();
  const a = await seed(workflow, store, 'sakir@example.com', await sakirFiles());
  const intruder = store.upsertUser('mishab@example.com');

  assert.equal(store.getApplication(a.application.id, intruder.id), null);
  assert.equal(workflow.ownedApplication(a.application.id, intruder.id), null);

  const comparison = await workflow.compare({ applicationId: a.application.id, userId: intruder.id });
  assert.equal(comparison.error, 'application_not_found');
  cleanup();
});

test('a document is unreachable by id without its owning application', async () => {
  const { store, workflow, cleanup } = harness();
  const a = await seed(workflow, store, 'a@example.com', [await fixture('pan.jpg', SAKIR.pan)]);
  const other = store.upsertUser('b@example.com');
  const otherApp = workflow.startApplication(other.id);
  const documentId = store.listDocuments(a.application.id)[0].id;

  assert.ok(store.getDocument(documentId, a.application.id));
  assert.equal(store.getDocument(documentId, otherApp.id), null);

  const resolved = store.resolveOwnedDocuments([documentId], otherApp.id);
  assert.deepEqual(resolved.owned, []);
  assert.deepEqual(resolved.rejected, [documentId]);
  cleanup();
});

test('corrections and faces are scoped to the owning application', async () => {
  const { store, workflow, cleanup } = harness();
  const a = await seed(workflow, store, 'a@example.com', [await fixture('pan.jpg', SAKIR.pan)]);
  const other = store.upsertUser('b@example.com');
  const otherApp = workflow.startApplication(other.id);
  const documentId = store.listDocuments(a.application.id)[0].id;

  // Written through the wrong application, both are refused outright.
  assert.equal(store.setCorrection(documentId, otherApp.id, 'holder_name', 'HACKED'), null);
  assert.equal(store.setFace(documentId, otherApp.id, { embedding: [1, 2, 3] }), false);

  // The owner's correction applies without mutating the raw extraction.
  const updated = store.setCorrection(documentId, a.application.id, 'holder_name', 'CORRECTED NAME', 'holder');
  assert.equal(updated.fields.holder_name, 'CORRECTED NAME');
  assert.equal(updated.rawFields.holder_name.normalized_value, 'MUHAMMED SAKIR K');
  cleanup();
});

// A cache hit must reuse the COMPUTE, never the ownership.
test('identical bytes in two applications share extraction but not the document', async () => {
  const { store, workflow, cleanup } = harness();
  const file = await fixture('same.jpg', SAKIR.pan);

  const a = await seed(workflow, store, 'a@example.com', [file]);
  const b = await seed(workflow, store, 'b@example.com', [file]);

  const docA = store.listDocuments(a.application.id)[0];
  const docB = store.listDocuments(b.application.id)[0];

  assert.notEqual(docA.id, docB.id, 'each application gets its own document row');
  assert.equal(docA.applicationId, a.application.id);
  assert.equal(docB.applicationId, b.application.id);
  assert.equal(docA.extractionKey, docB.extractionKey, 'the immutable extraction is shared');

  // A correction by A is invisible to B, despite the shared extraction.
  store.setCorrection(docA.id, a.application.id, 'holder_name', 'ONLY FOR A', 'a');
  assert.equal(store.getDocument(docA.id, a.application.id).fields.holder_name, 'ONLY FOR A');
  assert.equal(store.getDocument(docB.id, b.application.id).fields.holder_name, 'MUHAMMED SAKIR K');
  cleanup();
});

test('concurrent applications do not interleave', async () => {
  const { store, workflow, cleanup } = harness();

  const people = await Promise.all([0, 1, 2, 3].map(async index => ({
    index,
    user: store.upsertUser(`u${index}@example.com`),
    files: await Promise.all([
      fixture(`p${index}.jpg`, { ...MISHAB.passport, holder_name: `PERSON ${index}`, document_number: `M765432${index}` }),
      fixture(`v${index}.jpg`, { ...MISHAB.voter, holder_name: `PERSON ${index}`, document_number: `XYZ765432${index}` })
    ])
  })));

  const applications = people.map(person => workflow.startApplication(person.user.id));

  // Interleaved ingestion and comparison, all at once.
  await Promise.all(people.map((person, index) =>
    workflow.ingest({ applicationId: applications[index].id, userId: person.user.id, files: person.files })));

  const comparisons = await Promise.all(people.map((person, index) =>
    workflow.compare({
      applicationId: applications[index].id, userId: person.user.id,
      documentIds: store.listDocuments(applications[index].id).map(document => document.id)
    })));

  comparisons.forEach((comparison, index) => {
    assert.equal(comparison.documents.length, 2, `application ${index} saw exactly its own documents`);
    const name = comparison.verdict.fields.find(field => field.label === 'holder_name');
    assert.equal(name.value, `PERSON ${index}`);

    const serialised = JSON.stringify(comparison.verdict);
    for (let other = 0; other < people.length; other++) {
      if (other === index) continue;
      assert.ok(!serialised.includes(`PERSON ${other}`), `person ${other} leaked into application ${index}`);
    }
  });
  cleanup();
});
