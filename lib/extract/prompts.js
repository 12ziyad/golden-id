'use strict';

const registry = require('../schemas/registry');

// Versioned: bump on ANY wording change. The extraction cache key includes this,
// so a prompt change forces a re-read instead of serving a stale result.
const PROMPT_VERSION = '3.0.0';

// Prompts are generated FROM the capability registry rather than hand-written
// per type. That means the model is never asked for a field the page cannot
// carry, and adding a country is data, not prose.

const FIELD_HINTS = {
  holder_name: 'the full name of the person this document belongs to, exactly as printed',
  surname: 'family name / surname only',
  given_names: 'given names only',
  father_name: "the father's name, only if explicitly labelled as such",
  mother_name: "the mother's name, only if explicitly labelled as such",
  spouse_name: "the husband's or wife's name, only if explicitly labelled as such",
  dob: 'date of birth exactly as printed, no reformatting',
  year_of_birth: 'year of birth when only a year is printed',
  age: 'age in years when an age is printed instead of a date',
  gender: 'gender or sex exactly as printed',
  address: 'the residential/postal address printed on this page',
  place_of_birth: 'place of birth (a town or district) — this is NOT a residential address',
  document_number: 'the document/card number printed on this page',
  issue_date: 'date of issue',
  expiry_date: 'date of expiry',
  nationality: 'nationality code or name',
  issuing_authority: 'the authority that issued the document',
  mrz: 'the two machine-readable lines at the bottom, transcribed exactly including every < character'
};

const DISAMBIGUATION = `Identify the document by these markers. The NUMBER is the most reliable signal:

- PAN card (India): says "INCOME TAX DEPARTMENT". Number is exactly 10 characters:
  five letters, four digits, one letter (ABCDE1234F). Prints a father's name.
  NEVER prints a gender or an address.
- Aadhaar card (India): says "AADHAAR"/"आधार" or "Unique Identification Authority",
  often "मेरा आधार, मेरी पहचान". Number is exactly 12 DIGITS, usually three groups
  of four. Prints a gender. NEVER prints a father's name unless an explicit
  S/O, D/O or W/O line is visible.
- Passport: says "PASSPORT". Number is one letter then seven digits. Has two
  machine-readable lines of <<< characters at the bottom, and an expiry date.
  The bio page NEVER prints parents, spouse or a residential address.
- Voter ID / EPIC (India): says "ELECTION COMMISSION OF INDIA". Number is three
  letters then seven digits (ABC1234567).
- Birth certificate: issued by a municipal or local registrar; registration
  number; usually both parents' names.
- Driving licence: says "DRIVING LICENCE", has a licence number and vehicle classes.

If the number you can read is 12 digits, it is an Aadhaar card, not a PAN card.`;

const BASE_RULES = [
  'Reply with JSON only. No prose, no explanation, no markdown code fences.',
  'Every key listed above must be present in your reply.',
  'Use null for any field not printed on this page. Never use "N/A", "none", "unknown" or an empty string.',
  'Never guess, infer, calculate or complete a value. If you cannot read it, use null.',
  // The evidence requirement. A value with no locatable printed source is
  // discarded by the backend, so producing one gains the model nothing.
  'For EVERY field you fill in, add an entry to the "evidence" object containing the exact printed text you read it from, including the printed label. Copy that text character for character from the document.',
  'If you cannot find a printed LABEL for a field and a value next to it, the field is not on this page: set it to null and add no evidence entry. Do not deduce a value from elsewhere on the card.',
  'A date of birth requires a visible date-of-birth label (DOB, Date of Birth, जन्म तिथि) or an age. If the card shows no such label, dob MUST be null even if you can see other dates such as an issue date.',
  'Transcribe values exactly as printed, preserving spacing, initials and punctuation.',
  'Keep the spaces between words in a name. "MUHAMMED SAKIR K" is three words and must not be run together as "MUHAMMEDSAKIR K".',
  'Write dates exactly as printed. Do not reformat, reorder or convert them.',
  'holder_name is the person the document belongs to — never a parent, spouse, or issuing officer.',
  'A place of birth is NOT an address. Never put a place of birth into the address field.',
  'Only report a value you can actually see on THIS page. Do not carry values over from any other document.',
  'If a value is printed in two scripts (for example Hindi and English), give the English form.'
];

/** Render the JSON shape for exactly the fields this page may carry. */
function shapeFor(allowed) {
  const lines = ['  "document_type": "pan|aadhaar|passport|voter|birth_certificate|driving_licence|unknown"'];
  for (const field of allowed) {
    lines.push(`  "${field}": "string or null"   // ${FIELD_HINTS[field] || field}`);
  }
  // The evidence object is what turns a claimed value into a locatable one.
  lines.push('  "evidence": {   // for each field you filled in, the exact printed text you read it from');
  lines.push('    "<field_name>": "the printed label and value, copied exactly"');
  lines.push('  }');
  return `{\n${lines.join(',\n')}\n}`;
}

// Warnings about fields a document type MAY carry but frequently does not.
// A capability is permission for the field to exist, not proof that it does —
// and the gap between those two is where invented values appear.
const ABSENCE_NOTES = {
  voter: [
    'MANY Voter ID cards print NO date of birth at all. Some show only an age; many show neither.',
    'Only fill in dob if you can see a date-of-birth or age LABEL with a value beside it. An issue date, a printing date, a serial number or a year appearing anywhere else is NOT a date of birth.',
    'If this card has no date-of-birth label, dob must be null and there must be no dob entry in evidence.'
  ],
  aadhaar: [
    'Some Aadhaar formats print only a year of birth, and the cut-out card and header formats often print no address at all.',
    'If no address is printed on this side, address must be null.'
  ],
  pan: [
    'Older PAN cards print no mother\'s name. If it is not labelled, leave mother_name null.'
  ],
  passport: [
    'The bio page carries no parents, no spouse and no residential address — those are on the back page.',
    'Place of birth is a town or district. It is NOT an address.'
  ],
  birth_certificate: [
    'The date of registration and the date of issue are NOT the date of birth. Only use the value under a date-of-birth label.'
  ]
};

/**
 * Build the extraction prompt for a document type and page role.
 *
 * When `docType` is unknown the generic disambiguation block is used and the
 * field list is the union of what any document might carry. When the type IS
 * known, the model is shown ONLY that page's permitted fields — it cannot
 * volunteer a father's name for a passport because it is never asked for one.
 */
function extractionPrompt(docType = 'unknown', pageRole = 'front', country = registry.DEFAULT_COUNTRY) {
  const sheet = registry.capabilitiesFor(docType, pageRole, country);
  const known = docType && docType !== 'unknown' && sheet.known;

  const allowed = known ? sheet.allowed : registry.ALL_FIELDS;
  const rules = [...BASE_RULES];

  if (known) {
    rules.unshift(
      `This is the ${sheet.pageRole} side of a ${sheet.label}. Only the fields listed above appear on it.`
    );
    if ((sheet.impossible || []).length) {
      rules.push(
        `A ${sheet.label} ${sheet.pageRole} page does NOT print: ${sheet.impossible.join(', ')}. `
        + 'Do not report those fields under any circumstances, even if you believe you can infer them.'
      );
    }
    if ((sheet.required || []).length) {
      rules.push(`If you cannot read ${sheet.required.join(' or ')}, return null for it rather than guessing.`);
    }
    // Fields this type is allowed to carry but often does not print.
    for (const note of ABSENCE_NOTES[docType] || []) rules.push(note);
  }

  const heading = known
    ? `You are reading the ${sheet.pageRole} side of a ${sheet.label} and extracting only the fields printed on it.`
    : `You are reading a scanned identity document and extracting the printed fields.\n\n${DISAMBIGUATION}`;

  return `${heading}

Return exactly this JSON object:
${shapeFor(allowed)}

Rules:
${rules.map(rule => `- ${rule}`).join('\n')}`;
}

/** A short prompt used only to classify a document. */
const classificationPrompt = () =>
  `Identify this identity document. Reply with JSON only, no prose and no code fences:
{"document_type": "pan|aadhaar|passport|voter|birth_certificate|driving_licence|unknown"}

${DISAMBIGUATION}`;

/** Re-read ONE uncertain field from an enhanced view of the document. */
const fieldRereadPrompt = (field, docType) =>
  `This is a ${docType === 'unknown' ? 'identity' : docType} document. Read exactly ONE field: ${FIELD_HINTS[field] || field}.
Transcribe it exactly as printed. Reply with JSON only:
{"${field}": "string or null"}
Return null if that field is unreadable or not present. Do not guess.`;

module.exports = {
  PROMPT_VERSION, extractionPrompt, classificationPrompt, fieldRereadPrompt,
  shapeFor, DISAMBIGUATION, BASE_RULES, FIELD_HINTS, ABSENCE_NOTES
};
