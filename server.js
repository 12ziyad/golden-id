'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { config } = require('./lib/config');
const { flags, issuanceBlockReason } = require('./lib/flags');
const { getStore } = require('./lib/db');
const { createWorkflow } = require('./lib/application');
const { createLimiter, LIMITS } = require('./lib/ratelimit');
const { getKeys, mintShareToken, redeemShareToken, revoke } = require('./lib/record/issue');
const { DECISIONS } = require('./lib/compare/decision');

// Routing and HTTP only.
//
// The security rule this file enforces: NO route accepts a document reference
// without resolving it through the application the signed-in user owns. The
// previous version took a list of content hashes straight from the request body
// and compared whatever they pointed at, which is what let one applicant's
// documents appear inside another's comparison.
//
// This remains a PROTOTYPE. It performs no government authentication and the
// Golden ID it issues is not a Government of India credential.

const publicDir = path.join(__dirname, 'public');
const otpChallenges = new Map();
const sessions = new Map();
const limiter = createLimiter();

let workflow = null;
const getWorkflow = () => (workflow ||= createWorkflow());
const setWorkflow = flow => { workflow = flow; };

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readBody = req => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', chunk => {
    raw += chunk;
    if (raw.length > 80_000_000) reject(new Error('Request too large'));
  });
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid JSON')); } });
  req.on('error', reject);
});

const bearer = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
const clientKey = req => (req.socket.remoteAddress || 'unknown');

/** Resolve the signed-in session, or null. Expired sessions are deleted on sight. */
function currentSession(req) {
  const token = bearer(req);
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expires < Date.now()) { sessions.delete(token); return null; }
  return session;
}

/** Drop expired sessions and OTP challenges; both maps otherwise grow forever. */
function sweepAuth(now = Date.now()) {
  for (const [token, session] of sessions) if (session.expires < now) sessions.delete(token);
  for (const [id, challenge] of otpChallenges) if (challenge.expires < now) otpChallenges.delete(id);
}

/** Apply a rate limit; returns true when the request was refused. */
function limited(req, res, bucket, key) {
  const result = limiter.take(`${bucket}:${key}`, LIMITS[bucket]);
  if (result.allowed) return false;
  res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(result.retryAfterSeconds) });
  res.end(JSON.stringify({ error: 'Too many requests. Please wait before trying again.', retryAfterSeconds: result.retryAfterSeconds }));
  return true;
}

async function api(req, res, url) {
  const { pathname } = url;

  // --- auth ---------------------------------------------------------------

  if (req.method === 'GET' && pathname === '/api/v1/auth/session') {
    const session = currentSession(req);
    if (!session) return json(res, 401, { valid: false, error: 'Session expired.' });
    return json(res, 200, {
      valid: true,
      user: { identifier: session.identifier },
      expiresAt: new Date(session.expires).toISOString()
    });
  }

  if (req.method === 'POST' && pathname === '/api/v1/auth/request-otp') {
    if (limited(req, res, 'otpRequest', clientKey(req))) return true;
    const { identifier = '' } = await readBody(req);
    const value = String(identifier).trim().toLowerCase();
    const valid = /^\+?[1-9]\d{9,14}$/.test(value.replace(/[\s-]/g, '')) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    if (!valid) return json(res, 400, { error: 'Enter a valid mobile number or email address.' });

    const challengeId = crypto.randomUUID();
    const otp = String(crypto.randomInt(100000, 1000000));
    otpChallenges.set(challengeId, { identifier: value, otp, expires: Date.now() + 5 * 60_000, attempts: 0 });

    const body = {
      challengeId, expiresIn: 300,
      message: 'Demo OTP generated. Production must deliver it through an approved provider.'
    };
    // The OTP is only echoed back when the server is explicitly in demo mode.
    // Returning it over any network-reachable deployment defeats the point of
    // having an OTP at all.
    if (config.security.exposeDemoOtp) body.demoOtp = otp;
    else console.log(`[otp] challenge ${challengeId} for ${value.slice(0, 3)}*** -> ${otp}`);

    return json(res, 200, body);
  }

  if (req.method === 'POST' && pathname === '/api/v1/auth/verify-otp') {
    if (limited(req, res, 'otpVerify', clientKey(req))) return true;
    const { challengeId, otp } = await readBody(req);
    const challenge = otpChallenges.get(challengeId);
    if (!challenge || challenge.expires < Date.now()) {
      if (challenge) otpChallenges.delete(challengeId);
      return json(res, 400, { error: 'OTP expired. Request a new one.' });
    }
    challenge.attempts++;
    if (challenge.attempts > 5) { otpChallenges.delete(challengeId); return json(res, 429, { error: 'Too many attempts. Request a new OTP.' }); }
    if (String(otp) !== challenge.otp) return json(res, 401, { error: 'Incorrect OTP.' });
    otpChallenges.delete(challengeId);

    // A durable user id, so applications and records have a real owner.
    const user = getWorkflow().store.upsertUser(challenge.identifier);
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    sessions.set(sessionToken, { identifier: challenge.identifier, userId: user.id, expires: Date.now() + 60 * 60_000 });

    return json(res, 200, { sessionToken, expiresIn: 3600, user: { identifier: challenge.identifier } });
  }

  // --- public key ----------------------------------------------------------

  if (req.method === 'GET' && pathname === '/api/v1/.well-known/golden-id-key') {
    const keys = getKeys();
    return json(res, 200, {
      algorithm: 'Ed25519',
      publicKeyPem: keys.publicKeyPem,
      publicKeyRaw: keys.publicKeyRaw,
      usage: 'Verify the signature over the canonical JSON of an issued record.',
      disclaimer: 'Prototype signing key. Not a Government of India credential.'
    });
  }

  // --- applications --------------------------------------------------------

  if (req.method === 'POST' && pathname === '/api/v1/applications') {
    const session = currentSession(req);
    if (!session) return json(res, 401, { error: 'Please sign in before continuing.' });
    const body = await readBody(req);
    if (body.consent !== true) return json(res, 400, { error: 'Explicit consent is required.' });

    const application = getWorkflow().startApplication(session.userId);
    return json(res, 201, {
      applicationId: application.id,
      status: application.status,
      createdAt: application.createdAt,
      issuanceEnabled: flags.issuanceEnabled,
      issuanceNote: issuanceBlockReason()
    });
  }

  if (req.method === 'GET' && pathname === '/api/v1/applications') {
    const session = currentSession(req);
    if (!session) return json(res, 401, { error: 'Please sign in before continuing.' });
    return json(res, 200, { applications: getWorkflow().store.listApplications(session.userId) });
  }

  const appMatch = pathname.match(/^\/api\/v1\/applications\/([^/]+)$/);
  if (req.method === 'GET' && appMatch) {
    const session = currentSession(req);
    if (!session) return json(res, 401, { error: 'Please sign in before continuing.' });
    const flow = getWorkflow();
    const applicationId = decodeURIComponent(appMatch[1]);
    const application = flow.ownedApplication(applicationId, session.userId);
    if (!application) return json(res, 404, { error: 'Application not found.' });
    return json(res, 200, {
      ...application,
      documents: flow.store.listDocuments(applicationId).map(flow.presentDocument)
    });
  }

  // --- ingestion -----------------------------------------------------------

  const ingestMatch = pathname.match(/^\/api\/v1\/applications\/([^/]+)\/documents$/);
  if (req.method === 'POST' && ingestMatch) {
    const session = currentSession(req);
    if (!session) return json(res, 401, { error: 'Please sign in before continuing.' });
    if (limited(req, res, 'extract', session.userId)) return true;

    const body = await readBody(req);
    // Consent remains mandatory before any extraction.
    if (body.consent !== true) return json(res, 400, { error: 'Explicit consent is required.' });
    if (!Array.isArray(body.files) || !body.files.length) return json(res, 400, { error: 'Select at least one file.' });

    const result = await getWorkflow().ingest({
      applicationId: decodeURIComponent(ingestMatch[1]),
      userId: session.userId,
      files: body.files,
      source: body.source || 'files'
    });

    if (result.error === 'application_not_found') return json(res, 404, { error: 'Application not found.' });
    return json(res, 200, result);
  }

  // --- per-field correction ------------------------------------------------

  const fieldMatch = pathname.match(/^\/api\/v1\/applications\/([^/]+)\/documents\/([^/]+)\/field$/);
  if (req.method === 'PATCH' && fieldMatch) {
    const session = currentSession(req);
    if (!session) return json(res, 401, { error: 'Please sign in before continuing.' });
    const { field, value } = await readBody(req);
    if (!field) return json(res, 400, { error: 'A field name is required.' });

    const result = getWorkflow().correctField({
      applicationId: decodeURIComponent(fieldMatch[1]),
      userId: session.userId,
      documentId: decodeURIComponent(fieldMatch[2]),
      field, value, actor: session.identifier
    });

    if (result.error === 'application_not_found') return json(res, 404, { error: 'Application not found.' });
    if (result.error === 'document_not_found') return json(res, 404, { error: 'That document is not part of this application.' });
    return json(res, 200, result);
  }

  const removeMatch = pathname.match(/^\/api\/v1\/applications\/([^/]+)\/documents\/([^/]+)$/);
  if (req.method === 'DELETE' && removeMatch) {
    const session = currentSession(req);
    if (!session) return json(res, 401, { error: 'Please sign in before continuing.' });
    const result = getWorkflow().removeDocument({
      applicationId: decodeURIComponent(removeMatch[1]),
      userId: session.userId,
      documentId: decodeURIComponent(removeMatch[2])
    });
    if (result.error) return json(res, 404, { error: 'That document is not part of this application.' });
    return json(res, 200, result);
  }

  // --- comparison ----------------------------------------------------------

  const compareMatch = pathname.match(/^\/api\/v1\/applications\/([^/]+)\/compare$/);
  if (req.method === 'POST' && compareMatch) {
    const session = currentSession(req);
    if (!session) return json(res, 401, { error: 'Please sign in before continuing.' });
    if (limited(req, res, 'compare', session.userId)) return true;

    const body = await readBody(req);
    if (body.consent !== true) return json(res, 400, { error: 'Explicit consent is required.' });

    const flow = getWorkflow();
    const applicationId = decodeURIComponent(compareMatch[1]);
    const comparison = await flow.compare({
      applicationId,
      userId: session.userId,
      documentIds: body.documentIds
    });

    if (comparison.error === 'application_not_found') return json(res, 404, { error: 'Application not found.' });
    if (comparison.error === 'document_ids_required') {
      return json(res, 400, { error: 'Select the documents to compare.', code: 'document_ids_required' });
    }
    if (comparison.error === 'duplicate_document_ids') {
      return json(res, 400, { error: 'The same document was selected more than once.', code: 'duplicate_document_ids', ids: comparison.ids });
    }
    if (comparison.error === 'removed_document_selected') {
      return json(res, 400, { error: 'A removed document cannot take part in a comparison.', code: 'removed_document_selected', ids: comparison.ids });
    }
    if (comparison.error === 'documents_still_processing') {
      return json(res, 409, {
        error: 'Some documents are still being processed. Comparison will run once they finish.',
        pending: comparison.pending
      });
    }

    const payload = {
      applicationId,
      comparisonId: comparison.comparisonId,
      decision: comparison.decision,
      status: comparison.verdict.status,
      summary: comparison.verdict.summary,
      reasons: comparison.verdict.reasons,
      verdict: comparison.verdict,
      face: comparison.face,
      integrity: comparison.integrity,
      documents: comparison.documents,
      logicalDocuments: comparison.logicalDocuments,
      issuanceEnabled: flags.issuanceEnabled,
      warning: 'Prototype extraction — not government verification.'
    };

    // An integrity failure is always terminal, whatever the fields say.
    if (comparison.decision === DECISIONS.BLOCKED_SECURITY_INTEGRITY) {
      return json(res, 409, payload);
    }
    if (!comparison.verdict.issuable) {
      return json(res, 422, payload);
    }

    if (!flags.issuanceEnabled) {
      return json(res, 200, {
        ...payload,
        issued: false,
        issuanceNote: issuanceBlockReason()
      });
    }

    const issued = flow.issue({
      applicationId, userId: session.userId, comparison, actor: session.identifier
    });
    if (issued.error) return json(res, 422, { ...payload, issued: false, issuanceError: issued.error });

    const share = mintShareToken(flow.store, issued.gid, {
      scope: ['holder_name', 'dob', 'gender', 'documents'],
      actor: session.identifier
    });

    return json(res, issued.issued ? 201 : 200, {
      ...payload,
      issued: true,
      gid: issued.gid,
      record: issued.record,
      signature: issued.signature,
      alreadyIssued: !issued.issued,
      dedupReason: issued.reason,
      shareToken: share.token,
      shareExpiresAt: share.expiresAt,
      verifyUrl: `/verify.html?id=${encodeURIComponent(issued.gid)}`
    });
  }

  const verdictMatch = pathname.match(/^\/api\/v1\/applications\/([^/]+)\/verdict$/);
  if (req.method === 'GET' && verdictMatch) {
    const session = currentSession(req);
    if (!session) return json(res, 401, { error: 'Please sign in before continuing.' });
    const flow = getWorkflow();
    const applicationId = decodeURIComponent(verdictMatch[1]);
    if (!flow.ownedApplication(applicationId, session.userId)) return json(res, 404, { error: 'Application not found.' });

    const comparison = flow.store.latestComparison(applicationId);
    if (!comparison) return json(res, 404, { error: 'No comparison has been run for this application.' });
    return json(res, 200, comparison);
  }

  // --- share tokens and retrieval ------------------------------------------

  const shareMatch = pathname.match(/^\/api\/v1\/records\/([^/]+)\/share$/);
  if (req.method === 'POST' && shareMatch) {
    const session = currentSession(req);
    if (!session) return json(res, 401, { error: 'Please sign in before continuing.' });
    const body = await readBody(req);

    const flow = getWorkflow();
    const gid = decodeURIComponent(shareMatch[1]);
    const record = flow.store.getRecord(gid);
    // Only the holder may share their own record.
    if (!record || (record.userId && record.userId !== session.userId)) {
      return json(res, 404, { error: 'No such Golden ID.' });
    }

    const result = mintShareToken(flow.store, gid, {
      scope: body.scope,
      ttlMs: body.ttlSeconds ? Number(body.ttlSeconds) * 1000 : undefined,
      singleUse: body.singleUse === true,
      actor: session.identifier
    });

    if (result.error === 'not_found') return json(res, 404, { error: 'No such Golden ID.' });
    if (result.error === 'revoked') return json(res, 410, { error: 'That Golden ID has been revoked.' });
    if (result.error) return json(res, 400, { error: 'Choose at least one field to share.' });

    return json(res, 201, {
      ...result,
      shareUrl: `/verify.html?id=${encodeURIComponent(result.gid)}&token=${encodeURIComponent(result.token)}`
    });
  }

  const cardMatch = pathname.match(/^\/api\/v1\/cards\/([^/]+)$/);
  if (req.method === 'GET' && cardMatch) {
    if (limited(req, res, 'cardRetrieve', clientKey(req))) return true;
    const gid = decodeURIComponent(cardMatch[1]);
    const token = bearer(req) || url.searchParams.get('token') || '';
    if (!token) return json(res, 401, { error: 'A share token is required.' });

    const store = getWorkflow().store;
    const actor = (req.headers['user-agent'] || 'unknown').slice(0, 120);
    const result = redeemShareToken(store, token, { actor });

    if (result.error === 'invalid_token') return json(res, 401, { error: 'That share link is not valid.' });
    if (result.error === 'expired') return json(res, 401, { error: 'That share link has expired.' });
    if (result.error === 'already_used') return json(res, 401, { error: 'That share link has already been used.' });
    if (result.error === 'revoked') return json(res, 410, { error: 'That Golden ID has been revoked.' });
    if (result.error) return json(res, 404, { error: 'Card not found.' });
    if (result.record.gid !== gid) return json(res, 403, { error: 'That share token belongs to a different Golden ID.' });

    return json(res, 200, {
      ...result.record,
      scope: result.scope,
      signature: result.signature,
      signatureNote: result.signature
        ? 'Signature covers the canonical JSON of the full record.'
        : 'This is a scoped subset; verify the full record to check its signature.',
      disclaimer: 'Prototype record. Not a Government of India credential.'
    });
  }

  const revokeMatch = pathname.match(/^\/api\/v1\/records\/([^/]+)\/revoke$/);
  if (req.method === 'POST' && revokeMatch) {
    const session = currentSession(req);
    if (!session) return json(res, 401, { error: 'Please sign in before continuing.' });
    const body = await readBody(req).catch(() => ({}));
    const flow = getWorkflow();
    const gid = decodeURIComponent(revokeMatch[1]);
    const record = flow.store.getRecord(gid);
    if (!record || (record.userId && record.userId !== session.userId)) return json(res, 404, { error: 'No such Golden ID.' });

    const done = revoke(flow.store, gid, { actor: session.identifier, reason: body.reason || 'holder request' });
    if (!done) return json(res, 404, { error: 'No such Golden ID.' });
    return json(res, 200, { revoked: true });
  }

  // --- status --------------------------------------------------------------

  if (req.method === 'GET' && pathname === '/api/v1/status') {
    return json(res, 200, {
      issuanceEnabled: flags.issuanceEnabled,
      issuanceNote: issuanceBlockReason(),
      visionConfigured: config.cloudflare.configured,
      faceThreshold: config.face.threshold,
      decisions: Object.values(DECISIONS)
    });
  }

  return false;
}

// --- static files -----------------------------------------------------------

const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml'
};

/**
 * Map a URL path to a file inside public/, or null.
 * The separator suffix matters: `<root>/public.bak` starts with
 * `<root>/public`, so a bare prefix check would serve sibling directories.
 */
function resolveStatic(pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(publicDir, requested));
  return file.startsWith(publicDir + path.sep) ? file : null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      if (await api(req, res, url) === false) json(res, 404, { error: 'Not found' });
      return;
    }
    const file = resolveStatic(url.pathname);
    if (!file) return json(res, 403, { error: 'Forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, {
        'content-type': mime[path.extname(file)] || 'application/octet-stream',
        // Browsers must revalidate: a heuristically cached app.js silently
        // resurrects fixed bugs long after the server has moved on.
        'cache-control': 'no-cache'
      });
      res.end(data);
    });
  } catch (error) {
    json(res, 400, { error: error.message });
  }
});

if (require.main === module) {
  const flow = getWorkflow();
  flow.uploads.startSweeping();
  getKeys();
  setInterval(() => { limiter.sweep(); sweepAuth(); }, 5 * 60_000).unref?.();

  server.listen(config.port, () => {
    console.log(`Golden ID demo: http://localhost:${config.port}`);
    console.log(`  storage:   ${config.db.path}`);
    console.log(`  vision:    ${config.cloudflare.configured ? `${config.models.primary} (cross-check: ${config.crossCheckMode})` : 'NOT CONFIGURED — falling back to local OCR'}`);
    console.log(`  faces:     advisory only, threshold ${config.face.threshold}`);
    console.log(`  issuance:  ${flags.issuanceEnabled ? 'ENABLED' : 'DISABLED (pending isolation sign-off)'}`);
    console.log(`  demo OTP:  ${config.security.exposeDemoOtp ? 'returned in API responses (localhost demo)' : 'server log only'}`);
  });
}

module.exports = { server, api, getStore, getWorkflow, setWorkflow, sessions, otpChallenges, limiter, resolveStatic, sweepAuth };
