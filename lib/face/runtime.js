'use strict';

const fs = require('fs');
const path = require('path');
const { config } = require('../config');

// Loading @vladmandic/human under Node 24 takes three workarounds, each of
// which was found by trying it rather than by reading docs:
//
//   1. The bundled browser ESM build stubs `util` out entirely, so the tfjs
//      node platform constructs `new undefined.TextEncoder()`. We use the
//      node-wasm build with pure-JS tfjs packages instead — no native compile.
//   2. The package's `exports` map is malformed (its keys are missing the "./"
//      prefix), so neither subpath imports nor require.resolve of its
//      package.json work. The dist file is located on disk directly.
//   3. Model weights load through `fetch`, and Node's fetch does not implement
//      the file: scheme. We install a narrow file: shim.
//
// If any of this fails, face matching reports itself unavailable and the rest
// of the application carries on. Face results are advisory and never block
// issuance, so a missing runtime is a degradation, not an outage.

let runtimePromise = null;

/** Teach global fetch to read file: URLs, leaving every other scheme alone. */
function installFileFetch() {
  if (globalThis.__goldenIdFileFetch) return;
  const original = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!url.startsWith('file://')) return original(input, init);

    const filePath = decodeURIComponent(new URL(url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
    try {
      const data = await fs.promises.readFile(filePath);
      return new Response(data, {
        status: 200,
        headers: { 'content-type': filePath.endsWith('.json') ? 'application/json' : 'application/octet-stream' }
      });
    } catch (error) {
      return new Response(String(error.message), { status: 404 });
    }
  };
  globalThis.__goldenIdFileFetch = true;
}

/** Locate the installed human package without going through its exports map. */
function findHumanRoot() {
  const candidates = [
    path.join(config.root, 'node_modules', '@vladmandic', 'human'),
    path.join(__dirname, '..', '..', 'node_modules', '@vladmandic', 'human')
  ];
  return candidates.find(candidate => fs.existsSync(path.join(candidate, 'dist', 'human.node-wasm.js'))) || null;
}

/**
 * Load the face runtime once. Resolves to `{ available, human, tf, reason }`.
 * Never throws — an unavailable runtime is a supported state.
 */
function loadRuntime() {
  if (runtimePromise) return runtimePromise;

  runtimePromise = (async () => {
    if (!config.face.enabled) {
      return { available: false, reason: 'Face matching is disabled (FACE_MATCH_ENABLED=false)' };
    }

    const humanRoot = findHumanRoot();
    if (!humanRoot) {
      return { available: false, reason: '@vladmandic/human is not installed' };
    }

    try {
      const tf = require('@tensorflow/tfjs-core');
      require('@tensorflow/tfjs-backend-cpu');

      // Prefer wasm; fall back to the pure-JS CPU backend if it will not start.
      try {
        const wasm = require('@tensorflow/tfjs-backend-wasm');
        const wasmDir = path.join(config.root, 'node_modules', '@tensorflow', 'tfjs-backend-wasm', 'dist');
        if (fs.existsSync(wasmDir)) wasm.setWasmPaths(wasmDir + path.sep);
        await tf.setBackend('wasm');
      } catch {
        await tf.setBackend('cpu');
      }
      await tf.ready();

      installFileFetch();

      const exported = require(path.join(humanRoot, 'dist', 'human.node-wasm.js'));
      const Human = exported.Human || exported.default || exported;

      const modelBasePath = `file://${path.join(humanRoot, 'models').replace(/\\/g, '/')}/`;
      const human = new Human({
        backend: tf.getBackend(),
        modelBasePath,
        debug: false,
        cacheSensitivity: 0,
        face: {
          enabled: true,
          detector: { enabled: true, rotation: false, maxDetected: 4, minConfidence: 0.2 },
          description: { enabled: true }, // faceres — provides the embedding
          mesh: { enabled: false }, iris: { enabled: false },
          emotion: { enabled: false }, antispoof: { enabled: false }, liveness: { enabled: false }
        },
        body: { enabled: false }, hand: { enabled: false },
        object: { enabled: false }, gesture: { enabled: false }, filter: { enabled: false }
      });

      await human.load();
      return { available: true, human, tf, backend: tf.getBackend(), reason: '' };
    } catch (error) {
      return { available: false, reason: `Face runtime failed to start: ${error.message}` };
    }
  })();

  return runtimePromise;
}

/** Drop the cached runtime — used by tests. */
const resetRuntime = () => { runtimePromise = null; };

module.exports = { loadRuntime, resetRuntime, installFileFetch, findHumanRoot };
