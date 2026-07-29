'use strict';

const registry = require('../schemas/registry');

// Which fields each document may vote on.
//
// This is now DERIVED from the capability registry rather than being a second,
// independently-maintained table. The old duplicate said a passport carries
// father_name and mother_name; the registry says a passport bio page carries
// neither. Two sources of truth meant a hallucinated passport parent name was
// not only stored but treated as a legitimate vote and could become the
// consensus value on an issued credential.
//
// Three outcomes per (document, page, field):
//   'yes'      the page carries it; a blank means extraction failed
//   'partial'  some layouts carry it; a blank is ignored, a value is compared
//   'no'       the page cannot carry it; the document ABSTAINS entirely

const DOCUMENT_TYPES = ['birth_certificate', 'aadhaar', 'pan', 'passport', 'voter', 'driving_licence'];

// Fields compared as one pool. A Voter ID printing a husband's name where a PAN
// prints a father's name is not a contradiction.
const COMPARISON_GROUPS = {
  guardian_name: ['father_name', 'spouse_name']
};

// Per-card facts, validated individually and never compared across documents.
const NEVER_COMPARED = new Set([
  'document_number', 'issue_date', 'expiry_date', 'mrz',
  'issuing_authority', 'nationality', 'surname', 'given_names',
  // A place of birth is not an address and is not an identity field to
  // cross-compare; conflating them is a known failure mode.
  'place_of_birth'
]);

const COMPARABLE_FIELDS = [
  'holder_name', 'dob', 'gender', 'father_name', 'mother_name', 'spouse_name', 'address'
];

/**
 * 'yes' | 'partial' | 'no' for a document/page/field.
 * Comparison groups resolve to their strongest member.
 */
function carries(documentType, field, pageRole = 'front', country = registry.DEFAULT_COUNTRY) {
  const members = COMPARISON_GROUPS[field] || [field];

  let best = 'no';
  for (const member of members) {
    const sheet = registry.capabilitiesFor(documentType, pageRole, country);
    if ((sheet.impossible || []).includes(member)) continue;
    if ((sheet.allowed || []).includes(member)) {
      // Required means we expect it; merely allowed means layouts vary.
      if ((sheet.required || []).includes(member)) return 'yes';
      best = best === 'yes' ? 'yes' : 'yes';
    } else if (sheet.conditional && sheet.conditional[member]) {
      if (best === 'no') best = 'partial';
    }
  }

  // Fields that vary by layout are 'partial' rather than expected.
  if (best === 'yes' && PARTIAL_BY_NATURE[field] && PARTIAL_BY_NATURE[field].includes(documentType)) {
    return 'partial';
  }
  return best;
}

// Fields a document may or may not print depending on its vintage or layout.
// A blank in one of these is an ABSTENTION, not a failed extraction.
const PARTIAL_BY_NATURE = {
  dob: ['voter'],                       // some rolls print only an age
  mother_name: ['pan'],                 // only post-2023 PAN cards
  // Aadhaar comes in several formats. The full A4 letter carries an address;
  // the cut-out card and the e-Aadhaar header often do not. Reporting a blank
  // there as "not readable" tells the holder to fix something that was never
  // printed. Passport addresses are on the back page, rarely scanned.
  address: ['passport', 'aadhaar'],
  father_name: ['voter', 'aadhaar'],
  spouse_name: ['voter', 'passport'],
  gender: ['birth_certificate']
};

/** True when this document is expected to supply the field. */
const expects = (documentType, field, pageRole = 'front', country = registry.DEFAULT_COUNTRY) =>
  carries(documentType, field, pageRole, country) === 'yes';

/** True when a blank should simply be ignored for this document/field. */
const ignoresBlank = (documentType, field, pageRole = 'front', country = registry.DEFAULT_COUNTRY) =>
  carries(documentType, field, pageRole, country) !== 'yes';

/**
 * True when the document takes part in this field's comparison at all.
 * A document that cannot carry the field ABSTAINS: it counts as neither
 * agreement nor disagreement.
 */
const participates = (documentType, field, pageRole = 'front', country = registry.DEFAULT_COUNTRY) =>
  carries(documentType, field, pageRole, country) !== 'no';

function groupFor(field) {
  for (const [group, members] of Object.entries(COMPARISON_GROUPS)) {
    if (members.includes(field)) return group;
  }
  return field;
}

const membersOf = group => COMPARISON_GROUPS[group] || [group];

module.exports = {
  DOCUMENT_TYPES, COMPARISON_GROUPS, COMPARABLE_FIELDS, NEVER_COMPARED,
  PARTIAL_BY_NATURE, carries, expects, ignoresBlank, participates, groupFor, membersOf
};
