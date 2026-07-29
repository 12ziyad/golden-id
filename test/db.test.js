'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStore, contentHash, extractionKey } = require('../lib/db');
const { createUploadStore, decodeDataUri } = require('../lib/uploads');

const envelope = value => ({
  raw_value: value, normalized_value: value, confidence: 0.9,
  status: value == null ? 'not_present' : 'present_verified', source: 'vision',
  evidence_text: null, page: 1, bounding_box: null, validator_results: [],
  model_version: 'test', prompt_version: '2.0.0'
});

const sampleExtraction = (hash, overrides = {}) => ({
  contentHash: hash,
  extractor: '2.0.0', promptVersion: '2.0.0', schemaVersion: '2.0.0',
  modelIds: ['@cf/test/model'],
  type: 'pan',
  rawFields: {
    holder_name: envelope('ASHA DEVI'),
    dob: envelope('21/05/1990'),
    father_name: envelope('RAM KUMAR')
  },
  confidence: { holder_name: 'high' },
  source: 'vision',
  ...overrides
});

/** A store with a user, an application and a batch already in place. */
function scaffold() {
  const store = createStore(':memory:');
  const user = store.upsertUser('holder@example.com');
  const application = store.createApplication(user.id);
  const batchId = store.createBatch(application.id, { source: 'files' });
  return { store, user, application, batchId };
}

// --- ownership chain --------------------------------------------------------

test('a user is created once and reused', () => {
  const store = createStore(':memory:');
  const first = store.upsertUser('a@example.com');
  const second = store.upsertUser('a@example.com');
  assert.equal(first.id, second.id);
  store.close();
});

test('an application belongs to exactly one user', () => {
  const store = createStore(':memory:');
  const owner = store.upsertUser('owner@example.com');
  const other = store.upsertUser('other@example.com');
  const application = store.createApplication(owner.id);

  assert.ok(store.getApplication(application.id, owner.id));
  assert.equal(store.getApplication(application.id, other.id), null);
  store.close();
});

test('a document is only reachable through its owning application', () => {
  const { store, application, batchId } = scaffold();
  const other = store.createApplication(store.upsertUser('other@example.com').id);

  const documentId = store.createDocument({
    applicationId: application.id, uploadBatchId: batchId,
    contentHash: contentHash(Buffer.from('bytes')), fileName: 'pan.jpg', detectedMime: 'image/jpeg'
  });

  assert.ok(store.getDocument(documentId, application.id));
  assert.equal(store.getDocument(documentId, other.id), null);
  store.close();
});

// --- cache provenance -------------------------------------------------------

test('the cache key changes when the prompt, schema, extractor or model changes', () => {
  const hash = contentHash(Buffer.from('same bytes'));
  const base = { contentHash: hash, extractor: '2.0.0', promptVersion: '2.0.0', schemaVersion: '2.0.0', modelIds: ['m1'] };

  const original = extractionKey(base);
  assert.notEqual(original, extractionKey({ ...base, promptVersion: '2.1.0' }), 'a prompt change must invalidate');
  assert.notEqual(original, extractionKey({ ...base, schemaVersion: '2.1.0' }), 'a schema change must invalidate');
  assert.notEqual(original, extractionKey({ ...base, extractor: '2.1.0' }), 'an extractor change must invalidate');
  assert.notEqual(original, extractionKey({ ...base, modelIds: ['m2'] }), 'a model change must invalidate');
  assert.equal(original, extractionKey({ ...base }), 'identical inputs give an identical key');
});

test('an extraction round-trips and is immutable', () => {
  const store = createStore(':memory:');
  const hash = contentHash(Buffer.from('pan-card-bytes'));
  const record = sampleExtraction(hash);
  const key = extractionKey(record);

  store.saveExtraction({ ...record, extractionKey: key });
  const loaded = store.getExtractionByKey(key);
  assert.equal(loaded.contentHash, hash);
  assert.equal(loaded.type, 'pan');
  assert.equal(loaded.rawFields.holder_name.normalized_value, 'ASHA DEVI');

  // Saving again does not overwrite — extraction rows are write-once.
  store.saveExtraction({ ...record, extractionKey: key, type: 'aadhaar' });
  assert.equal(store.getExtractionByKey(key).type, 'pan');
  store.close();
});

test('an unseen key misses', () => {
  const store = createStore(':memory:');
  assert.equal(store.getExtractionByKey('nope'), null);
  store.close();
});

test('content hash is stable for identical bytes and differs otherwise', () => {
  assert.equal(contentHash(Buffer.from('abc')), contentHash(Buffer.from('abc')));
  assert.notEqual(contentHash(Buffer.from('abc')), contentHash(Buffer.from('abd')));
});

// --- corrections ------------------------------------------------------------

test('a correction overrides the model without mutating the extraction', () => {
  const { store, application, batchId } = scaffold();
  const hash = contentHash(Buffer.from('blurry-dob'));
  const record = sampleExtraction(hash);
  const key = extractionKey(record);
  store.saveExtraction({ ...record, extractionKey: key });

  const documentId = store.createDocument({
    applicationId: application.id, uploadBatchId: batchId,
    contentHash: hash, extractionKey: key, fileName: 'pan.jpg'
  });

  const updated = store.setCorrection(documentId, application.id, 'dob', '12/08/1997', 'holder');
  assert.equal(updated.fields.dob, '12/08/1997');
  assert.equal(updated.rawFields.dob.normalized_value, '21/05/1990', 'raw extraction is untouched');

  // Clearing the correction falls back to the extracted value.
  const cleared = store.setCorrection(documentId, application.id, 'dob', '', 'holder');
  assert.equal(cleared.fields.dob, '21/05/1990');
  store.close();
});

test('a correction to the document type outranks the backend classification', () => {
  const { store, application, batchId } = scaffold();
  const documentId = store.createDocument({
    applicationId: application.id, uploadBatchId: batchId,
    contentHash: contentHash(Buffer.from('x')), docType: 'pan'
  });

  const updated = store.setCorrection(documentId, application.id, 'document_type', 'aadhaar', 'holder');
  assert.equal(updated.type, 'aadhaar');
  assert.equal(updated.detectedType, 'pan', 'what the backend decided is retained');
  store.close();
});

// --- faces ------------------------------------------------------------------

test('face embeddings are stored against the owned document, not the bytes', () => {
  const { store, application, batchId } = scaffold();
  const documentId = store.createDocument({
    applicationId: application.id, uploadBatchId: batchId, contentHash: contentHash(Buffer.from('photo'))
  });

  assert.equal(store.getFace(documentId, application.id), null);
  store.setFace(documentId, application.id, { embedding: [0.1, 0.2], box: [1, 2, 3, 4], detector: 'human' });
  assert.deepEqual(store.getFace(documentId, application.id).embedding, [0.1, 0.2]);

  const other = store.createApplication(store.upsertUser('other@example.com').id);
  assert.equal(store.getFace(documentId, other.id), null);
  store.close();
});

// --- comparisons, records, audit --------------------------------------------

test('comparisons round-trip and are scoped', () => {
  const { store, application } = scaffold();
  const comparisonId = store.saveComparison({
    applicationId: application.id, documentIds: ['d1', 'd2'],
    verdict: { status: 'match' }, decision: 'verified_match', integrity: { ok: true }
  });

  const loaded = store.getComparison(comparisonId, application.id);
  assert.equal(loaded.decision, 'verified_match');
  assert.deepEqual(loaded.documentIds, ['d1', 'd2']);

  const other = store.createApplication(store.upsertUser('other@example.com').id);
  assert.equal(store.getComparison(comparisonId, other.id), null);
  store.close();
});

test('records: save, look up by dedup hash, and revoke', () => {
  const { store, application, user } = scaffold();
  store.saveRecord({
    gid: 'GID-1', applicationId: application.id, userId: user.id,
    record: { fields: { holder_name: { value: 'ASHA DEVI' } } }, signature: 'sig', dedupHash: 'dedup-1'
  });

  assert.equal(store.getRecord('GID-1').record.fields.holder_name.value, 'ASHA DEVI');
  assert.equal(store.findRecordByDedupHash('dedup-1').gid, 'GID-1');

  assert.equal(store.revokeRecord('GID-1', 'contaminated'), true);
  assert.equal(store.getRecord('GID-1').revoked, true);
  assert.equal(store.getRecord('GID-1').revokedReason, 'contaminated');
  assert.equal(store.findRecordByDedupHash('dedup-1'), null, 'revoked records stop matching for dedup');
  store.close();
});

test('document numbers map back to their Golden ID, ignoring revoked records', () => {
  const store = createStore(':memory:');
  store.saveRecord({ gid: 'GID-2', record: {}, dedupHash: 'dedup-2' });
  store.linkDocumentNumber('BQIPS8241E', 'pan', 'GID-2');

  assert.equal(store.findGidByDocumentNumber('BQIPS8241E'), 'GID-2');
  assert.equal(store.findGidByDocumentNumber('UNKNOWN123'), null);

  store.revokeRecord('GID-2');
  assert.equal(store.findGidByDocumentNumber('BQIPS8241E'), null);
  store.close();
});

test('audit rows accumulate in order and are queryable by application', () => {
  const { store, application, user } = scaffold();
  store.audit({ gid: 'GID-3', applicationId: application.id, userId: user.id, action: 'issued', actor: 'holder' });
  store.audit({ gid: 'GID-3', applicationId: application.id, action: 'retrieved', actor: 'verifier' });

  const byGid = store.auditFor('GID-3');
  assert.equal(byGid.length, 2);
  assert.equal(byGid[0].action, 'issued');
  assert.equal(store.auditForApplication(application.id).length, 2);
  store.close();
});

// --- uploads ----------------------------------------------------------------

test('data URIs decode to bytes and a mime type', () => {
  const decoded = decodeDataUri(`data:image/jpeg;base64,${Buffer.from('hello').toString('base64')}`);
  assert.equal(decoded.mimeType, 'image/jpeg');
  assert.equal(decoded.buffer.toString(), 'hello');
  assert.equal(decodeDataUri('not a data uri'), null);
});

test('uploads: stored by hash, readable, deletable, and swept on TTL', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-uploads-'));
  const uploads = createUploadStore({ dir: directory, ttlMs: 1000 });

  const { hash } = uploads.put(Buffer.from('scan-bytes'), 'image/jpeg');
  assert.equal(uploads.read(hash).toString(), 'scan-bytes');
  assert.match(uploads.find(hash), /\.jpg$/);

  assert.equal(uploads.sweep(Date.now()), 0);
  assert.equal(uploads.sweep(Date.now() + 3_600_000), 1);
  assert.equal(uploads.read(hash), null);

  const second = uploads.put(Buffer.from('another'), 'image/png');
  assert.equal(uploads.remove(second.hash), true);
  assert.equal(uploads.remove(second.hash), false, 'removing twice is harmless');

  fs.rmSync(directory, { recursive: true, force: true });
});
