'use strict';

const { emptyExtraction } = require('./schema');
const { parseMrz } = require('../validate/checksums');
const { inferType } = require('../validate/formats');

// Local OCR, retained ONLY as a fallback for when Workers AI is unreachable or
// unconfigured. Results from this path are marked `tesseract-fallback` so the
// UI can say so.
//
// Two deliberate changes from the original implementation:
//   * one pass, not three. The old code scored three page-segmentation modes,
//     then threw the score away and concatenated all three raw texts, so the
//     field regexes ran over interleaved output from three different readers.
//   * eng+hin, because these cards print bilingual Hindi/English labels and an
//     English-only model reads the Hindi as garbage that pollutes the text.

const fs = require('fs');
const path = require('path');

let workerPromise = null;
let languages = 'eng';

/**
 * Assemble a single tessdata directory.
 *
 * Each language ships as its own npm package with its own directory, but
 * Tesseract accepts exactly ONE `langPath`. Asking for "eng+hin" while pointing
 * at the eng package makes the worker throw asynchronously for the missing
 * file — outside any promise chain, which previously took the whole server
 * down. So we copy what we have into one directory and only ever request
 * languages whose files are demonstrably present.
 *
 * Returns `{ langPath, languages }`.
 */
function resolveLanguages() {
  const target = path.join(require('../config').config.root, '.tessdata');
  const wanted = [
    { code: 'eng', module: '@tesseract.js-data/eng' },
    { code: 'hin', module: '@tesseract.js-data/hin' }
  ];

  const available = [];
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch {
    // Cannot stage the data; fall back to whatever eng ships with.
    const english = require('@tesseract.js-data/eng');
    return { langPath: english.langPath, languages: 'eng' };
  }

  for (const { code, module } of wanted) {
    try {
      const pack = require(module);
      const file = `${code}.traineddata.gz`;
      const source = path.join(pack.langPath, file);
      if (!fs.existsSync(source)) continue;
      const destination = path.join(target, file);
      if (!fs.existsSync(destination)) fs.copyFileSync(source, destination);
      available.push(code);
    } catch {
      // Language not installed. English-only OCR still works; it just reads
      // the Hindi half of a bilingual card as noise.
    }
  }

  if (!available.length) {
    const english = require('@tesseract.js-data/eng');
    return { langPath: english.langPath, languages: 'eng' };
  }
  return { langPath: target, languages: available.join('+') };
}

async function getWorker() {
  if (!workerPromise) {
    const { createWorker } = require('tesseract.js');
    const resolved = resolveLanguages();
    languages = resolved.languages;
    // A failed worker must never be cached, or every later document inherits
    // the same broken instance.
    workerPromise = createWorker(resolved.languages, 1, {
      langPath: resolved.langPath,
      gzip: true
    }).catch(error => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

async function terminate() {
  if (!workerPromise) return;
  const worker = await workerPromise.catch(() => null);
  workerPromise = null;
  if (worker) await worker.terminate().catch(() => {});
}

// --- field picking over raw OCR text ---------------------------------------

const DATE = '(?:\\d{4}[/.\\-]\\d{1,2}[/.\\-]\\d{1,2}|\\d{1,2}[/.\\-]\\d{1,2}[/.\\-]\\d{2,4})';

// A captured value has to look like a name before we believe it. Without this,
// the label "Given Name(s)" matches on \bname\b and yields "(s)".
const looksLikeValue = value => /\p{L}{2,}/u.test(value);

function pickLabelled(text, labels) {
  const lines = text.split(/\r?\n/).map(line => line.trim());
  for (const label of labels) {
    // Prefer a label at the start of its own line, which is how cards print.
    for (let index = 0; index < lines.length; index++) {
      const match = lines[index].match(new RegExp(`^${label}\\s*[:=\\-]?\\s*(.*)$`, 'i'));
      if (!match) continue;
      const inline = match[1].trim();
      if (inline && looksLikeValue(inline)) return inline;
      // Label alone on its line: the value is on the next one.
      const next = (lines[index + 1] || '').trim();
      if (!inline && next && looksLikeValue(next)) return next;
    }
  }
  for (const label of labels) {
    const match = text.match(new RegExp(`${label}\\s*[:=\\-]\\s*([^\\r\\n]{2,60})`, 'i'));
    if (match && looksLikeValue(match[1].trim())) return match[1].trim();
  }
  return null;
}

/**
 * Best-effort field extraction from OCR text.
 *
 * Note the deliberate conservatism: where the original code fell back to "the
 * last clean line above the date", which reliably captured the FATHER's name on
 * a PAN card, this returns null instead. A null the holder can correct is far
 * better than a confidently wrong name that silently becomes their identity.
 */
function fieldsFromText(rawText) {
  const text = String(rawText || '').replace(/\0/g, ' ').replace(/\s*([/.\-])\s*/g, '$1');
  const result = emptyExtraction();

  // The MRZ, when present, is the most reliable region on a passport.
  const mrz = parseMrz(text);
  if (mrz) {
    result.document_type = 'passport';
    result.name = mrz.name || null;
    result.dob = mrz.dob || null;
    result.gender = mrz.sex || null;
    result.document_number = mrz.number || null;
    result.expiry_date = mrz.expiry || null;
  }

  result.name = result.name || pickLabelled(text, ['name of (?:the )?(?:card ?)?holder', "holder'?s name", '\\bname\\b(?! of father)']);
  result.father_name = pickLabelled(text, ["father'?s? name", 'father', 'पिता']);
  result.mother_name = pickLabelled(text, ["mother'?s? name", 'mother', 'माता']);
  result.spouse_name = pickLabelled(text, ["husband'?s? name", "wife'?s? name", "spouse'?s? name"]);

  if (!result.dob) {
    const labelled = text.match(new RegExp(`(?:dob|date of birth|birth|जन्म)[^\\d]{0,20}(${DATE})`, 'i'));
    // Two-digit years are accepted here; the old regex demanded four and so
    // found nothing at all on cards printing 12/08/97.
    const loose = text.match(new RegExp(`\\b(${DATE})\\b`));
    result.dob = (labelled && labelled[1]) || (loose && loose[1]) || null;
  }

  if (!result.gender) {
    // "Sex: M" and "Gender: F" are as common on these cards as the full word.
    const labelled = text.match(/\b(?:sex|gender|लिंग)\s*[:=-]\s*(male|female|other|m|f|o)\b/i);
    const bare = text.match(/\b(male|female|पुरुष|महिला)\b/i);
    result.gender = (labelled && labelled[1]) || (bare && bare[1]) || null;
  }

  const address = pickLabelled(text, ['address', 'पता']);
  result.address = address || null;

  if (!result.document_number) {
    const pan = text.match(/\b([A-Z]{5}\s?\d{4}\s?[A-Z])\b/);
    const aadhaar = text.match(/\b(\d{4}\s?\d{4}\s?\d{4})\b/);
    const epic = text.match(/\b([A-Z]{3}\s?\d{7})\b/);
    const passport = text.match(/\b([A-Z]\d{7})\b/);
    result.document_number = (pan && pan[1]) || (aadhaar && aadhaar[1]) || (epic && epic[1]) || (passport && passport[1]) || null;
  }

  if (result.document_type === 'unknown') {
    // Registrars print "Certificate of Birth" as often as "Birth Certificate".
    const declared = text.match(/\b(income tax|permanent account|aadhaar|आधार|passport|election commission|elector|birth certificate|certificate of birth|registration of birth)\b/i);
    const label = (declared && declared[1].toLowerCase()) || '';
    result.document_type =
      /income tax|permanent account/.test(label) ? 'pan'
      : /aadhaar|आधार/.test(label) ? 'aadhaar'
      : /passport/.test(label) ? 'passport'
      : /election|elector/.test(label) ? 'voter'
      : /birth/.test(label) ? 'birth_certificate'
      : inferType(result.document_number || '') || 'unknown';
  }

  // Aadhaar prints the holder's name unlabelled, on the line above the date of
  // birth. Reading by position is exactly the heuristic that used to capture
  // the FATHER's name on PAN cards — so it is scoped to Aadhaar alone, which
  // by design carries no parent name at all, and only when nothing else worked.
  if (!result.name && result.document_type === 'aadhaar') {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const dobIndex = lines.findIndex(line => /(?:dob|date of birth|जन्म)/i.test(line));
    const header = /government|india|भारत|सरकार|unique|identification|authority|aadhaar|आधार|male|female|year of birth|address|आम आदमी/i;

    const candidates = lines
      .slice(0, dobIndex < 0 ? lines.length : dobIndex)
      .filter(line => /^[A-Za-z][A-Za-z .]{2,50}$/.test(line) && !header.test(line));

    // The name sits immediately above the date of birth.
    result.name = candidates.at(-1) || null;
  }

  return result;
}

/**
 * Run local OCR over an image buffer and pick fields from the text.
 * `recognizer` is injectable so tests never load the OCR engine.
 */
async function extractWithTesseract(buffer, options = {}) {
  const recognize = options.recognize || (async image => {
    const worker = await getWorker();
    await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
    return worker.recognize(image);
  });

  const outcome = await recognize(buffer);
  const text = outcome?.data?.text || '';
  const confidence = Math.round(outcome?.data?.confidence ?? 0);

  return {
    fields: fieldsFromText(text),
    text,
    ocrConfidence: confidence,
    languages,
    source: 'tesseract-fallback'
  };
}

module.exports = { extractWithTesseract, fieldsFromText, getWorker, terminate, resolveLanguages };
