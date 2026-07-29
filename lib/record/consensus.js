'use strict';

const { normalizeName } = require('../normalize/name');
const { normalizeDate } = require('../normalize/date');
const { normalizeGender } = require('../normalize/gender');
const { normalizeAddress } = require('../normalize/address');

// The golden record is built from the CONSENSUS of the documents, with the
// provenance of every value retained.
//
// The original implementation copied documents[0] — whichever card happened to
// be first in the upload list — so the issued identity depended on file
// ordering. If four cards agreed and the first was the outlier, the outlier won.
//
// Majority vote alone is also not enough: two guesses from one vision model
// should not outweigh a value read from a UIDAI-signed QR or a checksummed MRZ.
// The cluster layer therefore ranks by evidence WEIGHT, and this layer records
// which sources backed the winning value so the basis is auditable.

const RECORD_FIELDS = ['holder_name', 'dob', 'gender', 'guardian_name', 'mother_name', 'address'];

/** Present a normalised value the way it should appear on a card. */
function displayValue(field, value) {
  if (!value) return '';
  if (field === 'dob') return normalizeDate(value).iso || value;
  if (field === 'gender') return normalizeGender(value) || value;
  if (field === 'address') return normalizeAddress(value).text || value;
  if (/name$/.test(field)) return normalizeName(value).ordered || value;
  return value;
}

/**
 * Build the golden record from a comparison verdict.
 *
 * Each field carries the value, which documents supplied it, which dissented,
 * which could not be read, the evidence sources behind it, and the resulting
 * confidence — so a verifier can see the basis for every value rather than
 * trusting a flat string.
 */
function buildConsensus(verdict, options = {}) {
  const fields = {};

  for (const field of verdict.fields || []) {
    if (field.label === 'face') continue;
    if (!RECORD_FIELDS.includes(field.label)) continue;

    if (!field.value) {
      // A value only the applicant supplied enters the record EXPLICITLY
      // unverified — never dressed up as a consensus of documents.
      const asserted = (field.abstained || []).find(item => item.reason === 'holder_asserted' && item.observedValue);
      if (asserted) {
        fields[field.label] = {
          value: displayValue(field.label, asserted.observedValue),
          sources: [],
          dissenting: [],
          evidence: [],
          evidenceStrong: false,
          confidence: 0,
          verificationStatus: 'unverified',
          provenance: 'applicant_supplied',
          note: 'Applicant supplied; not verified from the uploaded document.',
          unreadable: (field.unreadable || []).map(item => item.type).sort(),
          abstained: (field.abstained || []).map(item => item.type).sort()
        };
      }
      continue;
    }

    fields[field.label] = {
      value: displayValue(field.label, field.value),
      sources: [...field.agreeing].sort(),
      dissenting: (field.dissenting || []).map(item => item.type).sort(),
      // Which KINDS of evidence backed this: barcode/mrz beats vision.
      evidence: (field.sources || []).sort(),
      evidenceStrong: Boolean(field.evidenceStrong),
      confidence: field.confidence,
      unreadable: (field.unreadable || []).map(item => item.type).sort(),
      // Documents that legitimately do not carry the field abstained; they are
      // recorded so a reader can tell "absent" from "disagreed".
      abstained: (field.abstained || []).map(item => item.type).sort()
    };
  }

  // Document numbers are per-card facts, not consensus values. They are listed
  // with their own validation outcome and never compared across documents.
  const documents = (options.documents || []).map(document => ({
    type: document.type,
    number: document.validation && document.validation.number
      ? document.validation.number
      : (document.fields || {}).document_number || '',
    valid: Boolean(document.validation && document.validation.valid),
    repaired: Boolean(document.validation && document.validation.repaired),
    source: document.source || ''
  }));

  return { fields, documents };
}

const publicSummary = record => ({
  holder_name: record.fields.holder_name ? record.fields.holder_name.value : '',
  dob: record.fields.dob ? record.fields.dob.value : '',
  gender: record.fields.gender ? record.fields.gender.value : ''
});

module.exports = { buildConsensus, displayValue, publicSummary, RECORD_FIELDS };
