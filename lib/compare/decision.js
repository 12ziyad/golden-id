'use strict';

const { isHolderSource } = require('./cluster');

// Explicit decision states.
//
// A binary match/reject cannot express the difference between "these are two
// different people", "we could not read the date of birth", and "one document
// in this comparison belongs to somebody else". Those need different responses
// from the holder, the operator and the system, so they are different states.

const DECISIONS = {
  VERIFIED_MATCH: 'verified_match',
  // Every shared field agreed, and some fields came from a single document
  // because no other document prints them. That is normal — an Aadhaar carries
  // a gender a PAN never will — and is not a reason to withhold a credential.
  VERIFIED_NO_CONFLICT: 'verified_no_conflict',
  VERIFIED_WITH_PARTIAL_OVERLAP: 'verified_with_partial_overlap',
  LIKELY_MATCH_NEEDS_CONFIRMATION: 'likely_match_needs_confirmation',
  INSUFFICIENT_EVIDENCE: 'insufficient_evidence',
  EXTRACTION_FAILED: 'extraction_failed',
  DOCUMENT_CONFLICT: 'document_conflict',
  SUSPECTED_CROSS_IDENTITY: 'suspected_cross_identity',
  REJECTED_INVALID_DOCUMENT: 'rejected_invalid_document',
  BLOCKED_SECURITY_INTEGRITY: 'blocked_security_integrity',
  RETAKE_REQUIRED: 'retake_required'
};

// Only these permit a Golden ID to be minted.
const ISSUABLE = new Set([
  DECISIONS.VERIFIED_MATCH,
  DECISIONS.VERIFIED_NO_CONFLICT,
  DECISIONS.VERIFIED_WITH_PARTIAL_OVERLAP
]);

// These require a human, not just the holder clicking "confirm".
const NEEDS_MANUAL_REVIEW = new Set([
  DECISIONS.DOCUMENT_CONFLICT,
  DECISIONS.SUSPECTED_CROSS_IDENTITY,
  DECISIONS.BLOCKED_SECURITY_INTEGRITY
]);

const HUMAN_READABLE = {
  [DECISIONS.VERIFIED_MATCH]: 'The documents agree and a Golden ID can be issued.',
  [DECISIONS.VERIFIED_NO_CONFLICT]: 'Nothing the documents share disagrees. Some details come from a single document because the others do not print them.',
  [DECISIONS.VERIFIED_WITH_PARTIAL_OVERLAP]: 'The documents overlap on some details and agree on all of them. The rest are single-source and recorded with their provenance.',
  [DECISIONS.LIKELY_MATCH_NEEDS_CONFIRMATION]: 'The documents almost certainly describe the same person, but some details need your confirmation.',
  [DECISIONS.INSUFFICIENT_EVIDENCE]: 'There is not enough readable evidence to decide. Add another document or correct the fields we could not read.',
  [DECISIONS.EXTRACTION_FAILED]: 'None of the uploaded documents could be read.',
  [DECISIONS.DOCUMENT_CONFLICT]: 'The documents disagree on details that identify a person. This needs manual review.',
  [DECISIONS.SUSPECTED_CROSS_IDENTITY]: 'These documents appear to describe more than one person.',
  [DECISIONS.REJECTED_INVALID_DOCUMENT]: 'A document failed its own format or checksum validation.',
  [DECISIONS.BLOCKED_SECURITY_INTEGRITY]: 'An integrity check failed. Issuance is blocked and this has been recorded.',
  [DECISIONS.RETAKE_REQUIRED]: 'One or more images are not clear enough to read. Please retake them.'
};

// Identity-defining fields. Only a genuine disagreement on these can conflict.
const IDENTITY_FIELDS = new Set(['holder_name', 'dob', 'gender']);

// Minimum independent evidence before a credential may be minted.
const MINIMUM_AGREEING_DOCUMENTS = 2;
const REQUIRED_CONSENSUS_FIELDS = ['holder_name', 'dob'];

/**
 * Decide the outcome of a comparison.
 *
 * `input`:
 *   fields      clustered field results
 *   integrity   { ok, failures: [...] }  — ownership / cross-identity checks
 *   documents   [{ type, status, validation }]
 *
 * Integrity always wins: no amount of field agreement can override a document
 * that does not belong to this application.
 */
function decide({ fields = [], integrity = { ok: true, failures: [] }, documents = [], face = null } = {}) {
  const reasons = [];

  // 1. Integrity first, unconditionally.
  if (integrity && integrity.ok === false) {
    return {
      decision: DECISIONS.BLOCKED_SECURITY_INTEGRITY,
      issuable: false,
      needsManualReview: true,
      reasons: (integrity.failures || []).map(failure => ({
        code: failure.code || 'integrity_failure',
        detail: failure.detail || 'An integrity check failed.'
      })),
      summary: HUMAN_READABLE[DECISIONS.BLOCKED_SECURITY_INTEGRITY]
    };
  }

  // 2. Document-level states before field logic.
  const usable = documents.filter(document => document.status === 'ready');
  const needRetake = documents.filter(document => document.status === 'retake_required');
  const invalid = documents.filter(document => document.status === 'rejected_file');

  if (documents.length && !usable.length) {
    if (needRetake.length) {
      return {
        decision: DECISIONS.RETAKE_REQUIRED, issuable: false, needsManualReview: false,
        reasons: needRetake.map(document => ({ code: 'retake_required', detail: `${document.fileName || document.type}: ${document.statusReason || 'image quality too low'}` })),
        summary: HUMAN_READABLE[DECISIONS.RETAKE_REQUIRED]
      };
    }
    if (invalid.length) {
      return {
        decision: DECISIONS.REJECTED_INVALID_DOCUMENT, issuable: false, needsManualReview: false,
        reasons: invalid.map(document => ({ code: 'invalid_document', detail: document.statusReason || 'Document failed validation.' })),
        summary: HUMAN_READABLE[DECISIONS.REJECTED_INVALID_DOCUMENT]
      };
    }
    return {
      decision: DECISIONS.EXTRACTION_FAILED, issuable: false, needsManualReview: false,
      reasons: [{ code: 'no_readable_documents', detail: 'No document produced a usable read.' }],
      summary: HUMAN_READABLE[DECISIONS.EXTRACTION_FAILED]
    };
  }

  // 3. Field analysis.
  const conflicts = [];
  const confirmations = [];
  const unreadableRequired = [];

  for (const field of fields) {
    if (field.label === 'face') continue;
    const isIdentity = IDENTITY_FIELDS.has(field.label);

    if (field.status === 'not_extracted' && REQUIRED_CONSENSUS_FIELDS.includes(field.label)) {
      unreadableRequired.push(field.label);
      continue;
    }
    if (!field.dissenting || !field.dissenting.length) continue;

    if (!isIdentity) continue; // parents, address: warn/info only, never conflict

    // A conflict needs at least TWO genuinely document-evidenced values. One
    // verified value plus one unknown is not a disagreement, and a value the
    // holder typed can neither manufacture nor suffer a conflict on its own.
    if ((field.corroboration ?? field.agreeing.length) < 1) continue;

    // A dissent every party agrees is a misread is a confirmation, not a conflict.
    const hard = field.dissenting.filter(item =>
      !item.needsConfirmation && !item.likely_ocr_variant && !isHolderSource(item.source));
    if (hard.length) conflicts.push({ field: field.label, dissenting: hard });
    else confirmations.push(field.label);
  }

  if (conflicts.length) {
    // Several identity fields disagreeing outright suggests two different people
    // rather than a bad scan.
    const decision = conflicts.length >= 2
      ? DECISIONS.SUSPECTED_CROSS_IDENTITY
      : DECISIONS.DOCUMENT_CONFLICT;
    return {
      decision, issuable: false, needsManualReview: true,
      reasons: conflicts.map(conflict => ({
        code: 'identity_field_conflict',
        detail: `${conflict.field}: ${conflict.dissenting.map(item => `${item.type} says "${item.value}"`).join('; ')}`
      })),
      summary: HUMAN_READABLE[decision]
    };
  }

  if (needRetake.length) {
    reasons.push({ code: 'retake_recommended', detail: `${needRetake.length} image(s) were too poor to read.` });
  }

  if (unreadableRequired.length) {
    return {
      decision: DECISIONS.INSUFFICIENT_EVIDENCE, issuable: false, needsManualReview: false,
      reasons: [
        ...reasons,
        ...unreadableRequired.map(field => ({ code: 'required_field_unreadable', detail: `${field} could not be read on any document. Enter it manually to continue.` }))
      ],
      summary: HUMAN_READABLE[DECISIONS.INSUFFICIENT_EVIDENCE]
    };
  }

  // 4. Anchor evidence.
  //
  // The identity anchor is the NAME: at least two documents must independently
  // support it, or we have no basis for saying they describe one person.
  //
  // Everything else is judged by ABSENCE OF CONTRADICTION, not by universal
  // overlap. Requiring every identity field to appear on two documents would
  // reject a perfectly ordinary PAN + Aadhaar pair, because a PAN prints no
  // gender and many Aadhaar layouts print no address. A field only one document
  // carries is recorded with its provenance, not treated as a deficiency.
  const nameField = fields.find(item => item.label === 'holder_name');
  let nameSupport = 0;
  if (nameField && Array.isArray(nameField.agreeingEntries)) {
    // Distinct logical documents with document evidence. The same card listed
    // twice, its own back page, or a value the holder typed all count once or
    // not at all — a single card can never corroborate itself.
    const support = new Set(
      nameField.agreeingEntries
        .filter(entry => !isHolderSource(entry.source))
        .map(entry => entry.logicalId)
    );
    for (const item of nameField.dissenting || []) {
      if ((item.needsConfirmation || item.likely_ocr_variant) && !isHolderSource(item.source)) {
        support.add(item.logicalId || item.documentId || item.type);
      }
    }
    nameSupport = support.size;
  } else if (nameField) {
    // Hand-built field shapes without per-entry detail: fall back to counts.
    const confirmable = (nameField.dissenting || []).filter(item => item.needsConfirmation || item.likely_ocr_variant).length;
    nameSupport = (nameField.agreeing || []).length + confirmable;
  }

  if (nameSupport < MINIMUM_AGREEING_DOCUMENTS) {
    return {
      decision: DECISIONS.INSUFFICIENT_EVIDENCE, issuable: false, needsManualReview: false,
      reasons: [
        ...reasons,
        {
          code: 'insufficient_corroboration',
          detail: `The name is supported by only ${nameSupport} document(s); at least ${MINIMUM_AGREEING_DOCUMENTS} must independently show it.`
        }
      ],
      summary: HUMAN_READABLE[DECISIONS.INSUFFICIENT_EVIDENCE]
    };
  }

  if (confirmations.length) {
    return {
      decision: DECISIONS.LIKELY_MATCH_NEEDS_CONFIRMATION, issuable: false, needsManualReview: false,
      reasons: [
        ...reasons,
        ...confirmations.map(field => ({ code: 'needs_confirmation', detail: `Please confirm the ${field} reading.` }))
      ],
      summary: HUMAN_READABLE[DECISIONS.LIKELY_MATCH_NEEDS_CONFIRMATION],
      confirmable: confirmations
    };
  }

  // Nothing contradicts. Distinguish "several documents corroborated each
  // other" from "they agreed where they overlapped, and the rest is
  // single-source", because those are materially different assurances.
  const comparable = fields.filter(field => field.label !== 'face' && field.value);
  const supportOf = field => field.corroboration ?? field.agreeing.length;
  const multiSourced = comparable.filter(field => supportOf(field) >= 2);
  // <= 1 rather than === 1: a value carried only by holder input has ZERO
  // document corroboration and must never let the verdict claim "match".
  const singleSourced = comparable.filter(field => supportOf(field) <= 1);

  const decision = singleSourced.length === 0
    ? DECISIONS.VERIFIED_MATCH
    : (multiSourced.length >= 2
      ? DECISIONS.VERIFIED_WITH_PARTIAL_OVERLAP
      : DECISIONS.VERIFIED_NO_CONFLICT);

  return {
    decision,
    issuable: true,
    needsManualReview: false,
    reasons: [
      ...reasons,
      ...singleSourced.map(field => ({
        code: 'single_source',
        detail: `${field.label}: provided only by ${field.agreeing.map(String).join(', ')}. Other documents do not print it.`
      }))
    ],
    summary: HUMAN_READABLE[decision],
    multiSourced: multiSourced.map(field => field.label),
    singleSourced: singleSourced.map(field => field.label)
  };
}

module.exports = {
  DECISIONS, ISSUABLE, NEEDS_MANUAL_REVIEW, HUMAN_READABLE,
  IDENTITY_FIELDS, MINIMUM_AGREEING_DOCUMENTS, REQUIRED_CONSENSUS_FIELDS, decide
};
