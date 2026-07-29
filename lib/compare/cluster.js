'use strict';

const { levenshtein } = require('./levenshtein');
const { compareNames, VERDICTS } = require('./names');
const { normalizeName } = require('../normalize/name');
const { normalizeDate } = require('../normalize/date');
const { normalizeGender } = require('../normalize/gender');
const { normalizeAddress, compareAddresses } = require('../normalize/address');
const { diffFor } = require('./diff');
const matrix = require('./matrix');
const { STATUS, EXCLUSION_REASON } = require('../extract/evidence');

// Group each field's values across documents, keeping every source's identity
// and its evidence strength.
//
// The original implementation built a Set of raw strings and rejected whenever
// its size exceeded one, so a blank counted as a mismatch. That is gone. Here a
// document that cannot carry a field never enters the pool at all, and one that
// could not be read is recorded as unreadable rather than as a dissenter.

const OCR_VARIANT_DISTANCE = 2;

// How much a source's agreement is worth. A Verhoeff-valid number or a decoded
// UIDAI QR is not the same quality of evidence as one vision model's guess.
const SOURCE_WEIGHTS = {
  barcode: 1.0,       // UIDAI Secure QR
  mrz: 1.0,           // checksummed machine-readable zone
  deterministic: 0.95,
  user: 1.0,          // the holder typed it
  ocr: 0.7,
  vision: 0.6,
  'vision+crosscheck': 0.85,
  'tesseract-fallback': 0.5,
  'embedded-text': 0.8,
  manual: 1.0
};

const weightFor = source => SOURCE_WEIGHTS[source] ?? 0.6;

// Values the HOLDER typed are displayed and prevent false conflicts, but they
// are not document evidence: they never corroborate, never count as agreement
// between documents, and never satisfy the minimum-evidence rule.
const HOLDER_SOURCES = new Set(['user', 'user_correction', 'manual']);
const isHolderSource = source => HOLDER_SOURCES.has(source);

/** Normalise one field value, returning the grouping key and display form. */
function normalizeField(field, value) {
  if (value == null || String(value).trim() === '') return { key: '', display: '', meta: {} };

  if (/name$/.test(field) || field === 'guardian_name') {
    const name = normalizeName(value);
    return { key: name.sorted, display: name.ordered, meta: { tokens: name.tokens } };
  }
  if (field === 'dob' || /date$/.test(field)) {
    const date = normalizeDate(value);
    return {
      key: date.iso || '',
      display: date.iso || date.original,
      meta: { ambiguous: date.ambiguous, original: date.original, reason: date.reason }
    };
  }
  if (field === 'gender') {
    const gender = normalizeGender(value);
    return { key: gender, display: gender, meta: {} };
  }
  if (field === 'address') {
    const address = normalizeAddress(value);
    return { key: address.text, display: address.text, meta: { postalCode: address.postalCode } };
  }
  const text = String(value).trim().replace(/\s+/g, ' ').toUpperCase();
  return { key: text, display: text, meta: {} };
}

/** Are two values close enough to be the same value read twice? */
function sameValue(field, a, b) {
  if (/name$/.test(field) || field === 'guardian_name') {
    const result = compareNames(a, b);
    return {
      same: result.verdict === VERDICTS.IDENTICAL || result.verdict === VERDICTS.SAFE_VARIANT,
      confirm: result.verdict === VERDICTS.NEEDS_CONFIRMATION,
      distance: result.pairs ? result.pairs.reduce((sum, pair) => sum + pair.distance, 0) : null,
      explanation: result.explanation,
      signals: result.signals,
      score: result.score
    };
  }
  if (field === 'address') {
    const result = compareAddresses(a, b);
    return {
      same: result.relation === 'same',
      confirm: result.relation === 'same_area',
      distance: null,
      explanation: result.detail,
      signals: [result.relation],
      score: result.score
    };
  }
  const distance = levenshtein(a, b, 8);
  return {
    same: distance === 0,
    confirm: distance > 0 && distance <= OCR_VARIANT_DISTANCE,
    distance,
    explanation: distance <= OCR_VARIANT_DISTANCE ? 'Differs by a small number of characters.' : 'The values differ.',
    signals: [],
    score: null
  };
}

/**
 * Cluster a field's values across documents.
 *
 * `entries` is `[{ type, value, source, documentId, pageRole, status }]`,
 * pre-filtered to documents that participate in this field.
 */
function clusterField(field, entries, options = {}) {
  const country = options.country;
  const present = [];
  const unreadable = [];
  const abstained = [];

  // Holder confirmations for THIS field. A stored confirmation only ever
  // resolves a SOFT difference (one the engine itself marked confirmable);
  // hard differences never consult this list, so a material conflict cannot
  // be clicked away.
  const fieldConfirmations = (options.confirmations || []).filter(item => item.field === field);
  const confirmationFor = (a, b) => {
    if (!fieldConfirmations.length) return null;
    const keyA = normalizeField(field, a).key;
    const keyB = normalizeField(field, b).key;
    for (const confirmation of fieldConfirmations) {
      const keys = [confirmation.acceptedValue, ...(confirmation.otherValues || []).map(item => item.value)]
        .map(value => normalizeField(field, value).key);
      if (keys.includes(keyA) && keys.includes(keyB)) return confirmation;
    }
    return null;
  };

  for (const entry of entries) {
    // Gate 1 — capability. A field the document type cannot carry never enters
    // the pool at all.
    if (!matrix.participates(entry.type, field, entry.pageRole || 'front', country)) {
      abstained.push({
        type: entry.type, documentId: entry.documentId,
        reason: 'not_carried_by_document',
        detail: 'this document does not print this field'
      });
      continue;
    }

    // Gate 2 — presence. The type COULD carry it; this page may still not show
    // it. A value we could not locate on the page abstains: it is reported, but
    // it can never contradict a value we can evidence.
    const state = entry.state;
    if (state && state.status && state.status !== STATUS.PRESENT_VERIFIED) {
      const bucket = state.status === STATUS.UNREADABLE ? unreadable : abstained;
      bucket.push({
        type: entry.type, documentId: entry.documentId,
        reason: state.status,
        detail: EXCLUSION_REASON[state.status] || state.reason || 'excluded from comparison',
        // What was read, so nothing is hidden — just not compared.
        observedValue: state.rawValue ?? null,
        evidenceReason: state.reason || null
      });
      continue;
    }

    const normalized = normalizeField(field, entry.value);
    if (!normalized.key) {
      if (matrix.expects(entry.type, field, entry.pageRole || 'front', country)) {
        unreadable.push({
          type: entry.type, documentId: entry.documentId,
          reason: 'not_extracted', detail: 'expected on this document but could not be read'
        });
      } else {
        abstained.push({
          type: entry.type, documentId: entry.documentId,
          reason: 'not_printed_on_this_page', detail: 'not printed on this page'
        });
      }
      continue;
    }

    present.push({
      type: entry.type,
      documentId: entry.documentId,
      // Front and back of one card share a logical id; agreement is counted
      // across logical documents, never across pages of the same card.
      logicalId: entry.logicalId || entry.documentId || entry.type,
      key: normalized.key,
      display: normalized.display,
      raw: entry.value,
      source: entry.source || 'vision',
      weight: weightFor(entry.source),
      meta: normalized.meta
    });
  }

  if (!present.length) {
    return {
      field, value: '', agreeing: [], agreeingEntries: [], dissenting: [], unreadable, abstained,
      confidence: 0, clusters: [], corroboration: 0,
      status: unreadable.length ? 'not_extracted' : 'not_applicable'
    };
  }

  // 1. Exact groups.
  const groups = new Map();
  for (const item of present) {
    if (!groups.has(item.key)) groups.set(item.key, { key: item.key, display: item.display, members: [], variant: false });
    groups.get(item.key).members.push(item);
  }
  let clusters = [...groups.values()];

  // 2. Merge groups whose representatives are the same value seen twice.
  let merged = true;
  while (merged && clusters.length > 1) {
    merged = false;
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const comparison = sameValue(field, clusters[i].display, clusters[j].display);
        if (!comparison.same) continue;
        const weightI = clusters[i].members.reduce((sum, m) => sum + m.weight, 0);
        const weightJ = clusters[j].members.reduce((sum, m) => sum + m.weight, 0);
        const [keep, absorb] = weightI >= weightJ ? [clusters[i], clusters[j]] : [clusters[j], clusters[i]];
        keep.members.push(...absorb.members);
        keep.variant = true;
        keep.variantExplanation = comparison.explanation;
        clusters = clusters.filter(cluster => cluster !== absorb);
        merged = true;
        break outer;
      }
    }
  }

  // 3. The winner is decided by EVIDENCE QUALITY first and count second.
  //
  //    A value read from a UIDAI-signed QR or a checksummed MRZ is machine
  //    printed and verified; two guesses from a vision model are not. Majority
  //    vote alone would let the guesses outvote the verified read, so a cluster
  //    containing a deterministic source wins outright.
  const STRONG = 0.9;
  const strongest = cluster => Math.max(...cluster.members.map(member => member.weight));
  const totalWeight = cluster => cluster.members.reduce((sum, member) => sum + member.weight, 0);

  clusters.sort((a, b) => {
    const strongA = strongest(a) >= STRONG ? 1 : 0;
    const strongB = strongest(b) >= STRONG ? 1 : 0;
    return strongB - strongA
      || totalWeight(b) - totalWeight(a)
      || b.members.length - a.members.length
      || a.display.localeCompare(b.display);
  });
  const majority = clusters[0];

  // Within the winning cluster, report the spelling with the most weight behind it.
  const spellings = new Map();
  for (const member of majority.members) {
    spellings.set(member.display, (spellings.get(member.display) || 0) + member.weight);
  }
  const value = [...spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];

  const agreeing = [];
  const agreeingEntries = [];
  const dissenting = [];
  const variants = [];

  for (const member of majority.members) {
    if (member.display === value) {
      agreeing.push(member.type);
      agreeingEntries.push({ documentId: member.documentId, logicalId: member.logicalId, type: member.type, source: member.source });
      continue;
    }

    const comparison = sameValue(field, value, member.display);

    // A SAFE variant — different spacing, word order, capitalisation, an
    // expanded abbreviation — is the same value written differently. Asking
    // the holder to "confirm" a difference we have just told them is
    // immaterial is noise, and it was blocking issuance on nothing. It is
    // recorded as a spelling seen, and counted as AGREEING.
    if (comparison.same) {
      agreeing.push(member.type);
      agreeingEntries.push({ documentId: member.documentId, logicalId: member.logicalId, type: member.type, source: member.source });
      variants.push({
        type: member.type, documentId: member.documentId, value: member.display,
        explanation: comparison.explanation, signals: comparison.signals, source: member.source
      });
      continue;
    }

    const confirmed = confirmationFor(value, member.display);
    if (confirmed) {
      agreeing.push(member.type);
      agreeingEntries.push({ documentId: member.documentId, logicalId: member.logicalId, type: member.type, source: member.source });
      variants.push({
        type: member.type, documentId: member.documentId, value: member.display,
        explanation: 'Confirmed by the holder as the same person.',
        signals: comparison.signals, source: member.source,
        holderConfirmed: true, confirmedAt: confirmed.createdAt
      });
      continue;
    }

    dissenting.push({
      type: member.type, documentId: member.documentId, logicalId: member.logicalId, value: member.display,
      distance: comparison.distance, diff: diffFor(field, value, member.display),
      likely_ocr_variant: true, explanation: comparison.explanation,
      signals: comparison.signals, source: member.source, needsConfirmation: true
    });
  }

  for (const cluster of clusters.slice(1)) {
    for (const member of cluster.members) {
      const comparison = sameValue(field, value, member.display);

      // Only a SOFT difference can carry a confirmation past this point.
      const confirmed = comparison.confirm ? confirmationFor(value, member.display) : null;
      if (confirmed) {
        agreeing.push(member.type);
        agreeingEntries.push({ documentId: member.documentId, logicalId: member.logicalId, type: member.type, source: member.source });
        variants.push({
          type: member.type, documentId: member.documentId, value: member.display,
          explanation: 'Confirmed by the holder as the same person.',
          signals: comparison.signals, source: member.source,
          holderConfirmed: true, confirmedAt: confirmed.createdAt
        });
        continue;
      }

      dissenting.push({
        type: member.type, documentId: member.documentId, logicalId: member.logicalId, value: member.display,
        distance: comparison.distance, diff: diffFor(field, value, member.display),
        likely_ocr_variant: false, explanation: comparison.explanation,
        signals: comparison.signals, source: member.source,
        needsConfirmation: Boolean(comparison.confirm)
      });
    }
  }

  // Corroboration counts DISTINCT LOGICAL DOCUMENTS backed by document
  // evidence. The same card listed twice, or the front and back of one card,
  // is ONE source; a value the holder typed is none.
  const corroboration = new Set(
    agreeingEntries.filter(entry => !isHolderSource(entry.source)).map(entry => entry.logicalId)
  ).size;

  // Safe variants agree, so their evidence counts toward the confidence.
  const agreeingTypes = new Set(agreeing);
  const agreeWeight = majority.members
    .filter(member => agreeingTypes.has(member.type))
    .reduce((sum, member) => sum + member.weight, 0);
  const presentWeight = present.reduce((sum, member) => sum + member.weight, 0);

  return {
    field,
    value,
    agreeing,
    agreeingEntries,
    dissenting,
    // Documents that agree but printed/read the value in a different form.
    // Shown for transparency; never a reason to stop.
    variants,
    unreadable,
    abstained,
    confidence: presentWeight ? Number((agreeWeight / presentWeight).toFixed(2)) : 0,
    // Evidence-strong means at least one deterministic source backs the value.
    evidenceStrong: majority.members.some(member => member.weight >= 0.9),
    sources: [...new Set(majority.members.map(member => member.source))],
    clusters: clusters.map(cluster => ({
      value: cluster.display,
      members: cluster.members.map(member => member.type),
      likely_ocr_variant: Boolean(cluster.variant)
    })),
    // One document providing a value is NOT agreement — there is nothing for it
    // to agree with. Saying "agreed" would imply corroboration that does not
    // exist, so it is reported as single-source with its provenance.
    status: dissenting.length
      ? 'disagreement'
      : (corroboration >= 2 ? 'agreement' : 'single_source'),
    corroboration
  };
}

module.exports = { clusterField, normalizeField, sameValue, weightFor, isHolderSource, SOURCE_WEIGHTS, OCR_VARIANT_DISTANCE };
