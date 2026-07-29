'use strict';

const { inferType, validateNumber, FORMATS } = require('../validate/formats');

// The backend decides what a document is. The vision model's `document_type`
// is one weighted vote, never the verdict.
//
// This exists because a real Aadhaar card was labelled "pan" by the model even
// though it had extracted a Verhoeff-valid 12-digit Aadhaar number, a gender,
// and no father's name — three facts individually incompatible with a PAN card.
//
// Evidence, in descending order of trustworthiness:
//   1. A decoded Aadhaar Secure QR or a valid passport MRZ. These are
//      machine-printed, structured and checksummed: effectively conclusive.
//   2. The document number's format, with Aadhaar's Verhoeff checksum.
//   3. Which fields the card carries.
//   4. What the model called it.
//
// When the top two candidates are close, the answer is `needs_confirmation`
// rather than a silent coin-flip.

const TYPES = ['pan', 'aadhaar', 'passport', 'voter', 'birth_certificate', 'driving_licence'];

const WEIGHTS = {
  qr: 10,                 // decoded Aadhaar Secure QR — conclusive
  mrz: 10,                // valid passport MRZ — conclusive
  numberFormat: 5,
  numberContradiction: 4,
  fieldContradiction: 2,
  fieldSupport: 2,
  modelClaim: 2
};

// A win this narrow is not a decision; it is a coin toss we refuse to make.
const CONFIDENT_MARGIN = 3;

const present = value => value != null && String(value).trim() !== '';

/**
 * Decide a document's type from the evidence.
 *
 * Returns `{ type, claimed, corrected, confident, needsConfirmation, confidence,
 * runnerUp, scores, evidence, reason }`.
 */
function classifyDocument(fields = {}, claimedType = 'unknown', signals = {}) {
  const scores = Object.fromEntries(TYPES.map(type => [type, 0]));
  const evidence = [];
  const claimed = TYPES.includes(claimedType) ? claimedType : 'unknown';

  // --- 1. Conclusive machine-readable evidence -----------------------------
  if (signals.aadhaarQr) {
    scores.aadhaar += WEIGHTS.qr;
    evidence.push({
      signal: 'aadhaar_secure_qr', supports: 'aadhaar', weight: WEIGHTS.qr,
      detail: 'A UIDAI Secure QR decoded successfully from this image'
    });
  }
  if (signals.mrz && signals.mrz.valid) {
    scores.passport += WEIGHTS.mrz;
    evidence.push({
      signal: 'passport_mrz', supports: 'passport', weight: WEIGHTS.mrz,
      detail: 'A machine-readable zone parsed with valid check digits'
    });
  }

  // --- 2. Document number format -------------------------------------------
  const number = fields.document_number;
  if (present(number)) {
    const numberType = inferType(number);
    if (numberType) {
      scores[numberType] += WEIGHTS.numberFormat;
      evidence.push({
        signal: 'document_number_format', supports: numberType, weight: WEIGHTS.numberFormat,
        detail: numberType === 'aadhaar'
          ? 'Number is 12 digits and passes the Verhoeff checksum'
          : `Number matches the ${FORMATS[numberType].label} format`
      });
    }

    if (claimed !== 'unknown' && FORMATS[claimed] && FORMATS[claimed].pattern) {
      const check = validateNumber(claimed, number);
      if (!check.valid && check.reason !== 'not_validated') {
        scores[claimed] -= WEIGHTS.numberContradiction;
        evidence.push({
          signal: 'document_number_contradiction', contradicts: claimed, weight: -WEIGHTS.numberContradiction,
          detail: `Number does not fit the ${FORMATS[claimed].label} format (${check.reason})`
        });
      }
    }
  }

  // --- 3. Field presence ----------------------------------------------------
  const holderName = fields.holder_name ?? fields.name;

  if (present(fields.gender)) {
    scores.pan -= WEIGHTS.fieldContradiction;
    evidence.push({ signal: 'gender_present', contradicts: 'pan', weight: -WEIGHTS.fieldContradiction, detail: 'A PAN card does not print a gender' });
  }
  if (present(fields.address)) {
    scores.pan -= WEIGHTS.fieldContradiction;
    scores.aadhaar += 1;
    scores.voter += 1;
    evidence.push({ signal: 'address_present', contradicts: 'pan', weight: -WEIGHTS.fieldContradiction, detail: 'A PAN card does not print an address' });
  }
  if (present(fields.father_name)) {
    scores.aadhaar -= WEIGHTS.fieldContradiction;
    scores.pan += 1;
    scores.voter += 1;
    evidence.push({ signal: 'father_name_present', contradicts: 'aadhaar', weight: -WEIGHTS.fieldContradiction, detail: "An Aadhaar card does not print a father's name" });
  }
  if (present(fields.expiry_date)) {
    scores.passport += WEIGHTS.fieldSupport;
    scores.driving_licence += 1;
    evidence.push({ signal: 'expiry_date_present', supports: 'passport', weight: WEIGHTS.fieldSupport, detail: 'Only a passport or licence prints an expiry date' });
  }
  // NOTE: a model-returned `mrz` string is deliberately NOT counted here.
  //
  // An MRZ is only evidence when it PARSES with valid check digits, which is
  // already scored above as `passport_mrz`. A real Voter ID was classified as a
  // passport because the model invented an MRZ-looking string and this
  // heuristic treated it as proof. Unparsed text in an MRZ slot proves nothing.
  if (present(fields.mother_name)) {
    scores.birth_certificate += WEIGHTS.fieldSupport;
    scores.voter -= 1;
    evidence.push({ signal: 'mother_name_present', supports: 'birth_certificate', weight: WEIGHTS.fieldSupport, detail: "A mother's name is characteristic of a birth certificate" });
  }
  if (present(fields.spouse_name)) {
    scores.voter += WEIGHTS.fieldSupport;
    evidence.push({ signal: 'spouse_name_present', supports: 'voter', weight: WEIGHTS.fieldSupport, detail: "A spouse's name is characteristic of a Voter ID" });
  }
  if (present(fields.place_of_birth)) {
    scores.passport += 1;
    scores.birth_certificate += 1;
  }
  if (!present(holderName) && present(fields.document_number)) {
    // Nothing decisive, but worth noting for the audit trail.
    evidence.push({ signal: 'holder_name_missing', weight: 0, detail: 'No holder name was read from this page' });
  }

  // --- 4. The model's own label --------------------------------------------
  if (claimed !== 'unknown') {
    scores[claimed] += WEIGHTS.modelClaim;
    evidence.push({ signal: 'model_claim', supports: claimed, weight: WEIGHTS.modelClaim, detail: `The vision model called this a ${claimed}` });
  }

  // --- decide ---------------------------------------------------------------
  const ranked = TYPES.map(type => ({ type, score: scores[type] })).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const runnerUp = ranked[1];

  if (best.score <= 0) {
    return {
      type: claimed, claimed, corrected: false,
      confident: false, needsConfirmation: claimed === 'unknown',
      confidence: claimed === 'unknown' ? 0 : 0.3,
      runnerUp: runnerUp.type, scores, evidence,
      reason: "No decisive evidence; kept the model's classification."
    };
  }

  const margin = best.score - runnerUp.score;
  const corrected = best.type !== claimed && claimed !== 'unknown';
  const confident = margin >= CONFIDENT_MARGIN;

  return {
    type: best.type,
    claimed,
    corrected,
    confident,
    // A close call is surfaced for confirmation instead of being guessed.
    needsConfirmation: !confident,
    confidence: Math.max(0, Math.min(1, Number((margin / (WEIGHTS.numberFormat + WEIGHTS.modelClaim)).toFixed(2)))),
    runnerUp: runnerUp.type,
    scores,
    evidence,
    reason: corrected
      ? `Reclassified from ${claimed} to ${best.type}: ${evidence
          .filter(item => item.supports === best.type || item.contradicts === claimed)
          .map(item => item.detail).join('; ')}`
      : (!confident
          ? `Could not separate ${best.type} from ${runnerUp.type} on the available evidence.`
          : (claimed === 'unknown'
              ? `Identified as ${best.type}: ${evidence.filter(item => item.supports === best.type).map(item => item.detail).join('; ')}`
              : ''))
  };
}

module.exports = { classifyDocument, TYPES, WEIGHTS, CONFIDENT_MARGIN };
