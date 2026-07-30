'use strict';

// A STANDALONE external API client for the Golden ID service.
//
// Simulates a third-party integration end to end using nothing but HTTP:
// OTP sign-in -> application -> document upload -> explicit comparison ->
// issuance -> verdict -> scoped share -> retrieval -> INDEPENDENT Ed25519
// signature verification (the canonical-JSON algorithm is re-implemented
// here from its documented definition, proving interoperability).
//
//   node scripts/api-demo.js <base-url> <image1> [image2 ...]
//   node scripts/api-demo.js http://localhost:3000 pan.jpg aadhaar.jpg

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [, , baseUrl, ...imagePaths] = process.argv;
if (!baseUrl || imagePaths.length < 2) {
  console.error('Usage: node scripts/api-demo.js <base-url> <image1> <image2> [...]');
  process.exit(1);
}

const call = async (method, route, { token, body } = {}) => {
  const response = await fetch(baseUrl + route, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180000)
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
};

const step = (label, status, detail) => console.log(`${String(status).padEnd(4)} ${label}${detail ? '  →  ' + detail : ''}`);

/** Canonical JSON: keys sorted recursively — per the documented record format. */
const canonicalize = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

(async () => {
  console.log(`Golden ID external API demo against ${baseUrl}\n`);

  // 0. Unauthenticated service discovery.
  const status = await call('GET', '/api/v1/status');
  step('GET  /status', status.status, `issuance=${status.payload.issuanceEnabled} vision=${status.payload.visionConfigured}`);

  // Guardrail: nothing works without a session.
  const unauthed = await call('POST', '/api/v1/applications', { body: { consent: true } });
  step('POST /applications (no token)', unauthed.status, unauthed.payload.error);

  // 1. Passwordless sign-in. (Demo mode returns the OTP; production delivers it.)
  const identifier = `api-demo-${Date.now()}@example.com`;
  const otp = await call('POST', '/api/v1/auth/request-otp', { body: { identifier } });
  step('POST /auth/request-otp', otp.status, `challenge=${otp.payload.challengeId?.slice(0, 8)}…`);
  const session = await call('POST', '/api/v1/auth/verify-otp', {
    body: { challengeId: otp.payload.challengeId, otp: otp.payload.demoOtp }
  });
  step('POST /auth/verify-otp', session.status, `session for ${session.payload.user?.identifier}`);
  const token = session.payload.sessionToken;

  // 2. An application — the boundary every document lives inside.
  const application = await call('POST', '/api/v1/applications', { token, body: { consent: true } });
  step('POST /applications', application.status, `id=${application.payload.applicationId}`);
  const applicationId = application.payload.applicationId;

  // 3. Upload documents (base64 data URIs). Extraction runs inline.
  const files = imagePaths.map(file => ({
    name: path.basename(file),
    data: `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`
  }));
  console.log('     …uploading + AI extraction (both vision models run now)…');
  const ingest = await call('POST', `/api/v1/applications/${applicationId}/documents`, {
    token, body: { consent: true, files }
  });
  const documents = ingest.payload.documents || [];
  step('POST /applications/:id/documents', ingest.status,
    documents.map(document => `${document.file}: ${document.type}/${document.status}`).join(', '));
  for (const document of documents) {
    const fields = document.fields || {};
    console.log(`       ${document.file}  name=${fields.holder_name}  dob=${fields.dob}  number=${document.validation?.number} (masked)`);
  }

  // Guardrail: comparison REQUIRES an explicit selection.
  const noSelection = await call('POST', `/api/v1/applications/${applicationId}/compare`, {
    token, body: { consent: true }
  });
  step('POST /compare (no documentIds)', noSelection.status, noSelection.payload.code);

  // 4. Compare exactly the documents we name.
  const documentIds = documents.filter(document => document.status === 'ready').map(document => document.id);
  console.log('     …comparing (face pipeline + decision engine)…');
  const compare = await call('POST', `/api/v1/applications/${applicationId}/compare`, {
    token, body: { consent: true, documentIds }
  });
  step('POST /compare', compare.status, `decision=${compare.payload.decision} issued=${Boolean(compare.payload.issued)} gid=${compare.payload.gid || '—'}`);

  // 5. The stored verdict is retrievable later.
  const verdict = await call('GET', `/api/v1/applications/${applicationId}/verdict`, { token });
  step('GET  /applications/:id/verdict', verdict.status, `decision=${verdict.payload.decision}, ${verdict.payload.documentIds?.length} documents recorded`);

  if (!compare.payload.gid) {
    console.log('\nNo Golden ID was issued (see decision above) — flow demonstrated up to the policy gate.');
    return;
  }

  // 6. Holder-controlled scoped sharing.
  const share = await call('POST', `/api/v1/records/${compare.payload.gid}/share`, {
    token, body: { scope: ['holder_name', 'dob'], ttlSeconds: 300 }
  });
  step('POST /records/:gid/share', share.status, `scope=holder_name,dob expires=${share.payload.expiresAt}`);

  // 7. A verifier retrieves ONLY the released fields, with no session.
  const card = await call('GET', `/api/v1/cards/${compare.payload.gid}?token=${encodeURIComponent(share.payload.token)}`);
  step('GET  /cards/:gid (share token)', card.status,
    `released: ${Object.keys(card.payload.fields || {}).join(', ')} — gender withheld: ${!card.payload.fields?.gender}`);

  // 8. Independent signature verification: fetch the public key and verify the
  //    signed record with Node's crypto alone. No app code involved.
  const wellKnown = await call('GET', '/api/v1/.well-known/golden-id-key');
  const verified = crypto.verify(
    null,
    Buffer.from(canonicalize(compare.payload.record)),
    crypto.createPublicKey(wellKnown.payload.publicKeyPem),
    Buffer.from(compare.payload.signature, 'base64')
  );
  step('GET  /.well-known/golden-id-key', wellKnown.status, `Ed25519 signature independently verified: ${verified}`);

  console.log(`\nDone. A third-party client completed the ENTIRE flow over plain HTTP${verified ? ' and cryptographically verified the record.' : '.'}`);
})().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
