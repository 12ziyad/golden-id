'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');
const { buildConsensus, publicSummary } = require('./consensus');
const { dedupHashForRecord, findExisting, linkDocuments } = require('./dedup');

// Issuance produces a SIGNED credential, not a random string.
//
// The old version handed out `GID-<random>` plus a permanent bearer token, so
// anyone holding the token held it forever and a verifier could only "check"
// the ID by asking this same server. Here the record is signed with Ed25519 and
// a verifier can check the signature against a published public key, while
// retrieval uses short-lived scoped tokens instead of a permanent secret.
//
// This is still a prototype credential and NOT a government-issued identity.

// --- key management ---------------------------------------------------------

let cachedKeys = null;

/**
 * Load the Ed25519 keypair, generating it on first run.
 * The private key is written outside the repository (see config.signing.keyPath)
 * with owner-only permissions so it cannot be committed by accident.
 */
function getKeys(keyPath = config.signing.keyPath) {
  if (cachedKeys && cachedKeys.keyPath === keyPath) return cachedKeys;

  let privateKey;
  if (fs.existsSync(keyPath)) {
    privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
  } else {
    const generated = crypto.generateKeyPairSync('ed25519');
    privateKey = generated.privateKey;
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, pem, { mode: 0o600 });
    try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort on Windows */ }
  }

  const publicKey = crypto.createPublicKey(privateKey);
  cachedKeys = {
    keyPath,
    privateKey,
    publicKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    publicKeyRaw: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url')
  };
  return cachedKeys;
}

/** Forget the cached keypair — used by tests that swap key paths. */
const resetKeys = () => { cachedKeys = null; };

// --- canonical JSON ---------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted at every level. Signing a
 * non-canonical encoding would mean a re-serialised record fails its own
 * signature purely because a key moved.
 */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function sign(payload, keyPath) {
  const { privateKey } = getKeys(keyPath);
  return crypto.sign(null, Buffer.from(canonicalize(payload), 'utf8'), privateKey).toString('base64url');
}

/**
 * Verify a signature. Pass the public key PEM when checking against a specific
 * key; otherwise the local keypair at `keyPath` is used. Passing neither checks
 * against the default key path, which is only ever what you want in-process.
 */
function verify(payload, signature, publicKeyPem, keyPath) {
  const key = publicKeyPem ? crypto.createPublicKey(publicKeyPem) : getKeys(keyPath).publicKey;
  try {
    return crypto.verify(null, Buffer.from(canonicalize(payload), 'utf8'), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

// --- issuance ---------------------------------------------------------------

const newGid = () => `GID-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

/**
 * Issue (or return an existing) Golden ID.
 *
 * Returns `{ gid, record, signature, issued, reason }`. `issued` is false when
 * an existing Golden ID was returned instead of minting a second one.
 */
function issueRecord(store, { verdict, documents = [], sessionIdentifier = '', applicationId = null, userId = null, keyPath } = {}) {
  const consensus = buildConsensus(verdict, { documents });

  const existing = findExisting(store, { record: consensus, documents: consensus.documents });
  if (existing) {
    const found = store.getRecord(existing.gid);
    store.audit({ gid: existing.gid, applicationId, userId, action: 'dedup_hit', actor: sessionIdentifier, detail: existing.reason });
    return {
      gid: existing.gid,
      record: found ? found.record : null,
      signature: found ? found.signature : '',
      issued: false,
      reason: existing.reason
    };
  }

  const gid = newGid();
  const issuedAt = new Date().toISOString();
  const dedupHash = dedupHashForRecord(consensus);

  const record = {
    gid,
    issuedAt,
    status: 'verified_demo',
    fields: consensus.fields,
    documents: consensus.documents.map(document => ({
      type: document.type,
      valid: document.valid,
      repaired: document.repaired,
      // The full number is never embedded in the signed record.
      numberSuffix: document.number ? document.number.slice(-4) : ''
    })),
    disclaimer: 'Prototype record. Not a Government of India credential and not verified against any government system.'
  };

  const signature = sign(record, keyPath);

  store.saveRecord({ gid, applicationId, userId, record, signature, dedupHash, issuedAt });
  linkDocuments(store, gid, consensus.documents);
  store.audit({ gid, applicationId, userId, action: 'issued', actor: sessionIdentifier, detail: `${consensus.documents.length} documents` });

  return { gid, record, signature, issued: true, reason: 'new' };
}

// --- share tokens -----------------------------------------------------------

const ALL_SCOPES = ['holder_name', 'dob', 'gender', 'guardian_name', 'mother_name', 'address', 'documents', 'photo'];

/**
 * Mint a short-lived, scoped, optionally single-use retrieval token.
 * The holder chooses which fields the token releases.
 */
function mintShareToken(store, gid, { scope, ttlMs, singleUse = false, actor = '' } = {}) {
  const record = store.getRecord(gid);
  if (!record) return { error: 'not_found' };
  if (record.revoked) return { error: 'revoked' };

  const requested = Array.isArray(scope) && scope.length ? scope : ['holder_name', 'dob', 'gender'];
  const allowed = requested.filter(field => ALL_SCOPES.includes(field));
  if (!allowed.length) return { error: 'invalid_scope' };

  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + (ttlMs || config.share.defaultTtlMs)).toISOString();

  store.createShareToken({ token, gid, scope: allowed, singleUse, expiresAt });
  store.audit({ gid, action: 'share_token_minted', actor, detail: `scope=${allowed.join(',')} singleUse=${singleUse}` });

  return { token, gid, scope: allowed, expiresAt, singleUse: Boolean(singleUse) };
}

/**
 * Resolve a share token to the record fields it releases.
 * Enforces expiry, single use and revocation, and logs the retrieval.
 */
function redeemShareToken(store, token, { actor = '' } = {}) {
  const share = store.getShareToken(token);
  if (!share) return { error: 'invalid_token' };

  if (new Date(share.expiresAt).getTime() < Date.now()) {
    store.audit({ gid: share.gid, action: 'retrieval_denied', actor, detail: 'expired token' });
    return { error: 'expired' };
  }
  if (share.singleUse && share.usedAt) {
    store.audit({ gid: share.gid, action: 'retrieval_denied', actor, detail: 'single-use token already used' });
    return { error: 'already_used' };
  }

  const stored = store.getRecord(share.gid);
  if (!stored) return { error: 'not_found' };
  if (stored.revoked) {
    store.audit({ gid: share.gid, action: 'retrieval_denied', actor, detail: 'record revoked' });
    return { error: 'revoked' };
  }

  // Project the record down to the released scope, and nothing more.
  const fields = {};
  for (const field of share.scope) {
    if (field === 'documents' || field === 'photo') continue;
    if (stored.record.fields && stored.record.fields[field]) fields[field] = stored.record.fields[field];
  }

  const projected = {
    gid: stored.gid,
    issuedAt: stored.record.issuedAt,
    status: stored.record.status,
    fields,
    disclaimer: stored.record.disclaimer
  };
  if (share.scope.includes('documents')) projected.documents = stored.record.documents;

  if (share.singleUse) store.markShareTokenUsed(token);
  store.audit({ gid: share.gid, action: 'retrieved', actor, detail: `scope=${share.scope.join(',')}` });

  return {
    record: projected,
    scope: share.scope,
    // The signature covers the FULL record; a scoped projection cannot be
    // verified against it, so we say so rather than shipping a signature that
    // will not check out.
    signature: share.scope.length === ALL_SCOPES.length ? stored.signature : null,
    fullRecordSigned: true
  };
}

function revoke(store, gid, { actor = '', reason = '' } = {}) {
  const done = store.revokeRecord(gid, reason);
  if (done) store.audit({ gid, action: 'revoked', actor, detail: reason });
  return done;
}

module.exports = {
  getKeys,
  resetKeys,
  canonicalize,
  sign,
  verify,
  issueRecord,
  mintShareToken,
  redeemShareToken,
  revoke,
  newGid,
  ALL_SCOPES
};
