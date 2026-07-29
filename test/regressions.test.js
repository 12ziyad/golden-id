'use strict';

// Regressions found by running the system against two real Indian ID cards.
// Each test below corresponds to something that was demonstrably wrong in the
// live UI, not to a hypothetical.

const os = require('os');
const path = require('path');
const fs = require('fs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-regression-'));
process.env.NODE_ENV = 'test';
process.env.UPLOAD_DIR = path.join(scratch, 'uploads');
process.env.GOLDEN_ID_KEY_PATH = path.join(scratch, 'key.pem');
process.env.CF_ACCOUNT_ID = '';
process.env.CF_API_TOKEN = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const { clusterField } = require('../lib/compare/cluster');
const { compareDocuments } = require('../lib/compare');
const { DECISIONS, ISSUABLE } = require('../lib/compare/decision');
const { extractionPrompt } = require('../lib/extract/prompts');
const matrix = require('../lib/compare/matrix');
const { buildConsensus } = require('../lib/record/consensus');
const { harness, fixture, seed } = require('./helpers/harness');

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const document = (type, fields, extra = {}) => ({
  id: `doc-${type}`, type, pageRole: 'front', fields,
  source: 'vision', status: 'ready', ...extra
});

// ---------------------------------------------------------------------------
// 1. The focused prompt must do the real read.
//
// The generic prompt offers all 18 fields; small vision models drop fields when
// asked for that many at once. A real PAN lost its father's name and a real
// Aadhaar lost its gender, both plainly printed on the card.
// ---------------------------------------------------------------------------

test('the focused prompt asks for far fewer fields than the generic one', () => {
  const count = prompt => (prompt.match(/": "string or null"/g) || []).length;
  const generic = extractionPrompt('unknown');
  assert.ok(count(generic) >= 15, 'the generic prompt has to offer everything');
  assert.ok(count(extractionPrompt('pan', 'front')) <= 6);
  assert.ok(count(extractionPrompt('aadhaar', 'front')) <= 7);
  assert.ok(extractionPrompt('pan', 'front').length < generic.length);
});

test('a document the model types correctly is STILL re-read with its own prompt', async () => {
  const { store, workflow, vision, cleanup } = harness();

  // The model names the type correctly on the first pass, so nothing is
  // "corrected" — the old code therefore kept the weaker generic read.
  const file = await fixture('pan-correct-type.jpg', {
    document_type: 'pan', holder_name: 'MUHAMMED SAKIR K',
    father_name: 'RAHEEM KOTTAKANDI', dob: '19/05/2003', document_number: 'MPWPK2241E'
  });

  const { application } = await seed(workflow, store, 'a@example.com', [file]);
  const stored = store.listDocuments(application.id)[0];

  assert.equal(stored.type, 'pan');
  // A focused read must have happened.
  assert.match(stored.source, /focused/);
  // And the PAN-specific prompt must have been used at least once.
  const focused = vision.calls.filter(call => /PAN Card front page/i.test(call.prompt));
  assert.ok(focused.length >= 1, 'the PAN-specific prompt was used for the real read');
  cleanup();
});

test('a focused read that returns less than the identify pass is discarded', async () => {
  let call = 0;
  const { store, workflow, cleanup } = harness({
    vision: {
      configured: true,
      calls: [],
      async run(_model, { prompt }) {
        call++;
        // First (identify) read is complete; the focused read comes back empty.
        if (/PAN Card front page/i.test(prompt) && call > 1) {
          return JSON.stringify({ document_type: 'pan', holder_name: null, dob: null, document_number: null });
        }
        return JSON.stringify({
          document_type: 'pan', holder_name: 'ASHA DEVI',
          father_name: 'RAM KUMAR', dob: '01/01/1990', document_number: 'BQIPS8241E'
        });
      }
    }
  });

  const file = await fixture('regression-worse.jpg', { any: 'payload' });
  const { application } = await seed(workflow, store, 'a@example.com', [file]);
  const stored = store.listDocuments(application.id)[0];

  // The question here is which READ survived, so assert on the raw extraction.
  // Whether those values then verify is a separate matter, decided by evidence.
  assert.equal(stored.rawFields.holder_name.raw_value, 'ASHA DEVI', 'the better read was kept');
  assert.equal(stored.rawFields.father_name.raw_value, 'RAM KUMAR');
  cleanup();
});

// ---------------------------------------------------------------------------
// 2. A safe variant is agreement, not something to confirm.
//
// The UI said "Identical apart from where the spaces fell" and then asked the
// holder to confirm it, which by itself blocked issuance.
// ---------------------------------------------------------------------------

test('a spacing-only difference counts as agreement, not dissent', () => {
  const result = clusterField('holder_name', [
    { type: 'pan', value: 'MUHAMMED SAKIR K', source: 'vision', pageRole: 'front' },
    { type: 'aadhaar', value: 'MUHAMMEDSAKIR K', source: 'vision', pageRole: 'front' }
  ]);

  assert.deepEqual(result.agreeing.sort(), ['aadhaar', 'pan']);
  assert.deepEqual(result.dissenting, [], 'nothing to confirm — the values are the same');
  assert.equal(result.variants.length, 1, 'the other spelling is still shown');
  assert.equal(result.variants[0].type, 'aadhaar');
  assert.match(result.variants[0].explanation, /spaces/i);
  assert.equal(result.confidence, 1);
});

test('word order and capitalisation are agreement too', () => {
  const result = clusterField('holder_name', [
    { type: 'pan', value: 'MUHAMMED SAKIR K', source: 'vision', pageRole: 'front' },
    { type: 'aadhaar', value: 'K Muhammed Sakir', source: 'vision', pageRole: 'front' }
  ]);
  assert.deepEqual(result.agreeing.sort(), ['aadhaar', 'pan']);
  assert.deepEqual(result.dissenting, []);
});

// The exact live case: these two cards should now issue.
test('the two real cards reach verified_match, not needs-confirmation', () => {
  const verdict = compareDocuments([
    document('pan', { holder_name: 'MUHAMMED SAKIR K', dob: '19/05/2003', father_name: 'RAHEEM KOTTAKANDI' }),
    document('aadhaar', { holder_name: 'MUHAMMEDSAKIR K', dob: '19/05/2003', gender: 'Male' })
  ]);

  assert.ok(ISSUABLE.has(verdict.decision), `expected an issuable decision, got ${verdict.decision}`);
  assert.equal(verdict.issuable, true);
  assert.deepEqual(verdict.blocking, []);
  assert.deepEqual(verdict.confirmations, []);
});

test('a genuine one-character difference STILL asks for confirmation', () => {
  // The relaxation must not swallow a real spelling difference.
  const verdict = compareDocuments([
    document('pan', { holder_name: 'MUHAMMED SAKIR K', dob: '19/05/2003' }),
    document('aadhaar', { holder_name: 'MUHAMMAD SAKIR K', dob: '19/05/2003', gender: 'M' })
  ]);
  assert.equal(verdict.decision, DECISIONS.LIKELY_MATCH_NEEDS_CONFIRMATION);
  assert.ok(verdict.confirmations.includes('holder_name'));
});

test('a genuinely different person is still refused', () => {
  const verdict = compareDocuments([
    document('pan', { holder_name: 'MUHAMMED SAKIR K', dob: '19/05/2003' }),
    document('aadhaar', { holder_name: 'RAJESH KUMAR', dob: '03/11/1985', gender: 'M' })
  ]);
  assert.equal(verdict.issuable, false);
  assert.ok([DECISIONS.DOCUMENT_CONFLICT, DECISIONS.SUSPECTED_CROSS_IDENTITY].includes(verdict.decision));
});

test('consensus credits a safe-variant document as a source', () => {
  const verdict = compareDocuments([
    document('pan', { holder_name: 'MUHAMMED SAKIR K', dob: '19/05/2003' }),
    document('aadhaar', { holder_name: 'MUHAMMEDSAKIR K', dob: '19/05/2003', gender: 'Male' })
  ]);
  const consensus = buildConsensus(verdict, { documents: [] });
  assert.deepEqual(consensus.fields.holder_name.sources.sort(), ['aadhaar', 'pan']);
  assert.deepEqual(consensus.fields.holder_name.dissenting, []);
});

// ---------------------------------------------------------------------------
// 3. An Aadhaar without a printed address abstains rather than failing.
// ---------------------------------------------------------------------------

test('an Aadhaar with no printed address abstains instead of reporting failure', () => {
  // Not every Aadhaar layout prints an address: the cut-out card and the
  // e-Aadhaar header often do not. A blank there must not be reported as
  // something the holder failed to provide.
  assert.equal(matrix.expects('aadhaar', 'address', 'front'), false);
  assert.equal(matrix.participates('aadhaar', 'address', 'front'), true, 'an address IS compared when present');

  const verdict = compareDocuments([
    document('pan', { holder_name: 'MUHAMMED SAKIR K', dob: '19/05/2003' }),
    document('aadhaar', { holder_name: 'MUHAMMED SAKIR K', dob: '19/05/2003', gender: 'Male' })
  ]);

  // Nobody printed one, so there is nothing to report at all — no row telling
  // the holder an address was "not readable".
  const address = verdict.fields.find(field => field.label === 'address');
  assert.equal(address, undefined, 'a field no document carries is dropped entirely');
  assert.deepEqual(verdict.blocking, []);
});

test('an Aadhaar that DOES print an address still contributes it', () => {
  const verdict = compareDocuments([
    document('pan', { holder_name: 'RAM K', dob: '01/01/1990' }),
    document('aadhaar', { holder_name: 'RAM K', dob: '01/01/1990', gender: 'M', address: '12 MG ROAD, BENGALURU 560001' })
  ]);
  const address = verdict.fields.find(field => field.label === 'address');
  assert.deepEqual(address.agreeing, ['aadhaar']);
  assert.match(address.value, /MG ROAD/);
});

// ---------------------------------------------------------------------------
// 4. Uploading the same file twice must not create a second document.
//
// The client used to lose the link between a staged file and its server
// document, re-sent it on the next add, and produced duplicate rows that then
// appeared in the comparison as phantom extras.
// ---------------------------------------------------------------------------

test('re-ingesting the same file into one application does not duplicate it', async () => {
  const { store, workflow, cleanup } = harness();
  const pan = await fixture('dup-pan.jpg', {
    document_type: 'pan', holder_name: 'ASHA DEVI', dob: '01/01/1990', document_number: 'BQIPS8241E'
  });
  const aadhaar = await fixture('dup-aadhaar.jpg', {
    document_type: 'aadhaar', holder_name: 'ASHA DEVI', dob: '01/01/1990', gender: 'F', document_number: '234123412346'
  });

  const { application, user } = await seed(workflow, store, 'a@example.com', [pan]);
  assert.equal(store.listDocuments(application.id).length, 1);

  // Adding a second file must add exactly one document, not re-add the first.
  await workflow.ingest({ applicationId: application.id, userId: user.id, files: [aadhaar] });
  const documents = store.listDocuments(application.id);
  assert.equal(documents.length, 2);

  const names = documents.map(item => item.fileName).sort();
  assert.deepEqual(names, ['dup-aadhaar.jpg', 'dup-pan.jpg'], 'no duplicated file names');
  cleanup();
});

test('a removed document is excluded from the comparison', async () => {
  const { store, workflow, cleanup } = harness();
  const files = await Promise.all([
    fixture('keep-pan.jpg', { document_type: 'pan', holder_name: 'ASHA DEVI', dob: '01/01/1990', document_number: 'BQIPS8241E' }),
    fixture('keep-aadhaar.jpg', { document_type: 'aadhaar', holder_name: 'ASHA DEVI', dob: '01/01/1990', gender: 'F', document_number: '234123412346' }),
    fixture('drop-voter.jpg', { document_type: 'voter', holder_name: 'SOMEONE ELSE', dob: '05/05/1970', gender: 'M', document_number: 'ABC1234567' })
  ]);

  const { application, user } = await seed(workflow, store, 'a@example.com', files);
  const voter = store.listDocuments(application.id).find(item => item.type === 'voter');

  workflow.removeDocument({ applicationId: application.id, userId: user.id, documentId: voter.id });

  const activeIds = store.listDocuments(application.id)
    .filter(document => document.status !== 'removed_by_user')
    .map(document => document.id);
  const comparison = await workflow.compare({
    applicationId: application.id, userId: user.id, documentIds: activeIds
  });

  assert.ok(!JSON.stringify(comparison.verdict).includes('SOMEONE ELSE'), 'the removed document is gone from the verdict');
  assert.ok(ISSUABLE.has(comparison.decision), `expected an issuable decision, got ${comparison.decision}`);

  // Selecting the removed document by id is refused outright, not silently
  // filtered — the caller must know their selection was wrong.
  const refused = await workflow.compare({
    applicationId: application.id, userId: user.id, documentIds: [...activeIds, voter.id]
  });
  assert.equal(refused.error, 'removed_document_selected');
  assert.deepEqual(refused.ids, [voter.id]);
  cleanup();
});

// ---------------------------------------------------------------------------
// The comparison contract: explicit, unique, active document ids only. A
// single card listed twice used to clear the two-document evidence minimum
// and could mint a verified_match from one photograph.
// ---------------------------------------------------------------------------

test('one card cannot become two sources: duplicates refused, a single card is insufficient', async () => {
  const { store, workflow, cleanup } = harness();
  const pan = await fixture('self-pan.jpg', {
    document_type: 'pan', holder_name: 'ASHA DEVI', dob: '01/01/1990', document_number: 'BQIPS8241E'
  });
  const { application, user } = await seed(workflow, store, 'self@example.com', [pan]);
  const documentId = store.listDocuments(application.id)[0].id;

  const refused = await workflow.compare({
    applicationId: application.id, userId: user.id, documentIds: [documentId, documentId]
  });
  assert.equal(refused.error, 'duplicate_document_ids');
  assert.deepEqual(refused.ids, [documentId]);

  const single = await workflow.compare({
    applicationId: application.id, userId: user.id, documentIds: [documentId]
  });
  assert.equal(single.decision, DECISIONS.INSUFFICIENT_EVIDENCE);
  assert.equal(single.verdict.issuable, false);
  cleanup();
});

test('a comparison without an explicit selection is refused', async () => {
  const { store, workflow, cleanup } = harness();
  const { application, user } = await seed(workflow, store, 'sel@example.com', [
    await fixture('sel-pan.jpg', { document_type: 'pan', holder_name: 'ASHA DEVI', dob: '01/01/1990', document_number: 'BQIPS8241E' })
  ]);

  assert.equal((await workflow.compare({ applicationId: application.id, userId: user.id })).error, 'document_ids_required');
  assert.equal((await workflow.compare({ applicationId: application.id, userId: user.id, documentIds: [] })).error, 'document_ids_required');
  cleanup();
});

test('every comparison records exactly which documents fed it', async () => {
  const { store, workflow, cleanup } = harness();
  const files = await Promise.all([
    fixture('aud-pan.jpg', { document_type: 'pan', holder_name: 'ASHA DEVI', dob: '01/01/1990', document_number: 'BQIPS8241E' }),
    fixture('aud-aadhaar.jpg', { document_type: 'aadhaar', holder_name: 'ASHA DEVI', dob: '01/01/1990', gender: 'F', document_number: '234123412346' })
  ]);
  const { application, user } = await seed(workflow, store, 'aud@example.com', files);
  const ids = store.listDocuments(application.id).map(document => document.id);

  const comparison = await workflow.compare({ applicationId: application.id, userId: user.id, documentIds: ids });
  assert.deepEqual([...comparison.selected].sort(), [...ids].sort());

  const audit = store.auditForApplication(application.id).find(row => row.action === 'comparison_requested');
  assert.ok(audit, 'the request itself is audited');
  assert.deepEqual(JSON.parse(audit.detail).sort(), [...ids].sort());
  cleanup();
});
