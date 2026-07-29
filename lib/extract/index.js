'use strict';

const { config } = require('../config');
const { flags } = require('../flags');
const { contentHash, extractionKey } = require('../db');
const { createVisionClient } = require('./vision');
const { extractionPrompt, PROMPT_VERSION } = require('./prompts');
const {
  parseAndValidate, validateExtraction, emptyExtraction, plainValues, rawValues, fieldStates, reassess,
  SCHEMA_VERSION, SchemaError, envelope, STATUS
} = require('./schema');
const { evidenceContainsValue, labelPresent } = require('./evidence');
const { fieldRereadPrompt } = require('./prompts');
const enhance = require('../preprocess/enhance');
const { extractWithTesseract, fieldsFromText } = require('./tesseract');
const { classifyDocument } = require('./classify');
const { validateWithRepair } = require('../validate/repair');
const { parseMrz } = require('../validate/checksums');
const { readAadhaarQr } = require('../validate/barcode');
const preprocess = require('../preprocess');

// Extraction orchestration.
//
// Ordering matters and is deliberate:
//   1. preprocess and gate on quality — never read a document we cannot see
//   2. deterministic reads (QR, MRZ) — machine-printed, checksummed truth
//   3. classify from evidence — the backend decides what this document is
//   4. ONE vision call, prompted with only the fields that document can carry
//   5. deterministic sources overwrite the model wherever they exist
//   6. a second model only when a required field is still missing
//
// The cache is keyed by bytes AND by every version that shaped the result, so
// changing a prompt or a model can never serve a stale read.

// 3.1.0: blur-recovery pipeline (marginal tier, enhancement-variant OCR
// consensus, targeted field re-reads). Bumping this deliberately invalidates
// every cached extraction so recovery applies to previously seen files too.
const EXTRACTOR_VERSION = '3.1.0';

/** Run tasks with a concurrency cap, never letting one failure abort the rest. */
async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

const isBlank = value => value == null || String(value).trim() === '';

const same = (a, b) => String(a).trim().toUpperCase() === String(b).trim().toUpperCase();

/**
 * Merge two model readings field by field, at the envelope level.
 *
 * This is also where CROSS-CONFIRMATION happens. A value the first model could
 * not evidence, but which a second model independently produced identically,
 * is corroborated by that agreement and is promoted to verified. A value only
 * one model produced, with nothing supporting it, stays uncertain and is kept
 * out of comparison — it may well be real, but we cannot show where it came
 * from, so it must not be able to contradict a value we can.
 */
function mergeReadings(primary, secondary) {
  const fields = {};
  const confidence = {};
  const candidates = {};
  const names = new Set([...Object.keys(primary.fields || {}), ...Object.keys(secondary?.fields || {})]);

  for (const name of names) {
    const a = primary.fields ? primary.fields[name] : null;
    const b = secondary && secondary.fields ? secondary.fields[name] : null;

    // Compare on the RAW readings, so cross-confirmation can rescue a value
    // that neither model managed to evidence on its own.
    const aRaw = a && a.raw_value;
    const bRaw = b && b.raw_value;
    const aVerified = Boolean(a && a.status === STATUS.PRESENT_VERIFIED);
    const bVerified = Boolean(b && b.status === STATUS.PRESENT_VERIFIED);
    const aInvalid = Boolean(a && a.status === STATUS.INVALID);
    const bInvalid = Boolean(b && b.status === STATUS.INVALID);

    // A field the registry forbids stays rejected whatever the models say.
    if (aInvalid || bInvalid) {
      fields[name] = aInvalid ? a : b;
      confidence[name] = 'none';
      continue;
    }

    if (!isBlank(aRaw) && !isBlank(bRaw)) {
      if (same(aRaw, bRaw)) {
        const base = aVerified ? a : (bVerified ? b : a);
        fields[name] = {
          ...base,
          normalized_value: aRaw,
          status: STATUS.PRESENT_VERIFIED,
          verified: true,
          confidence: 0.95,
          evidence_reason: aVerified || bVerified ? base.evidence_reason : 'confirmed_by_second_model'
        };
        confidence[name] = 'high';
      } else {
        // Two models, two different readings. Keep the evidenced one if only
        // one is evidenced; otherwise neither can be trusted to compare.
        if (aVerified && !bVerified) { fields[name] = { ...a, confidence: 0.6 }; confidence[name] = 'medium'; }
        else if (bVerified && !aVerified) { fields[name] = { ...b, confidence: 0.6 }; confidence[name] = 'medium'; }
        else {
          fields[name] = {
            ...(a || b), normalized_value: null,
            status: STATUS.PRESENT_UNCERTAIN, verified: false, confidence: 0.3,
            evidence_reason: 'models_disagree'
          };
          confidence[name] = 'low';
        }
        candidates[name] = [aRaw, bRaw];
      }
      continue;
    }

    const only = !isBlank(aRaw) ? a : (!isBlank(bRaw) ? b : null);
    if (only) {
      fields[name] = { ...only, confidence: only.status === STATUS.PRESENT_VERIFIED ? 0.8 : 0.3 };
      confidence[name] = only.status === STATUS.PRESENT_VERIFIED ? 'medium' : 'low';
      continue;
    }

    fields[name] = a || b || envelope();
    confidence[name] = 'none';
  }

  return { fields, confidence, candidates };
}

/** Overwrite a field from a deterministic source, which always outranks a model. */
function applyDeterministic(fields, name, value, { source, evidence, validators = [] }) {
  if (isBlank(value)) return;
  fields[name] = envelope({
    raw_value: String(value),
    normalized_value: String(value),
    confidence: 0.99,
    // Machine-readable and checksummed: it carries its own proof.
    status: STATUS.PRESENT_VERIFIED,
    verified: true,
    source,
    evidence_text: evidence ? String(evidence).slice(0, 200) : null,
    evidence_reason: `self_evident_source:${source}`,
    validator_results: validators
  });
}

/** Validate the document number and attempt positional OCR repair. */
function validateDocument(type, values) {
  if (isBlank(values.document_number)) {
    return { number: null, valid: false, reason: 'empty', repaired: false, changes: [], needsManualEntry: false };
  }
  const result = validateWithRepair(type, values.document_number);
  return {
    number: result.value, valid: result.valid, reason: result.reason || '',
    repaired: result.repaired, changes: result.changes, needsManualEntry: result.needsManualEntry
  };
}

function createExtractor(options = {}) {
  const store = options.store;
  if (!store) throw new Error('createExtractor requires a store');

  const vision = options.vision || createVisionClient();
  const tesseract = options.tesseract || extractWithTesseract;
  const crossCheckMode = options.crossCheckMode || config.crossCheckMode;
  const models = { ...config.models, ...(options.models || {}) };
  const concurrency = options.concurrency || config.extraction.concurrency;
  const onProgress = options.onProgress || (() => {});
  const qrReader = options.readAadhaarQr || readAadhaarQr;
  const qualityCheck = options.assessQuality || preprocess.assessQuality;
  const normalizeImage = options.normalizeImage || preprocess.normalizeImage;

  const modelIds = [models.primary, models.crossCheck].filter(Boolean);

  /**
   * Read ONE document. Returns the immutable extraction plus the preprocessing
   * outcome; the caller attaches it to an owned `documents` row.
   */
  async function extractOne({ buffer, mimeType, fileName, hint, pageRole = 'front', country }) {
    const hash = contentHash(buffer);
    const key = extractionKey({
      contentHash: hash,
      extractor: EXTRACTOR_VERSION,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      modelIds
    });

    // 1. Cache, keyed by bytes AND versions. A cached quality-gate failure is
    //    still a quality-gate failure: the same blurred file must come back as
    //    retake_required with its original reasons, not as a mystery
    //    "unreadable" because the cache dropped the verdict.
    const cached = store.getExtractionByKey(key);
    if (cached) {
      onProgress({ hash, fileName, stage: 'cached' });
      const retakeRequired = Boolean(cached.validation && cached.validation.qualityGate === 'failed');
      return {
        ...cached, extractionKey: key, contentHash: hash, cached: true,
        quality: { cached: true, reasons: (cached.validation && cached.validation.reasons) || [] },
        ...(retakeRequired ? { retakeRequired: true } : {})
      };
    }

    onProgress({ hash, fileName, stage: 'preprocessing' });

    // 2. Preprocess: EXIF orientation applied, oversized scans bounded.
    const isImage = /^image\//i.test(mimeType || '');
    let readable = buffer;
    let readableMime = mimeType || 'image/jpeg';
    let quality = { assessed: false, usable: true, reasons: [], metrics: {} };

    if (isImage) {
      const normalized = await normalizeImage(buffer);
      readable = normalized.buffer;
      readableMime = normalized.mimeType;
      quality = await qualityCheck(readable);
      quality.orientationApplied = normalized.orientationApplied || false;

      // 3. Quality gate: refuse to read what we cannot see.
      if (flags.enforceQualityGate && quality.assessed && !quality.usable) {
        const record = {
          extractionKey: key, contentHash: hash, extractor: EXTRACTOR_VERSION,
          promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION, modelIds,
          rawFields: emptyExtraction().fields, type: 'unknown',
          confidence: {}, candidates: {},
          validation: { qualityGate: 'failed', reasons: quality.reasons },
          classification: {}, source: 'quality-gate'
        };
        store.saveExtraction(record);
        onProgress({ hash, fileName, stage: 'retake_required' });
        return { ...store.getExtractionByKey(key), extractionKey: key, contentHash: hash, cached: false, quality, retakeRequired: true };
      }
    }

    onProgress({ hash, fileName, stage: 'extracting' });

    const errors = [];
    const deterministic = { aadhaarQr: null, mrz: null };

    // 4. Deterministic reads BEFORE any model. These are checksummed truth.
    if (isImage) {
      try {
        deterministic.aadhaarQr = await qrReader(readable, readableMime);
      } catch (error) {
        errors.push({ source: 'aadhaar_qr', message: error.message });
      }
    }

    // 5. Text uploads carry their own content; no vision model is called.
    const isText = /^text\//i.test(mimeType || '');
    let ocrText = '';
    let primary = null;
    let secondary = null;
    let source = '';

    if (isText) {
      const text = buffer.toString('utf8');
      ocrText = text;
      primary = validateExtraction(fieldsFromText(text), {
        pageRole, country, source: 'ocr', pageText: text, docType: hint, trustValues: true
      });
      source = 'embedded-text';
    }

    // Local OCR runs as CORROBORATION, not just as a fallback.
    //
    // Its text is produced without the vision model's involvement, which makes
    // it the only independent check on whether a value the model reports is
    // actually printed on the page. Without it, a model that invents a date of
    // birth on a card that has none is unchallengeable — which is exactly what
    // happened on a real Voter ID.
    if (!isText && !ocrText && flags.deterministicCrossRead) {
      try {
        const ocr = await tesseract(readable);
        ocrText = ocr.text || '';
      } catch (error) {
        // No corroboration available. Evidence then rests on the model's own
        // snippet, which is weaker — recorded so the degradation is visible.
        errors.push({ source: 'tesseract', message: error.message, effect: 'no_independent_corroboration' });
      }
    }

    // Every independent OCR pass over this page, for the consensus check
    // later: a value seen by two independent passes is printed, not invented.
    const ocrReads = [];
    if (ocrText) ocrReads.push({ variant: 'base', text: ocrText });

    // 5b. BLUR RECOVERY. A MARGINAL image gets extra OCR passes over derived
    //     enhancement variants (in memory only; the stored original is never
    //     touched). Capped at 3 variants, tesseract only — no additional
    //     vision-model calls per variant.
    const tier = quality.tier || (quality.assessed ? (quality.usable ? 'good' : 'unusable') : 'good');
    let bestVariant = null;
    if (isImage && tier === 'marginal' && flags.deterministicCrossRead) {
      try {
        const variants = await enhance.variantsFor(readable, quality.metrics || {});
        const reads = await mapWithLimit(variants, 2, async variant => {
          const ocr = await tesseract(variant.buffer);
          return { variant: variant.name, text: ocr.text || '', buffer: variant.buffer };
        });
        for (const read of reads) {
          if (read.ok && read.value.text.trim().length >= 20) {
            ocrReads.push({ variant: read.value.variant, text: read.value.text });
            if (!bestVariant || read.value.text.length > bestVariant.text.length) bestVariant = read.value;
          }
        }
        // The richest text becomes the page text the evidence layer reads.
        if (bestVariant && bestVariant.text.length > ocrText.length) ocrText = bestVariant.text;
      } catch (error) {
        errors.push({ source: 'enhance', message: error.message });
      }
    }

    if (ocrText) {
      const mrz = parseMrz(ocrText);
      if (mrz) deterministic.mrz = mrz;
    }
    // An enhancement variant may reveal an MRZ the base read missed.
    if (!deterministic.mrz) {
      for (const read of ocrReads) {
        const mrz = parseMrz(read.text);
        if (mrz) { deterministic.mrz = mrz; break; }
      }
    }

    // 6. Classify from evidence, BEFORE the main extraction, so the prompt can
    //    be the one written for the document this actually is.
    const preliminaryValues = primary ? plainValues(primary.fields) : {};
    if (deterministic.aadhaarQr) preliminaryValues.document_number = preliminaryValues.document_number || '';
    let classification = classifyDocument(
      preliminaryValues,
      hint && hint !== 'unknown' ? hint : (primary ? primary.document_type : 'unknown'),
      deterministic
    );

    // 7. Establish the document type, then read it with ITS OWN prompt.
    //
    // The generic prompt has to offer every field any document might carry —
    // 18 of them — and asking a small vision model for 18 fields at once
    // measurably degrades the read: a real PAN lost its father's name and a
    // real Aadhaar lost its gender, both plainly printed. The type-specific
    // prompts ask for 5-6 fields and get them.
    //
    // So the generic prompt is now only ever used to IDENTIFY the document.
    // The read that produces the fields we keep always uses the focused prompt.
    if (!isText && vision.configured) {
      const dataUri = `data:${readableMime};base64,${readable.toString('base64')}`;
      const read = async (type, label) => parseAndValidate(
        await vision.run(models.primary, { prompt: extractionPrompt(type, pageRole, country), dataUri }),
        {
          docType: type === 'unknown' ? undefined : type,
          pageRole, country, source: 'vision', modelVersion: models.primary,
          promptVersion: PROMPT_VERSION, pageText: ocrText, readLabel: label
        }
      );

      // 7a. Identify. Deterministic evidence may already have settled it, in
      //     which case this costs nothing.
      let knownType = classification.confident && classification.type !== 'unknown'
        ? classification.type
        : 'unknown';

      if (knownType === 'unknown') {
        try {
          primary = await read('unknown', 'identify');
          source = 'vision';
          classification = classifyDocument(rawValues(primary.fields), primary.document_type, deterministic);
          if (classification.type !== 'unknown') knownType = classification.type;
        } catch (error) {
          errors.push({ model: models.primary, message: error.message, retired: Boolean(error.retired) });
          if (error.retired) throw error;
        }
      }

      // 7b. The real read, with the prompt written for this exact document.
      //     Skipped only when we still have no idea what we are looking at.
      if (knownType !== 'unknown') {
        const alreadyFocused = primary && primary.readLabel === 'focused';
        if (!alreadyFocused) {
          try {
            const focused = await read(knownType, 'focused');
            // Keep whichever read produced more usable fields — a focused read
            // that comes back emptier than the identify pass is a regression,
            // not an improvement.
            // Count fields that came back with CONTENT. Verification happens
            // later — after deterministic sources and cross-model confirmation
            // — so scoring on verified fields here would compare two reads
            // before either has had the chance to be verified.
            const score = extraction => extraction
              ? Object.values(extraction.fields).filter(field =>
                field.raw_value != null && field.status !== STATUS.INVALID).length
              : -1;
            if (score(focused) >= score(primary)) {
              primary = focused;
              source = source ? `${source}+focused` : 'vision';
            } else {
              errors.push({ model: models.primary, message: 'focused read returned fewer fields; kept the identify pass' });
            }
          } catch (error) {
            errors.push({ model: models.primary, message: `focused read failed: ${error.message}` });
            if (error.retired) throw error;
          }
        }
      }

      // 8. Re-classify over whatever we finally read.
      if (primary) {
        classification = classifyDocument(rawValues(primary.fields), classification.type, deterministic);
      }

      const requiredMissing = !primary
        || ['holder_name', 'dob'].some(field => !primary.fields[field] || primary.fields[field].status !== STATUS.PRESENT_VERIFIED);

      if (crossCheckMode === 'always' || requiredMissing || !classification.confident) {
        try {
          secondary = parseAndValidate(
            await vision.run(models.crossCheck, { prompt: extractionPrompt(classification.type, pageRole, country), dataUri }),
            {
              docType: classification.type === 'unknown' ? undefined : classification.type,
              pageRole, country, source: 'vision', modelVersion: models.crossCheck,
              promptVersion: PROMPT_VERSION, pageText: ocrText
            }
          );
          source = primary ? `${source}+crosscheck` : 'vision-crosscheck-only';
        } catch (error) {
          errors.push({ model: models.crossCheck, message: error.message, retired: Boolean(error.retired) });
        }
      }
    }

    // 9. Local OCR fallback, only when no model produced anything at all.
    if (!isText && !primary && !secondary) {
      try {
        const ocr = await tesseract(readable);
        ocrText = ocr.text || ocrText;
        primary = validateExtraction(ocr.fields, {
          pageRole, country, source: 'ocr', pageText: ocrText, docType: classification.type
        });
        source = 'tesseract-fallback';
      } catch (error) {
        errors.push({ source: 'tesseract', message: error.message });
      }
    }

    const merged = primary || secondary
      ? mergeReadings(primary || { fields: {} }, secondary)
      : { fields: emptyExtraction().fields, confidence: {}, candidates: {} };

    // 10. Deterministic sources overwrite the model. A UIDAI-signed QR or a
    //     checksummed MRZ is not something a vision model gets to override.
    if (deterministic.aadhaarQr) {
      const qr = deterministic.aadhaarQr;
      const validators = [{ validator: 'aadhaar_secure_qr', passed: true, detail: 'Decoded from the UIDAI Secure QR printed on the card. Signature not verified (no bundled certificate).' }];
      applyDeterministic(merged.fields, 'holder_name', qr.name, { source: 'barcode', evidence: 'Aadhaar Secure QR', validators });
      applyDeterministic(merged.fields, 'dob', qr.dob, { source: 'barcode', evidence: 'Aadhaar Secure QR', validators });
      applyDeterministic(merged.fields, 'gender', qr.gender, { source: 'barcode', evidence: 'Aadhaar Secure QR', validators });
      applyDeterministic(merged.fields, 'address', qr.address, { source: 'barcode', evidence: 'Aadhaar Secure QR', validators });
    }

    if (deterministic.mrz && deterministic.mrz.valid) {
      const mrz = deterministic.mrz;
      const validators = [{ validator: 'mrz_check_digits', passed: true, detail: 'All ICAO 9303 check digits validated.' }];
      applyDeterministic(merged.fields, 'holder_name', mrz.name, { source: 'mrz', evidence: mrz.lines?.[0], validators });
      applyDeterministic(merged.fields, 'dob', mrz.dob, { source: 'mrz', evidence: mrz.lines?.[1], validators });
      applyDeterministic(merged.fields, 'gender', mrz.sex, { source: 'mrz', evidence: mrz.lines?.[1], validators });
      applyDeterministic(merged.fields, 'document_number', mrz.number, { source: 'mrz', evidence: mrz.lines?.[1], validators });
      applyDeterministic(merged.fields, 'expiry_date', mrz.expiry, { source: 'mrz', evidence: mrz.lines?.[1], validators });
      applyDeterministic(merged.fields, 'surname', mrz.surname, { source: 'mrz', validators });
      applyDeterministic(merged.fields, 'given_names', mrz.given, { source: 'mrz', validators });
    }

    // 11. Final classification over everything we now know.
    classification = classifyDocument(rawValues(merged.fields), classification.type, deterministic);
    const type = classification.type || 'unknown';

    // The first read was assessed before we knew what this document was. Now
    // that the type is settled, judge the same values against the real one.
    const rejudged = reassess(merged.fields, { docType: type, pageRole, country, pageText: ocrText });
    merged.fields = rejudged.fields;

    // 11b. OCR-CONSENSUS RECOVERY. A value the models produced but could not
    //      evidence becomes verified only when at least TWO independent OCR
    //      passes (base read + enhancement variants) each show it printed on
    //      the page, under its label. Different variants recover different
    //      regions, so this sees evidence no single pass contains.
    const RECOVERABLE = new Set([STATUS.PRESENT_UNCERTAIN, STATUS.NOT_PRESENT, STATUS.UNREADABLE]);
    const recovered = [];
    if (ocrReads.length >= 2) {
      for (const [name, field] of Object.entries(merged.fields)) {
        if (!field || field.raw_value == null || String(field.raw_value).trim() === '') continue;
        if (!RECOVERABLE.has(field.status)) continue;
        const value = String(field.raw_value);
        const hits = ocrReads.filter(read =>
          evidenceContainsValue(name, value, read.text) && labelPresent(name, '', read.text));
        if (hits.length >= 2) {
          merged.fields[name] = {
            ...field,
            normalized_value: field.raw_value,
            status: STATUS.PRESENT_VERIFIED,
            verified: true,
            confidence: Math.max(field.confidence || 0, 0.75),
            evidence_reason: 'verified_by_ocr_consensus',
            evidence_variants: hits.map(hit => hit.variant)
          };
          recovered.push(name);
        }
      }
    }

    // 11c. TARGETED RE-READ. For at most two identity-critical fields still
    //      unevidenced on a marginal image, ask the vision model to read that
    //      ONE field from the best enhanced view. Agreement between the two
    //      independent readings verifies; disagreement stays uncertain. A
    //      field whose label is visibly on the page but whose value never
    //      became readable is marked so, honestly.
    if (!isText && vision.configured && tier === 'marginal') {
      const targets = Object.entries(merged.fields)
        .filter(([name, field]) => field && field.raw_value
          && field.status === STATUS.PRESENT_UNCERTAIN
          && ['holder_name', 'dob', 'document_number'].includes(name))
        .slice(0, 2);
      for (const [name, field] of targets) {
        try {
          const view = bestVariant ? bestVariant.buffer : readable;
          const answer = await vision.run(models.primary, {
            prompt: fieldRereadPrompt(name, type),
            dataUri: `data:image/jpeg;base64,${view.toString('base64')}`
          });
          const parsed = JSON.parse(String(answer).replace(/```json|```/gi, '').trim());
          const reread = parsed && parsed[name];
          if (reread && evidenceContainsValue(name, String(field.raw_value), String(reread))) {
            merged.fields[name] = {
              ...field,
              normalized_value: field.raw_value,
              status: STATUS.PRESENT_VERIFIED,
              verified: true,
              confidence: Math.max(field.confidence || 0, 0.8),
              evidence_reason: 'verified_by_field_reread'
            };
            recovered.push(name);
          } else if (labelPresent(name, '', ocrText)) {
            merged.fields[name] = { ...field, evidence_reason: 'field_area_found_but_unreadable' };
          }
        } catch (error) {
          errors.push({ source: 'field_reread', field: name, message: error.message });
        }
      }
    }

    // What was attempted and what came back is part of the quality story the
    // holder sees.
    if (tier === 'marginal') {
      quality.enhancement = {
        attempted: ocrReads.map(read => read.variant).filter(variant => variant !== 'base'),
        recovered
      };
    }

    const values = plainValues(merged.fields);

    const rejected = [
      ...((primary && primary.rejected) || []),
      ...((secondary && secondary.rejected) || []),
      ...rejudged.rejected
    ];

    const record = {
      extractionKey: key,
      contentHash: hash,
      extractor: EXTRACTOR_VERSION,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      modelIds,
      rawFields: merged.fields,
      fieldStates: fieldStates(merged.fields),
      type,
      confidence: merged.confidence,
      candidates: merged.candidates,
      validation: {
        ...validateDocument(type, values),
        errors,
        rejectedFields: rejected,
        deterministic: {
          aadhaarQr: Boolean(deterministic.aadhaarQr),
          mrz: Boolean(deterministic.mrz && deterministic.mrz.valid)
        },
        qualityGate: quality.assessed ? (quality.usable ? 'passed' : 'failed') : 'skipped'
      },
      classification,
      source: source || 'failed'
    };

    store.saveExtraction(record);
    onProgress({ hash, fileName, stage: 'done', type });

    return {
      ...store.getExtractionByKey(key),
      extractionKey: key, contentHash: hash, cached: false, quality,
      normalizedBuffer: isImage ? readable : null
    };
  }

  return {
    vision,
    extractOne,
    extractionKeyFor: buffer => extractionKey({
      contentHash: contentHash(buffer), extractor: EXTRACTOR_VERSION,
      promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION, modelIds
    }),

    /** Extract a batch in parallel; one failure never aborts the rest. */
    async extractAll(documents) {
      const outcomes = await mapWithLimit(documents, concurrency, extractOne);
      return outcomes.map((outcome, index) => {
        if (outcome.ok) return outcome.value;
        const document = documents[index];
        return {
          contentHash: document.buffer ? contentHash(document.buffer) : '',
          extractionKey: null,
          type: 'unknown',
          rawFields: emptyExtraction().fields,
          confidence: {}, candidates: {},
          validation: { errors: [{ message: outcome.error.message, retired: Boolean(outcome.error.retired) }] },
          classification: {}, source: 'failed', failed: true, error: outcome.error.message
        };
      });
    }
  };
}

module.exports = {
  createExtractor, mergeReadings, mapWithLimit, validateDocument,
  applyDeterministic, EXTRACTOR_VERSION, SchemaError
};
