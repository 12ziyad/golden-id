'use strict';

const { config } = require('./config');
const { flags } = require('./flags');
const { getStore } = require('./db');
const { createUploadStore, decodeDataUri } = require('./uploads');
const { createExtractor } = require('./extract');
const { discover, LIMITS } = require('./upload/discover');
const { compareDocuments } = require('./compare');
const { DECISIONS } = require('./compare/decision');
const { plainValues } = require('./extract/schema');
const { embedAll } = require('./face/embed');
const { matchFaces } = require('./face/match');
const { groupPages } = require('./upload/grouping');
const { issueRecord } = require('./record/issue');

// The application workflow, kept out of the HTTP layer.
//
// EVERY method here takes an application scope and never accepts a bare content
// hash from a client. That is the structural fix for the contamination bug: a
// document is reachable only through the application that owns it.

const DOCUMENT_LABELS = {
  birth_certificate: 'Birth Certificate',
  aadhaar: 'Aadhaar Card',
  pan: 'PAN Card',
  passport: 'Passport',
  voter: 'Voter ID',
  driving_licence: 'Driving Licence',
  unknown: 'Unrecognised document'
};

// A document must reach one of these before comparison may run.
const FINAL_STATUSES = new Set(['ready', 'unreadable', 'retake_required', 'rejected_file', 'removed_by_user']);

const mask = value => {
  const clean = String(value || '').replace(/\s/g, '');
  return clean.length > 4 ? `${'*'.repeat(Math.min(clean.length - 4, 8))}${clean.slice(-4)}` : '****';
};

/**
 * Replace every occurrence of the given full numbers anywhere in a payload —
 * fields, raw envelopes, evidence snippets, candidates, classification notes.
 * Walks a COPY; the hydrated document (and the extraction it aliases) is never
 * touched.
 */
const redactNumbers = (node, numbers) => {
  if (node == null || !numbers.length) return node;
  if (typeof node === 'string') {
    return numbers.reduce(
      (value, number) => value.includes(number) ? value.split(number).join(mask(number)) : value,
      node
    );
  }
  if (Array.isArray(node)) return node.map(item => redactNumbers(item, numbers));
  if (typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node)) out[key] = redactNumbers(node[key], numbers);
    return out;
  }
  return node;
};

function createWorkflow(options = {}) {
  const store = options.store || getStore();
  const uploads = options.uploads || createUploadStore();
  const extractor = options.extractor || createExtractor({ store });
  const faceEmbedder = options.faceEmbedder;

  const workflow = {
    store,
    uploads,
    extractor,

    // -- applications -------------------------------------------------------

    /** Start a fresh application. Nothing is ever carried over from a previous one. */
    startApplication(userId) {
      return store.createApplication(userId);
    },

    /** Resolve an application the caller actually owns, or null. */
    ownedApplication(applicationId, userId) {
      return store.getApplication(applicationId, userId);
    },

    // -- ingestion ----------------------------------------------------------

    /**
     * Discover, register and extract an upload.
     *
     * `files` are `[{ name, relativePath, data | text }]`. Folders and ZIPs
     * arrive as their constituent files; a ZIP arrives as one file and is
     * expanded here with full path/bomb/type guards.
     */
    async ingest({ applicationId, userId, files, source = 'files' }) {
      const application = store.getApplication(applicationId, userId);
      if (!application) return { error: 'application_not_found' };

      // 1. Decode to bytes.
      const inputs = [];
      for (const file of files || []) {
        const decoded = file.data ? decodeDataUri(file.data) : null;
        const buffer = decoded
          ? decoded.buffer
          : (file.text != null ? Buffer.from(String(file.text), 'utf8') : null);
        if (!buffer || !buffer.length) continue;
        inputs.push({ name: file.name || 'document', relativePath: file.relativePath || '', buffer });
      }

      // 2. Discover: expand archives and PDFs, sniff real types, apply limits.
      const discovered = flags.bulkUpload
        ? await discover(inputs, { limits: LIMITS })
        : {
          files: inputs.map(input => ({ ...input, mimeType: 'image/jpeg', pageNumber: 1 })),
          skipped: [], limitsHit: [], totalBytes: inputs.reduce((sum, input) => sum + input.buffer.length, 0)
        };

      const existing = store.listDocuments(applicationId);
      const room = LIMITS.maxFiles - existing.length;
      const accepted = discovered.files.slice(0, Math.max(0, room));
      const overflow = discovered.files.length - accepted.length;

      const batchId = store.createBatch(applicationId, {
        source, fileCount: accepted.length, byteSize: discovered.totalBytes
      });

      // 3. Register each discovered file as an OWNED document row, before any
      //    extraction. A cache hit later reuses the extraction, never the row.
      const registered = accepted.map(file => {
        const documentId = store.createDocument({
          applicationId,
          uploadBatchId: batchId,
          contentHash: store.contentHash(file.buffer),
          fileName: file.name,
          relativePath: file.relativePath || '',
          detectedMime: file.mimeType,
          byteSize: file.buffer.length,
          pageNumber: file.pageNumber || 1,
          status: 'pending'
        });
        uploads.put(file.buffer, file.mimeType);
        return { documentId, file };
      });

      // 4. Extract in parallel, each document independently.
      const results = await extractor.extractAll(registered.map(item => ({
        buffer: item.file.buffer,
        mimeType: item.file.mimeType,
        fileName: item.file.name
      })));

      results.forEach((result, index) => {
        const { documentId } = registered[index];
        const status = result.failed ? 'unreadable'
          : result.retakeRequired ? 'retake_required'
            : result.type === 'unknown' ? 'unreadable'
              : 'ready';
        const reason = result.retakeRequired
          ? (result.quality?.reasons || []).map(item => item.detail).join(' ')
          : result.failed ? (result.error || 'Extraction failed.')
            : result.type === 'unknown' ? 'The document type could not be determined.'
              : '';

        store.updateDocument(documentId, applicationId, {
          extractionKey: result.extractionKey,
          docType: result.type,
          status,
          statusReason: reason,
          quality: result.quality || {}
        });
      });

      store.audit({
        applicationId, userId, action: 'documents_ingested',
        detail: `${registered.length} document(s) from ${source}`
      });

      return {
        applicationId,
        batchId,
        documents: store.listDocuments(applicationId).map(workflow.presentDocument),
        skipped: discovered.skipped,
        limitsHit: [...discovered.limitsHit, ...(overflow > 0 ? ['max_files'] : [])],
        overflow
      };
    },

    /** Shape a document for the API. Numbers are masked in transit. */
    presentDocument(document) {
      const values = plainValues(document.rawFields || {});
      const merged = { ...values, ...document.corrections };

      // Every spelling of the document number this document is known by. The
      // whole outgoing payload is scrubbed of them, not just validation.number:
      // raw envelopes, evidence text and candidates all used to leak the full
      // value while the "masked" field sat beside them.
      const numberEnvelope = (document.rawFields || {}).document_number || {};
      const numbers = [...new Set(
        [
          merged.document_number,
          numberEnvelope.raw_value,
          numberEnvelope.normalized_value,
          document.validation && document.validation.number
        ].filter(value => typeof value === 'string' && value.replace(/\s/g, '').length > 4)
      )].sort((a, b) => b.length - a.length);

      return redactNumbers({
        id: document.id,
        file: document.fileName,
        relativePath: document.relativePath,
        type: document.type,
        detectedType: document.detectedType,
        label: DOCUMENT_LABELS[document.type] || DOCUMENT_LABELS.unknown,
        pageRole: document.pageRole,
        pageNumber: document.pageNumber,
        status: document.status,
        statusReason: document.statusReason,
        quality: document.quality,
        fields: merged,
        rawFields: document.rawFields,
        fieldStates: document.fieldStates,
        corrections: document.corrections,
        confidence: document.confidence,
        candidates: document.candidates,
        classification: document.classification,
        validation: {
          ...document.validation,
          number: document.validation && document.validation.number ? mask(document.validation.number) : ''
        },
        source: document.source
      }, numbers);
    },

    // -- corrections --------------------------------------------------------

    correctField({ applicationId, userId, documentId, field, value, actor }) {
      if (!store.getApplication(applicationId, userId)) return { error: 'application_not_found' };
      const updated = store.setCorrection(documentId, applicationId, field, value, actor || '');
      if (!updated) return { error: 'document_not_found' };
      store.audit({ applicationId, userId, action: 'field_corrected', actor, detail: field });
      return { document: workflow.presentDocument(updated) };
    },

    removeDocument({ applicationId, userId, documentId }) {
      if (!store.getApplication(applicationId, userId)) return { error: 'application_not_found' };
      const updated = store.updateDocument(documentId, applicationId, { status: 'removed_by_user' });
      if (!updated) return { error: 'document_not_found' };
      return { document: workflow.presentDocument(updated) };
    },

    // -- comparison ---------------------------------------------------------

    /**
     * Compare the NAMED documents of ONE application.
     *
     * The contract is explicit: the caller lists exactly which documents take
     * part. "Compare whatever happens to be in the application" is how removed
     * and stale documents used to sneak back into verdicts. Every id must be
     * unique, owned by this application and not removed. An id belonging to
     * another application is not merely ignored — it is an integrity failure
     * that blocks issuance outright.
     */
    async compare({ applicationId, userId, documentIds }) {
      const application = store.getApplication(applicationId, userId);
      if (!application) return { error: 'application_not_found' };

      if (!Array.isArray(documentIds) || documentIds.length === 0) {
        return { error: 'document_ids_required' };
      }
      const ids = documentIds.map(value => String(value));
      const duplicates = [...new Set(ids.filter((value, index) => ids.indexOf(value) !== index))];
      if (duplicates.length) {
        return { error: 'duplicate_document_ids', ids: duplicates };
      }

      const integrity = { ok: true, failures: [] };
      const resolved = store.resolveOwnedDocuments(ids, applicationId);
      const selected = resolved.owned;
      if (resolved.rejected.length && flags.enforceOwnership) {
        integrity.ok = false;
        integrity.failures.push({
          code: 'foreign_document_reference',
          detail: `${resolved.rejected.length} document reference(s) do not belong to this application and were refused.`
        });
        store.audit({
          applicationId, userId, action: 'integrity_block',
          detail: `foreign document ids: ${resolved.rejected.length}`
        });
      }

      // Selecting a removed document is a caller error — unless integrity has
      // already failed, in which case the blocked verdict must proceed and be
      // recorded rather than masked by a validation response.
      if (integrity.ok) {
        const removedSelected = selected.filter(document => document.status === 'removed_by_user');
        if (removedSelected.length) {
          return { error: 'removed_document_selected', ids: removedSelected.map(document => document.id) };
        }
      }

      const active = selected.filter(document => document.status !== 'removed_by_user');

      // The exact selection is auditable: which documents fed which comparison.
      store.audit({
        applicationId, userId, action: 'comparison_requested', detail: JSON.stringify(ids)
      });

      // The barrier: comparison must not begin while anything is still working.
      const pending = active.filter(document => !FINAL_STATUSES.has(document.status));
      if (flags.enforceComparisonBarrier && pending.length) {
        return {
          error: 'documents_still_processing',
          pending: pending.map(document => ({ id: document.id, file: document.fileName, status: document.status }))
        };
      }

      const usable = active.filter(document => document.status === 'ready');

      // Face comparison, strictly within this application.
      const faceInputs = usable.map(document => {
        const cached = store.getFace(document.id, applicationId);
        return {
          type: document.type,
          documentId: document.id,
          face: cached && cached.embedding.length ? cached : null,
          buffer: cached ? null : uploads.read(document.contentHash)
        };
      });

      const embedded = await embedAll(faceInputs, {
        embedder: faceEmbedder,
        onEmbedded: (documentId, face) => {
          store.setFace(documentId, applicationId, face);
          const document = usable.find(item => item.id === documentId);
          // Extraction and the face embedding are both cached, so the source
          // scan has served its purpose.
          if (document) uploads.remove(document.contentHash);
        },
        keyBy: 'documentId'
      });

      const unavailable = embedded.find(item => item.available === false);
      const face = matchFaces(
        embedded.map(item => ({ type: item.type, face: item.face })),
        unavailable ? { available: false, reason: unavailable.reason } : {}
      );

      // Group front/back pages within this application only. The mapping from
      // document to logical document is what stops one card's two sides from
      // counting as two corroborating sources.
      store.clearLogicalDocuments(applicationId);
      const groups = groupPages(usable);
      const logicalOf = new Map();
      for (const group of groups) {
        const logicalId = store.createLogicalDocument({
          applicationId, docType: group.type,
          documentIds: group.documentIds, grouping: group.reason
        });
        for (const memberId of group.documentIds) logicalOf.set(memberId, logicalId);
      }

      const verdict = compareDocuments(
        usable.map(document => ({
          id: document.id,
          logicalId: logicalOf.get(document.id) || document.id,
          type: document.type,
          pageRole: document.pageRole,
          fields: { ...plainValues(document.rawFields), ...document.corrections },
          fieldStates: document.fieldStates,
          source: document.source,
          status: document.status,
          fileName: document.fileName,
          statusReason: document.statusReason
        })),
        { face, integrity }
      );

      const comparisonId = store.saveComparison({
        applicationId,
        documentIds: usable.map(document => document.id),
        verdict: { ...verdict, face },
        decision: verdict.decision,
        integrity
      });

      store.updateApplication(applicationId, userId, { status: verdict.decision, decision: verdict.decision });

      return {
        applicationId,
        comparisonId,
        verdict,
        face,
        integrity,
        decision: verdict.decision,
        documents: active.map(workflow.presentDocument),
        logicalDocuments: store.listLogicalDocuments(applicationId),
        selected: usable.map(document => document.id)
      };
    },

    // -- issuance -----------------------------------------------------------

    /**
     * Issue a Golden ID. Refuses unless the decision permits it AND the
     * issuance flag is on. Integrity failures can never be overridden.
     */
    issue({ applicationId, userId, comparison, actor }) {
      const application = store.getApplication(applicationId, userId);
      if (!application) return { error: 'application_not_found' };

      if (!comparison.verdict.issuable) {
        store.audit({ applicationId, userId, action: 'issuance_refused', actor, detail: comparison.verdict.decision });
        return { error: 'not_issuable', decision: comparison.verdict.decision, summary: comparison.verdict.summary };
      }
      if (!flags.issuanceEnabled) {
        store.audit({ applicationId, userId, action: 'issuance_blocked_by_flag', actor });
        return { error: 'issuance_disabled', decision: DECISIONS.BLOCKED_SECURITY_INTEGRITY };
      }

      // Only the documents that actually fed the comparison back the record —
      // never "whatever else happens to be ready in the application".
      const selectedIds = new Set(comparison.selected || []);
      const documents = store.listDocuments(applicationId)
        .filter(document => document.status === 'ready' && (selectedIds.size === 0 || selectedIds.has(document.id)));
      const result = issueRecord(store, {
        verdict: comparison.verdict,
        documents: documents.map(document => ({
          type: document.type,
          validation: document.validation,
          fields: { ...plainValues(document.rawFields), ...document.corrections },
          source: document.source
        })),
        applicationId,
        userId,
        sessionIdentifier: actor || ''
      });

      if (result.gid) store.updateApplication(applicationId, userId, { gid: result.gid, status: 'issued' });
      return result;
    }
  };

  return workflow;
}

module.exports = { createWorkflow, DOCUMENT_LABELS, FINAL_STATUSES, mask };
