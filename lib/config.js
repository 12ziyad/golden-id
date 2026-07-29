'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// A tiny .env reader rather than a dependency. It strips a UTF-8 BOM, which a
// Windows editor will happily leave on the first line — without that, the first
// key parses as "﻿CF_ACCOUNT_ID" and the account ID silently goes missing.

const ROOT = path.join(__dirname, '..');

function parseEnv(text) {
  const values = {};
  const body = text.replace(/^﻿/, '');
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

/** Load .env into process.env without overwriting anything already set. */
function loadEnv(file = path.join(ROOT, '.env')) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {}; // No .env is fine; the app degrades to Tesseract-only extraction.
  }
  const values = parseEnv(text);
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return values;
}

loadEnv();

const isTest = process.env.NODE_ENV === 'test';

const config = {
  root: ROOT,
  port: Number(process.env.PORT || 3000),

  cloudflare: {
    accountId: process.env.CF_ACCOUNT_ID || '',
    apiToken: process.env.CF_API_TOKEN || '',
    // Without credentials the vision path is skipped entirely and extraction
    // falls back to local OCR. That is a visible downgrade, not a silent one.
    get configured() { return Boolean(this.accountId && this.apiToken); },
    timeoutMs: Number(process.env.CF_TIMEOUT_MS || 15_000),
    retries: Number(process.env.CF_RETRIES || 2)
  },

  models: {
    primary: process.env.CF_MODEL_PRIMARY || '@cf/moondream/moondream3.1-9B-A2B',
    crossCheck: process.env.CF_MODEL_CROSS_CHECK || '@cf/meta/llama-3.2-11b-vision-instruct'
  },

  // 'always'            run both models on every document
  // 'on-low-confidence' run the cross-check only when the primary is unsure or
  //                     returned nothing for a required field
  crossCheckMode: process.env.CROSS_CHECK_MODE === 'on-low-confidence' ? 'on-low-confidence' : 'always',

  extraction: {
    concurrency: Number(process.env.EXTRACT_CONCURRENCY || 5),
    // When the backend overrules the model's document_type, re-read the file
    // once with the prompt written for the document it actually is.
    reclassifyOnCorrection: process.env.RECLASSIFY_ON_CORRECTION !== 'false'
  },

  face: {
    // Deliberately conservative and configurable. ID card photos are printed,
    // low-resolution and often decades old, so scores are noisy and this needs
    // tuning against real samples before it means anything.
    threshold: Number(process.env.FACE_MATCH_THRESHOLD || 0.5),
    enabled: process.env.FACE_MATCH_ENABLED !== 'false'
  },

  db: {
    path: isTest ? ':memory:' : (process.env.DB_PATH || path.join(ROOT, 'golden-id.sqlite'))
  },

  uploads: {
    dir: process.env.UPLOAD_DIR || path.join(ROOT, '.uploads'),
    ttlMs: Number(process.env.UPLOAD_TTL_MS || 30 * 60_000),
    sweepMs: Number(process.env.UPLOAD_SWEEP_MS || 5 * 60_000)
  },

  signing: {
    // The private key lives outside the repository so it cannot be committed.
    keyPath: process.env.GOLDEN_ID_KEY_PATH || path.join(os.homedir(), '.golden-id', 'signing-key.pem')
  },

  share: {
    defaultTtlMs: Number(process.env.SHARE_TTL_MS || 15 * 60_000)
  },

  security: {
    // The demo OTP is echoed in the API response ONLY when explicitly allowed.
    // Anything reachable beyond localhost must leave this off, or the OTP is
    // not a second factor at all.
    exposeDemoOtp: process.env.EXPOSE_DEMO_OTP === 'true' || (!process.env.EXPOSE_DEMO_OTP && isTest === false && process.env.NODE_ENV !== 'production'),
    // Retention for uploaded scans and extraction rows.
    retentionDays: Number(process.env.RETENTION_DAYS || 7)
  },

  isTest
};

module.exports = { config, loadEnv, parseEnv };
