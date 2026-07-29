const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createWorker } = require('tesseract.js');
const englishOcr = require('@tesseract.js-data/eng');

const PORT = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, 'public');
const records = new Map();
const otpChallenges = new Map();
const sessions = new Map();
const REQUIRED_DOCUMENT_TYPES = ['birth_certificate', 'aadhaar', 'pan', 'passport', 'voter'];
const REQUIRED_DOCUMENT_LABELS = { birth_certificate:'Birth Certificate', aadhaar:'Aadhaar Card', pan:'PAN Card', passport:'Passport', voter:'Voter ID' };
let ocrWorkerPromise;
let ocrQueue = Promise.resolve();

function getOcrWorker() {
  if (!ocrWorkerPromise) ocrWorkerPromise = createWorker(englishOcr.code, 1, { langPath:englishOcr.langPath, gzip:englishOcr.gzip });
  return ocrWorkerPromise;
}

function runOcr(image, pageMode = '3') {
  const task = ocrQueue.then(async () => {
    const worker = await getOcrWorker();
    await worker.setParameters({ tessedit_pageseg_mode:pageMode, preserve_interword_spaces:'1' });
    return worker.recognize(image);
  });
  ocrQueue = task.catch(() => {});
  return task;
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
const mask = value => {
  const clean = String(value || '').replace(/\s/g, '');
  return clean.length > 4 ? `${'*'.repeat(Math.min(clean.length - 4, 8))}${clean.slice(-4)}` : '****';
};
const readBody = req => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', chunk => {
    raw += chunk;
    if (raw.length > 40_000_000) reject(new Error('Request too large'));
  });
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid JSON')); } });
  req.on('error', reject);
});

function compareDocuments(documents) {
  const fields = ['name', 'dob', 'gender', 'address'];
  const mismatches = [];
  for (const field of fields) {
    const values = documents.map(d => ({ type: d.type, value: normalize(d[field]) }));
    if (values.some(x => x.value) && new Set(values.map(x => x.value)).size > 1) mismatches.push({ field, values });
  }
  return mismatches;
}

function validateRequiredDocuments(documents) {
  if (!Array.isArray(documents)) return 'All five mandatory document records are required.';
  const types = documents.map(document => document.type);
  const missing = REQUIRED_DOCUMENT_TYPES.filter(type => !types.includes(type));
  if (missing.length) return `Missing mandatory documents: ${missing.map(type => REQUIRED_DOCUMENT_LABELS[type]).join(', ')}.`;
  if (documents.length !== 5 || new Set(types).size !== 5 || types.some(type => !REQUIRED_DOCUMENT_TYPES.includes(type))) return 'Provide exactly one Birth Certificate, Aadhaar Card, PAN Card, Passport and Voter ID.';
  if (documents.some(document => !document.name || !document.dob || !document.number)) return 'Each mandatory document must include the name, date of birth and document number.';
  return '';
}

function extractDocumentText(file) {
  const text = String(file.text || '').replace(/\0/g, ' ').replace(/\s*([/.-])\s*/g, '$1');
  const lines = text.split(/\r?\n/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const pick = patterns => { for (const pattern of patterns) { const match = text.match(pattern); if (match) return match[1].trim(); } return ''; };
  const afterLabel = labels => {
    for (let i=0;i<lines.length;i++) for (const label of labels) {
      const match=lines[i].match(new RegExp(`^${label}\\s*[:=-]?\\s*(.*)$`,'i'));
      if (match) return match[1].trim() || lines[i+1] || '';
    }
    return '';
  };
  const datePattern='(?:\\d{4}[/.\\-]\\d{1,2}[/.\\-]\\d{1,2}|\\d{1,2}[/.\\-]\\d{1,2}[/.\\-]\\d{4})';
  let dob = pick([new RegExp(`(?:dob|date of birth|birth|जन्म)[^\\d]{0,20}(${datePattern})`,'i'),new RegExp(`\\b(${datePattern})\\b`)]);
  if (!dob) {
    const ocrDateText=text.replace(/(?<=[0-9OIL])\s+(?=[0-9OIL])/gi,'').replace(/[O]/gi,'0').replace(/[IL]/gi,'1');
    const fuzzy=ocrDateText.match(new RegExp(`\\b(${datePattern})\\b`));
    if (fuzzy) dob=fuzzy[1];
  }
  dob=dob.replace(/\./g,'/');
  let name = pick([/(?:name|holder)\s*[:=-]\s*([A-Za-z][A-Za-z .]{2,60}?)(?=\s+(?:dob|date of birth|gender|sex)\s*[:=-]|[\r\n]|$)/i]);
  if (!name) name=afterLabel(['name(?: of (?:card )?holder)?','card holder']);
  if (!name) {
    const dobLine = lines.findIndex(line => /(?:dob|date of birth|birth)|\d{2}[/-]\d{2}[/-]\d{4}/i.test(line));
    const excluded = /government|india|income|tax|unique|identification|authority|aadhaar|male|female|year of birth|father|address/i;
    const candidates = lines.slice(0, dobLine < 0 ? lines.length : dobLine).filter(line => /^[A-Za-z][A-Za-z .]{2,50}$/.test(line) && !excluded.test(line));
    name = candidates.at(-1) || '';
  }
  let address = pick([/(?:address|पता)\s*[:=-]?\s*([^\r\n]+(?:[\r\n]+(?!\s*(?:dob|gender|male|female|\d{4}\s?\d{4}\s?\d{4}))[A-Za-z0-9,./ -]+){0,5})/i]);
  if (!address) address=afterLabel(['address','पता']);
  address = address.replace(/\s+/g, ' ').trim();
  const panNumber=pick([/\b([A-Z]{5}\s?\d{4}\s?[A-Z])\b/i]);
  const aadhaarNumber=pick([/\b(\d{4}\s?\d{4}\s?\d{4})\b/]);
  const epicNumber=pick([/(?:epic|voter)\s*(?:no|number)?\s*[:=-]\s*([A-Z0-9/-]{6,20})/i]);
  const passportNumber=pick([/(?:passport\s*(?:no|number)?\s*[:=-]?\s*)\b([A-Z][0-9]{7})\b/i, /\b([A-Z][0-9]{7})\b/]);
  const birthNumber=pick([/(?:registration|certificate)\s*(?:no|number)\s*[:=-]\s*([A-Z0-9/-]{4,30})/i]);
  let documentType=pick([/document\s*type\s*[:=-]\s*(birth certificate|aadhaar|pan|passport|voter)/i, /\b(birth certificate|aadhaar|pan|passport|voter)\b/i]).toLowerCase().replace(/\s+/g,'_');
  if (!documentType) documentType=panNumber?'pan':aadhaarNumber?'aadhaar':epicNumber?'voter':passportNumber?'passport':birthNumber?'birth_certificate':'document';
  return {
    fileName: String(file.name || 'document'),
    type: documentType,
    name, dob,
    gender: pick([/(?:gender|sex)\s*[:=-]?\s*(male|female|other|m|f)\b/i, /\b(male|female)\b/i]),
    address,
    number: panNumber||aadhaarNumber||epicNumber||passportNumber||birthNumber
  };
}

async function readUploadedFile(file) {
  if (file.data && /^data:image\//i.test(file.data)) {
    const decode = data => Buffer.from(data.replace(/^data:[^;]+;base64,/i, ''), 'base64');
    const colour = await runOcr(decode(file.data), '3');
    let enhanced = colour;
    if (file.enhancedData) enhanced = await runOcr(decode(file.enhancedData), '6');
    const sparse = await runOcr(decode(file.data), '11');
    const colourFields=extractDocumentText({name:file.name,text:colour.data.text});
    const enhancedFields=extractDocumentText({name:file.name,text:enhanced.data.text});
    const sparseFields=extractDocumentText({name:file.name,text:sparse.data.text});
    const fieldScore = fields => ['name','dob','gender','address','number'].filter(key=>fields[key]).length;
    const passes=[{result:colour,fields:colourFields},{result:enhanced,fields:enhancedFields},{result:sparse,fields:sparseFields}].sort((a,b)=>fieldScore(b.fields)-fieldScore(a.fields)||b.result.data.confidence-a.result.data.confidence);
    return { ...file, data:undefined, enhancedData:undefined, text:passes.map(pass=>pass.result.data.text).join('\n'), confidence:Math.round(Math.max(...passes.map(pass=>pass.result.data.confidence))), source:'ocr-multipass' };
  }
  return { ...file, confidence: 100, source: 'embedded-text' };
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/v1/auth/session') {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const session = sessions.get(token);
    if (!session || session.expires < Date.now()) return json(res, 401, { valid:false, error:'Session expired.' });
    return json(res, 200, { valid:true, user:{identifier:session.identifier}, expiresAt:new Date(session.expires).toISOString() });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/auth/request-otp') {
    const { identifier = '' } = await readBody(req);
    const value = String(identifier).trim().toLowerCase();
    const valid = /^\+?[1-9]\d{9,14}$/.test(value.replace(/[\s-]/g, '')) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    if (!valid) return json(res, 400, { error: 'Enter a valid mobile number or email address.' });
    const challengeId = crypto.randomUUID();
    const otp = String(crypto.randomInt(100000, 1000000));
    otpChallenges.set(challengeId, { identifier: value, otp, expires: Date.now() + 5 * 60_000, attempts: 0 });
    return json(res, 200, { challengeId, expiresIn: 300, demoOtp: otp, message: 'Demo OTP generated. Production must deliver it through an approved provider.' });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/auth/verify-otp') {
    const { challengeId, otp } = await readBody(req);
    const challenge = otpChallenges.get(challengeId);
    if (!challenge || challenge.expires < Date.now()) return json(res, 400, { error: 'OTP expired. Request a new one.' });
    challenge.attempts++;
    if (challenge.attempts > 5) { otpChallenges.delete(challengeId); return json(res, 429, { error: 'Too many attempts. Request a new OTP.' }); }
    if (String(otp) !== challenge.otp) return json(res, 401, { error: 'Incorrect OTP.' });
    otpChallenges.delete(challengeId);
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    sessions.set(sessionToken, { identifier: challenge.identifier, expires: Date.now() + 60 * 60_000 });
    return json(res, 200, { sessionToken, expiresIn: 3600, user: { identifier: challenge.identifier } });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/documents/identify') {
    const sessionToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const session = sessions.get(sessionToken);
    if (!session || session.expires < Date.now()) return json(res, 401, { error: 'Please sign in before continuing.' });
    const body = await readBody(req);
    if (body.consent !== true) return json(res, 400, { error: 'Explicit consent is required.' });
    if (!Array.isArray(body.files) || body.files.length < 1 || body.files.length > 5) return json(res, 400, { error: 'Select between one and five files.' });
    const documents = [];
    for (const file of body.files) {
      const readFile = await readUploadedFile(file);
      const extracted = extractDocumentText(readFile);
      documents.push({ file:extracted.fileName, type:extracted.type, label:REQUIRED_DOCUMENT_LABELS[extracted.type] || 'Unknown document', confidence:readFile.confidence });
    }
    return json(res, 200, { documents });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/applications/compare-files') {
    const sessionToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const session = sessions.get(sessionToken);
    if (!session || session.expires < Date.now()) return json(res, 401, { error: 'Please sign in before continuing.' });
    const body = await readBody(req);
    if (body.consent !== true) return json(res, 400, { error: 'Explicit consent is required.' });
    if (!Array.isArray(body.files) || body.files.length < 2 || body.files.length > 5) return json(res, 400, { error: 'Upload between two and five identity documents.' });
    const readFiles = [];
    for (const file of body.files) readFiles.push(await readUploadedFile(file));
    const documents = readFiles.map(file => ({ ...extractDocumentText(file), confidence:file.confidence, source:file.source }));
    const recognizedTypes = documents.map(document => document.type);
    const unrecognized = documents.filter(document => !REQUIRED_DOCUMENT_TYPES.includes(document.type));
    if (unrecognized.length || new Set(recognizedTypes).size !== recognizedTypes.length) return json(res, 422, { status:'rejected', reason:'Each file must be a different recognized identity document.', detectedDocuments:documents.map(document => ({file:document.fileName,type:document.type})) });
    const uncertain = documents.filter(d => d.source.startsWith('ocr') && d.confidence < 45).map(d => ({ file:d.fileName, reason:`OCR confidence is ${d.confidence}%. Extracted values are shown for review rather than discarded.`, extracted:{type:d.type,name:d.name||'Not found',dob:d.dob||'Not found',gender:d.gender||'Not found',address:d.address||'Not found',number:mask(d.number)} }));
    const unreadable = documents.filter(d => !d.name || !d.dob).map(d => ({ file: d.fileName, reason: !d.name && !d.dob ? 'Name and date of birth could not be extracted.' : !d.name ? 'Name could not be extracted.' : 'Date of birth could not be extracted.' }));
    if (unreadable.length) return json(res, 422, { status: 'rejected', reason: 'OCR processed every image, but required identity fields could not be located reliably.', corrections: unreadable.map(item=>{const d=documents.find(doc=>doc.fileName===item.file);return {...item,extracted:d?{type:d.type,name:d.name||'Not found',dob:d.dob||'Not found',gender:d.gender||'Not found',address:d.address||'Not found',number:mask(d.number)}:{}}}) });
    const mismatches = compareDocuments(documents);
    if (mismatches.length) return json(res, 422, { status: 'needs_correction', reason: 'Identity details do not match exactly between the uploaded documents.', corrections:uncertain, mismatches:mismatches.map(m=>({...m,explanation:`The ${m.field} differs, including missing, extra, misspelled or misplaced characters.`})) });
    if (uncertain.length) return json(res, 422, { status:'review_required', reason:'The fields were extracted and matched, but one or more images need confirmation before a Golden ID can be issued.', corrections:uncertain });
    const id = `GID-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    const token = crypto.randomBytes(24).toString('base64url');
    const first = documents[0];
    const record = { id, status:'verified_demo', name:first.name, dob:first.dob, gender:first.gender||'Not provided', photo:'', documents:documents.map(d=>({type:d.type||'document',number:mask(d.number),verified:'text-extracted-demo'})), issuedAt:new Date().toISOString(), token };
    records.set(id, record);
    return json(res, 201, { ...record, warning:'Prototype text extraction—not government verification.' });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/applications') {
    const sessionToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const session = sessions.get(sessionToken);
    if (!session || session.expires < Date.now()) return json(res, 401, { error: 'Please sign in before continuing.' });
    const body = await readBody(req);
    if (body.consent !== true) return json(res, 400, { error: 'Explicit consent is required.' });
    const documentError = validateRequiredDocuments(body.documents);
    if (documentError) return json(res, 400, { error: documentError });
    const mismatches = compareDocuments(body.documents);
    if (mismatches.length) return json(res, 422, { status: 'needs_correction', mismatches });

    const id = `GID-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    const token = crypto.randomBytes(24).toString('base64url');
    const first = body.documents[0];
    const record = {
      id, status: 'verified_demo', name: first.name.trim(), dob: first.dob,
      gender: first.gender || 'Not provided', photo: body.photo || '',
      documents: body.documents.map(d => ({ type: d.type, number: mask(d.number), verified: 'simulated' })),
      issuedAt: new Date().toISOString(), token
    };
    records.set(id, record);
    return json(res, 201, { ...record, verifyUrl: `/verify.html?id=${encodeURIComponent(id)}`, warning: 'Prototype result—not a government credential.' });
  }

  const match = url.pathname.match(/^\/api\/v1\/cards\/([^/]+)$/);
  if (req.method === 'GET' && match) {
    const record = records.get(decodeURIComponent(match[1]));
    if (!record) return json(res, 404, { error: 'Card not found or server was restarted.' });
    const supplied = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token');
    if (supplied !== record.token) return json(res, 401, { error: 'A valid holder token is required.' });
    const { token, photo, ...safe } = record;
    return json(res, 200, safe);
  }
  return false;
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) { if (await api(req, res, url) === false) json(res, 404, { error: 'Not found' }); return; }
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(publicDir, requested));
    if (!file.startsWith(publicDir)) return json(res, 403, { error: 'Forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(data);
    });
  } catch (error) { json(res, 400, { error: error.message }); }
});
if (require.main === module) server.listen(PORT, () => console.log(`Golden ID demo: http://localhost:${PORT}`));
module.exports = { compareDocuments, extractDocumentText, validateRequiredDocuments, server };
