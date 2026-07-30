'use strict';

// Evidence verification.
//
// A document TYPE having a capability ("a Voter ID may print a date of birth")
// does not prove the field appears on THIS page. A real Voter ID that prints no
// DOB produced "2010-01-15" from the model, and because the type could carry a
// DOB the value was accepted and then contradicted the Aadhaar. The card was
// blamed for a disagreement it never took part in.
//
// So a value is only allowed to participate in comparison when we can point at
// the printed text it came from. Everything else is recorded, shown, and
// excluded — never treated as a contradiction.

const STATUS = {
  PRESENT_VERIFIED: 'present_verified',   // value + locatable evidence
  PRESENT_UNCERTAIN: 'present_uncertain', // value, but nothing corroborates it
  NOT_PRESENT: 'not_present',             // the page does not show this field
  UNREADABLE: 'unreadable',               // it is there but could not be read
  INVALID: 'invalid'                      // impossible for this document, or failed validation
};

// Only these may take part in a comparison.
const PARTICIPATING = new Set([STATUS.PRESENT_VERIFIED]);

// Sources whose output is machine-printed and checksummed. These carry their
// own proof and never need textual corroboration.
const SELF_EVIDENT_SOURCES = new Set(['mrz', 'barcode', 'deterministic']);

// A label that must appear near the value for it to count as located. Without
// this, "the model returned something" would be its own evidence.
const FIELD_LABELS = {
  dob: /\b(d\.?o\.?b|date\s*of\s*birth|birth\s*date|born|जन्म|जन्म\s*तिथि|year\s*of\s*birth|y\.?o\.?b|age)\b/i,
  gender: /\b(gender|sex|male|female|पुरुष|महिला|लिंग|transgender)\b/i,
  father_name: /\b(father|father'?s?\s*name|पिता|s\s*\/\s*o|son\s*of)\b/i,
  mother_name: /\b(mother|mother'?s?\s*name|माता|d\s*\/\s*o)\b/i,
  spouse_name: /\b(husband|wife|spouse|पति|पत्नी|w\s*\/\s*o)\b/i,
  address: /\b(address|पता|residence|resident|r\s*\/\s*o)\b/i,
  holder_name: /\b(name|नाम|holder|surname|given\s*name)\b/i,
  issue_date: /\b(issue|issued|date\s*of\s*issue|जारी)\b/i,
  expiry_date: /\b(expiry|expires|valid\s*until|date\s*of\s*expiry)\b/i,
  place_of_birth: /\b(place\s*of\s*birth|birth\s*place)\b/i,
  document_number: /.*/ // the number's own format check is stronger than a label
};

// Fields that are NOT printed with a label and must not be required to have
// one. An Aadhaar prints the holder's name on its own with no "Name:" before
// it; a gender is printed as the bare word "Male"; a number's own format
// identifies it. Demanding a label for these rejects perfectly good reads.
//
// The label requirement is kept for exactly the fields that ARE always
// labelled on an identity document and are the ones prone to mis-mapping: a
// date of birth, a parent's or spouse's name, an address, an issue or expiry
// date. Those are where an unlabelled guess is almost certainly invented.
const SELF_IDENTIFYING = new Set([
  'document_number', 'mrz', 'holder_name', 'surname', 'given_names', 'gender'
]);

/** Reduce text for comparison: uppercase, strip everything but letters/digits. */
const squash = value => String(value == null ? '' : value)
  .toUpperCase()
  .replace(/[^A-Z0-9ऀ-ॿ]/g, '');

/** Digits only, for matching dates written in different orders. */
const digitsOf = value => String(value == null ? '' : value).replace(/\D/g, '');

/**
 * Does the evidence snippet actually contain the value?
 *
 * Dates are compared on their digits in any order, because "12/08/1997" and
 * "1997-08-12" are the same printed value read two ways.
 */
function evidenceContainsValue(field, value, evidenceText) {
  if (!evidenceText) return false;
  const haystack = squash(evidenceText);
  const needle = squash(value);
  if (!needle) return false;
  if (haystack.includes(needle)) return true;

  if (field === 'dob' || /date$/.test(field)) {
    // Compare dates by MEANING, not by digit order. "07/05/2002" printed on the
    // card and "2002-05-07" returned by the model are the same date; assuming
    // the year is always the last four digits breaks on ISO.
    const { normalizeDate } = require('../normalize/date');
    const wanted = normalizeDate(value).iso;
    if (!wanted) return digitsOf(evidenceText).includes(digitsOf(value));

    // Any date-shaped run in the evidence that means the same thing.
    const candidates = String(evidenceText).match(/\d{1,4}[/.\-\s]\d{1,2}[/.\-\s]\d{1,4}/g) || [];
    if (candidates.some(candidate => normalizeDate(candidate).iso === wanted)) return true;

    // A year-only value, where the card prints just the year of birth.
    const year = wanted.slice(0, 4);
    return /^\d{4}$/.test(String(value).trim()) && digitsOf(evidenceText).includes(year);
  }

  // Names are matched token by token, and tolerantly: local OCR mangles printed
  // names constantly, and demanding an exact reproduction of every token would
  // reject a name that is plainly on the card. A clear majority of the name
  // having been read is enough to say the value came from this page.
  if (/name$/.test(field)) {
    const tokens = String(value).toUpperCase().split(/\s+/).filter(token => token.length > 1);
    if (!tokens.length) return haystack.includes(needle);
    const found = tokens.filter(token => haystack.includes(squash(token)));
    return found.length / tokens.length >= 0.6;
  }

  return false;
}

/** Is a label for this field visible in the evidence (or the wider page text)? */
function labelPresent(field, evidenceText, pageText) {
  if (SELF_IDENTIFYING.has(field)) return true;
  const pattern = FIELD_LABELS[field];
  if (!pattern) return true;
  return pattern.test(String(evidenceText || '')) || pattern.test(String(pageText || ''));
}

/**
 * Decide a field's status from its value and the evidence offered for it.
 *
 * `pageText` is whatever independent text we have for the page (local OCR).
 * When it exists it is the strongest corroboration available; when it does not,
 * we fall back to the model's own evidence snippet, which is weaker but still
 * far better than accepting a bare value.
 *
 * Returns `{ status, verified, reason }`.
 */
/**
 * Can this page text WITNESS that a label is absent? Only when local OCR
 * demonstrably read the document: it found at least one real field label.
 * Garbage OCR — guilloche card backgrounds, mixed scripts, low contrast —
 * yields no labels at all, and its silence about one more label proves
 * nothing. (document_number's catch-all pattern is excluded: it matches
 * anything.)
 */
function pageTextWitnessesAbsence(pageText) {
  const text = String(pageText || '');
  if (text.replace(/\s+/g, '').length < 30) return false;
  return Object.entries(FIELD_LABELS).some(([field, pattern]) =>
    field !== 'document_number' && pattern.test(text));
}

function assessField({ field, value, evidenceText, pageText, source, crossConfirmed = false, formatValidated = false, required = false }) {
  if (value == null || String(value).trim() === '') {
    return { status: STATUS.NOT_PRESENT, verified: false, reason: 'no_value_returned' };
  }

  // A checksummed machine-readable source is its own proof.
  if (SELF_EVIDENT_SOURCES.has(source)) {
    return { status: STATUS.PRESENT_VERIFIED, verified: true, reason: `self_evident_source:${source}` };
  }

  // The holder typing a value they can see is evidence, recorded as such.
  if (source === 'user') {
    return { status: STATUS.PRESENT_VERIFIED, verified: true, reason: 'user_confirmed' };
  }

  // A document number that satisfies its type's format and checksum proves
  // itself: a 12-digit string that passes Verhoeff is an Aadhaar number, and
  // no amount of missing surrounding text makes it less so.
  if (formatValidated) {
    return { status: STATUS.PRESENT_VERIFIED, verified: true, reason: 'format_and_checksum_valid' };
  }

  const hasLabel = labelPresent(field, evidenceText, pageText);
  const inEvidence = evidenceContainsValue(field, value, evidenceText);
  const inPage = pageText ? evidenceContainsValue(field, value, pageText) : false;

  // Strongest available: the value appears in text read independently of the
  // model that produced it, under a label for this field.
  if (inPage && hasLabel) {
    return { status: STATUS.PRESENT_VERIFIED, verified: true, reason: 'corroborated_by_page_text' };
  }

  // Two models independently produced the same value.
  if (crossConfirmed && hasLabel) {
    return { status: STATUS.PRESENT_VERIFIED, verified: true, reason: 'confirmed_by_second_model' };
  }

  // The model pointed at printed text that genuinely contains the value, and a
  // label for the field is visible.
  if (inEvidence && hasLabel) {
    // The page-text veto: if independent text exists and the value is nowhere
    // in it, the "evidence" was invented alongside the value.
    //
    // Applied only to LABEL-REQUIRED fields — a date of birth, a parent, an
    // address — which is where invention actually happens and matters. Names,
    // genders and numbers identify themselves, and vetoing them on the strength
    // of imperfect local OCR rejects values that are plainly on the card.
    // The veto also needs text worth trusting: OCR that could not read a
    // single field label off the page cannot witness a value's absence.
    const corroborationUsable = pageTextWitnessesAbsence(pageText);
    if (corroborationUsable && !inPage && !SELF_IDENTIFYING.has(field)) {
      return {
        status: STATUS.PRESENT_UNCERTAIN, verified: false,
        reason: 'evidence_not_found_in_page_text'
      };
    }
    return { status: STATUS.PRESENT_VERIFIED, verified: true, reason: 'evidence_supports_value' };
  }

  // A field the document type REQUIRES — the name on an Aadhaar, the number on
  // a PAN — is one the card certainly carries. The purpose of this gate is to
  // stop INVENTED fields: values for things the document does not have. A
  // required field is, by definition, not one of those.
  //
  // Withholding it until local OCR corroborates would mean a card in a script
  // we cannot read (Malayalam, among others) can never supply its own holder's
  // name, however clearly it is printed. Whether the value is CORRECT is then
  // settled by the comparison layer, which is where disagreement belongs.
  if (required && SELF_IDENTIFYING.has(field)) {
    return {
      status: STATUS.PRESENT_VERIFIED, verified: true,
      reason: inPage ? 'corroborated_by_page_text' : 'required_field_read_from_document'
    };
  }

  if (!hasLabel) {
    // "No label anywhere" is only meaningful when the OCR could read labels
    // at all. A real phone photo of a PAN card produces garbage local OCR —
    // concluding "the card has no DOB label" from garbage threw away
    // correctly read values on real documents. Without a witness, the value
    // stays VISIBLE and uncertain, eligible for a targeted re-read.
    if (!pageTextWitnessesAbsence(pageText)) {
      return {
        status: STATUS.PRESENT_UNCERTAIN, verified: false,
        reason: 'no_local_corroboration_available'
      };
    }
    // The page text is readable and shows no label for this field. This is
    // the Voter-ID-DOB case: the card carries no date-of-birth label, so a
    // returned date cannot have been read off it.
    //
    // Only applied to fields that ARE always labelled — see SELF_IDENTIFYING.
    return {
      status: STATUS.NOT_PRESENT, verified: false,
      reason: 'no_label_for_field_on_page'
    };
  }

  // A label is present and the value looks plausible, but we could not tie the
  // two together. Kept and shown, excluded from comparison.
  return { status: STATUS.PRESENT_UNCERTAIN, verified: false, reason: 'value_without_supporting_evidence' };
}

/** True when a field in this state may take part in comparison. */
const participates = status => PARTICIPATING.has(status);

/** Human-readable explanation of why a field is not being compared. */
const EXCLUSION_REASON = {
  [STATUS.NOT_PRESENT]: 'not printed on this document',
  [STATUS.PRESENT_UNCERTAIN]: 'read without supporting evidence, so it is not compared',
  [STATUS.UNREADABLE]: 'printed but could not be read',
  [STATUS.INVALID]: 'not a field this document can carry, or it failed validation',
  holder_asserted: 'Applicant supplied; not verified from the uploaded document.'
};

module.exports = {
  STATUS, PARTICIPATING, SELF_EVIDENT_SOURCES, FIELD_LABELS, SELF_IDENTIFYING,
  EXCLUSION_REASON, assessField, participates, evidenceContainsValue, labelPresent,
  pageTextWitnessesAbsence, squash
};
