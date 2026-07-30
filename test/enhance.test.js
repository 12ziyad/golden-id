'use strict';

// The blur-recovery pipeline: quality tiers, enhancement variants, and the
// OCR-consensus rule that turns "a model said so" into "it is printed there".

const os = require('os');
const path = require('path');
const fs = require('fs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-enhance-'));
process.env.NODE_ENV = 'test';
process.env.UPLOAD_DIR = path.join(scratch, 'uploads');
process.env.GOLDEN_ID_KEY_PATH = path.join(scratch, 'key.pem');
process.env.CF_ACCOUNT_ID = '';
process.env.CF_API_TOKEN = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const { tierFor, assessQuality } = require('../lib/preprocess');
const { variantsFor } = require('../lib/preprocess/enhance');
const { harness, fixture, seed, fixtureVision } = require('./helpers/harness');

/**
 * A vision client whose CROSS-CHECK model is down. Without it, the second
 * model would agree with the first (both answer from the same fixture) and
 * promote the field before the OCR-consensus path is ever exercised.
 */
function primaryOnlyVision() {
  const inner = fixtureVision();
  return {
    configured: true,
    calls: inner.calls,
    async run(model, args) {
      if (/llama/i.test(String(model))) throw new Error('cross-check model unavailable');
      return inner.run(model, args);
    }
  };
}

let sharp = null;
try { sharp = require('sharp'); } catch { /* tier tests on real images need sharp */ }

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

// A synthetic PAN-style card with real printed text, rendered at 800x500.
const svgCard = `<svg width="800" height="500" xmlns="http://www.w3.org/2000/svg">
  <rect width="800" height="500" fill="#f4f0e4"/>
  <rect x="0" y="0" width="800" height="70" fill="#2b5e9c"/>
  <text x="40" y="45" font-family="Arial" font-size="28" fill="#fff">INCOME TAX DEPARTMENT  GOVT. OF INDIA</text>
  <text x="40" y="130" font-family="Arial" font-size="22" fill="#333">Permanent Account Number Card</text>
  <text x="40" y="190" font-family="Arial" font-size="26" fill="#111" font-weight="bold">BQIPS8241E</text>
  <text x="40" y="250" font-family="Arial" font-size="20" fill="#333">Name</text>
  <text x="40" y="285" font-family="Arial" font-size="26" fill="#111" font-weight="bold">ASHA TESTPERSON</text>
  <text x="40" y="345" font-family="Arial" font-size="20" fill="#333">Date of Birth</text>
  <text x="40" y="380" font-family="Arial" font-size="26" fill="#111" font-weight="bold">01/01/1990</text>
</svg>`;

async function renderCard(blur = 0) {
  const base = await sharp(Buffer.from(svgCard)).jpeg({ quality: 92 }).toBuffer();
  return blur ? sharp(base).blur(blur).jpeg({ quality: 85 }).toBuffer() : base;
}

// --- tier mapping ------------------------------------------------------------

test('tier mapping: each axis degrades good → marginal → unusable', () => {
  const base = { width: 800, height: 500, sharpness: 60, contrast: 20, glare: 0.05, dark: 0.3 };
  assert.equal(tierFor(base), 'good');
  assert.equal(tierFor({ ...base, sharpness: 30 }), 'marginal');
  assert.equal(tierFor({ ...base, sharpness: 10 }), 'unusable');
  assert.equal(tierFor({ ...base, contrast: 12 }), 'marginal');
  assert.equal(tierFor({ ...base, contrast: 5 }), 'unusable');
  assert.equal(tierFor({ ...base, glare: 0.15 }), 'marginal');
  assert.equal(tierFor({ ...base, glare: 0.3 }), 'unusable');
  assert.equal(tierFor({ ...base, dark: 0.6 }), 'marginal');
  assert.equal(tierFor({ ...base, dark: 0.8 }), 'unusable');
  // Upscaling cannot invent pixels: low resolution is honestly unusable.
  assert.equal(tierFor({ ...base, width: 200 }), 'unusable');
});

test('quality tiers on real images: sharp is good, soft is marginal, heavy blur is unusable', async () => {
  if (!sharp) return;
  const good = await assessQuality(await renderCard(0));
  assert.equal(good.tier, 'good');

  const marginal = await assessQuality(await renderCard(2.4));
  assert.equal(marginal.tier, 'marginal');
  assert.equal(marginal.usable, true, 'marginal images proceed into recovery, not rejection');
  assert.ok(marginal.reasons.some(reason => reason.code === 'image_blurred'), 'the softness is still reported');

  const unusable = await assessQuality(await renderCard(6));
  assert.equal(unusable.tier, 'unusable');
  assert.equal(unusable.usable, false);

  const tiny = await assessQuality(await sharp(await renderCard(0)).resize(300).jpeg().toBuffer());
  assert.equal(tiny.tier, 'unusable');
});

// --- variants ----------------------------------------------------------------

test('variants target the failing metric, are capped at three, and never touch the original', async () => {
  if (!sharp) return;
  const buffer = await renderCard(2.4);
  const before = Buffer.from(buffer);

  const soft = await variantsFor(buffer, { sharpness: 30, contrast: 50, glare: 0, dark: 0, width: 800 });
  const softNames = soft.map(variant => variant.name);
  assert.ok(softNames.includes('sharpen'), 'a soft image gets a sharpen variant');
  assert.ok(softNames.includes('upscale2x'), 'a small soft image gets an upscale variant');
  assert.ok(!softNames.includes('clahe'), 'contrast is fine, so no contrast variant');

  const flat = await variantsFor(buffer, { sharpness: 80, contrast: 8, glare: 0, dark: 0, width: 1600 });
  assert.ok(flat.map(variant => variant.name).includes('clahe'), 'a low-contrast image gets local equalisation');

  const everything = await variantsFor(buffer, { sharpness: 30, contrast: 8, glare: 0.2, dark: 0.6, width: 700 });
  assert.ok(everything.length <= 3, 'the variant budget is capped');

  assert.deepEqual(buffer, before, 'the input buffer is byte-identical after enhancement');
  for (const variant of everything) {
    assert.ok(!variant.buffer.equals(buffer), 'a variant is a derivative, not the original');
  }
});

// --- consensus recovery -------------------------------------------------------

test('a marginal image recovers an unevidenced field only via independent OCR consensus', async () => {
  // The base OCR pass sees no date of birth; two enhancement variants do,
  // under its label. Two independent sightings verify what one model claim
  // could not.
  const longBase = 'INCOME TAX DEPARTMENT GOVT OF INDIA\nPermanent Account Number Card\nBQIPS8241E\nName\nASHA DEVI\n'
    + 'GOVERNMENT WATERMARK TEXT '.repeat(6);
  const variantText = 'Name ASHA DEVI\nDate of Birth 01/01/1990';
  let calls = 0;

  const { store, workflow, cleanup } = harness({
    vision: primaryOnlyVision(),
    assessQuality: async () => ({
      usable: true, assessed: true, tier: 'marginal',
      reasons: [{ code: 'image_blurred', detail: 'The image is too soft to read reliably.' }],
      metrics: { sharpness: 30, width: 800, height: 500, contrast: 50, glare: 0, dark: 0 }
    }),
    tesseract: async () => {
      calls += 1;
      return { text: calls === 1 ? longBase : variantText, fields: {}, source: 'tesseract-fallback' };
    }
  });

  const file = await fixture('marginal-pan.jpg', {
    document_type: 'pan', holder_name: 'ASHA DEVI', dob: '01/01/1990', document_number: 'BQIPS8241E'
  });
  const { application } = await seed(workflow, store, 'mg@example.com', [file]);
  const document = store.listDocuments(application.id)[0];

  assert.equal(document.status, 'ready');
  assert.ok(calls >= 3, 'enhancement variants each got their own OCR pass');
  assert.equal(document.rawFields.dob.status, 'present_verified');
  assert.equal(document.rawFields.dob.evidence_reason, 'verified_by_ocr_consensus');
  assert.ok((document.rawFields.dob.evidence_variants || []).length >= 2, 'at least two independent sightings');
  assert.ok(document.quality.enhancement, 'the recovery attempt is part of the quality story');
  assert.ok(document.quality.enhancement.recovered.includes('dob'));
  cleanup();
});

test('one OCR sighting is NOT consensus: the field stays unverified', async () => {
  // Only a single variant ever shows the value — that is one independent
  // sighting, not agreement, and must not become present_verified.
  const longBase = 'INCOME TAX DEPARTMENT GOVT OF INDIA\nPermanent Account Number Card\nBQIPS8241E\nName\nASHA DEVI\n'
    + 'GOVERNMENT WATERMARK TEXT '.repeat(6);
  let calls = 0;

  const { store, workflow, cleanup } = harness({
    vision: primaryOnlyVision(),
    assessQuality: async () => ({
      usable: true, assessed: true, tier: 'marginal',
      reasons: [{ code: 'image_blurred', detail: 'soft' }],
      metrics: { sharpness: 30, width: 800, height: 500, contrast: 50, glare: 0, dark: 0 }
    }),
    tesseract: async () => {
      calls += 1;
      // Call 2 (first variant) sees the DOB; every other pass sees none.
      return {
        text: calls === 2 ? 'Name ASHA DEVI\nDate of Birth 01/01/1990' : longBase,
        fields: {}, source: 'tesseract-fallback'
      };
    }
  });

  const file = await fixture('single-sighting-pan.jpg', {
    document_type: 'pan', holder_name: 'ASHA DEVI', dob: '01/01/1990', document_number: 'BQIPS8241E'
  });
  const { application } = await seed(workflow, store, 'ss@example.com', [file]);
  const document = store.listDocuments(application.id)[0];

  assert.notEqual(document.rawFields.dob.status, 'present_verified',
    'a single sighting never verifies');
  assert.ok(!(document.quality.enhancement?.recovered || []).includes('dob'));
  cleanup();
});

test('a good-quality photo whose local OCR is garbage is rescued by the targeted re-read', async () => {
  // The real-document case: the image is FINE, the model reads the DOB
  // correctly, but tesseract produces label-free noise, so nothing local can
  // corroborate. The single-field re-read (an independent second reading)
  // settles it — without weakening the hallucination guard.
  const { store, workflow, cleanup } = harness({
    vision: primaryOnlyVision(),
    tesseract: async () => ({
      text: 'zzkw 93ks 02ld 93ja lqpz 88dh 43jf 92kd asdw 71bd', fields: {}, source: 'tesseract-fallback'
    })
  });
  const file = await fixture('real-photo-pan.jpg', {
    document_type: 'pan', holder_name: 'MUHAMMED SAKIR K',
    dob: '19/05/2003', father_name: 'RAHEEM KOTTAKANDI', document_number: 'MPWPK2241E'
  });
  const { application } = await seed(workflow, store, 'rp@example.com', [file]);
  const document = store.listDocuments(application.id)[0];

  assert.equal(document.status, 'ready');
  assert.equal(document.rawFields.dob.status, 'present_verified');
  assert.equal(document.rawFields.dob.evidence_reason, 'verified_by_field_reread');
  cleanup();
});

test('an unusable image is refused with specific guidance, not guessed at', async () => {
  if (!sharp) return;
  const { store, workflow, cleanup } = harness({ preprocess: true });
  const blurred = await renderCard(6);
  const file = { name: 'hopeless.jpg', data: `data:image/jpeg;base64,${blurred.toString('base64')}` };

  const { application } = await seed(workflow, store, 'bad@example.com', [file]);
  const document = store.listDocuments(application.id)[0];

  assert.equal(document.status, 'retake_required');
  assert.match(document.statusReason, /soft|blur|steady/i, 'the holder is told WHAT is wrong');
  cleanup();
});
