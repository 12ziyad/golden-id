'use strict';

const matrix = require('./matrix');
const { clusterField } = require('./cluster');
const { decide, DECISIONS, IDENTITY_FIELDS } = require('./decision');

// Severity per field.
//   reject  identity-defining; a genuine disagreement means different people
//   warn    worth showing, never blocks (parents and spouses vary in spelling
//           and in which relative a card chooses to print)
//   info    never blocks under any circumstance
const SEVERITY = {
  holder_name: 'reject',
  dob: 'reject',
  gender: 'reject',
  guardian_name: 'warn',
  father_name: 'warn',
  mother_name: 'warn',
  spouse_name: 'warn',
  address: 'info',
  face: 'warn'
};

const severityRank = { none: -1, info: 0, warn: 1, needs_confirmation: 2, reject: 3 };

// Field states that may take part in a comparison. Everything else abstains.
const PARTICIPATING_STATES = new Set(['present_verified']);

/**
 * Gather the entries taking part in a field, honouring comparison groups.
 *
 * Two separate questions, and conflating them was the bug:
 *   CAN this document type carry the field?      (capability — the matrix)
 *   DOES this page actually show it?             (presence — the field state)
 *
 * A Voter ID *may* carry a date of birth. That does not mean the card in front
 * of us prints one. Only a value we could locate on the page participates; a
 * value the model produced without evidence abstains and is reported, never
 * compared.
 */
function entriesForField(field, documents, country) {
  const members = matrix.membersOf(field);
  const entries = [];

  for (const document of documents) {
    const pageRole = document.pageRole || 'front';
    const participating = members.filter(member => matrix.participates(document.type, member, pageRole, country));

    // A document that cannot carry the field still enters the list, with no
    // value, so the clustering layer can record it as an explicit ABSTENTION.
    let value = '';
    let memberUsed = null;
    let state = null;

    for (const member of participating) {
      const candidate = document.fields ? document.fields[member] : document[member];
      if (candidate == null || String(candidate).trim() === '') continue;

      // When the document carries field states, honour them. Plain-value input
      // (manual entry, tests) has none and is treated as holder-asserted.
      const memberState = document.fieldStates ? document.fieldStates[member] : null;
      if (memberState && !PARTICIPATING_STATES.has(memberState.status)) {
        if (!state) { state = memberState; memberUsed = member; }
        continue;
      }
      value = candidate;
      memberUsed = member;
      state = memberState || { status: 'present_verified', verified: true, source: document.source, reason: 'value_supplied_directly' };
      break;
    }

    entries.push({
      type: document.type,
      documentId: document.id || document.documentId || '',
      // Pages of one physical card share a logical id; a document compared
      // outside the grouping pipeline is its own logical document.
      logicalId: document.logicalId || document.id || document.documentId || '',
      value,
      member: memberUsed,
      state,
      source: (state && state.source) || document.source,
      pageRole,
      status: document.status
    });
  }
  return entries;
}

/** Field-level severity from its clustered result. */
function severityFor(field, cluster) {
  const base = SEVERITY[field] || 'warn';

  // A field NO document supplied is a note, never a confirmation and never a
  // rejection. Nothing contradicts anything; there is simply nothing there. The
  // holder can still type it in, but they are not made to before continuing.
  if (cluster.status === 'not_extracted') return 'info';
  if (!cluster.dissenting.length) return 'none';
  if (base === 'info') return 'info';
  if (base === 'warn') return 'warn';

  // Identity field with a real disagreement. Anything every signal says is a
  // misread becomes a confirmation, not a rejection — a single low-confidence
  // OCR read must never hard-reject a person.
  const allConfirmable = cluster.dissenting.every(item => item.needsConfirmation || item.likely_ocr_variant);
  return allConfirmable ? 'needs_confirmation' : 'reject';
}

/**
 * Compare a set of documents.
 *
 * `documents` is `[{ id, type, pageRole, fields, source, status }]`.
 * `options.integrity` carries the ownership verdict; it always wins.
 */
function compareDocuments(documents, options = {}) {
  const list = Array.isArray(documents) ? documents.filter(Boolean) : [];
  const country = options.country;
  const fields = [];

  // Comparison groups replace their members, so father/spouse are pooled once.
  const seen = new Set();
  const order = [];
  for (const field of matrix.COMPARABLE_FIELDS) {
    const group = matrix.groupFor(field);
    if (seen.has(group)) continue;
    seen.add(group);
    order.push(group);
  }

  for (const field of order) {
    const entries = entriesForField(field, list, country);
    if (!entries.length) continue;

    const cluster = clusterField(field, entries, { country });
    if (cluster.status === 'not_applicable' && !cluster.unreadable.length) continue;

    fields.push({
      ...cluster,
      label: field,
      severity: severityFor(field, cluster),
      requiresManualEntry: cluster.status === 'not_extracted' && SEVERITY[field] === 'reject'
    });
  }

  if (options.face) fields.push(faceField(options.face));

  const decision = decide({
    fields,
    integrity: options.integrity || { ok: true, failures: [] },
    documents: list,
    face: options.face
  });

  const blocking = fields.filter(field => field.severity === 'reject');
  const confirmations = fields.filter(field => field.severity === 'needs_confirmation');
  const warnings = fields.filter(field => field.severity === 'warn');
  const notes = fields.filter(field => field.severity === 'info');

  return {
    // Legacy-compatible summary, kept so existing callers keep working.
    status: decision.issuable ? 'match'
      : decision.decision === DECISIONS.LIKELY_MATCH_NEEDS_CONFIRMATION ? 'needs_confirmation'
        : 'rejected',
    decision: decision.decision,
    issuable: decision.issuable,
    needsManualReview: decision.needsManualReview,
    summary: decision.summary,
    reasons: decision.reasons,
    multiSourced: decision.multiSourced || [],
    singleSourced: decision.singleSourced || [],
    fields,
    blocking: blocking.map(field => field.label),
    confirmations: confirmations.map(field => field.label),
    warnings: warnings.map(field => field.label),
    notes: notes.map(field => field.label),
    severity: fields.reduce((worst, field) => (
      severityRank[field.severity] > severityRank[worst] ? field.severity : worst
    ), 'info')
  };
}

/** Wrap a face-match result in the same shape as a compared field. */
function faceField(face) {
  const dissenting = (face.pairs || [])
    .filter(pair => !pair.match)
    .map(pair => ({
      type: `${pair.a} ↔ ${pair.b}`,
      value: `similarity ${Number(pair.similarity).toFixed(2)}`,
      distance: null, diff: '', likely_ocr_variant: false, needsConfirmation: true
    }));

  return {
    field: 'face',
    label: 'face',
    value: face.available === false ? 'Face matching unavailable' : `${face.compared || 0} photo pair(s) compared`,
    agreeing: (face.pairs || []).filter(pair => pair.match).map(pair => `${pair.a} ↔ ${pair.b}`),
    dissenting,
    unreadable: (face.withoutFace || []).map(type => ({ type, reason: 'no_face_detected' })),
    abstained: [],
    confidence: face.confidence == null ? 0 : face.confidence,
    clusters: [],
    status: dissenting.length ? 'disagreement' : 'agreement',
    // Never a reject: a false face rejection is far more damaging than a miss.
    severity: dissenting.length ? 'warn' : 'none',
    advisory: true,
    requiresManualEntry: false,
    note: face.note || ''
  };
}

module.exports = {
  compareDocuments, severityFor, entriesForField, faceField,
  SEVERITY, DECISIONS, IDENTITY_FIELDS
};
