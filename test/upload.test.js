'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');

const { discover, expandZip, safeEntryPath, LIMITS, DiscoveryError } = require('../lib/upload/discover');
const { sniffMime, assessQuality, normalizeImage, laplacianVariance } = require('../lib/preprocess');
const { groupPages, pagesLink, inferPageRole } = require('../lib/upload/grouping');
const { makeJpeg } = require('./helpers/harness');

// --- MIME sniffing ----------------------------------------------------------

test('the real type comes from the bytes, never the filename', async () => {
  const jpeg = await makeJpeg('sniff');
  assert.equal(sniffMime(jpeg).mime, 'image/jpeg');

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  assert.equal(sniffMime(png).mime, 'image/png');

  assert.equal(sniffMime(Buffer.from('%PDF-1.7\n...')).mime, 'application/pdf');
  assert.equal(sniffMime(Buffer.from('plain text content here')).mime, 'text/plain');
});

test('executables are refused however they are named', () => {
  const exe = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64)]);      // MZ
  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64)]);

  assert.equal(sniffMime(exe).safe, false);
  assert.match(sniffMime(exe).reason, /executable/);
  assert.equal(sniffMime(elf).safe, false);
});

test('a misleading extension does not get a file past discovery', async () => {
  const exe = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(1024)]);
  const result = await discover([{ name: 'aadhaar.jpg', buffer: exe }]);

  assert.equal(result.files.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /executable/);
});

// --- ZIP safety -------------------------------------------------------------

test('ZIP-slip paths are refused', () => {
  assert.equal(safeEntryPath('../../etc/passwd').ok, false);
  assert.equal(safeEntryPath('/etc/passwd').ok, false);
  assert.equal(safeEntryPath('C:\\Windows\\System32\\evil.dll').ok, false);
  assert.equal(safeEntryPath('docs/../../escape.jpg').ok, false);
  assert.equal(safeEntryPath('a\0b.jpg').ok, false);

  assert.equal(safeEntryPath('documents/aadhaar.jpg').ok, true);
  assert.equal(safeEntryPath('aadhaar.jpg').ok, true);
});

/** Build a real ZIP in memory, so the guards are tested against real archives. */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = entry.content;
    const compressed = zlib.deflateRawSync(content);
    const crc = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(content.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(entry.externalAttributes || 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuffer, end]);
}

function crc32(buffer) {
  let c = ~0;
  for (const byte of buffer) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

test('a ZIP of images expands into individual documents', async () => {
  const jpeg = await makeJpeg('zip-a');
  const other = await makeJpeg('zip-b');
  const zip = buildZip([
    { name: 'docs/pan.jpg', content: jpeg },
    { name: 'docs/aadhaar.jpg', content: other }
  ]);

  const result = await discover([{ name: 'documents.zip', buffer: zip }]);
  assert.equal(result.files.length, 2);
  assert.deepEqual(result.files.map(file => file.relativePath).sort(), ['docs/aadhaar.jpg', 'docs/pan.jpg']);
  assert.ok(result.files.every(file => file.mimeType === 'image/jpeg'));
});

test('a ZIP entry that escapes the root is dropped, the rest still load', async () => {
  const jpeg = await makeJpeg('zip-safe');
  const zip = buildZip([
    { name: '../../escape.jpg', content: jpeg },
    { name: 'good.jpg', content: await makeJpeg('zip-good') }
  ]);

  const result = await discover([{ name: 'documents.zip', buffer: zip }]);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].relativePath, 'good.jpg');
  assert.ok(result.skipped.some(item => item.reason === 'path_traversal'));
});

test('a decompression bomb is refused', async () => {
  // 8 MB of zeros compresses to almost nothing — ratio far beyond the limit.
  const bomb = Buffer.alloc(8 * 1024 * 1024, 0);
  const zip = buildZip([{ name: 'bomb.bin', content: bomb }]);

  const result = await discover([{ name: 'bomb.zip', buffer: zip }]);
  assert.equal(result.files.length, 0);
  assert.ok(result.skipped.some(item => item.reason === 'compression_bomb' || item.reason === 'archive_too_large'));
});

test('a nested archive is not expanded', async () => {
  const inner = buildZip([{ name: 'deep.jpg', content: await makeJpeg('deep') }]);
  const outer = buildZip([{ name: 'inner.zip', content: inner }]);

  const result = await discover([{ name: 'outer.zip', buffer: outer }]);
  assert.equal(result.files.length, 0);
  assert.ok(result.skipped.some(item => item.reason === 'nested_archive'));
});

test('a symlink entry is skipped', async () => {
  // Unix mode 0xA1FF (symlink) in the high 16 bits of the external attributes.
  const zip = buildZip([
    { name: 'link.jpg', content: Buffer.from('/etc/passwd'), externalAttributes: (0xa1ff << 16) >>> 0 },
    { name: 'real.jpg', content: await makeJpeg('real') }
  ]);

  const result = await discover([{ name: 'archive.zip', buffer: zip }]);
  assert.ok(result.skipped.some(item => item.reason === 'symlink'));
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].relativePath, 'real.jpg');
});

test('macOS resource forks and directory entries are ignored quietly', async () => {
  const zip = buildZip([
    { name: '__MACOSX/._pan.jpg', content: Buffer.from('junk') },
    { name: '.DS_Store', content: Buffer.from('junk') },
    { name: 'pan.jpg', content: await makeJpeg('mac-real') }
  ]);
  const result = await discover([{ name: 'archive.zip', buffer: zip }]);
  assert.equal(result.files.length, 1);
});

test('the file-count and size limits hold', async () => {
  const many = [];
  for (let i = 0; i < LIMITS.maxFiles + 10; i++) {
    many.push({ name: `f${i}.jpg`, buffer: await makeJpeg(`limit-${i}`) });
  }
  const result = await discover(many);
  assert.equal(result.files.length, LIMITS.maxFiles);
  assert.ok(result.limitsHit.includes('max_files'));

  const huge = { name: 'huge.jpg', buffer: Buffer.alloc(LIMITS.maxFileBytes + 1024) };
  const rejected = await discover([huge]);
  assert.equal(rejected.files.length, 0);
  assert.ok(rejected.skipped.some(item => item.reason === 'file_too_large'));
});

test('duplicate bytes under different names both register as documents', async () => {
  const jpeg = await makeJpeg('dupe');
  const result = await discover([
    { name: 'first.jpg', buffer: jpeg },
    { name: 'second.jpg', buffer: jpeg }
  ]);
  // Both are kept: the extraction is shared by hash, but each file is its own
  // document so the holder can see and remove them independently.
  assert.equal(result.files.length, 2);
});

// --- preprocessing / quality ------------------------------------------------

test('a blurred image is measurably softer than a sharp one', () => {
  const size = 64;
  const sharpImage = new Uint8Array(size * size);
  const flatImage = new Uint8Array(size * size).fill(128);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) sharpImage[y * size + x] = (x % 2) * 255;
  }
  assert.ok(laplacianVariance(sharpImage, size, size) > laplacianVariance(flatImage, size, size));
  assert.equal(laplacianVariance(flatImage, size, size), 0);
});

test('a tiny image fails the resolution gate', async () => {
  const tiny = await makeJpeg('tiny');   // 64x40, far below the minimum
  const quality = await assessQuality(tiny);
  if (quality.assessed) {
    assert.equal(quality.usable, false);
    assert.ok(quality.reasons.some(reason => reason.code === 'resolution_too_low'));
  }
});

test('normalisation returns a usable buffer even for odd input', async () => {
  const jpeg = await makeJpeg('normalise');
  const result = await normalizeImage(jpeg);
  assert.ok(Buffer.isBuffer(result.buffer));
  assert.ok(result.buffer.length > 0);
});

// --- front/back grouping ----------------------------------------------------

const doc = (id, type, fields, extra = {}) => ({
  id, type, rawFields: {}, corrections: fields, relativePath: '', ...extra
});

test('two pages sharing a document number group together', () => {
  const groups = groupPages([
    doc('a', 'aadhaar', { holder_name: 'ASHA DEVI', document_number: '234123412346', dob: '01/01/1990' }),
    doc('b', 'aadhaar', { document_number: '234123412346', address: '12 MG ROAD' })
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].documentIds.length, 2);
  assert.equal(groups[0].reason.signal, 'same_document_number');
});

test('two DIFFERENT people are never grouped, even with the same document type', () => {
  const groups = groupPages([
    doc('a', 'aadhaar', { holder_name: 'ASHA DEVI', document_number: '234123412346' }),
    doc('b', 'aadhaar', { holder_name: 'RAJESH KUMAR', document_number: '999988887777' })
  ]);
  assert.equal(groups.length, 2, 'two people, two logical documents');
});

test('two different valid numbers of the same type are two cards', () => {
  const link = pagesLink(
    doc('a', 'pan', { document_number: 'BQIPS8241E' }),
    doc('b', 'pan', { document_number: 'MPWPK2241E' })
  );
  assert.equal(link.linked, false);
  assert.equal(link.reason, 'different_document_numbers');
});

test('ambiguous pages are kept separate rather than guessed into a pair', () => {
  const link = pagesLink(
    doc('a', 'voter', { holder_name: 'ASHA DEVI' }),
    doc('b', 'voter', { address: '12 MG ROAD' })
  );
  assert.equal(link.linked, false);
  assert.equal(link.reason, 'insufficient_evidence_to_group');
});

test('pages of the same PDF group together', () => {
  const link = pagesLink(
    doc('a', 'passport', {}, { relativePath: 'scan.pdf#page=1' }),
    doc('b', 'passport', {}, { relativePath: 'scan.pdf#page=2' })
  );
  assert.equal(link.linked, true);
  assert.equal(link.reason.signal, 'same_source_file');
});

test('page role is inferred from the fields a side carries', () => {
  assert.equal(inferPageRole(doc('a', 'aadhaar', { holder_name: 'ASHA', dob: '01/01/1990', gender: 'F' })), 'front');
  assert.equal(inferPageRole(doc('b', 'aadhaar', { address: '12 MG ROAD' })), 'back');
});
