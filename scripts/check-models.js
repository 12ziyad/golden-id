'use strict';

// Verify the configured Workers AI model IDs are still live on this account,
// and optionally send one real inference per model to confirm the request shape.
//
//   node scripts/check-models.js          catalog check only
//   node scripts/check-models.js --smoke  also run one real inference each
//
// The Workers AI catalog changes frequently. When a model disappears this is
// where you find out, rather than discovering it as blank cards in production.

const zlib = require('zlib');
const { config } = require('../lib/config');
const { createVisionClient } = require('../lib/extract/vision');

/** A tiny valid PNG, built in-process so the check needs no fixture files. */
function tinyPng(width = 64, height = 64) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      // A dark band across the middle, so the image is not featureless.
      const dark = y > height / 3 && y < (height * 2) / 3;
      raw[offset++] = dark ? 0x20 : 0xf0;
      raw[offset++] = dark ? 0x20 : 0xf0;
      raw[offset++] = dark ? 0x20 : 0xf0;
    }
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : crc32(body));
    return Buffer.concat([length, body, crc]);
  };

  // Node < 22.15 has no zlib.crc32; keep a small implementation to hand.
  function crc32(buffer) {
    let c = ~0;
    for (const byte of buffer) {
      c ^= byte;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

async function main() {
  const smoke = process.argv.includes('--smoke');

  if (!config.cloudflare.configured) {
    console.error('✖ Workers AI is not configured. Set CF_ACCOUNT_ID and CF_API_TOKEN in .env');
    process.exitCode = 1;
    return;
  }

  const client = createVisionClient();
  const models = [config.models.primary, config.models.crossCheck];
  console.log(`Account ${config.cloudflare.accountId.slice(0, 6)}…  checking ${models.length} models\n`);

  let failed = false;

  const catalog = await client.checkModels(models).catch(error => {
    console.error(`✖ Could not reach the model catalog: ${error.message}`);
    failed = true;
    return [];
  });

  for (const entry of catalog) {
    console.log(`${entry.available ? '✔' : '✖'} ${entry.model}${entry.available ? '' : '  NOT FOUND IN CATALOG'}`);
    if (!entry.available) failed = true;
  }

  if (smoke) {
    const dataUri = `data:image/png;base64,${tinyPng().toString('base64')}`;
    console.log('\nSmoke-testing request shapes with a synthetic image…\n');

    for (const model of models) {
      try {
        const started = Date.now();
        const text = await client.run(model, {
          prompt: 'Reply with JSON only: {"ok": true}',
          dataUri,
          maxTokens: 64
        });
        console.log(`✔ ${model}  (${Date.now() - started} ms)`);
        console.log(`  → ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
      } catch (error) {
        failed = true;
        console.error(`✖ ${model}: ${error.message}`);
        if (error.body) console.error(`  ${String(error.body).slice(0, 200)}`);
      }
    }
  }

  if (failed) {
    console.error('\nOne or more models are unavailable. Update CF_MODEL_PRIMARY / CF_MODEL_CROSS_CHECK in .env.');
    process.exitCode = 1;
  } else {
    console.log('\nAll configured models are available.');
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
