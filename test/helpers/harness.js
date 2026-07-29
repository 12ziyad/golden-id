'use strict';

const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { createStore } = require('../../lib/db');
const { createWorkflow } = require('../../lib/application');
const { createExtractor } = require('../../lib/extract');
const { createUploadStore } = require('../../lib/uploads');

// Test harness.
//
// Fixtures are REAL JPEG bytes, not JSON dressed up as an image, because the
// server now sniffs the MIME type from the bytes themselves — a security fix
// that a fake "image" would sidestep. The vision model is mocked by looking up
// the fixture keyed on the content hash of those real bytes, so the upload,
// discovery, hashing and caching paths all run exactly as they do in
// production while no network call is made.

const registry = new Map();   // contentHash -> extraction JSON

let sharp = null;
try { sharp = require('sharp'); } catch { /* fall back to a handmade JPEG */ }

/**
 * Build a small, visually distinct JPEG. Distinct pixels matter: two fixtures
 * must not collide on content hash.
 */
function makeJpeg(seed) {
  const width = 64;
  const height = 40;
  const data = Buffer.alloc(width * height * 3);
  let value = crypto.createHash('sha256').update(String(seed)).digest();
  for (let i = 0; i < data.length; i++) data[i] = value[i % value.length];

  if (sharp) {
    return sharp(data, { raw: { width, height, channels: 3 } }).jpeg({ quality: 80 }).toBuffer();
  }
  // Minimal valid JPEG container with the seed embedded in a comment segment.
  const comment = Buffer.from(String(seed), 'utf8');
  return Promise.resolve(Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xfe]),
    Buffer.from([((comment.length + 2) >> 8) & 0xff, (comment.length + 2) & 0xff]),
    comment,
    Buffer.from([0xff, 0xd9])
  ]));
}

/**
 * Register a fixture: real image bytes whose extraction result is `fields`.
 * Returns `{ name, data }` ready to POST.
 */
async function fixture(name, fields) {
  const buffer = await makeJpeg(`${name}:${JSON.stringify(fields)}`);
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  registry.set(hash, fields);
  return { name, data: `data:image/jpeg;base64,${buffer.toString('base64')}`, buffer, hash };
}

/** A vision client that answers from the fixture registry, and counts calls. */
function fixtureVision() {
  const calls = [];
  return {
    configured: true,
    calls,
    async run(model, { prompt, dataUri }) {
      calls.push({ model, prompt });
      const buffer = Buffer.from(String(dataUri).split(',')[1], 'base64');
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      const fields = registry.get(hash);
      if (!fields) throw new Error('No fixture registered for these bytes');
      return JSON.stringify(fields);
    }
  };
}

/**
 * A workflow over an in-memory store with every external dependency stubbed.
 * Preprocessing is bypassed by default so tests exercise one layer at a time;
 * pass `options.preprocess = true` to run the real pipeline.
 */
function harness(options = {}) {
  const store = createStore(':memory:');
  const vision = options.vision || fixtureVision();
  const dir = options.uploadDir || fs.mkdtempSync(path.join(os.tmpdir(), 'golden-test-'));

  const extractor = options.extractor || createExtractor({
    store,
    vision,
    crossCheckMode: options.crossCheckMode || 'on-low-confidence',
    ...(options.preprocess ? {} : {
      assessQuality: async () => ({ usable: true, assessed: false, reasons: [], metrics: {} }),
      normalizeImage: async buffer => ({ buffer, mimeType: 'image/jpeg', changed: false, orientationApplied: false })
    }),
    readAadhaarQr: options.readAadhaarQr || (async () => null),
    tesseract: options.tesseract || (async () => { throw new Error('OCR disabled in tests'); })
  });

  const workflow = createWorkflow({
    store,
    uploads: createUploadStore({ dir }),
    extractor,
    faceEmbedder: options.faceEmbedder || (async () => ({ available: false, face: null, reason: 'disabled in tests' }))
  });

  return { store, workflow, vision, dir, cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** Create a user, an application, and ingest the given fixtures. */
async function seed(workflow, store, identifier, files) {
  const user = store.upsertUser(identifier);
  const application = workflow.startApplication(user.id);
  const result = await workflow.ingest({ applicationId: application.id, userId: user.id, files });
  return { user, application, result };
}

module.exports = { harness, fixture, fixtureVision, makeJpeg, seed, registry };
