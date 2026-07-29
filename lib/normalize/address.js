'use strict';

// Addresses are parsed into components for display and for a structured,
// advisory comparison. They are NEVER used to reject an application: a person
// legitimately has different addresses on cards issued years apart, and an
// address difference says nothing about whether two documents describe the
// same human being.
//
// A place of birth is deliberately NOT an address and is never compared against
// one — conflating the two is how a passport's "PARATHODI" became a residential
// address in the live database.

const EXPANSIONS = [
  [/\bR\/?O\b/g, 'RESIDENT OF'],
  [/\bS\/?O\b/g, 'SON OF'],
  [/\bD\/?O\b/g, 'DAUGHTER OF'],
  [/\bW\/?O\b/g, 'WIFE OF'],
  [/\bC\/?O\b/g, 'CARE OF'],
  [/\bH\.?\s?NO\.?\b/g, 'HOUSE NO'],
  [/\bFLR\b/g, 'FLOOR'],
  [/\bAPT\b/g, 'APARTMENT'],
  [/\bRD\b/g, 'ROAD'],
  [/\bST\b/g, 'STREET'],
  [/\bLN\b/g, 'LANE'],
  [/\bDIST\b/g, 'DISTRICT'],
  [/\bTQ\b/g, 'TALUK'],
  [/\bPO\b/g, 'POST OFFICE'],
  [/\bPS\b/g, 'POLICE STATION'],
  [/\bNR\b/g, 'NEAR'],
  [/\bOPP\b/g, 'OPPOSITE']
];

// Indian states and union territories, for the state component.
const STATES = [
  'ANDHRA PRADESH', 'ARUNACHAL PRADESH', 'ASSAM', 'BIHAR', 'CHHATTISGARH', 'GOA', 'GUJARAT',
  'HARYANA', 'HIMACHAL PRADESH', 'JHARKHAND', 'KARNATAKA', 'KERALA', 'MADHYA PRADESH',
  'MAHARASHTRA', 'MANIPUR', 'MEGHALAYA', 'MIZORAM', 'NAGALAND', 'ODISHA', 'ORISSA', 'PUNJAB',
  'RAJASTHAN', 'SIKKIM', 'TAMIL NADU', 'TELANGANA', 'TRIPURA', 'UTTAR PRADESH', 'UTTARAKHAND',
  'WEST BENGAL', 'DELHI', 'NEW DELHI', 'JAMMU AND KASHMIR', 'LADAKH', 'PUDUCHERRY',
  'CHANDIGARH', 'ANDAMAN AND NICOBAR ISLANDS', 'DADRA AND NAGAR HAVELI', 'DAMAN AND DIU', 'LAKSHADWEEP'
];

const COUNTRIES = ['INDIA', 'BHARAT'];

/**
 * Parse an address into components.
 * Returns `{ text, house, street, locality, district, state, postalCode,
 * country, tokens, empty }`. Every component is best-effort; a missing one is
 * simply absent rather than guessed.
 */
function normalizeAddress(value) {
  let text = String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/(?:\s*,\s*)+/g, ', ')
    .replace(/^[\s,.\-]+|[\s,.\-]+$/g, '')
    .toUpperCase()
    .trim();

  if (!text) {
    return { text: '', house: '', street: '', locality: '', district: '', state: '', postalCode: '', country: '', tokens: [], empty: true };
  }

  const postalMatch = text.match(/\b(\d{6})\b/);
  const postalCode = postalMatch ? postalMatch[1] : '';

  for (const [pattern, replacement] of EXPANSIONS) text = text.replace(pattern, replacement);
  text = text.replace(/\s+/g, ' ').trim();

  const parts = text.split(',').map(part => part.trim()).filter(Boolean);

  const country = COUNTRIES.find(name => parts.some(part => part === name)) || '';
  const state = STATES.find(name => parts.some(part => part.includes(name))) || '';

  // A leading part containing a digit is almost always a house/plot number.
  const house = parts.length && /\d/.test(parts[0]) && parts[0].length <= 30 ? parts[0] : '';

  const structural = new Set([country, state].filter(Boolean));
  const remaining = parts.filter(part =>
    part !== house
    && !structural.has(part)
    && !STATES.some(name => part.includes(name))
    && !COUNTRIES.includes(part)
    && part !== postalCode
    && part.replace(/\D/g, '') !== postalCode);

  const street = remaining[0] || '';
  const locality = remaining[1] || '';
  const district = remaining.length > 2 ? remaining[remaining.length - 1] : '';

  // Content words used for the loose overlap comparison.
  const tokens = text
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2 && !/^(THE|AND|NEAR|POST|OFFICE|HOUSE|ROAD|STREET|DISTRICT)$/.test(token));

  return { text, house, street, locality, district, state, postalCode, country, tokens, empty: false };
}

/**
 * Compare two addresses structurally.
 *
 * Returns `{ relation, score, detail }` where `relation` is one of
 * `same | same_area | different | unknown`. This is ADVISORY ONLY and must
 * never contribute to a rejection.
 */
function compareAddresses(a, b) {
  const left = normalizeAddress(a);
  const right = normalizeAddress(b);

  if (left.empty || right.empty) {
    return { relation: 'unknown', score: 0, detail: 'One of the addresses is not present.' };
  }
  if (left.text === right.text) {
    return { relation: 'same', score: 1, detail: 'The addresses are identical.' };
  }

  // A shared PIN code is strong evidence of the same locality.
  if (left.postalCode && left.postalCode === right.postalCode) {
    const overlap = tokenOverlap(left.tokens, right.tokens);
    return {
      relation: overlap >= 0.5 ? 'same' : 'same_area',
      score: Math.max(0.6, overlap),
      detail: overlap >= 0.5
        ? 'The same address, written with different levels of detail.'
        : `Both addresses are in postal area ${left.postalCode}.`
    };
  }

  const overlap = tokenOverlap(left.tokens, right.tokens);
  if (overlap >= 0.6) {
    return { relation: 'same', score: overlap, detail: 'The addresses largely agree.' };
  }
  if (overlap >= 0.3) {
    return { relation: 'same_area', score: overlap, detail: 'The addresses share some components.' };
  }

  return {
    relation: 'different',
    score: overlap,
    detail: 'The addresses differ. This is expected when documents were issued years apart and never blocks a Golden ID.'
  };
}

function tokenOverlap(a, b) {
  const left = new Set(a);
  const right = new Set(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / Math.min(left.size, right.size);
}

module.exports = { normalizeAddress, compareAddresses, tokenOverlap, STATES, EXPANSIONS };
