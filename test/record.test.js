'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-record-'));
process.env.NODE_ENV = 'test';
process.env.GOLDEN_ID_KEY_PATH = path.join(scratch, 'signing-key.pem');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStore } = require('../lib/db');
const { compareDocuments } = require('../lib/compare');
const { buildConsensus } = require('../lib/record/consensus');
const { dedupHash } = require('../lib/record/dedup');
const {
  issueRecord, mintShareToken, redeemShareToken, revoke,
  sign, verify, canonicalize, getKeys, resetKeys
} = require('../lib/record/issue');

const KEY_PATH = process.env.GOLDEN_ID_KEY_PATH;

test.after(() => {
  resetKeys();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const document = (type, fields, extra = {}) => ({
  id: `doc-${type}`, type, pageRole: 'front', fields,
  source: 'vision', status: 'ready', ...extra
});

// Five documents describing one person, with the Voter spelling the name
// slightly differently — the realistic case.
const documentSet = () => [
  document('pan', { holder_name: 'MUHAMMED SAKIR K', dob: '12/08/1997', father_name: 'ABDUL RAHMAN K' }),
  document('aadhaar', { holder_name: 'MUHAMMED SAKIR K', dob: '12/08/1997', gender: 'MALE', address: '12 MG ROAD, BENGALURU 560001' }),
  document('passport', { holder_name: 'MUHAMMED SAKIR K', dob: '12/08/1997', gender: 'M' }),
  document('voter', { holder_name: 'MUHAMMED SAKIR K', dob: '12/08/1997', gender: 'M', father_name: 'ABDUL RAHMAN K' }),
  document('birth_certificate', { holder_name: 'MUHAMMED SAKIR K', dob: '12/08/1997', gender: 'Male', father_name: 'ABDUL RAHMAN K', mother_name: 'FATHIMA BEEVI' })
];

const validations = () => [
  { type: 'pan', validation: { number: 'BQIPS8241E', valid: true, repaired: false }, source: 'vision' },
  { type: 'aadhaar', validation: { number: '234123412346', valid: true, repaired: false }, source: 'vision' },
  { type: 'passport', validation: { number: 'M1234567', valid: true, repaired: false }, source: 'vision' },
  { type: 'voter', validation: { number: 'ABC1234567', valid: true, repaired: false }, source: 'vision' },
  { type: 'birth_certificate', validation: { number: 'BLR/1997/44821', valid: true, repaired: false }, source: 'vision' }
];

const verdictFor = (documents = documentSet()) => compareDocuments(documents);

/** A store with an owning user and application, as issuance now requires. */
function scaffold() {
  const store = createStore(':memory:');
  const user = store.upsertUser('holder@example.com');
  const application = store.createApplication(user.id);
  return { store, user, application };
}

// --- consensus --------------------------------------------------------------

test('consensus: fields come from the majority, not from whichever document was first', () => {
  const documents = documentSet();
  documents[0] = document('pan', { holder_name: 'MUHAMMAD SAKIR K', dob: '12/08/1997', father_name: 'ABDUL RAHMAN K' });

  const consensus = buildConsensus(verdictFor(documents), { documents: validations() });
  assert.equal(consensus.fields.holder_name.value, 'MUHAMMED SAKIR K');
  assert.ok(consensus.fields.holder_name.sources.length >= 3);
  assert.ok(consensus.fields.holder_name.dissenting.includes('pan'));
});

test('consensus: the outlier does not win even when it is listed first', () => {
  const documents = documentSet();
  const outlier = document('voter', { holder_name: 'MUHAMMAD SAKIR K', dob: '12/08/1997', gender: 'M' });
  const reordered = [outlier, ...documents.filter(item => item.type !== 'voter')];

  const consensus = buildConsensus(compareDocuments(reordered), { documents: validations() });
  assert.equal(consensus.fields.holder_name.value, 'MUHAMMED SAKIR K');
});

test('consensus: dates and genders are stored normalised, with provenance', () => {
  const consensus = buildConsensus(verdictFor(), { documents: validations() });
  assert.equal(consensus.fields.dob.value, '1997-08-12');
  assert.equal(consensus.fields.gender.value, 'M');
  assert.ok(consensus.fields.dob.sources.length >= 4);
  assert.ok(Array.isArray(consensus.fields.dob.evidence));
});

test('consensus records abstentions separately from disagreement', () => {
  const consensus = buildConsensus(verdictFor(), { documents: validations() });
  const address = consensus.fields.address;
  assert.ok(address.value.includes('MG ROAD'));
  assert.ok(address.sources.includes('aadhaar'));
  // A PAN prints no address at all — it abstained rather than disagreeing.
  assert.ok(address.abstained.includes('pan'));
  assert.ok(!address.dissenting.includes('pan'));
});

// --- signing ----------------------------------------------------------------

test('canonical JSON is stable regardless of key order', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.equal(canonicalize({ a: [3, { d: 1, c: 2 }] }), '{"a":[3,{"c":2,"d":1}]}');
});

test('a record signature verifies, and any change breaks it', () => {
  const payload = { gid: 'GID-TEST', fields: { holder_name: { value: 'ASHA DEVI' } } };
  const signature = sign(payload, KEY_PATH);
  const pem = getKeys(KEY_PATH).publicKeyPem;

  assert.equal(verify(payload, signature, pem), true);
  assert.equal(verify({ fields: { holder_name: { value: 'ASHA DEVI' } }, gid: 'GID-TEST' }, signature, pem), true);
  assert.equal(verify({ ...payload, gid: 'GID-OTHER' }, signature, pem), false);
  assert.equal(verify(payload, signature, getKeys(path.join(scratch, 'other.pem')).publicKeyPem), false);
});

test('the keypair persists outside the repo and is reused', () => {
  const first = getKeys(KEY_PATH);
  assert.ok(fs.existsSync(KEY_PATH));
  resetKeys();
  assert.equal(first.publicKeyPem, getKeys(KEY_PATH).publicKeyPem);
});

// --- issuance ---------------------------------------------------------------

test('issuing produces a signed record whose signature verifies', () => {
  const { store, user, application } = scaffold();
  const result = issueRecord(store, {
    verdict: verdictFor(), documents: validations(),
    applicationId: application.id, userId: user.id, keyPath: KEY_PATH
  });

  assert.equal(result.issued, true);
  assert.match(result.gid, /^GID-[0-9A-F]{12}$/);
  assert.equal(verify(result.record, result.signature, getKeys(KEY_PATH).publicKeyPem), true);
  assert.equal(result.record.fields.holder_name.value, 'MUHAMMED SAKIR K');
  store.close();
});

test('the issued record is attributed to its application and user', () => {
  const { store, user, application } = scaffold();
  const result = issueRecord(store, {
    verdict: verdictFor(), documents: validations(),
    applicationId: application.id, userId: user.id, keyPath: KEY_PATH
  });
  const stored = store.getRecord(result.gid);
  assert.equal(stored.applicationId, application.id);
  assert.equal(stored.userId, user.id);
  store.close();
});

test('the signed record never embeds a full document number', () => {
  const { store, user, application } = scaffold();
  const result = issueRecord(store, {
    verdict: verdictFor(), documents: validations(),
    applicationId: application.id, userId: user.id, keyPath: KEY_PATH
  });
  const serialised = JSON.stringify(result.record);

  assert.ok(!serialised.includes('BQIPS8241E'));
  assert.ok(!serialised.includes('234123412346'));
  assert.ok(serialised.includes('241E'), 'a suffix is kept for recognition');
  store.close();
});

// --- dedup ------------------------------------------------------------------

test('dedup: the same person gets the same Golden ID', () => {
  const { store, user, application } = scaffold();
  const args = { verdict: verdictFor(), documents: validations(), applicationId: application.id, userId: user.id, keyPath: KEY_PATH };

  const first = issueRecord(store, args);
  const second = issueRecord(store, args);
  assert.equal(second.issued, false);
  assert.equal(second.gid, first.gid);
  assert.equal(second.reason, 'identity_match');
  store.close();
});

test('dedup: name ordering cannot be used to obtain a second Golden ID', () => {
  assert.equal(
    dedupHash({ name: 'MUHAMMED SAKIR K', dob: '12/08/1997', gender: 'M' }),
    dedupHash({ name: 'K MUHAMMED SAKIR', dob: '1997-08-12', gender: 'MALE' })
  );
});

test('dedup: a genuinely different person gets a different Golden ID', () => {
  const { store, user, application } = scaffold();
  const first = issueRecord(store, {
    verdict: verdictFor(), documents: validations(),
    applicationId: application.id, userId: user.id, keyPath: KEY_PATH
  });

  const other = compareDocuments([
    document('pan', { holder_name: 'RAJESH KUMAR', dob: '03/11/1985', father_name: 'SURESH KUMAR' }),
    document('aadhaar', { holder_name: 'RAJESH KUMAR', dob: '03/11/1985', gender: 'M', address: '9 NEHRU ROAD' })
  ]);
  const second = issueRecord(store, {
    verdict: other,
    documents: [{ type: 'pan', validation: { number: 'ZZZPK1111Z', valid: true } }],
    applicationId: application.id, userId: user.id, keyPath: KEY_PATH
  });

  assert.equal(second.issued, true);
  assert.notEqual(second.gid, first.gid);
  store.close();
});

test('dedup: two different people whose DOBs are unreadable never collapse to one Golden ID', () => {
  // An identity fingerprint of name + gender alone is no fingerprint at all —
  // two namesakes must not share a Golden ID just because neither DOB was read.
  assert.equal(dedupHash({ name: 'RAVI KUMAR', dob: '', gender: 'M' }), null);

  const { store, user, application } = scaffold();
  const personOne = compareDocuments([
    document('pan', { holder_name: 'RAVI KUMAR', father_name: 'MOHAN KUMAR' }),
    document('voter', { holder_name: 'RAVI KUMAR', gender: 'M' })
  ]);
  const first = issueRecord(store, {
    verdict: personOne,
    documents: [{ type: 'pan', validation: { number: 'AAAPA1111A', valid: true } }],
    applicationId: application.id, userId: user.id, keyPath: KEY_PATH
  });

  const personTwo = compareDocuments([
    document('pan', { holder_name: 'RAVI KUMAR', father_name: 'SURESH NAIR' }),
    document('voter', { holder_name: 'RAVI KUMAR', gender: 'M' })
  ]);
  const second = issueRecord(store, {
    verdict: personTwo,
    documents: [{ type: 'pan', validation: { number: 'BBBPB2222B', valid: true } }],
    applicationId: application.id, userId: user.id, keyPath: KEY_PATH
  });

  assert.equal(second.issued, true, 'a namesake with different documents is a different person');
  assert.notEqual(second.gid, first.gid);
  store.close();
});

test('dedup: a shared document number returns the existing Golden ID', () => {
  const { store, user, application } = scaffold();
  const first = issueRecord(store, {
    verdict: verdictFor(), documents: validations(),
    applicationId: application.id, userId: user.id, keyPath: KEY_PATH
  });

  const differentIdentity = compareDocuments(documentSet().map(item => ({
    ...item, fields: { ...item.fields, holder_name: 'SOMEONE ELSE ENTIRELY', dob: '01/01/1970' }
  })));

  const second = issueRecord(store, {
    verdict: differentIdentity, documents: validations(),
    applicationId: application.id, userId: user.id, keyPath: KEY_PATH
  });

  assert.equal(second.issued, false, 'the same PAN cannot back a second Golden ID');
  assert.equal(second.gid, first.gid);
  assert.equal(second.reason, 'document_number_match');
  store.close();
});

// --- share tokens and retrieval ---------------------------------------------

function issued() {
  const { store, user, application } = scaffold();
  const result = issueRecord(store, {
    verdict: verdictFor(), documents: validations(),
    applicationId: application.id, userId: user.id, keyPath: KEY_PATH
  });
  return { store, gid: result.gid };
}

test('a share token releases only the fields in its scope', () => {
  const { store, gid } = issued();
  const share = mintShareToken(store, gid, { scope: ['holder_name'], ttlMs: 60_000 });
  const result = redeemShareToken(store, share.token, { actor: 'verifier' });

  assert.ok(result.record.fields.holder_name);
  assert.equal(result.record.fields.dob, undefined, 'dob was not in scope');
  assert.equal(result.record.fields.address, undefined);
  store.close();
});

test('an expired share token is refused', () => {
  const { store, gid } = issued();
  const share = mintShareToken(store, gid, { scope: ['holder_name'], ttlMs: -1000 });
  assert.equal(redeemShareToken(store, share.token).error, 'expired');
  store.close();
});

test('a single-use token works exactly once', () => {
  const { store, gid } = issued();
  const share = mintShareToken(store, gid, { scope: ['holder_name'], ttlMs: 60_000, singleUse: true });
  assert.ok(redeemShareToken(store, share.token).record);
  assert.equal(redeemShareToken(store, share.token).error, 'already_used');
  store.close();
});

test('an unknown token is refused', () => {
  const store = createStore(':memory:');
  assert.equal(redeemShareToken(store, 'not-a-real-token').error, 'invalid_token');
  store.close();
});

test('a revoked record cannot be retrieved even with a valid token', () => {
  const { store, gid } = issued();
  const share = mintShareToken(store, gid, { scope: ['holder_name'], ttlMs: 60_000 });

  assert.equal(revoke(store, gid, { actor: 'holder', reason: 'contaminated' }), true);
  assert.equal(redeemShareToken(store, share.token).error, 'revoked');
  assert.equal(store.getRecord(gid).revokedReason, 'contaminated');
  store.close();
});

test('every retrieval and denial is written to the audit trail', () => {
  const { store, gid } = issued();
  const share = mintShareToken(store, gid, { scope: ['holder_name'], ttlMs: 60_000, actor: 'holder' });
  redeemShareToken(store, share.token, { actor: 'verifier@example.com' });

  const actions = store.auditFor(gid).map(row => row.action);
  assert.ok(actions.includes('issued'));
  assert.ok(actions.includes('share_token_minted'));
  assert.ok(actions.includes('retrieved'));

  const retrieval = store.auditFor(gid).find(row => row.action === 'retrieved');
  assert.equal(retrieval.actor, 'verifier@example.com');
  store.close();
});
