'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { sniffMime } = require('../preprocess');

// Turn whatever the user dropped — files, a folder, a ZIP, a multi-page PDF —
// into a flat list of individual document candidates, safely.
//
// An archive from an untrusted user is a genuine attack surface, so every known
// class is handled explicitly: ZIP-slip (entries that escape the extract root),
// ZIP bombs (absurd compression ratios), nested archives, symlinks, executables
// disguised by extension, and sheer file-count/size exhaustion.

const LIMITS = {
  maxFiles: 50,                       // per application
  maxTotalBytes: 200 * 1024 * 1024,   // 200 MB expanded
  maxFileBytes: 25 * 1024 * 1024,     // 25 MB per document
  maxCompressionRatio: 100,           // expanded/compressed — bomb guard
  maxArchiveDepth: 1,                 // no nested archives
  maxPdfPages: 20
};

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff']);

class DiscoveryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DiscoveryError';
    this.code = code;
  }
}

/**
 * Normalise an archive entry path and confirm it cannot escape the root.
 * This is the ZIP-slip guard: "../../etc/passwd" and absolute paths are refused.
 */
function safeEntryPath(entryName) {
  const raw = String(entryName || '').replace(/\\/g, '/');

  if (raw.includes('\0')) return { ok: false, reason: 'null_byte_in_path' };
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return { ok: false, reason: 'absolute_path' };

  const normalised = path.posix.normalize(raw);
  if (normalised.startsWith('..') || normalised.includes('/../')) return { ok: false, reason: 'path_traversal' };
  if (normalised.startsWith('/')) return { ok: false, reason: 'absolute_path' };

  return { ok: true, path: normalised };
}

/** Directory entries and resource forks we never treat as documents. */
const isIgnorable = entryPath =>
  entryPath.endsWith('/')
  || entryPath.startsWith('__MACOSX/')
  || path.posix.basename(entryPath).startsWith('._')
  || path.posix.basename(entryPath) === '.DS_Store'
  || path.posix.basename(entryPath) === 'Thumbs.db';

/**
 * Expand a ZIP into in-memory file candidates.
 * Nothing is written to disk during expansion, which removes an entire class of
 * path-escape risk: an entry that would have escaped simply never becomes a file.
 */
async function expandZip(buffer, { depth = 0, limits = LIMITS } = {}) {
  if (depth > limits.maxArchiveDepth) {
    throw new DiscoveryError('Nested archives are not accepted.', 'nested_archive');
  }

  const yauzl = require('yauzl');
  const files = [];
  const skipped = [];
  let totalUncompressed = 0;
  let totalCompressed = 0;

  await new Promise((resolve, reject) => {
    // `decodeStrings: false` turns OFF yauzl's own path validation, which
    // aborts the entire archive on the first bad entry name. We want a
    // malicious entry SKIPPED while the legitimate files still load, and
    // safeEntryPath below is stricter than yauzl's check anyway.
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: true, decodeStrings: false }, (error, zipfile) => {
      if (error) return reject(new DiscoveryError(`Could not read the archive: ${error.message}`, 'bad_archive'));

      if (zipfile.entryCount > limits.maxFiles * 4) {
        zipfile.close();
        return reject(new DiscoveryError(`Archive contains ${zipfile.entryCount} entries, which exceeds the limit.`, 'too_many_entries'));
      }

      zipfile.readEntry();

      zipfile.on('entry', entry => {
        // With decodeStrings off, fileName arrives as a Buffer.
        const rawName = Buffer.isBuffer(entry.fileName)
          ? entry.fileName.toString('utf8')
          : String(entry.fileName);

        const safe = safeEntryPath(rawName);
        if (!safe.ok) {
          skipped.push({ name: rawName, reason: safe.reason });
          return zipfile.readEntry();
        }
        if (isIgnorable(safe.path)) return zipfile.readEntry();

        // Symlinks are stored with the symlink bit in the external attributes.
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((unixMode & 0xf000) === 0xa000) {
          skipped.push({ name: safe.path, reason: 'symlink' });
          return zipfile.readEntry();
        }

        if (entry.uncompressedSize > limits.maxFileBytes) {
          skipped.push({ name: safe.path, reason: 'file_too_large' });
          return zipfile.readEntry();
        }

        // Bomb guard: a wildly favourable ratio means expansion is a weapon.
        const ratio = entry.compressedSize > 0 ? entry.uncompressedSize / entry.compressedSize : 0;
        if (ratio > limits.maxCompressionRatio && entry.uncompressedSize > 1024 * 1024) {
          zipfile.close();
          return reject(new DiscoveryError(
            `Archive entry "${safe.path}" expands ${Math.round(ratio)}x, which is refused as a decompression bomb.`,
            'compression_bomb'
          ));
        }

        totalUncompressed += entry.uncompressedSize;
        totalCompressed += entry.compressedSize;
        if (totalUncompressed > limits.maxTotalBytes) {
          zipfile.close();
          return reject(new DiscoveryError('Archive expands beyond the total size limit.', 'archive_too_large'));
        }

        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            skipped.push({ name: safe.path, reason: 'unreadable_entry' });
            return zipfile.readEntry();
          }
          const chunks = [];
          let seen = 0;
          stream.on('data', chunk => {
            seen += chunk.length;
            // Second bomb guard: trust the stream, not the declared size.
            if (seen > limits.maxFileBytes) {
              stream.destroy();
              skipped.push({ name: safe.path, reason: 'file_too_large' });
              return;
            }
            chunks.push(chunk);
          });
          stream.on('error', () => {
            skipped.push({ name: safe.path, reason: 'stream_error' });
            zipfile.readEntry();
          });
          stream.on('end', () => {
            const data = Buffer.concat(chunks);
            const sniffed = sniffMime(data);
            if (!sniffed.safe) {
              skipped.push({ name: safe.path, reason: sniffed.reason || 'unsupported_type' });
            } else if (sniffed.mime === 'application/zip') {
              skipped.push({ name: safe.path, reason: 'nested_archive' });
            } else {
              files.push({ name: path.posix.basename(safe.path), relativePath: safe.path, buffer: data, mimeType: sniffed.mime });
            }
            zipfile.readEntry();
          });
        });
      });

      zipfile.on('end', () => resolve());
      zipfile.on('error', err => reject(new DiscoveryError(`Archive error: ${err.message}`, 'bad_archive')));
    });
  });

  return { files, skipped, totalUncompressed, totalCompressed };
}

/** Rasterise a PDF into one image per page. */
async function expandPdf(buffer, { limits = LIMITS, relativePath = '', name = 'document.pdf' } = {}) {
  let pdfium;
  try {
    pdfium = require('@hyzyla/pdfium');
  } catch {
    throw new DiscoveryError('PDF support is not installed on this server.', 'pdf_unsupported');
  }

  const library = await pdfium.PDFiumLibrary.init();
  const files = [];
  try {
    const document = await library.loadDocument(buffer);
    const pages = document.pages();
    if (pages.length > limits.maxPdfPages) {
      throw new DiscoveryError(`PDF has ${pages.length} pages; the limit is ${limits.maxPdfPages}.`, 'pdf_too_many_pages');
    }

    const sharp = require('sharp');
    for (let index = 0; index < pages.length; index++) {
      const rendered = await pages[index].render({
        scale: 2,   // ~144 DPI; enough for card text without exploding size
        render: 'bitmap'
      });
      const jpeg = await sharp(Buffer.from(rendered.data), {
        raw: { width: rendered.width, height: rendered.height, channels: 4 }
      }).jpeg({ quality: 92 }).toBuffer();

      const base = name.replace(/\.pdf$/i, '');
      files.push({
        name: `${base} (page ${index + 1}).jpg`,
        relativePath: relativePath ? `${relativePath}#page=${index + 1}` : '',
        buffer: jpeg,
        mimeType: 'image/jpeg',
        pageNumber: index + 1,
        fromPdf: true
      });
    }
    document.destroy();
  } finally {
    library.destroy();
  }
  return files;
}

/**
 * Discover every document candidate in an upload.
 *
 * `inputs` are `[{ name, relativePath, buffer }]` — already decoded bytes.
 * Returns `{ files, skipped, limitsHit }`; `files` are individual documents
 * ready to be given their own owned `documents` row and processed independently.
 * Nothing here batches multiple documents into one model call.
 */
async function discover(inputs, { limits = LIMITS } = {}) {
  const files = [];
  const skipped = [];
  const limitsHit = [];
  let totalBytes = 0;

  const push = candidate => {
    if (files.length >= limits.maxFiles) {
      if (!limitsHit.includes('max_files')) limitsHit.push('max_files');
      return false;
    }
    if (totalBytes + candidate.buffer.length > limits.maxTotalBytes) {
      if (!limitsHit.includes('max_total_bytes')) limitsHit.push('max_total_bytes');
      return false;
    }
    totalBytes += candidate.buffer.length;
    files.push(candidate);
    return true;
  };

  for (const input of inputs || []) {
    const buffer = input.buffer;
    if (!buffer || !buffer.length) {
      skipped.push({ name: input.name, reason: 'empty_file' });
      continue;
    }
    if (buffer.length > limits.maxFileBytes) {
      skipped.push({ name: input.name, reason: 'file_too_large' });
      continue;
    }

    // Type comes from the BYTES, never from the filename or the client header.
    const sniffed = sniffMime(buffer);
    if (!sniffed.safe) {
      skipped.push({ name: input.name, reason: sniffed.reason || 'unsupported_type' });
      continue;
    }

    if (sniffed.mime === 'application/zip') {
      try {
        const expanded = await expandZip(buffer, { depth: 0, limits });
        skipped.push(...expanded.skipped.map(item => ({ ...item, archive: input.name })));
        for (const entry of expanded.files) {
          if (entry.mimeType === 'application/pdf') {
            try {
              for (const page of await expandPdf(entry.buffer, { limits, relativePath: entry.relativePath, name: entry.name })) {
                if (!push(page)) break;
              }
            } catch (error) {
              skipped.push({ name: entry.name, reason: error.code || 'pdf_failed' });
            }
          } else if (!push(entry)) break;
        }
      } catch (error) {
        skipped.push({ name: input.name, reason: error.code || 'bad_archive', detail: error.message });
      }
      continue;
    }

    if (sniffed.mime === 'application/pdf') {
      try {
        for (const page of await expandPdf(buffer, { limits, relativePath: input.relativePath || '', name: input.name })) {
          if (!push(page)) break;
        }
      } catch (error) {
        skipped.push({ name: input.name, reason: error.code || 'pdf_failed', detail: error.message });
      }
      continue;
    }

    if (IMAGE_MIMES.has(sniffed.mime) || sniffed.mime === 'text/plain') {
      push({
        name: input.name,
        relativePath: input.relativePath || '',
        buffer,
        mimeType: sniffed.mime,
        pageNumber: 1
      });
      continue;
    }

    skipped.push({ name: input.name, reason: 'unsupported_type' });
  }

  return { files, skipped, limitsHit, totalBytes };
}

module.exports = { discover, expandZip, expandPdf, safeEntryPath, isIgnorable, LIMITS, DiscoveryError };
