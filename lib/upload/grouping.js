'use strict';

const { compareNames, VERDICTS } = require('../compare/names');
const { plainValues } = require('../extract/schema');

// Group the pages of one physical document together — the front and back of an
// Aadhaar card, the two sides of a Voter ID, the pages of a PDF.
//
// The overriding constraint: grouping must NEVER merge pages belonging to two
// different people. Every caller passes documents from a single application, and
// on top of that we only group when positive evidence links the pages. When the
// evidence is ambiguous the pages are kept SEPARATE and each stands alone —
// wrongly splitting one card is harmless, wrongly merging two people is not.

// Which side of a document a page looks like, from the fields it carries.
// `document_number` is deliberately NOT a front marker: most cards print the
// number on both sides, so counting it would make every back page look like a
// front and prevent the two from ever pairing.
const BACK_MARKERS = ['address', 'father_name', 'mother_name', 'spouse_name'];
const FRONT_MARKERS = ['holder_name', 'dob', 'gender', 'mrz'];

const valueOf = (document, field) => {
  const values = { ...plainValues(document.rawFields || {}), ...(document.corrections || {}) };
  const value = values[field];
  return value == null ? '' : String(value).trim();
};

/** Guess whether a page is the front or the back of its document. */
function inferPageRole(document) {
  const front = FRONT_MARKERS.filter(field => valueOf(document, field)).length;
  const back = BACK_MARKERS.filter(field => valueOf(document, field)).length;
  if (front === 0 && back > 0) return 'back';
  if (back > front) return 'back';
  return 'front';
}

/**
 * Two pages belong to the same physical document only when something positively
 * links them. Returns `{ linked, reason }`.
 */
function pagesLink(a, b) {
  if (a.type !== b.type) return { linked: false, reason: 'different_document_types' };

  const numberA = valueOf(a, 'document_number');
  const numberB = valueOf(b, 'document_number');

  // Strongest link: the same document number printed on both sides.
  if (numberA && numberB) {
    const normalise = value => value.toUpperCase().replace(/[\s-]/g, '');
    if (normalise(numberA) === normalise(numberB)) {
      return { linked: true, reason: { signal: 'same_document_number', detail: 'Both pages print the same document number.' } };
    }
    // Two different valid numbers means two different cards. Never merge.
    return { linked: false, reason: 'different_document_numbers' };
  }

  const nameA = valueOf(a, 'holder_name');
  const nameB = valueOf(b, 'holder_name');

  // Both name the holder: they must be the same person.
  if (nameA && nameB) {
    const comparison = compareNames(nameA, nameB);
    if (comparison.verdict === VERDICTS.IDENTICAL || comparison.verdict === VERDICTS.SAFE_VARIANT) {
      return { linked: true, reason: { signal: 'same_holder_name', detail: 'Both pages name the same holder.' } };
    }
    return { linked: false, reason: 'different_holder_names' };
  }

  // Consecutive pages of the same source PDF are the same document.
  if (a.relativePath && b.relativePath) {
    const base = value => String(value).split('#page=')[0];
    if (base(a.relativePath) && base(a.relativePath) === base(b.relativePath)) {
      return { linked: true, reason: { signal: 'same_source_file', detail: 'Both pages came from the same PDF.' } };
    }
  }

  // One page names the holder and the other does not — a plausible front/back
  // pair, but nothing actually proves it. Adjacency in the upload is a weak
  // hint, not evidence, so we decline to merge.
  return { linked: false, reason: 'insufficient_evidence_to_group' };
}

/**
 * Group an application's documents into logical documents.
 * Returns `[{ type, documentIds, pageRoles, reason }]`.
 */
function groupPages(documents = []) {
  const groups = [];
  const assigned = new Set();

  for (const document of documents) {
    if (assigned.has(document.id)) continue;

    const group = {
      type: document.type,
      documentIds: [document.id],
      pageRoles: { [document.id]: document.pageRole || inferPageRole(document) },
      reason: { signal: 'single_page', detail: 'Stands alone.' }
    };
    assigned.add(document.id);

    for (const candidate of documents) {
      if (assigned.has(candidate.id)) continue;
      const link = pagesLink(document, candidate);
      if (!link.linked) continue;

      const role = candidate.pageRole || inferPageRole(candidate);
      // One page per role: two "fronts" of the same type are two cards, not a pair.
      if (Object.values(group.pageRoles).includes(role)) continue;

      group.documentIds.push(candidate.id);
      group.pageRoles[candidate.id] = role;
      group.reason = link.reason;
      assigned.add(candidate.id);
    }

    groups.push(group);
  }

  return groups;
}

module.exports = { groupPages, pagesLink, inferPageRole, BACK_MARKERS, FRONT_MARKERS };
