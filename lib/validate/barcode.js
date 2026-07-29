'use strict';

const zlib = require('zlib');

// Deterministic reads that beat any vision model.
//
// The Aadhaar "Secure QR" printed on modern cards contains a UIDAI-SIGNED
// payload with the holder's name, DOB, gender and address. When it decodes, it
// is ground truth: no OCR, no model, no guessing. Nothing else available
// without a government API comes close.
//
// We verify the STRUCTURE, not the signature — verifying the RSA signature
// needs UIDAI's public certificate, which we deliberately do not bundle. So a
// decoded QR is treated as strong evidence, never as government verification.

let readerPromise = null;
function getReader() {
  if (!readerPromise) {
    readerPromise = import('zxing-wasm/reader').catch(() => null);
  }
  return readerPromise;
}

/**
 * Read every barcode/QR in an image.
 * Returns `[{ format, text, bytes }]`; an empty array is normal, not an error.
 */
async function readBarcodes(buffer, mimeType = 'image/jpeg') {
  const reader = await getReader();
  if (!reader) return [];
  try {
    const blob = new Blob([buffer], { type: mimeType });
    const results = await reader.readBarcodes(blob, {
      tryHarder: true,
      formats: ['QRCode', 'DataMatrix', 'PDF417', 'Aztec', 'Code128'],
      maxNumberOfSymbols: 4
    });
    return (results || []).map(result => ({
      format: result.format,
      text: result.text || '',
      bytes: result.bytes ? Buffer.from(result.bytes) : null
    }));
  } catch {
    return [];
  }
}

// --- Aadhaar Secure QR ------------------------------------------------------

const AADHAAR_FIELD_ORDER = [
  'email_mobile_flag', 'reference_id', 'name', 'dob', 'gender',
  'careof', 'district', 'landmark', 'house', 'location', 'pincode',
  'postoffice', 'state', 'street', 'subdistrict', 'vtc'
];

/**
 * Decode an Aadhaar Secure QR payload.
 *
 * The modern format is a big integer whose bytes are raw-deflate compressed;
 * the inflated buffer is a sequence of 0xFF-delimited fields followed by a
 * photo and a 256-byte RSA signature. The older format is plain XML.
 */
function parseAadhaarQr(raw) {
  if (raw == null) return null;

  const text = typeof raw === 'string' ? raw.trim() : '';

  // Legacy XML QR.
  if (text.startsWith('<?xml') || text.startsWith('<PrintLetterBarcodeData')) {
    const attributes = {};
    for (const match of text.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) attributes[match[1]] = match[2];
    if (!attributes.name && !attributes.uid) return null;
    return {
      version: 'xml',
      name: attributes.name || null,
      dob: attributes.dob || attributes.yob || null,
      gender: attributes.gender || null,
      address: [attributes.house, attributes.street, attributes.loc, attributes.vtc, attributes.dist, attributes.state, attributes.pc]
        .filter(Boolean).join(', ') || null,
      lastFourDigits: attributes.uid ? String(attributes.uid).slice(-4) : null,
      signed: false,
      hasPhoto: false
    };
  }

  // Secure QR: a decimal big integer.
  let compressed = null;
  if (typeof raw !== 'string' && Buffer.isBuffer(raw)) {
    compressed = raw;
  } else if (/^\d{20,}$/.test(text)) {
    let value = BigInt(text);
    const bytes = [];
    while (value > 0n) {
      bytes.unshift(Number(value & 0xffn));
      value >>= 8n;
    }
    compressed = Buffer.from(bytes);
  } else {
    return null;
  }

  let inflated;
  try {
    inflated = zlib.inflateRawSync(compressed);
  } catch {
    try { inflated = zlib.inflateSync(compressed); } catch { return null; }
  }

  // Split on 0xFF up to the photo. Field 0 is the flag, then reference id, etc.
  const parts = [];
  let start = 0;
  for (let i = 0; i < inflated.length && parts.length <= AADHAAR_FIELD_ORDER.length; i++) {
    if (inflated[i] === 0xff) {
      parts.push(inflated.slice(start, i).toString('utf8'));
      start = i + 1;
    }
  }
  if (parts.length < 6) return null;

  const values = {};
  AADHAAR_FIELD_ORDER.forEach((field, index) => { values[field] = parts[index] || ''; });

  // The reference id is <last 4 of Aadhaar><timestamp>.
  const referenceId = values.reference_id || '';
  const lastFour = /^\d{4}/.test(referenceId) ? referenceId.slice(0, 4) : null;

  const address = ['house', 'street', 'landmark', 'location', 'vtc', 'postoffice', 'subdistrict', 'district', 'state', 'pincode']
    .map(key => values[key]).filter(Boolean).join(', ');

  if (!values.name) return null;

  return {
    version: 'secure',
    name: values.name || null,
    dob: values.dob || null,
    gender: values.gender || null,
    address: address || null,
    careOf: values.careof || null,
    pincode: values.pincode || null,
    lastFourDigits: lastFour,
    // The payload carries a UIDAI signature we do not verify (no bundled cert).
    signed: true,
    signatureVerified: false,
    hasPhoto: inflated.length > start + 256
  };
}

/**
 * Locate and decode an Aadhaar Secure QR in an image.
 * Returns null when there is no QR — the common case for older cards.
 */
async function readAadhaarQr(buffer, mimeType = 'image/jpeg') {
  for (const barcode of await readBarcodes(buffer, mimeType)) {
    if (barcode.format !== 'QRCode') continue;
    const parsed = parseAadhaarQr(barcode.text) || (barcode.bytes ? parseAadhaarQr(barcode.bytes) : null);
    if (parsed) return parsed;
  }
  return null;
}

module.exports = { readBarcodes, readAadhaarQr, parseAadhaarQr, AADHAAR_FIELD_ORDER };
