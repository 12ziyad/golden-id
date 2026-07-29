'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('../config');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const toJson = value => JSON.stringify(value == null ? null : value);
const fromJson = (value, fallback) => {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

/** SHA-256 of the file bytes. Identifies the FILE, never the owner. */
const contentHash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * The extraction cache key. Bytes alone are not enough: if the prompt, schema,
 * extractor or model changes, the same bytes must produce a NEW entry rather
 * than silently serving a read produced by different software.
 */
function extractionKey({ contentHash: hash, extractor, promptVersion, schemaVersion, modelIds }) {
  const material = [hash, extractor, promptVersion, schemaVersion, [].concat(modelIds || []).join(',')].join('|');
  return crypto.createHash('sha256').update(material).digest('hex');
}

/**
 * Add a column to an existing table if it is missing. `CREATE TABLE IF NOT
 * EXISTS` does nothing to a table that already exists, so a database created by
 * an earlier version needs new columns added explicitly.
 */
function ensureColumn(database, table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some(entry => entry.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function open(file = config.db.path) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec(SCHEMA);
  ensureColumn(database, 'extractions', 'field_states', "TEXT NOT NULL DEFAULT '{}'");
  return database;
}

/**
 * Data access. Every method that touches identity data takes an owner scope and
 * filters on it in SQL. There is deliberately no way to read a document, a
 * correction or a face embedding by hash alone.
 */
function createStore(file = config.db.path) {
  const database = open(file);
  const run = (sql, ...args) => database.prepare(sql).run(...args);
  const get = (sql, ...args) => database.prepare(sql).get(...args);
  const all = (sql, ...args) => database.prepare(sql).all(...args);

  const store = {
    database,
    contentHash,
    extractionKey,

    close() { database.close(); },

    // -- users --------------------------------------------------------------

    /** Find or create the durable user behind an OTP identifier. */
    upsertUser(identifier) {
      const existing = get('SELECT * FROM users WHERE identifier = ?', identifier);
      if (existing) return { id: existing.id, identifier: existing.identifier, createdAt: existing.created_at };
      const userId = id();
      run('INSERT INTO users (id, identifier, created_at) VALUES (?, ?, ?)', userId, identifier, now());
      return { id: userId, identifier, createdAt: now() };
    },

    getUser(userId) {
      const row = get('SELECT * FROM users WHERE id = ?', userId);
      return row ? { id: row.id, identifier: row.identifier, createdAt: row.created_at } : null;
    },

    // -- applications -------------------------------------------------------

    createApplication(userId) {
      const applicationId = id();
      run('INSERT INTO applications (id, user_id, status, created_at) VALUES (?, ?, ?, ?)',
        applicationId, userId, 'open', now());
      return store.getApplication(applicationId, userId);
    },

    /** Always scoped: an application is only readable by the user who owns it. */
    getApplication(applicationId, userId) {
      const row = userId
        ? get('SELECT * FROM applications WHERE id = ? AND user_id = ?', applicationId, userId)
        : get('SELECT * FROM applications WHERE id = ?', applicationId);
      if (!row) return null;
      return {
        id: row.id, userId: row.user_id, status: row.status, decision: row.decision,
        gid: row.gid, createdAt: row.created_at, closedAt: row.closed_at
      };
    },

    listApplications(userId) {
      return all('SELECT id, status, decision, gid, created_at FROM applications WHERE user_id = ? ORDER BY created_at DESC', userId)
        .map(row => ({ id: row.id, status: row.status, decision: row.decision, gid: row.gid, createdAt: row.created_at }));
    },

    updateApplication(applicationId, userId, patch = {}) {
      const owned = store.getApplication(applicationId, userId);
      if (!owned) return null;
      run('UPDATE applications SET status = ?, decision = ?, gid = ?, closed_at = ? WHERE id = ? AND user_id = ?',
        patch.status ?? owned.status,
        patch.decision ?? owned.decision,
        patch.gid ?? owned.gid,
        patch.closedAt ?? owned.closedAt,
        applicationId, userId);
      return store.getApplication(applicationId, userId);
    },

    // -- upload batches -----------------------------------------------------

    createBatch(applicationId, { source = 'files', fileCount = 0, byteSize = 0 } = {}) {
      const batchId = id();
      run('INSERT INTO upload_batches (id, application_id, source, file_count, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        batchId, applicationId, source, fileCount, byteSize, now());
      return batchId;
    },

    // -- documents ----------------------------------------------------------

    /**
     * Create the owned reference to an uploaded file. A cache hit on the
     * extraction never skips this: every application gets its own row.
     */
    createDocument(record) {
      const documentId = record.id || id();
      const timestamp = now();
      run(`INSERT INTO documents
        (id, application_id, upload_batch_id, content_hash, extraction_key, file_name, relative_path,
         detected_mime, byte_size, page_number, page_role, doc_type, status, status_reason, quality, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        documentId, record.applicationId, record.uploadBatchId, record.contentHash,
        record.extractionKey || null, record.fileName || '', record.relativePath || '',
        record.detectedMime || '', record.byteSize || 0, record.pageNumber || 1,
        record.pageRole || 'front', record.docType || 'unknown',
        record.status || 'pending', record.statusReason || '',
        toJson(record.quality || {}), timestamp, timestamp);
      return documentId;
    },

    updateDocument(documentId, applicationId, patch = {}) {
      const owned = store.getDocument(documentId, applicationId);
      if (!owned) return null;
      run(`UPDATE documents SET extraction_key = ?, doc_type = ?, status = ?, status_reason = ?,
             quality = ?, page_role = ?, updated_at = ?
           WHERE id = ? AND application_id = ?`,
        patch.extractionKey ?? owned.extractionKey ?? null,
        // `detectedType` is what the hydrated document calls the stored
        // doc_type; `type` may carry a holder correction and must not be
        // written back over the backend's classification.
        patch.docType ?? owned.detectedType ?? 'unknown',
        patch.status ?? owned.status,
        patch.statusReason ?? owned.statusReason,
        toJson(patch.quality ?? owned.quality),
        patch.pageRole ?? owned.pageRole,
        now(), documentId, applicationId);
      return store.getDocument(documentId, applicationId);
    },

    /**
     * Read one document. `applicationId` is REQUIRED — this is the join that
     * makes it impossible to pull another applicant's document into a
     * comparison by guessing an id or a hash.
     */
    getDocument(documentId, applicationId) {
      const row = get('SELECT * FROM documents WHERE id = ? AND application_id = ?', documentId, applicationId);
      return row ? store._hydrateDocument(row) : null;
    },

    listDocuments(applicationId) {
      return all('SELECT * FROM documents WHERE application_id = ? ORDER BY created_at ASC', applicationId)
        .map(row => store._hydrateDocument(row));
    },

    /** Resolve client-supplied document ids, keeping ONLY those actually owned. */
    resolveOwnedDocuments(documentIds, applicationId) {
      const owned = [];
      const rejected = [];
      for (const documentId of documentIds || []) {
        const found = store.getDocument(documentId, applicationId);
        if (found) owned.push(found);
        else rejected.push(documentId);
      }
      return { owned, rejected };
    },

    _hydrateDocument(row) {
      const corrections = store.correctionsFor(row.id);
      const extraction = row.extraction_key ? store.getExtractionByKey(row.extraction_key) : null;
      const rawFields = extraction ? extraction.rawFields : {};
      // Corrections are applied on read and never written back into the
      // immutable extraction.
      const fields = { ...valuesOf(rawFields), ...corrections };

      // Per-field state, with corrections recorded for what they are: a value
      // the HOLDER asserts, not one we located on the page. A correction can
      // make a field usable, but it can never claim the document printed it.
      const states = { ...(extraction ? extraction.fieldStates : {}) };
      for (const field of Object.keys(corrections)) {
        const printed = states[field] || {};
        states[field] = {
          status: 'present_verified',
          verified: true,
          source: 'user',
          reason: printed.status === 'not_present'
            ? 'user_supplied_value_not_printed_on_document'
            : 'user_corrected_printed_value',
          // What the document itself showed, kept alongside the correction.
          documentStatus: printed.status || 'not_present',
          documentValue: printed.rawValue ?? null,
          evidenceText: printed.evidenceText ?? null
        };
      }
      return {
        id: row.id,
        applicationId: row.application_id,
        uploadBatchId: row.upload_batch_id,
        contentHash: row.content_hash,
        extractionKey: row.extraction_key,
        fileName: row.file_name,
        relativePath: row.relative_path,
        detectedMime: row.detected_mime,
        byteSize: row.byte_size,
        pageNumber: row.page_number,
        pageRole: row.page_role,
        // A holder correction to the type outranks both model and backend.
        type: corrections.document_type || row.doc_type,
        detectedType: row.doc_type,
        status: row.status,
        statusReason: row.status_reason,
        quality: fromJson(row.quality, {}),
        fields,
        fieldStates: states,
        rawFields,
        corrections,
        confidence: extraction ? extraction.confidence : {},
        candidates: extraction ? extraction.candidates : {},
        validation: extraction ? extraction.validation : {},
        classification: extraction ? extraction.classification : {},
        source: extraction ? extraction.source : '',
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    },

    // -- extractions (immutable, byte+version scoped, NO ownership) ----------

    getExtractionByKey(key) {
      const row = get('SELECT * FROM extractions WHERE extraction_key = ?', key);
      if (!row) return null;
      return {
        extractionKey: row.extraction_key,
        contentHash: row.content_hash,
        extractor: row.extractor,
        promptVersion: row.prompt_version,
        schemaVersion: row.schema_version,
        modelIds: row.model_ids,
        rawFields: fromJson(row.raw_fields, {}),
        fieldStates: fromJson(row.field_states, {}),
        type: row.doc_type,
        confidence: fromJson(row.confidence, {}),
        candidates: fromJson(row.candidates, {}),
        validation: fromJson(row.validation, {}),
        classification: fromJson(row.classification, {}),
        source: row.source,
        createdAt: row.created_at
      };
    },

    saveExtraction(record) {
      const key = record.extractionKey || extractionKey(record);
      run(`INSERT INTO extractions
        (extraction_key, content_hash, extractor, prompt_version, schema_version, model_ids,
         raw_fields, field_states, doc_type, confidence, candidates, validation, classification, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(extraction_key) DO NOTHING`,
        key, record.contentHash, record.extractor || '', record.promptVersion || '',
        record.schemaVersion || '', [].concat(record.modelIds || []).join(','),
        toJson(record.rawFields || {}), toJson(record.fieldStates || {}), record.type || 'unknown',
        toJson(record.confidence || {}), toJson(record.candidates || {}),
        toJson(record.validation || {}), toJson(record.classification || {}),
        record.source || '', now());
      return store.getExtractionByKey(key);
    },

    // -- corrections (owned, attributed) ------------------------------------

    /** Record a holder correction. Raw extraction is never mutated. */
    setCorrection(documentId, applicationId, field, value, actor = '') {
      if (!store.getDocument(documentId, applicationId)) return null;
      run('DELETE FROM corrections WHERE document_id = ? AND field = ?', documentId, field);
      if (value != null && String(value).trim() !== '') {
        run('INSERT INTO corrections (id, application_id, document_id, field, value, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          id(), applicationId, documentId, field, String(value).trim(), actor, now());
      }
      return store.getDocument(documentId, applicationId);
    },

    correctionsFor(documentId) {
      const rows = all('SELECT field, value FROM corrections WHERE document_id = ?', documentId);
      return Object.fromEntries(rows.map(row => [row.field, row.value]));
    },

    // -- face embeddings (owned) --------------------------------------------

    setFace(documentId, applicationId, face) {
      if (!store.getDocument(documentId, applicationId)) return false;
      run(`INSERT INTO face_embeddings (document_id, application_id, embedding, box, quality, detector, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(document_id) DO UPDATE SET
             embedding = excluded.embedding, box = excluded.box,
             quality = excluded.quality, detector = excluded.detector`,
        documentId, applicationId, toJson(face.embedding || []), toJson(face.box || []),
        toJson(face.quality || {}), face.detector || '', now());
      return true;
    },

    getFace(documentId, applicationId) {
      const row = get('SELECT * FROM face_embeddings WHERE document_id = ? AND application_id = ?', documentId, applicationId);
      if (!row) return null;
      return {
        documentId: row.document_id,
        embedding: fromJson(row.embedding, []),
        box: fromJson(row.box, []),
        quality: fromJson(row.quality, {}),
        detector: row.detector
      };
    },

    // -- logical documents --------------------------------------------------

    createLogicalDocument({ applicationId, docType, documentIds, grouping }) {
      const logicalId = id();
      run('INSERT INTO logical_documents (id, application_id, doc_type, document_ids, grouping, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        logicalId, applicationId, docType || 'unknown', toJson(documentIds || []), toJson(grouping || {}), now());
      return logicalId;
    },

    listLogicalDocuments(applicationId) {
      return all('SELECT * FROM logical_documents WHERE application_id = ? ORDER BY created_at ASC', applicationId)
        .map(row => ({
          id: row.id, applicationId: row.application_id, docType: row.doc_type,
          documentIds: fromJson(row.document_ids, []), grouping: fromJson(row.grouping, {}), createdAt: row.created_at
        }));
    },

    clearLogicalDocuments(applicationId) {
      run('DELETE FROM logical_documents WHERE application_id = ?', applicationId);
    },

    // -- comparisons --------------------------------------------------------

    saveComparison({ applicationId, documentIds, verdict, decision, integrity }) {
      const comparisonId = id();
      run('INSERT INTO comparisons (id, application_id, document_ids, verdict, decision, integrity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        comparisonId, applicationId, toJson(documentIds || []), toJson(verdict || {}),
        decision || '', toJson(integrity || {}), now());
      return comparisonId;
    },

    getComparison(comparisonId, applicationId) {
      const row = get('SELECT * FROM comparisons WHERE id = ? AND application_id = ?', comparisonId, applicationId);
      if (!row) return null;
      return {
        id: row.id, applicationId: row.application_id,
        documentIds: fromJson(row.document_ids, []), verdict: fromJson(row.verdict, {}),
        decision: row.decision, integrity: fromJson(row.integrity, {}), createdAt: row.created_at
      };
    },

    latestComparison(applicationId) {
      const row = get('SELECT * FROM comparisons WHERE application_id = ? ORDER BY created_at DESC LIMIT 1', applicationId);
      return row ? store.getComparison(row.id, applicationId) : null;
    },

    // -- records ------------------------------------------------------------

    saveRecord(record) {
      run(`INSERT INTO records (gid, application_id, user_id, record, signature, dedup_hash, revoked, revoked_at, issued_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
        record.gid, record.applicationId || null, record.userId || null,
        toJson(record.record), record.signature || '', record.dedupHash || '', record.issuedAt || now());
      return store.getRecord(record.gid);
    },

    getRecord(gid) {
      const row = get('SELECT * FROM records WHERE gid = ?', gid);
      if (!row) return null;
      return {
        gid: row.gid, applicationId: row.application_id, userId: row.user_id,
        record: fromJson(row.record, {}), signature: row.signature, dedupHash: row.dedup_hash,
        revoked: Boolean(row.revoked), revokedAt: row.revoked_at, revokedReason: row.revoked_reason,
        issuedAt: row.issued_at
      };
    },

    findRecordByDedupHash(hash) {
      const row = get('SELECT gid FROM records WHERE dedup_hash = ? AND revoked = 0', hash);
      return row ? store.getRecord(row.gid) : null;
    },

    revokeRecord(gid, reason = '') {
      const result = run('UPDATE records SET revoked = 1, revoked_at = ?, revoked_reason = ? WHERE gid = ?', now(), reason, gid);
      return result.changes > 0;
    },

    linkDocumentNumber(number, docType, gid) {
      run('INSERT INTO document_numbers (number, doc_type, gid) VALUES (?, ?, ?) ON CONFLICT(number, doc_type) DO NOTHING',
        number, docType, gid);
    },

    findGidByDocumentNumber(number) {
      const row = get(`SELECT d.gid FROM document_numbers d
                       JOIN records r ON r.gid = d.gid AND r.revoked = 0
                       WHERE d.number = ?`, number);
      return row ? row.gid : null;
    },

    // -- share tokens -------------------------------------------------------

    createShareToken({ token, gid, scope, singleUse, expiresAt }) {
      run('INSERT INTO share_tokens (token, gid, scope, single_use, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)',
        token, gid, toJson(scope || []), singleUse ? 1 : 0, expiresAt, now());
      return { token, gid, scope: scope || [], singleUse: Boolean(singleUse), expiresAt };
    },

    getShareToken(token) {
      const row = get('SELECT * FROM share_tokens WHERE token = ?', token);
      if (!row) return null;
      return {
        token: row.token, gid: row.gid, scope: fromJson(row.scope, []),
        singleUse: Boolean(row.single_use), expiresAt: row.expires_at,
        usedAt: row.used_at, createdAt: row.created_at
      };
    },

    markShareTokenUsed(token) {
      run('UPDATE share_tokens SET used_at = ? WHERE token = ?', now(), token);
    },

    // -- audit --------------------------------------------------------------

    audit(entry) {
      run('INSERT INTO audit (gid, application_id, user_id, action, actor, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        entry.gid || '', entry.applicationId || '', entry.userId || '',
        entry.action, entry.actor || '',
        typeof entry.detail === 'string' ? entry.detail : toJson(entry.detail || ''), now());
    },

    auditFor(gid) {
      return all('SELECT * FROM audit WHERE gid = ? ORDER BY id ASC', gid);
    },

    auditForApplication(applicationId) {
      return all('SELECT * FROM audit WHERE application_id = ? ORDER BY id ASC', applicationId);
    }
  };

  return store;
}

/**
 * Collapse per-field evidence envelopes down to plain values for comparison.
 *
 * ONLY an `extracted` field yields a value. Falling back to `raw_value` would
 * resurrect exactly what the capability registry rejected — a hallucinated
 * passport father_name is stored with its raw value for audit, and must never
 * escape back into comparison or consensus through this function.
 */
function valuesOf(rawFields) {
  const out = {};
  for (const [field, envelope] of Object.entries(rawFields || {})) {
    if (envelope && typeof envelope === 'object' && 'raw_value' in envelope) {
      // Only a VERIFIED field yields a comparable value. An uncertain read —
      // one we could not locate on the page — is kept in `rawFields` for
      // display, but must never reach comparison, where it could contradict a
      // value we actually can evidence.
      out[field] = envelope.status === 'present_verified'
        ? (envelope.normalized_value ?? envelope.raw_value ?? null)
        : null;
    } else {
      out[field] = envelope;
    }
  }
  return out;
}

let shared = null;
const getStore = () => (shared ||= createStore());
const resetStore = () => { shared = null; };

module.exports = { createStore, getStore, resetStore, contentHash, extractionKey, open, valuesOf };
