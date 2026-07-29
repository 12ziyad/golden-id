'use strict';

const crypto = require('crypto');
const { normalizeName } = require('../normalize/name');
const { normalizeDate } = require('../normalize/date');
const { normalizeGender } = require('../normalize/gender');

// A system called "one ID" that hands the same person a fresh identifier on
// every upload is worthless. Before minting we check two things: an identity
// fingerprint, and every document number involved. Either hit returns the
// Golden ID that already exists.

/**
 * Identity fingerprint: name (order-insensitive) + DOB + gender.
 * Uses the sorted token set so "MUHAMMED SAKIR K" and "K MUHAMMED SAKIR"
 * fingerprint identically — the same person cannot get two IDs by reordering.
 */
function dedupHash({ name, dob, gender }) {
  const normalizedName = normalizeName(name).sorted;
  const normalizedDob = normalizeDate(dob).iso || '';
  const normalizedGender = normalizeGender(gender);
  // Without both a name and a DOB there is no usable fingerprint. Hashing
  // "name + gender" alone would hand every namesake the same Golden ID the
  // moment two applicants' DOBs went unread.
  if (!normalizedName || !normalizedDob) return null;
  const material = `${normalizedName}|${normalizedDob}|${normalizedGender}`;
  return crypto.createHash('sha256').update(material).digest('hex');
}

/** Build the fingerprint straight from a consensus record. */
const dedupHashForRecord = record => dedupHash({
  name: record.fields.holder_name ? record.fields.holder_name.value : '',
  dob: record.fields.dob ? record.fields.dob.value : '',
  gender: record.fields.gender ? record.fields.gender.value : ''
});

/**
 * Look for an existing Golden ID for this person.
 * Returns `{ gid, reason }` when one is found, or null.
 */
function findExisting(store, { record, documents = [] }) {
  const hash = dedupHashForRecord(record);

  const byIdentity = hash ? store.findRecordByDedupHash(hash) : null;
  if (byIdentity) return { gid: byIdentity.gid, reason: 'identity_match', dedupHash: hash };

  // A document number can only ever back one Golden ID.
  for (const document of documents) {
    if (!document.number) continue;
    const gid = store.findGidByDocumentNumber(document.number);
    if (gid) return { gid, reason: 'document_number_match', dedupHash: hash, number: document.number };
  }

  return null;
}

/** Record the document numbers that back a newly issued Golden ID. */
function linkDocuments(store, gid, documents = []) {
  for (const document of documents) {
    if (!document.number) continue;
    store.linkDocumentNumber(document.number, document.type || 'unknown', gid);
  }
}

module.exports = { dedupHash, dedupHashForRecord, findExisting, linkDocuments };
