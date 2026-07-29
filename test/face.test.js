'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { matchFaces, cosineSimilarity } = require('../lib/face/match');
const { embedAll } = require('../lib/face/embed');
const { compareDocuments } = require('../lib/compare');

// The embedder is injected throughout, so these tests never load the 44 MB
// model bundle or touch the wasm backend.
const vector = (seed, length = 512) =>
  Array.from({ length }, (_, i) => Math.sin(seed * (i + 1)) * 0.5 + Math.cos(seed + i) * 0.5);

const face = (seed) => ({ embedding: vector(seed), box: [0, 0, 40, 50], confidence: 0.9, dimensions: 512 });

test('cosine similarity: identical, opposite and orthogonal vectors', () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosineSimilarity([1, 0, 0], [-1, 0, 0]), -1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([2, 0], [8, 0]), 1, 'magnitude does not matter');
});

test('cosine similarity: refuses mismatched or empty input rather than returning a number', () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2]), null);
  assert.equal(cosineSimilarity([], []), null);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), null, 'a zero vector has no direction');
  assert.equal(cosineSimilarity(null, [1]), null);
});

test('matching faces across four documents produces every pair', () => {
  const result = matchFaces([
    { type: 'aadhaar', face: face(1) },
    { type: 'pan', face: face(1) },
    { type: 'passport', face: face(1) },
    { type: 'voter', face: face(1) }
  ], { threshold: 0.5 });

  assert.equal(result.compared, 6, 'four documents make six pairs');
  assert.ok(result.pairs.every(pair => pair.match));
  assert.equal(result.confidence, 1);
  assert.equal(result.advisory, true);
});

test('a dissimilar face is reported but never blocks issuance', () => {
  const faces = [
    { type: 'aadhaar', face: face(1) },
    { type: 'pan', face: face(1) },
    { type: 'voter', face: face(40) }
  ];
  const result = matchFaces(faces, { threshold: 0.9 });
  assert.ok(result.pairs.some(pair => !pair.match));

  const verdict = compareDocuments([
    { id: 'a', type: 'aadhaar', pageRole: 'front', status: 'ready', source: 'vision', fields: { holder_name: 'RAM K', dob: '01/01/1990', gender: 'M', address: 'X' } },
    { id: 'p', type: 'pan', pageRole: 'front', status: 'ready', source: 'vision', fields: { holder_name: 'RAM K', dob: '01/01/1990' } },
    { id: 'v', type: 'voter', pageRole: 'front', status: 'ready', source: 'vision', fields: { holder_name: 'RAM K', dob: '01/01/1990', gender: 'M', address: 'X' } }
  ], { face: result });

  const faceField = verdict.fields.find(field => field.label === 'face');
  assert.equal(faceField.severity, 'warn');
  assert.equal(faceField.advisory, true);
  assert.deepEqual(verdict.blocking, [], 'a face mismatch never blocks');
  assert.equal(verdict.status, 'match');
});

test('a document with no detectable face is excluded, not failed', () => {
  const result = matchFaces([
    { type: 'aadhaar', face: face(1) },
    { type: 'pan', face: face(1) },
    { type: 'birth_certificate', face: null }
  ], { threshold: 0.5 });

  assert.equal(result.compared, 1, 'only the two documents with photos are compared');
  assert.deepEqual(result.withoutFace, ['birth_certificate']);
  assert.deepEqual(result.withFace, ['aadhaar', 'pan']);
});

test('a single photograph means no comparison is possible, and says so', () => {
  const result = matchFaces([
    { type: 'aadhaar', face: face(1) },
    { type: 'birth_certificate', face: null }
  ]);
  assert.equal(result.compared, 0);
  assert.equal(result.available, true);
  assert.match(result.note, /only one document carried a usable photograph/i);
});

test('no photographs at all is a note, not an error', () => {
  const result = matchFaces([{ type: 'birth_certificate', face: null }]);
  assert.equal(result.compared, 0);
  assert.match(result.note, /no photograph/i);
});

test('an unavailable face runtime degrades to an advisory note', () => {
  const result = matchFaces(
    [{ type: 'aadhaar', face: face(1) }, { type: 'pan', face: face(1) }],
    { available: false, reason: '@vladmandic/human is not installed' }
  );

  assert.equal(result.available, false);
  assert.equal(result.compared, 0);
  assert.match(result.note, /not installed/);

  const verdict = compareDocuments([
    { id: 'a', type: 'aadhaar', pageRole: 'front', status: 'ready', source: 'vision', fields: { holder_name: 'RAM K', dob: '01/01/1990', gender: 'M', address: 'X' } },
    { id: 'p', type: 'pan', pageRole: 'front', status: 'ready', source: 'vision', fields: { holder_name: 'RAM K', dob: '01/01/1990' } }
  ], { face: result });

  assert.equal(verdict.status, 'match', 'a missing face runtime cannot stop issuance');
});

test('the threshold is configurable and actually changes the verdict', () => {
  const faces = [{ type: 'aadhaar', face: face(1) }, { type: 'pan', face: face(3) }];
  const similarity = matchFaces(faces, { threshold: 0.5 }).pairs[0].similarity;

  const lenient = matchFaces(faces, { threshold: similarity - 0.01 });
  const strict = matchFaces(faces, { threshold: similarity + 0.01 });

  assert.equal(lenient.pairs[0].match, true);
  assert.equal(strict.pairs[0].match, false);
});

test('embedAll reuses a cached embedding instead of recomputing it', async () => {
  let calls = 0;
  const results = await embedAll(
    [
      { type: 'aadhaar', contentHash: 'h1', face: face(1) },       // cached
      { type: 'pan', contentHash: 'h2', buffer: Buffer.from('x') } // needs work
    ],
    { embedder: async () => { calls++; return { available: true, face: face(2), reason: '' }; } }
  );

  assert.equal(calls, 1, 'only the uncached document was embedded');
  assert.equal(results[0].cached, true);
  assert.equal(results[1].cached, false);
});

test('embedAll reports newly computed embeddings so they can be cached', async () => {
  const cached = [];
  await embedAll(
    [{ type: 'pan', contentHash: 'h2', buffer: Buffer.from('x') }],
    {
      embedder: async () => ({ available: true, face: face(2), reason: '' }),
      onEmbedded: (hash, value) => cached.push({ hash, dimensions: value.dimensions })
    }
  );
  assert.deepEqual(cached, [{ hash: 'h2', dimensions: 512 }]);
});

test('a document whose scan was already deleted is skipped without error', async () => {
  const results = await embedAll(
    [{ type: 'pan', contentHash: 'h3' }],
    { embedder: async () => { throw new Error('should not be called'); } }
  );
  assert.equal(results[0].face, null);
  assert.equal(results[0].reason, 'image_not_retained');
});

test('an embedder that throws does not take down the batch', async () => {
  const results = await embedAll(
    [
      { type: 'pan', contentHash: 'h1', buffer: Buffer.from('a') },
      { type: 'aadhaar', contentHash: 'h2', buffer: Buffer.from('b') }
    ],
    {
      embedder: async buffer => {
        if (buffer.toString() === 'a') throw new Error('decode blew up');
        return { available: true, face: face(1), reason: '' };
      }
    }
  );

  assert.equal(results[0].face, null);
  assert.match(results[0].reason, /decode blew up/);
  assert.ok(results[1].face, 'the second document still got an embedding');
});
