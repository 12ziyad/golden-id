'use strict';

const registry = require('../schemas/registry');
const { flags } = require('../flags');
const evidence = require('./evidence');

// Versioned so the extraction cache invalidates when this file's meaning
// changes. Bump on any change to field names, states or enforcement.
const SCHEMA_VERSION = '3.0.0';

const FIELDS = [
  'document_type',
  'holder_name', 'surname', 'given_names',
  'father_name', 'mother_name', 'spouse_name',
  'dob', 'year_of_birth', 'age', 'gender',
  'address', 'place_of_birth',
  'document_number', 'issue_date', 'expiry_date',
  'nationality', 'issuing_authority', 'mrz'
];

const ALIASES = {
  name: 'holder_name', full_name: 'holder_name', holder: 'holder_name',
  sex: 'gender', dateofbirth: 'dob', date_of_birth: 'dob',
  residential_address: 'address', pob: 'place_of_birth'
};

const DOCUMENT_TYPES = ['pan', 'aadhaar', 'passport', 'voter', 'birth_certificate', 'driving_licence', 'unknown'];

const NULLISH = new Set([
  '', 'NULL', 'NONE', 'N/A', 'NA', 'NIL', 'NOT AVAILABLE', 'NOT FOUND',
  'NOT PRESENT', 'NOT VISIBLE', 'UNKNOWN', 'UNDEFINED', '-', '--', 'NOT APPLICABLE',
  'NOT SPECIFIED', 'NOT MENTIONED', 'ABSENT', 'BLANK', 'EMPTY'
]);

const STATUS = evidence.STATUS;
const STATUSES = Object.values(STATUS);
const SOURCES = ['ocr', 'vision', 'mrz', 'barcode', 'user', 'deterministic'];

class SchemaError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'SchemaError';
    this.detail = detail;
  }
}

/**
 * One field's evidence envelope. A value never travels without the record of
 * where it came from and whether that source could be located.
 */
function envelope(overrides = {}) {
  return {
    raw_value: null,
    normalized_value: null,
    confidence: 0,
    status: STATUS.NOT_PRESENT,
    source: null,
    evidence_text: null,
    evidence_reason: null,
    verified: false,
    page: 1,
    bounding_box: null,
    validator_results: [],
    model_version: null,
    prompt_version: null,
    ...overrides
  };
}

function stripFences(text) {
  let output = String(text == null ? '' : text).trim();
  const fenced = output.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenced) output = fenced[1].trim();
  const firstBrace = output.indexOf('{');
  const lastBrace = output.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) output = output.slice(firstBrace, lastBrace + 1);
  return output.trim();
}

function parseModelJson(text) {
  const cleaned = stripFences(text);
  if (!cleaned) throw new SchemaError('Model returned an empty response', { text });
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SchemaError('Model response was not a JSON object', { text: cleaned });
    }
    return parsed;
  } catch (error) {
    if (error instanceof SchemaError) throw error;
    throw new SchemaError(`Model response was not valid JSON: ${error.message}`, { text: cleaned });
  }
}

function normalizeValue(value) {
  if (value == null) return null;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return null;
  if (Array.isArray(value)) {
    const joined = value.filter(item => item != null).map(String).join(', ').trim();
    return joined || null;
  }
  if (typeof value === 'object') {
    if (typeof value.value === 'string') return normalizeValue(value.value);
    if (typeof value.raw_value === 'string') return normalizeValue(value.raw_value);
    return null;
  }
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text || NULLISH.has(text.toUpperCase())) return null;
  return text;
}

const canonicalKey = key => {
  const lower = String(key).toLowerCase().trim();
  return ALIASES[lower] || lower;
};

function resolveDocumentType(raw) {
  const text = String(raw || '');
  if (text.includes('|')) return 'unknown';
  const type = text.toLowerCase().replace(/[\s-]+/g, '_');
  if (DOCUMENT_TYPES.includes(type)) return type;
  if (type.includes('birth')) return 'birth_certificate';
  if (type.includes('aadhaar') || type.includes('aadhar')) return 'aadhaar';
  if (type.includes('pan') || type.includes('permanent_account')) return 'pan';
  if (type.includes('passport')) return 'passport';
  if (type.includes('voter') || type.includes('epic') || type.includes('election')) return 'voter';
  if (type.includes('driv') || type.includes('licence') || type.includes('license')) return 'driving_licence';
  return 'unknown';
}

/** Pull the model's per-field evidence map out of the response, if it gave one. */
function evidenceMapFrom(parsed) {
  const raw = parsed.evidence || parsed._evidence || parsed.evidence_text || {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const canonical = canonicalKey(key);
    const text = normalizeValue(value);
    if (text) out[canonical] = text;
  }
  return out;
}

/**
 * Validate and normalise a parsed model response into evidence envelopes.
 *
 * Two independent gates:
 *   1. CAPABILITY — a field the document/page cannot carry is `invalid`,
 *      regardless of how confident the model was.
 *   2. EVIDENCE   — a field the document COULD carry still only becomes
 *      `present_verified` if the printed text it came from can be located.
 *      Anything else is recorded but excluded from comparison.
 *
 * The second gate is what stops a document being blamed for contradicting a
 * value it never printed.
 */
function validateExtraction(parsed, options = {}) {
  const {
    docType: assumedType,
    pageRole = 'front',
    country = registry.DEFAULT_COUNTRY,
    source = 'vision',
    page = 1,
    modelVersion = null,
    promptVersion = null,
    // Independent text for this page (local OCR). The strongest corroboration
    // available, because it was produced without the model's involvement.
    pageText = null,
    // Values a second model independently produced, for cross-confirmation.
    crossConfirmed = {},
    requireDocumentType = false,
    readLabel = null,
    // Skip evidence checks for trusted, self-describing input (manual entry).
    trustValues = false
  } = options;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SchemaError('Extraction must be a JSON object', { parsed });
  }

  const incoming = {};
  for (const [key, value] of Object.entries(parsed)) {
    const canonical = canonicalKey(key);
    if (canonical === 'document_type' || FIELDS.includes(canonical)) {
      if (incoming[canonical] == null) incoming[canonical] = value;
    }
  }

  if (!Object.keys(incoming).length) {
    throw new SchemaError('Extraction contained none of the expected fields', { keys: Object.keys(parsed) });
  }

  const evidenceMap = evidenceMapFrom(parsed);
  const documentType = resolveDocumentType(incoming.document_type ?? assumedType);
  if (requireDocumentType && documentType === 'unknown') {
    throw new SchemaError('Extraction did not identify the document type', { documentType: incoming.document_type });
  }

  const effectiveType = assumedType && assumedType !== 'unknown' ? assumedType : documentType;
  const rejected = [];
  const unsupported = [];
  const fields = {};

  for (const field of FIELDS) {
    if (field === 'document_type') continue;
    const value = normalizeValue(incoming[field]);
    const evidenceText = evidenceMap[field] || null;

    if (value == null) {
      fields[field] = envelope({
        status: STATUS.NOT_PRESENT, page,
        model_version: modelVersion, prompt_version: promptVersion,
        evidence_reason: 'no_value_returned'
      });
      continue;
    }

    // --- gate 1: capability -------------------------------------------------
    if (flags.enforceCapabilities && registry.isImpossible(effectiveType, field, pageRole, country)) {
      rejected.push({ field, value, reason: 'field_impossible_for_document', docType: effectiveType, pageRole });
      fields[field] = envelope({
        raw_value: value, normalized_value: null, status: STATUS.INVALID,
        source, page, model_version: modelVersion, prompt_version: promptVersion,
        evidence_text: evidenceText, evidence_reason: 'field_impossible_for_document',
        validator_results: [{
          validator: 'capability_registry', passed: false,
          detail: `A ${effectiveType} ${pageRole} page does not carry ${field}; value discarded as unsupported.`
        }]
      });
      continue;
    }

    const rule = registry.conditionalRule(effectiveType, field, pageRole, country);
    if (flags.enforceCapabilities && rule && rule.requiresEvidence) {
      const haystack = `${evidenceText || ''} ${pageText || ''} ${incoming.mrz || ''}`;
      if (!rule.requiresEvidence.test(haystack)) {
        rejected.push({ field, value, reason: 'conditional_evidence_missing', docType: effectiveType, pageRole });
        fields[field] = envelope({
          raw_value: value, normalized_value: null, status: STATUS.INVALID,
          source, page, model_version: modelVersion, prompt_version: promptVersion,
          evidence_text: evidenceText, evidence_reason: 'conditional_evidence_missing',
          validator_results: [{
            validator: 'conditional_capability', passed: false,
            detail: `A ${effectiveType} only carries ${field} when an explicit relationship marker is printed; none was visible.`
          }]
        });
        continue;
      }
    }

    // --- gate 2: evidence ---------------------------------------------------
    // A document number that satisfies its own format and checksum is
    // self-proving; it needs no surrounding text.
    let formatValidated = false;
    if (field === 'document_number' && effectiveType !== 'unknown') {
      try {
        formatValidated = require('../validate/formats').validateNumber(effectiveType, value).valid;
      } catch { formatValidated = false; }
    }

    const assessment = trustValues
      ? { status: STATUS.PRESENT_VERIFIED, verified: true, reason: 'trusted_input' }
      : evidence.assessField({
        field, value, evidenceText, pageText, source, formatValidated,
        // Does this document type REQUIRE the field? If so the card carries it.
        required: registry.requiredFields(effectiveType, pageRole, country).includes(field),
        crossConfirmed: Boolean(crossConfirmed && crossConfirmed[field])
      });

    if (assessment.status !== STATUS.PRESENT_VERIFIED) {
      unsupported.push({ field, value, status: assessment.status, reason: assessment.reason });
    }

    fields[field] = envelope({
      raw_value: value,
      // Only a verified field carries a comparable value. The raw reading is
      // always kept so nothing is hidden.
      normalized_value: assessment.status === STATUS.PRESENT_VERIFIED ? value : null,
      confidence: assessment.verified ? 0.8 : 0.3,
      status: assessment.status,
      verified: assessment.verified,
      source, page,
      evidence_text: evidenceText ? String(evidenceText).slice(0, 300) : null,
      evidence_reason: assessment.reason,
      model_version: modelVersion, prompt_version: promptVersion
    });
  }

  return {
    document_type: documentType, fields, rejected, unsupported,
    schemaVersion: SCHEMA_VERSION, pageRole, country, readLabel
  };
}

const parseAndValidate = (text, options) => validateExtraction(parseModelJson(text), options);

function emptyExtraction() {
  const fields = {};
  for (const field of FIELDS) {
    if (field === 'document_type') continue;
    fields[field] = envelope({ status: STATUS.UNREADABLE, evidence_reason: 'document_not_read' });
  }
  return { document_type: 'unknown', fields, rejected: [], unsupported: [], schemaVersion: SCHEMA_VERSION };
}

/**
 * Collapse envelopes to plain values for comparison.
 * ONLY a verified field yields a value — an uncertain or absent one must never
 * reach the comparison layer, where it could become a contradiction.
 */
function plainValues(fields) {
  const out = {};
  for (const [field, item] of Object.entries(fields || {})) {
    out[field] = item && item.status === STATUS.PRESENT_VERIFIED
      ? (item.normalized_value ?? item.raw_value ?? null)
      : null;
  }
  return out;
}

/**
 * Re-run the capability and evidence gates once the document type is known.
 *
 * The first read necessarily happens before we know what the document is, so it
 * is assessed against `unknown`: nothing is required, nothing is impossible.
 * Once classification settles, the same values must be judged against the real
 * document — otherwise a name that IS required on a Voter ID stays unverified
 * purely because we did not yet know it was a Voter ID when we read it.
 */
function reassess(fields, options = {}) {
  const {
    docType = 'unknown', pageRole = 'front', country = registry.DEFAULT_COUNTRY, pageText = null
  } = options;
  if (!docType || docType === 'unknown') return { fields, rejected: [], unsupported: [] };

  const out = {};
  const rejected = [];
  const unsupported = [];
  const required = registry.requiredFields(docType, pageRole, country);

  for (const [field, item] of Object.entries(fields || {})) {
    const value = item ? item.raw_value : null;

    if (value == null) { out[field] = item; continue; }

    // Capability, now against the type we actually settled on.
    if (flags.enforceCapabilities && registry.isImpossible(docType, field, pageRole, country)) {
      rejected.push({ field, value, reason: 'field_impossible_for_document', docType, pageRole });
      out[field] = {
        ...item, normalized_value: null, status: STATUS.INVALID, verified: false,
        evidence_reason: 'field_impossible_for_document',
        validator_results: [{
          validator: 'capability_registry', passed: false,
          detail: `A ${docType} ${pageRole} page does not carry ${field}; value discarded as unsupported.`
        }]
      };
      continue;
    }

    // Reassessment only ever UPGRADES. Verification already earned — by a
    // checksummed source, by corroborating page text, or by two models
    // independently reading the same value — cannot be re-derived from the
    // envelope alone, and must not be taken away by looking again.
    if (item.status === STATUS.PRESENT_VERIFIED) {
      out[field] = item;
      continue;
    }

    let formatValidated = false;
    if (field === 'document_number') {
      try { formatValidated = require('../validate/formats').validateNumber(docType, value).valid; }
      catch { formatValidated = false; }
    }

    const assessment = evidence.assessField({
      field, value, evidenceText: item.evidence_text, pageText,
      source: item.source, formatValidated,
      required: required.includes(field)
    });

    if (assessment.status !== STATUS.PRESENT_VERIFIED) {
      unsupported.push({ field, value, status: assessment.status, reason: assessment.reason });
    }

    out[field] = {
      ...item,
      normalized_value: assessment.status === STATUS.PRESENT_VERIFIED ? value : null,
      status: assessment.status,
      verified: assessment.verified,
      evidence_reason: assessment.reason
    };
  }

  return { fields: out, rejected, unsupported };
}

/**
 * Every field's RAW reading, including unverified ones.
 *
 * Classification must use this, not `plainValues`. Deciding what a document IS
 * is a different question from deciding what may be compared: a 12-digit number
 * identifies an Aadhaar card whether or not we could find text around it, and
 * withholding it from the classifier makes the document unidentifiable.
 */
function rawValues(fields) {
  const out = {};
  for (const [field, item] of Object.entries(fields || {})) {
    out[field] = item && item.status !== STATUS.INVALID ? (item.raw_value ?? null) : null;
  }
  return out;
}

/** The state of every field, for the comparison layer's participation rules. */
function fieldStates(fields) {
  const out = {};
  for (const [field, item] of Object.entries(fields || {})) {
    out[field] = {
      status: item ? item.status : STATUS.NOT_PRESENT,
      verified: Boolean(item && item.verified),
      reason: item ? item.evidence_reason : null,
      rawValue: item ? item.raw_value : null,
      source: item ? item.source : null,
      evidenceText: item ? item.evidence_text : null
    };
  }
  return out;
}

module.exports = {
  SCHEMA_VERSION, FIELDS, ALIASES, DOCUMENT_TYPES, NULLISH, STATUS, STATUSES, SOURCES,
  SchemaError, envelope, stripFences, parseModelJson, validateExtraction,
  parseAndValidate, normalizeValue, emptyExtraction, plainValues, rawValues, fieldStates, reassess,
  canonicalKey, resolveDocumentType, evidenceMapFrom
};
