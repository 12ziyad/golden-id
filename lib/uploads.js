'use strict';

const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const { contentHash } = require('./db');

// Uploaded scans are held on disk only as long as they are actually needed:
// long enough to extract text and to compute a face embedding, then deleted.
// Whatever survives that is swept on a TTL, so an abandoned session does not
// leave identity documents lying around.

const EXTENSIONS = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf'
};

const DATA_URI = /^data:([^;,]+)?(;base64)?,/i;

/** Decode a data URI into `{ buffer, mimeType }`. */
function decodeDataUri(value) {
  const text = String(value || '');
  const match = text.match(DATA_URI);
  if (!match) return null;
  const mimeType = (match[1] || 'application/octet-stream').toLowerCase();
  const payload = text.slice(match[0].length);
  const buffer = match[2] ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
  return { buffer, mimeType };
}

function createUploadStore(options = {}) {
  const directory = options.dir || config.uploads.dir;
  const ttlMs = options.ttlMs == null ? config.uploads.ttlMs : options.ttlMs;
  let timer = null;

  const ensure = () => fs.mkdirSync(directory, { recursive: true });
  const fileFor = (hash, extension = '.bin') => path.join(directory, `${hash}${extension}`);

  const store = {
    directory,

    /** Persist bytes under their content hash. Returns `{ hash, file, mimeType }`. */
    put(buffer, mimeType = 'application/octet-stream') {
      ensure();
      const hash = contentHash(buffer);
      const file = fileFor(hash, EXTENSIONS[mimeType] || '.bin');
      if (!fs.existsSync(file)) fs.writeFileSync(file, buffer);
      return { hash, file, mimeType, bytes: buffer.length };
    },

    /** Locate a stored file by hash regardless of the extension it was given. */
    find(hash) {
      if (!fs.existsSync(directory)) return null;
      const match = fs.readdirSync(directory).find(name => name.startsWith(`${hash}.`));
      return match ? path.join(directory, match) : null;
    },

    read(hash) {
      const file = store.find(hash);
      return file ? fs.readFileSync(file) : null;
    },

    /** Delete the source scan. Called once extraction and face work are cached. */
    remove(hash) {
      const file = store.find(hash);
      if (!file) return false;
      try { fs.unlinkSync(file); return true; } catch { return false; }
    },

    /** Delete anything older than the TTL. Returns the number of files removed. */
    sweep(nowMs = Date.now()) {
      if (!fs.existsSync(directory)) return 0;
      let removed = 0;
      for (const name of fs.readdirSync(directory)) {
        const file = path.join(directory, name);
        try {
          if (nowMs - fs.statSync(file).mtimeMs > ttlMs) { fs.unlinkSync(file); removed++; }
        } catch { /* raced with another sweep; nothing to do */ }
      }
      return removed;
    },

    startSweeping(intervalMs = config.uploads.sweepMs) {
      if (timer) return timer;
      timer = setInterval(() => store.sweep(), intervalMs);
      timer.unref?.();
      return timer;
    },

    stopSweeping() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };

  return store;
}

module.exports = { createUploadStore, decodeDataUri, EXTENSIONS };
