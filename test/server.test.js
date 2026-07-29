'use strict';

// Environment must be set before lib/config is first required.
const os = require('os');
const path = require('path');
const fs = require('fs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-server-'));
process.env.NODE_ENV = 'test';
process.env.UPLOAD_DIR = path.join(scratch, 'uploads');
process.env.GOLDEN_ID_KEY_PATH = path.join(scratch, 'signing-key.pem');
process.env.CF_ACCOUNT_ID = '';
process.env.CF_API_TOKEN = '';
process.env.FACE_MATCH_ENABLED = 'false';
process.env.EXPOSE_DEMO_OTP = 'true';
// Issuance is enabled ONLY for this suite, so the end-to-end path is covered.
// It remains off by default everywhere else.
process.env.ENABLE_ISSUANCE = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

const { server, setWorkflow, limiter } = require('../server');
const { verify, getKeys } = require('../lib/record/issue');
const { DECISIONS, ISSUABLE } = require('../lib/compare/decision');
const { harness, fixture } = require('./helpers/harness');

let base = '';
let shared = null;

test.before(async () => {
  shared = harness({ uploadDir: path.join(scratch, 'uploads') });
  setWorkflow(shared.workflow);
  await new Promise(resolve => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

test.beforeEach(() => limiter.clear());

const call = (method, url, { token, body } = {}) => fetch(`${base}${url}`, {
  method,
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body)
});

async function signIn(identifier = 'holder@example.com') {
  const requested = await (await call('POST', '/api/v1/auth/request-otp', { body: { identifier } })).json();
  const verified = await (await call('POST', '/api/v1/auth/verify-otp', {
    body: { challengeId: requested.challengeId, otp: requested.demoOtp }
  })).json();
  return verified.sessionToken;
}

async function newApplication(token) {
  const response = await call('POST', '/api/v1/applications', { token, body: { consent: true } });
  return (await response.json()).applicationId;
}

const { verhoeffDigit } = require('../lib/validate/checksums');

/**
 * A distinct person per test. Dedup is global by design — the same identity
 * always resolves to one Golden ID — so tests that each need their OWN record
 * must describe different people, exactly as real applicants would.
 */
function personFor(seed) {
  const digits = String(seed % 10000).padStart(4, '0');
  const name = `TEST PERSON ${seed}`;
  const aadhaarBody = `2341234${digits}`;
  return {
    pan: { document_type: 'pan', holder_name: name, father_name: `PARENT ${seed}`, dob: '12/08/1997', document_number: `BQIPS${digits}E` },
    aadhaar: { document_type: 'aadhaar', holder_name: name, dob: '12/08/1997', gender: 'MALE', document_number: aadhaarBody + verhoeffDigit(aadhaarBody), address: '12 MG ROAD, BENGALURU 560001' },
    passport: { document_type: 'passport', holder_name: name, dob: '12/08/1997', gender: 'M', document_number: `M${String(seed).padStart(7, '0')}` }
  };
}

const PERSON = personFor(1);

// --- auth and consent -------------------------------------------------------

test('consent and a valid session are required before anything is extracted', async () => {
  const anonymous = await call('POST', '/api/v1/applications', { body: { consent: true } });
  assert.equal(anonymous.status, 401);

  const token = await signIn();
  const applicationId = await newApplication(token);

  const withoutConsent = await call('POST', `/api/v1/applications/${applicationId}/documents`, {
    token, body: { consent: false, files: [await fixture('pan.jpg', PERSON.pan)] }
  });
  assert.equal(withoutConsent.status, 400);
  assert.match((await withoutConsent.json()).error, /consent/i);
});

test('a wrong OTP is refused', async () => {
  const requested = await (await call('POST', '/api/v1/auth/request-otp', { body: { identifier: 'a@b.com' } })).json();
  const wrong = await call('POST', '/api/v1/auth/verify-otp', {
    body: { challengeId: requested.challengeId, otp: '000000' }
  });
  assert.equal(wrong.status, 401);
});

test('OTP requests are rate limited', async () => {
  limiter.clear();
  let refused = 0;
  for (let i = 0; i < 8; i++) {
    const response = await call('POST', '/api/v1/auth/request-otp', { body: { identifier: `rate${i}@b.com` } });
    if (response.status === 429) refused++;
  }
  assert.ok(refused > 0, 'the limiter engages');
  limiter.clear();
});

test('the public signing key is published', async () => {
  const response = await call('GET', '/api/v1/.well-known/golden-id-key');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.algorithm, 'Ed25519');
  assert.match(body.publicKeyPem, /BEGIN PUBLIC KEY/);
  assert.match(body.disclaimer, /Not a Government of India credential/i);
});

// --- the full flow ----------------------------------------------------------

test('the full flow: application, ingest, compare, issue, share, retrieve', async () => {
  const token = await signIn('flow@example.com');
  const applicationId = await newApplication(token);

  const files = await Promise.all([
    fixture('flow-pan.jpg', personFor(2).pan),
    fixture('flow-aadhaar.jpg', personFor(2).aadhaar),
    fixture('flow-passport.jpg', personFor(2).passport)
  ]);

  const ingest = await call('POST', `/api/v1/applications/${applicationId}/documents`, {
    token, body: { consent: true, files }
  });
  assert.equal(ingest.status, 200);
  const ingested = await ingest.json();
  assert.equal(ingested.documents.length, 3);
  for (const document of ingested.documents) {
    assert.equal(document.status, 'ready');
    assert.ok(document.id);
  }

  // Document numbers are masked in transit.
  const pan = ingested.documents.find(document => document.type === 'pan');
  assert.match(pan.validation.number, /^\*+002E$/);

  const compare = await call('POST', `/api/v1/applications/${applicationId}/compare`, {
    token, body: { consent: true }
  });
  const compared = await compare.json();
  assert.equal(compare.status, 201, JSON.stringify(compared).slice(0, 400));
  assert.ok(ISSUABLE.has(compared.decision), `expected an issuable decision, got ${compared.decision}`);
  assert.match(compared.gid, /^GID-[0-9A-F]{12}$/);

  // Consensus, not documents[0], and signed.
  assert.equal(compared.record.fields.holder_name.value, 'TEST PERSON 2');
  assert.ok(compared.record.fields.holder_name.sources.length >= 2);
  const keyBody = await (await call('GET', '/api/v1/.well-known/golden-id-key')).json();
  assert.equal(verify(compared.record, compared.signature, keyBody.publicKeyPem), true);

  // Retrieve with the share token issuance minted.
  const card = await call('GET', `/api/v1/cards/${compared.gid}?token=${encodeURIComponent(compared.shareToken)}`);
  assert.equal(card.status, 200);
  const cardBody = await card.json();
  assert.equal(cardBody.gid, compared.gid);
  assert.ok(cardBody.fields.holder_name);
  assert.match(cardBody.disclaimer, /Not a Government of India credential/i);
});

test('a second application for the same person returns the same Golden ID', async () => {
  const token = await signIn('dedup@example.com');
  const files = await Promise.all([
    fixture('dedup-pan.jpg', personFor(3).pan),
    fixture('dedup-aadhaar.jpg', personFor(3).aadhaar)
  ]);

  const runOnce = async () => {
    const applicationId = await newApplication(token);
    await call('POST', `/api/v1/applications/${applicationId}/documents`, { token, body: { consent: true, files } });
    return (await (await call('POST', `/api/v1/applications/${applicationId}/compare`, { token, body: { consent: true } })).json());
  };

  const first = await runOnce();
  const second = await runOnce();
  assert.equal(second.gid, first.gid);
  assert.equal(second.alreadyIssued, true);
});

test('identical bytes are not extracted twice', async () => {
  const token = await signIn('cache@example.com');
  const applicationId = await newApplication(token);
  const files = [await fixture('cache-unique.jpg', { ...PERSON.pan, issue_date: '01/01/2020' })];

  const before = shared.vision.calls.length;
  await call('POST', `/api/v1/applications/${applicationId}/documents`, { token, body: { consent: true, files } });
  const afterFirst = shared.vision.calls.length;
  assert.ok(afterFirst > before, 'the first pass is a real extraction');

  const second = await newApplication(token);
  await call('POST', `/api/v1/applications/${second}/documents`, { token, body: { consent: true, files } });
  assert.equal(shared.vision.calls.length, afterFirst, 'the same bytes came from the cache');
});

// --- corrections ------------------------------------------------------------

test('a per-field correction changes the verdict without re-uploading', async () => {
  const token = await signIn('fix@example.com');
  const applicationId = await newApplication(token);

  const files = await Promise.all([
    fixture('fix-pan.jpg', personFor(4).pan),
    fixture('fix-aadhaar.jpg', personFor(4).aadhaar),
    fixture('fix-passport.jpg', { ...personFor(4).passport, dob: '01/01/1980' })
  ]);
  const ingested = await (await call('POST', `/api/v1/applications/${applicationId}/documents`, {
    token, body: { consent: true, files }
  })).json();

  const rejected = await call('POST', `/api/v1/applications/${applicationId}/compare`, { token, body: { consent: true } });
  assert.equal(rejected.status, 422);
  const rejectedBody = await rejected.json();
  assert.ok(rejectedBody.verdict.blocking.includes('dob'));

  const passport = ingested.documents.find(document => document.type === 'passport');
  const patched = await call('PATCH', `/api/v1/applications/${applicationId}/documents/${passport.id}/field`, {
    token, body: { field: 'dob', value: '12/08/1997' }
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).document.fields.dob, '12/08/1997');

  const accepted = await (await call('POST', `/api/v1/applications/${applicationId}/compare`, { token, body: { consent: true } })).json();
  assert.ok(ISSUABLE.has(accepted.decision), `expected an issuable decision, got ${accepted.decision}`);
});

test('a PAN without an address does not reject against an Aadhaar with one', async () => {
  const token = await signIn('addr@example.com');
  const applicationId = await newApplication(token);
  const files = await Promise.all([fixture('addr-pan.jpg', personFor(5).pan), fixture('addr-aadhaar.jpg', personFor(5).aadhaar)]);

  await call('POST', `/api/v1/applications/${applicationId}/documents`, { token, body: { consent: true, files } });
  const body = await (await call('POST', `/api/v1/applications/${applicationId}/compare`, { token, body: { consent: true } })).json();

  assert.ok(ISSUABLE.has(body.decision), `expected an issuable decision, got ${body.decision}`);
  assert.deepEqual(body.verdict.blocking, []);
});

// --- ownership at the HTTP boundary -----------------------------------------

test("one user cannot compare another user's application", async () => {
  const alice = await signIn('alice@example.com');
  const bob = await signIn('bob@example.com');

  const applicationId = await newApplication(alice);
  await call('POST', `/api/v1/applications/${applicationId}/documents`, {
    token: alice, body: { consent: true, files: [await fixture('alice-pan.jpg', personFor(12).pan)] }
  });

  const stolen = await call('POST', `/api/v1/applications/${applicationId}/compare`, { token: bob, body: { consent: true } });
  assert.equal(stolen.status, 404);

  const read = await call('GET', `/api/v1/applications/${applicationId}`, { token: bob });
  assert.equal(read.status, 404);
});

test("referencing another application's document is refused at the API", async () => {
  const alice = await signIn('alice2@example.com');
  const bob = await signIn('bob2@example.com');

  const aliceApp = await newApplication(alice);
  const aliceDocs = await (await call('POST', `/api/v1/applications/${aliceApp}/documents`, {
    token: alice, body: { consent: true, files: [await fixture('a2-pan.jpg', personFor(10).pan)] }
  })).json();

  const bobApp = await newApplication(bob);
  const bobDocs = await (await call('POST', `/api/v1/applications/${bobApp}/documents`, {
    token: bob, body: { consent: true, files: [await fixture('b2-aadhaar.jpg', personFor(11).aadhaar), await fixture('b2-passport.jpg', personFor(11).passport)] }
  })).json();

  const response = await call('POST', `/api/v1/applications/${bobApp}/compare`, {
    token: bob,
    body: { consent: true, documentIds: [...bobDocs.documents.map(d => d.id), aliceDocs.documents[0].id] }
  });

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.decision, DECISIONS.BLOCKED_SECURITY_INTEGRITY);
  assert.equal(body.integrity.ok, false);
});

// --- share tokens -----------------------------------------------------------

test('share tokens: scope is enforced and expiry is honoured', async () => {
  const token = await signIn('share@example.com');
  const applicationId = await newApplication(token);
  const files = await Promise.all([fixture('share-pan.jpg', personFor(6).pan), fixture('share-aadhaar.jpg', personFor(6).aadhaar)]);

  await call('POST', `/api/v1/applications/${applicationId}/documents`, { token, body: { consent: true, files } });
  const issued = await (await call('POST', `/api/v1/applications/${applicationId}/compare`, { token, body: { consent: true } })).json();

  const share = await (await call('POST', `/api/v1/records/${issued.gid}/share`, {
    token, body: { scope: ['holder_name'], ttlSeconds: 60 }
  })).json();

  const card = await (await call('GET', `/api/v1/cards/${issued.gid}?token=${encodeURIComponent(share.token)}`)).json();
  assert.ok(card.fields.holder_name);
  assert.equal(card.fields.dob, undefined, 'dob was not shared');

  const expired = await (await call('POST', `/api/v1/records/${issued.gid}/share`, {
    token, body: { scope: ['holder_name'], ttlSeconds: -60 }
  })).json();
  const refused = await call('GET', `/api/v1/cards/${issued.gid}?token=${encodeURIComponent(expired.token)}`);
  assert.equal(refused.status, 401);
});

test('retrieval without a token is refused', async () => {
  const response = await call('GET', '/api/v1/cards/GID-000000000000');
  assert.equal(response.status, 401);
});

test('a revoked record cannot be retrieved', async () => {
  const token = await signIn('revoke@example.com');
  const applicationId = await newApplication(token);
  const files = await Promise.all([fixture('rev-pan.jpg', personFor(7).pan), fixture('rev-passport.jpg', personFor(7).passport)]);

  await call('POST', `/api/v1/applications/${applicationId}/documents`, { token, body: { consent: true, files } });
  const issued = await (await call('POST', `/api/v1/applications/${applicationId}/compare`, { token, body: { consent: true } })).json();

  assert.equal((await call('POST', `/api/v1/records/${issued.gid}/revoke`, { token, body: { reason: 'test' } })).status, 200);
  const response = await call('GET', `/api/v1/cards/${issued.gid}?token=${encodeURIComponent(issued.shareToken)}`);
  assert.equal(response.status, 410);
});

test("a user cannot share another user's record", async () => {
  const alice = await signIn('alice3@example.com');
  const bob = await signIn('bob3@example.com');
  const applicationId = await newApplication(alice);
  const files = await Promise.all([fixture('a3-pan.jpg', personFor(8).pan), fixture('a3-aadhaar.jpg', personFor(8).aadhaar)]);

  await call('POST', `/api/v1/applications/${applicationId}/documents`, { token: alice, body: { consent: true, files } });
  const issued = await (await call('POST', `/api/v1/applications/${applicationId}/compare`, { token: alice, body: { consent: true } })).json();

  const stolen = await call('POST', `/api/v1/records/${issued.gid}/share`, { token: bob, body: { scope: ['holder_name'] } });
  assert.equal(stolen.status, 404);
});

// --- reports and status -----------------------------------------------------

test('the full verdict report is retrievable by application id', async () => {
  const token = await signIn('report@example.com');
  const applicationId = await newApplication(token);
  const files = await Promise.all([fixture('rep-pan.jpg', personFor(9).pan), fixture('rep-aadhaar.jpg', personFor(9).aadhaar)]);

  await call('POST', `/api/v1/applications/${applicationId}/documents`, { token, body: { consent: true, files } });
  await call('POST', `/api/v1/applications/${applicationId}/compare`, { token, body: { consent: true } });

  const report = await call('GET', `/api/v1/applications/${applicationId}/verdict`, { token });
  assert.equal(report.status, 200);
  const body = await report.json();
  assert.ok(Array.isArray(body.verdict.fields));
  assert.equal(body.applicationId, applicationId);
});

test('the status endpoint reports the issuance flag and decision vocabulary', async () => {
  const body = await (await call('GET', '/api/v1/status')).json();
  assert.equal(typeof body.issuanceEnabled, 'boolean');
  assert.ok(body.decisions.includes(DECISIONS.BLOCKED_SECURITY_INTEGRITY));
});

test('unknown API routes 404 rather than falling through to static files', async () => {
  const response = await call('GET', '/api/v1/does-not-exist');
  assert.equal(response.status, 404);
});
