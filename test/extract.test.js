'use strict';

process.env.NODE_ENV = 'test';
process.env.CF_ACCOUNT_ID = '';
process.env.CF_API_TOKEN = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createVisionClient, adapterFor, VisionError } = require('../lib/extract/vision');
const {
  parseAndValidate: rawParse, validateExtraction, stripFences, plainValues,
  SchemaError, SCHEMA_VERSION, envelope, STATUS
} = require('../lib/extract/schema');

// These tests exercise parsing and canonicalisation, not the evidence gate,
// so values are trusted. lib/extract/evidence.js and test/presence.test.js
// cover evidence verification.
const parseAndValidate = (text, options = {}) => rawParse(text, { trustValues: true, ...options });
const { extractionPrompt, PROMPT_VERSION } = require('../lib/extract/prompts');
const { mergeReadings, mapWithLimit, applyDeterministic } = require('../lib/extract');
const { fieldsFromText } = require('../lib/extract/tesseract');
const { parseAadhaarQr } = require('../lib/validate/barcode');
const { harness, fixture, seed } = require('./helpers/harness');

// --- schema -----------------------------------------------------------------

test('markdown fences and preamble are stripped before parsing', () => {
  const fenced = '```json\n{"document_type":"pan","holder_name":"ASHA DEVI"}\n```';
  assert.equal(stripFences(fenced), '{"document_type":"pan","holder_name":"ASHA DEVI"}');
  assert.equal(parseAndValidate(fenced).fields.holder_name.normalized_value, 'ASHA DEVI');

  const chatty = 'Here is the JSON:\n{"document_type":"pan","holder_name":"ASHA DEVI"}\nHope that helps!';
  assert.equal(parseAndValidate(chatty).fields.holder_name.normalized_value, 'ASHA DEVI');
});

test('malformed model output is rejected, not guessed at', () => {
  assert.throws(() => parseAndValidate('not json at all'), SchemaError);
  assert.throws(() => parseAndValidate(''), SchemaError);
  assert.throws(() => parseAndValidate('[1,2,3]'), SchemaError);
  assert.throws(() => parseAndValidate('{"unrelated":"payload"}'), SchemaError);
});

test('legacy field names are accepted and canonicalised', () => {
  const result = parseAndValidate('{"document_type":"pan","name":"ASHA DEVI","sex":"F"}', { docType: 'aadhaar' });
  assert.equal(result.fields.holder_name.normalized_value, 'ASHA DEVI');
  assert.equal(result.fields.gender.normalized_value, 'F');
});

test('model stand-ins for "absent" become real nulls', () => {
  const result = parseAndValidate('{"document_type":"pan","holder_name":"ASHA","father_name":"N/A","dob":"none"}');
  assert.equal(result.fields.father_name.normalized_value, null);
  assert.equal(result.fields.father_name.status, 'not_present');
  assert.equal(result.fields.dob.normalized_value, null);
});

test('every field carries an evidence envelope', () => {
  const result = parseAndValidate('{"document_type":"pan","holder_name":"ASHA DEVI"}', {
    modelVersion: '@cf/test/model', promptVersion: PROMPT_VERSION, source: 'vision'
  });
  const field = result.fields.holder_name;
  assert.equal(field.status, STATUS.PRESENT_VERIFIED);
  assert.equal(field.source, 'vision');
  assert.equal(field.model_version, '@cf/test/model');
  assert.equal(field.prompt_version, PROMPT_VERSION);
  assert.ok('bounding_box' in field);
  assert.ok(Array.isArray(field.validator_results));
  assert.equal(result.schemaVersion, SCHEMA_VERSION);
});

test('an unrecognised document type degrades to unknown', () => {
  assert.equal(parseAndValidate('{"document_type":"driving licence","holder_name":"A"}').document_type, 'driving_licence');
  assert.equal(parseAndValidate('{"document_type":"Aadhar Card","holder_name":"A"}').document_type, 'aadhaar');
  assert.equal(parseAndValidate('{"document_type":"spaceship","holder_name":"A"}').document_type, 'unknown');
});

test('an echoed enum is a non-answer, not a classification', () => {
  const result = parseAndValidate('{"document_type":"pan|aadhaar|passport|voter|birth_certificate|unknown","holder_name":"ASHA DEVI"}');
  assert.equal(result.document_type, 'unknown');
  assert.equal(result.fields.holder_name.normalized_value, 'ASHA DEVI');
});

// --- prompts ----------------------------------------------------------------

test('an unknown document type gets the disambiguation block', () => {
  const prompt = extractionPrompt('unknown');
  assert.match(prompt, /12 digits, it is an Aadhaar card/);
  assert.match(prompt, /JSON only/i);
  assert.match(prompt, /Keep the spaces between words/);
});

test('a known document type gets only its own fields', () => {
  const pan = extractionPrompt('pan', 'front');
  assert.match(pan, /"father_name"/);
  assert.ok(!/"gender"/.test(pan));
  assert.match(pan, /PAN Card front page/i);
});

// --- vision adapters --------------------------------------------------------

test('moondream uses the native run path with stream disabled', async () => {
  let captured = null;
  const client = createVisionClient({
    accountId: 'acct', apiToken: 'token',
    fetch: async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ success: true, result: { result: { answer: '{"document_type":"pan"}' } } }), { status: 200 });
    }
  });

  const text = await client.run('@cf/moondream/moondream3.1-9B-A2B', { prompt: 'read it', dataUri: 'data:image/jpeg;base64,AAA' });
  assert.equal(text, '{"document_type":"pan"}');
  assert.match(captured.url, /\/ai\/run\/@cf\/moondream/);
  assert.equal(captured.body.task, 'query');
  // Streaming defaults to true and silently returns an empty result over REST.
  assert.equal(captured.body.stream, false);
});

test('llama uses OpenAI chat completions with an image_url block', async () => {
  let captured = null;
  const client = createVisionClient({
    accountId: 'acct', apiToken: 'token',
    fetch: async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"document_type":"aadhaar"}' } }] }), { status: 200 });
    }
  });

  await client.run('@cf/meta/llama-3.2-11b-vision-instruct', { prompt: 'read it', dataUri: 'data:image/jpeg;base64,AAA' });
  assert.match(captured.url, /\/ai\/v1\/chat\/completions$/);
  assert.equal(captured.body.messages[0].content[1].type, 'image_url');
});

test('adapters are selected by model id', () => {
  assert.equal(adapterFor('@cf/moondream/moondream3.1-9B-A2B').path('@cf/moondream/moondream3.1-9B-A2B'), '/run/@cf/moondream/moondream3.1-9B-A2B');
  assert.equal(adapterFor('@cf/meta/llama-3.2-11b-vision-instruct').path(), '/v1/chat/completions');
});

test('a retired model fails loudly and is never retried', async () => {
  let attempts = 0;
  const client = createVisionClient({
    accountId: 'acct', apiToken: 'token', retries: 2,
    fetch: async () => {
      attempts++;
      return new Response(JSON.stringify({ success: false, errors: [{ code: 5007, message: 'No such model' }] }), { status: 404 });
    }
  });

  await assert.rejects(() => client.run('@cf/retired/model', { prompt: 'x', dataUri: 'd' }), error => {
    assert.equal(error.retired, true);
    assert.match(error.message, /retired/i);
    return true;
  });
  assert.equal(attempts, 1);
});

test('an intermittently empty response is retried rather than abandoned', async () => {
  let attempts = 0;
  const client = createVisionClient({
    accountId: 'acct', apiToken: 'token', retries: 2,
    fetch: async () => {
      attempts++;
      const body = attempts < 3
        ? { result: {}, success: true, errors: [] }
        : { success: true, result: { result: { answer: '{"document_type":"aadhaar"}' } } };
      return new Response(JSON.stringify(body), { status: 200 });
    }
  });
  assert.equal(await client.run('@cf/moondream/moondream3.1-9B-A2B', { prompt: 'x', dataUri: 'd' }), '{"document_type":"aadhaar"}');
  assert.equal(attempts, 3);
});

test('a licence-gated model explains how to accept', async () => {
  const client = createVisionClient({
    accountId: 'acct', apiToken: 'token', retries: 2,
    fetch: async () => new Response(JSON.stringify({
      success: false, errors: [{ message: "AiError: Model Agreement: you must submit the prompt 'agree'." }]
    }), { status: 403 })
  });
  await assert.rejects(() => client.run('@cf/meta/llama-3.2-11b-vision-instruct', { prompt: 'x', dataUri: 'd' }), error => {
    assert.equal(error.agreementRequired, true);
    assert.match(error.message, /"prompt":"agree"/);
    return true;
  });
});

test('an unconfigured client refuses rather than pretending', async () => {
  const client = createVisionClient({ accountId: '', apiToken: '', fetch: async () => new Response('{}') });
  assert.equal(client.configured, false);
  await assert.rejects(() => client.run('m', { prompt: 'x', dataUri: 'd' }), /not configured/i);
});

// --- merging and determinism ------------------------------------------------

test('agreement is high, one-sided is medium, disagreement keeps both', () => {
  const primary = { fields: { holder_name: envelope({ raw_value: 'ASHA DEVI', normalized_value: 'ASHA DEVI', status: STATUS.PRESENT_VERIFIED }), dob: envelope({ raw_value: '12/08/1997', normalized_value: '12/08/1997', status: STATUS.PRESENT_VERIFIED }) } };
  const secondary = { fields: { holder_name: envelope({ raw_value: 'ASHA DEVI', normalized_value: 'ASHA DEVI', status: STATUS.PRESENT_VERIFIED }), dob: envelope({ raw_value: '12/08/1998', normalized_value: '12/08/1998', status: STATUS.PRESENT_VERIFIED }) } };

  const merged = mergeReadings(primary, secondary);
  assert.equal(merged.confidence.holder_name, 'high');
  assert.equal(merged.confidence.dob, 'low');
  assert.deepEqual(merged.candidates.dob, ['12/08/1997', '12/08/1998']);
});

test('a rejected field survives merging as invalid, not as a value', () => {
  const primary = { fields: { father_name: envelope({ raw_value: 'HALLUCINATED', normalized_value: null, status: STATUS.INVALID }) } };
  const merged = mergeReadings(primary, null);
  assert.equal(merged.fields.father_name.status, 'invalid');
  assert.equal(plainValues(merged.fields).father_name, null);
});

test('a deterministic source overwrites whatever the model said', () => {
  const fields = { holder_name: envelope({ raw_value: 'ASHA DEVL', normalized_value: 'ASHA DEVL', status: STATUS.PRESENT_VERIFIED, source: 'vision' }) };
  applyDeterministic(fields, 'holder_name', 'ASHA DEVI', { source: 'barcode', evidence: 'QR', validators: [{ validator: 'qr', passed: true }] });

  assert.equal(fields.holder_name.normalized_value, 'ASHA DEVI');
  assert.equal(fields.holder_name.source, 'barcode');
  assert.equal(fields.holder_name.confidence, 0.99);
});

test('documents run in parallel under a concurrency cap', async () => {
  let active = 0;
  let peak = 0;
  await mapWithLimit([1, 2, 3, 4, 5, 6, 7, 8], 5, async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
  });
  assert.ok(peak > 1 && peak <= 5);
});

// --- Aadhaar Secure QR ------------------------------------------------------

test('a legacy XML Aadhaar QR parses', () => {
  const xml = '<?xml version="1.0"?><PrintLetterBarcodeData uid="123456789012" name="ASHA DEVI" gender="F" yob="1990" street="MG ROAD" vtc="BENGALURU" pc="560001"/>';
  const parsed = parseAadhaarQr(xml);
  assert.equal(parsed.name, 'ASHA DEVI');
  assert.equal(parsed.gender, 'F');
  assert.equal(parsed.lastFourDigits, '9012');
  assert.match(parsed.address, /MG ROAD/);
});

test('nonsense is not mistaken for an Aadhaar QR', () => {
  assert.equal(parseAadhaarQr('hello world'), null);
  assert.equal(parseAadhaarQr(''), null);
  assert.equal(parseAadhaarQr(null), null);
});

// --- OCR fallback -----------------------------------------------------------

test('the OCR fallback refuses to guess a name rather than taking the father\'s', () => {
  const text = `INCOME TAX DEPARTMENT
Permanent Account Number Card
BQIPS8241E
Name
MUHAMMED SAKIR K
Father's Name
ABDUL RAHMAN K
Date of Birth
12/08/1997`;
  const fields = fieldsFromText(text);
  assert.notEqual(fields.holder_name, 'ABDUL RAHMAN K');
  assert.equal(fields.father_name, 'ABDUL RAHMAN K');
});

test('the OCR fallback reads a two-digit year', () => {
  assert.equal(fieldsFromText('Name\nASHA DEVI\nDate of Birth 12/08/97').dob, '12/08/97');
});

// --- orchestration end to end ----------------------------------------------

test('near-JSON model output is salvaged, not discarded', () => {
  const { parseAndValidate } = require('../lib/extract/schema');
  // Observed live: moondream wrapped its answer in prose, used a bare
  // property name and left a trailing comma — and the whole read was thrown
  // away, downgrading the document to the OCR fallback.
  const messy = `Here is the extracted information you asked for:
{
  document_type: "pan",
  "holder_name": "ASHA TESTPERSON",
  "dob": "01/01/1990",
  "document_number": "BQIPS8241E",
}
Let me know if you need anything else!`;
  const result = parseAndValidate(messy, { docType: 'pan', pageRole: 'front', source: 'vision', pageText: '' });
  assert.equal(result.fields.holder_name.raw_value, 'ASHA TESTPERSON');
  assert.equal(result.fields.document_number.raw_value, 'BQIPS8241E');
});

test('identical bytes are extracted exactly once', async () => {
  const { store, workflow, vision, cleanup } = harness();
  const file = await fixture('cache.jpg', { document_type: 'pan', holder_name: 'ASHA DEVI', dob: '01/01/1990', document_number: 'BQIPS8241E' });

  const a = await seed(workflow, store, 'a@example.com', [file]);
  const callsAfterFirst = vision.calls.length;
  assert.ok(callsAfterFirst > 0);

  // Same bytes, same application: served from cache.
  await workflow.ingest({ applicationId: a.application.id, userId: a.user.id, files: [file] });
  assert.equal(vision.calls.length, callsAfterFirst, 'no second extraction for identical bytes');
  cleanup();
});

test('a cached quality-gate failure still asks for a retake on re-upload', async () => {
  const { store, workflow, cleanup } = harness({
    assessQuality: async () => ({
      usable: false, assessed: true,
      reasons: [{ reason: 'image_blurred', detail: 'The image is too blurred to read.' }],
      metrics: { sharpness: 3 }
    })
  });
  const file = await fixture('blurred-cache.jpg', { document_type: 'pan', holder_name: 'ASHA DEVI' });

  const first = await seed(workflow, store, 'blur-a@example.com', [file]);
  const original = store.listDocuments(first.application.id)[0];
  assert.equal(original.status, 'retake_required');
  assert.match(original.statusReason, /blurred/);

  // The same bytes in a NEW application hit the extraction cache — and must
  // come back as the same retake verdict with its original reasons, not as a
  // mystery "unreadable".
  const user = store.upsertUser('blur-b@example.com');
  const second = workflow.startApplication(user.id);
  await workflow.ingest({ applicationId: second.id, userId: user.id, files: [file] });
  const cached = store.listDocuments(second.id)[0];
  assert.equal(cached.status, 'retake_required');
  assert.match(cached.statusReason, /blurred/);
  cleanup();
});

test('one document failing never aborts the batch', async () => {
  const { store, workflow, cleanup } = harness({
    vision: {
      configured: true,
      async run(_model, { dataUri }) {
        const payload = Buffer.from(String(dataUri).split(',')[1], 'base64');
        if (payload.length % 2 === 0) throw new VisionError('simulated failure', { model: 'm' });
        return JSON.stringify({ document_type: 'pan', holder_name: 'ASHA DEVI', dob: '01/01/1990', document_number: 'BQIPS8241E' });
      }
    }
  });

  const files = await Promise.all([0, 1, 2].map(index =>
    fixture(`batch-${index}.jpg`, { document_type: 'pan', holder_name: `PERSON ${index}` })));
  const { application } = await seed(workflow, store, 'a@example.com', files);

  const documents = store.listDocuments(application.id);
  assert.equal(documents.length, 3, 'every document is still registered');
  assert.ok(documents.some(document => document.status !== 'ready'), 'at least one failed');
  cleanup();
});

test("a PAN carrying a father's name does not surface it as the cardholder", async () => {
  const { store, workflow, cleanup } = harness();
  const file = await fixture('pan-father.jpg', {
    document_type: 'pan', holder_name: 'MUHAMMED SAKIR K',
    father_name: 'ABDUL RAHMAN K', dob: '12/08/1997', document_number: 'BQIPS8241E'
  });

  const { application } = await seed(workflow, store, 'a@example.com', [file]);
  const document = store.listDocuments(application.id)[0];
  assert.equal(document.fields.holder_name, 'MUHAMMED SAKIR K');
  assert.equal(document.fields.father_name, 'ABDUL RAHMAN K');
  assert.notEqual(document.fields.holder_name, document.fields.father_name);
  cleanup();
});

test('a document number is validated and repaired during extraction', async () => {
  const { store, workflow, cleanup } = harness();
  // A PAN misread with a 1 where the I belongs.
  const file = await fixture('repair.jpg', {
    document_type: 'pan', holder_name: 'ASHA DEVI', dob: '01/01/1990', document_number: 'BQ1PS8241E'
  });

  const { application } = await seed(workflow, store, 'a@example.com', [file]);
  const document = store.listDocuments(application.id)[0];
  assert.equal(document.validation.number, 'BQIPS8241E');
  assert.equal(document.validation.repaired, true);
  assert.equal(document.validation.valid, true);
  cleanup();
});
