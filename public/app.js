const result = document.querySelector('#result');
let sessionToken = sessionStorage.getItem('goldenSession') || '';
let challengeId = '';

// APPLICATION-SCOPED STATE.
//
// The contamination bug lived here: `selectedFiles` and `extracted` were
// page-lifetime globals cleared only on logout, so uploading a second person's
// documents without logging out left the first person's files in the comparison
// set. Everything below hangs off `currentApplicationId`, and starting a new
// application resets all of it. The server enforces the same boundary
// independently — neither side is trusted alone.
//
// `epoch` is the guard against the subtler version of the same bug: an async
// continuation (an upload or comparison already in flight) writing an OLD
// application's documents into a freshly reset workspace. Every await is
// followed by an epoch check; a reset bumps the epoch and the stale
// continuation discards its own result.

let currentApplicationId = null;
let epoch = 0;
let selectedFiles = [];              // File objects staged for THIS application
let documents = new Map();           // documentId -> server-side document state
let uploaded = new Set();            // fileKey of every file already sent
let selectedDocs = new Set();        // documentIds ticked for the next comparison
let uploadPromise = null;            // in-flight upload (single-flight lock)
let uploadQueued = false;
let compareController = null;        // aborts a superseded comparison

const APPLICATION_KEY = 'goldenApplication';

const show = id => ['splash', 'auth', 'app'].forEach(x => document.querySelector('#' + x).classList.toggle('hidden', x !== id));
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const FIELD_LABELS = {
  holder_name: 'Name', dob: 'Date of birth', gender: 'Gender',
  guardian_name: 'Father / spouse name', mother_name: "Mother's name",
  address: 'Address', face: 'Photo match'
};
const DOC_LABELS = {
  birth_certificate: 'Birth Certificate', aadhaar: 'Aadhaar', pan: 'PAN',
  passport: 'Passport', voter: 'Voter ID', driving_licence: 'Driving Licence', unknown: 'Unknown'
};
const docLabel = type => DOC_LABELS[type] || type;

const DECISION_COPY = {
  verified_match: { tone: 'ok', title: 'Documents match' },
  verified_no_conflict: { tone: 'ok', title: 'No conflicts found' },
  verified_with_partial_overlap: { tone: 'ok', title: 'Documents agree where they overlap' },
  likely_match_needs_confirmation: { tone: 'warn', title: 'A few details need your confirmation' },
  insufficient_evidence: { tone: 'warn', title: 'Not enough readable evidence yet' },
  extraction_failed: { tone: 'error', title: 'Nothing could be read' },
  document_conflict: { tone: 'error', title: 'The documents disagree' },
  suspected_cross_identity: { tone: 'error', title: 'These documents may describe different people' },
  rejected_invalid_document: { tone: 'error', title: 'A document failed validation' },
  blocked_security_integrity: { tone: 'error', title: 'Blocked by an integrity check' },
  retake_required: { tone: 'warn', title: 'Some images need retaking' }
};

// --- session ---------------------------------------------------------------

async function sessionIsValid() {
  if (!sessionToken) return false;
  try {
    return (await fetch('/api/v1/auth/session', { headers: { authorization: `Bearer ${sessionToken}` } })).ok;
  } catch { return false; }
}

function requireFreshSignIn(message = 'Your session expired. Please request a new OTP to continue.') {
  sessionToken = '';
  sessionStorage.removeItem('goldenSession');
  // Keep the stored application id: the APPLICATION did not expire, only the
  // session. After signing back in the same applicant resumes where they were.
  resetApplicationState({ keepStored: true });
  document.querySelector('#authError').innerHTML = `<div class="error">${escapeHtml(message)}</div>`;
  document.querySelector('#verifyOtp').classList.add('hidden');
  document.querySelector('#requestOtp').classList.remove('hidden');
  show('auth');
}

const authed = () => ({ 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` });

const setMessage = text => {
  const message = document.querySelector('#fetchMessage');
  if (message) message.textContent = text;
};

/**
 * Wipe every trace of the previous applicant. Called on new application and
 * logout. Bumping the epoch and aborting in-flight requests is what stops an
 * upload or comparison that ALREADY left the station from delivering the old
 * application's documents into the new one.
 */
function resetApplicationState({ keepStored = false } = {}) {
  epoch++;
  if (compareController) { compareController.abort(); compareController = null; }
  currentApplicationId = null;
  if (!keepStored) sessionStorage.removeItem(APPLICATION_KEY);
  selectedFiles = [];
  documents = new Map();
  uploaded = new Set();
  selectedDocs = new Set();
  uploadQueued = false;
  result.innerHTML = '';
  const steps = document.querySelector('#compareSteps');
  if (steps) steps.innerHTML = '<b>1 Upload ✓</b><b class="active">2 Compare</b><b>3 Golden ID</b>';
  setMessage('');
  renderSelectedFiles();
}

/** Open a brand-new application on the server and remember it across refresh. */
async function startApplication() {
  const response = await fetch('/api/v1/applications', {
    method: 'POST', headers: authed(), body: JSON.stringify({ consent: true })
  });
  if (response.status === 401) { requireFreshSignIn(); return null; }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not start an application.');
  currentApplicationId = data.applicationId;
  sessionStorage.setItem(APPLICATION_KEY, currentApplicationId);
  return data;
}

function enterWorkspace() {
  show('app');
  document.querySelector('#appWelcome').classList.add('hidden');
  document.querySelector('#startPanel').classList.add('hidden');
  document.querySelector('#uploadPanel').classList.remove('hidden');
  document.querySelector('#workspace').classList.add('workflow-open');
}

/**
 * A refresh RESUMES the application in progress; only "Start a new
 * application" abandons it. The id survives in sessionStorage and the
 * documents are re-fetched from the server — the one source of truth.
 */
async function resumeApplication() {
  const stored = sessionStorage.getItem(APPLICATION_KEY);
  if (!stored || !sessionToken) return false;
  const myEpoch = epoch;
  try {
    const response = await fetch(`/api/v1/applications/${encodeURIComponent(stored)}`, { headers: authed() });
    if (myEpoch !== epoch) return true;
    if (!response.ok) { sessionStorage.removeItem(APPLICATION_KEY); return false; }
    const data = await response.json();
    currentApplicationId = data.id;
    documents = new Map();
    for (const item of data.documents || []) {
      if (item.status === 'removed_by_user') continue;
      documents.set(item.id, item);
      if (item.status === 'ready') selectedDocs.add(item.id);
    }
    enterWorkspace();
    showUploadStage();
    renderSelectedFiles();
    setMessage(documents.size
      ? `Resumed your application in progress. ${countsMessage()}`
      : 'Resumed your application in progress.');
    return true;
  } catch { return false; }
}

/**
 * The page can come back from the browser's back/forward cache with in-memory
 * state frozen at a moment that no longer exists. Re-fetch the truth.
 */
async function resyncFromServer() {
  if (!currentApplicationId || !sessionToken) return;
  const myEpoch = epoch;
  try {
    const response = await fetch(`/api/v1/applications/${encodeURIComponent(currentApplicationId)}`, { headers: authed() });
    if (myEpoch !== epoch) return;
    if (response.status === 401) { requireFreshSignIn(); return; }
    if (!response.ok) { resetApplicationState(); return; }
    const data = await response.json();
    const previous = documents;
    documents = new Map();
    for (const item of data.documents || []) {
      if (item.status === 'removed_by_user') continue;
      documents.set(item.id, { ...(previous.get(item.id) || {}), ...item });
    }
    pruneSelection();
    renderSelectedFiles();
  } catch { /* transient network problem — keep what we have */ }
}

document.querySelector('#begin').onclick = async () => {
  if (await sessionIsValid()) {
    if (!(await resumeApplication())) show('app');
  } else if (sessionToken) requireFreshSignIn('Your previous session is no longer active. Please sign in again.');
  else show('auth');
};

document.querySelector('#letsGo').onclick = async () => {
  if (!(await sessionIsValid())) { requireFreshSignIn(); return; }
  resetApplicationState();
  try {
    await startApplication();
  } catch (error) {
    result.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    return;
  }
  enterWorkspace();
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

function showCompareStage() {
  document.querySelector('#form').classList.add('hidden');
  document.querySelector('#compareStage').classList.remove('hidden');
}
function showUploadStage() {
  document.querySelector('#compareStage').classList.add('hidden');
  document.querySelector('#form').classList.remove('hidden');
  document.querySelector('#fileConsent').checked = false;
}
document.querySelector('#addFromCompare').onclick = showUploadStage;

/** Explicitly finish with this applicant and begin another. */
document.querySelector('#newApplication').onclick = async () => {
  if (!(await sessionIsValid())) { requireFreshSignIn(); return; }
  resetApplicationState();
  document.querySelector('#files').value = '';
  const folders = document.querySelector('#folders');
  if (folders) folders.value = '';
  document.querySelector('#fileConsent').checked = false;
  try {
    await startApplication();
  } catch (error) {
    result.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    return;
  }
  showUploadStage();
  setMessage('Started a new application. No documents from the previous one are carried over.');
};

document.querySelector('#logout').onclick = () => {
  sessionToken = '';
  sessionStorage.removeItem('goldenSession');
  resetApplicationState();
  document.querySelector('#uploadPanel').classList.add('hidden');
  document.querySelector('#appWelcome').classList.remove('hidden');
  document.querySelector('#startPanel').classList.remove('hidden');
  document.querySelector('#workspace').classList.remove('workflow-open');
  document.querySelector('#verifyOtp').classList.add('hidden');
  document.querySelector('#requestOtp').classList.remove('hidden');
  document.querySelector('#otp').value = '';
  showUploadStage();
  document.querySelector('#authError').innerHTML = '';
  show('auth');
};

document.querySelector('#requestOtp').onsubmit = async e => {
  e.preventDefault();
  document.querySelector('#authError').innerHTML = '';
  const r = await fetch('/api/v1/auth/request-otp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: document.querySelector('#identifier').value })
  });
  const d = await r.json();
  if (!r.ok) { document.querySelector('#authError').innerHTML = `<div class="error">${escapeHtml(d.error)}</div>`; return; }
  challengeId = d.challengeId;
  document.querySelector('#requestOtp').classList.add('hidden');
  document.querySelector('#verifyOtp').classList.remove('hidden');
  document.querySelector('#otpHint').textContent = d.demoOtp
    ? `Demo OTP: ${d.demoOtp} • expires in 5 minutes`
    : 'A one-time code has been generated. Check the server log (demo mode is off).';
  document.querySelector('#otp').focus();
};

document.querySelector('#verifyOtp').onsubmit = async e => {
  e.preventDefault();
  const r = await fetch('/api/v1/auth/verify-otp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId, otp: document.querySelector('#otp').value })
  });
  const d = await r.json();
  if (!r.ok) { document.querySelector('#authError').innerHTML = `<div class="error">${escapeHtml(d.error)}</div>`; return; }
  sessionToken = d.sessionToken;
  sessionStorage.setItem('goldenSession', sessionToken);
  resetApplicationState({ keepStored: true });
  show('app');
  await resumeApplication();
};

document.querySelector('#back').onclick = () => {
  document.querySelector('#verifyOtp').classList.add('hidden');
  document.querySelector('#requestOtp').classList.remove('hidden');
  document.querySelector('#authError').innerHTML = '';
};

// --- file selection --------------------------------------------------------

const fileKey = file => `${file.webkitRelativePath || file.name}:${file.size}:${file.lastModified}`;

/**
 * Read a file for upload. Images keep their EXIF intact — orientation is applied
 * SERVER-side now, because a canvas re-encode here silently dropped the
 * orientation tag and sent rotated passports to the face detector.
 */
const readFile = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve({
    name: file.name,
    relativePath: file.webkitRelativePath || '',
    data: reader.result
  });
  reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
  reader.readAsDataURL(file);
});

/**
 * SHA-256 of a staged file, matching the server's content hash. This is how
 * uploads are linked to server documents — by CONTENT, never by array
 * position, which is what let removed documents adopt new files' identities.
 */
async function hashFile(file) {
  if (!crypto.subtle) return null; // non-secure context: linking degrades gracefully
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Only documents the holder has not removed exist as far as the UI cares. */
const activeDocuments = () => [...documents.values()].filter(d => d.status !== 'removed_by_user');

function countsMessage() {
  const active = activeDocuments();
  const ready = active.filter(d => d.status === 'ready').length;
  return `${ready} of ${active.length} document${active.length === 1 ? '' : 's'} identified.`;
}

/** Keep the comparison selection meaningful: only existing, readable docs. */
function pruneSelection() {
  for (const id of [...selectedDocs]) {
    const doc = documents.get(id);
    if (!doc || doc.status !== 'ready') selectedDocs.delete(id);
  }
}

function autoSelectReady() {
  for (const doc of activeDocuments()) {
    if (doc.status === 'ready' && !selectedDocs.has(doc.id) && !doc.userDeselected) selectedDocs.add(doc.id);
  }
  pruneSelection();
}

function renderSelectedFiles() {
  const list = document.querySelector('#fileNames');
  if (!list) return;

  const active = activeDocuments();
  const rows = [];
  for (const file of selectedFiles) {
    const key = fileKey(file);
    const state = active.find(document => document.clientKey === key);
    rows.push(fileRow(file.name, file.size, state, key));
  }
  // Documents the server discovered (PDF pages, ZIP entries) that have no
  // corresponding File object.
  for (const document of active) {
    if (document.clientKey && selectedFiles.some(file => fileKey(file) === document.clientKey)) continue;
    rows.push(fileRow(document.file, 0, document, null));
  }

  list.innerHTML = rows.length ? rows.join('') : '<span class="empty-files">No documents added yet</span>';

  document.querySelectorAll('.document-option').forEach(option => {
    const present = active.some(item => item.type === option.dataset.document && item.status === 'ready');
    option.classList.toggle('uploaded', present);
    option.querySelector('.document-status').textContent = present ? '✓' : '○';
  });

  renderCompareManifest();
}

/** Say exactly which files the next comparison will use, before it runs. */
function renderCompareManifest() {
  const manifest = document.querySelector('#compareManifest');
  if (!manifest) return;
  const chosen = activeDocuments().filter(d => selectedDocs.has(d.id) && d.status === 'ready');
  manifest.textContent = chosen.length
    ? `Comparing ${chosen.length} document${chosen.length === 1 ? '' : 's'}: ${chosen.map(d => d.file).join(', ')}`
    : 'No documents selected for comparison yet.';
}

function fileRow(name, size, state, clientKey) {
  const status = state ? state.status : 'pending';
  const badge = {
    pending: '<span class="doc-state waiting">Waiting</span>',
    preprocessing: '<span class="doc-state reading">Checking image…</span>',
    extracting: '<span class="doc-state reading">Reading…</span>',
    ready: `<span class="doc-state ok">${escapeHtml(state ? state.label : 'Identified')}</span>`,
    unreadable: '<span class="doc-state bad">Could not read</span>',
    retake_required: '<span class="doc-state bad">Retake needed</span>',
    rejected_file: '<span class="doc-state bad">Rejected</span>',
    removed_by_user: '<span class="doc-state waiting">Removed</span>'
  }[status] || '<span class="doc-state waiting">Waiting</span>';

  const picker = state && state.id ? `<select class="doc-type-pick" data-type-for="${escapeHtml(state.id)}">${
    Object.entries(DOC_LABELS).map(([value, label]) =>
      `<option value="${value}"${state.type === value ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')
  }</select>` : '';

  const select = state && state.id && state.status === 'ready'
    ? `<label class="doc-select"><input type="checkbox" data-select-doc="${escapeHtml(state.id)}"${
        selectedDocs.has(state.id) ? ' checked' : ''}> Compare</label>`
    : '';

  const corrected = state && state.classification && state.classification.corrected
    ? `<div class="type-corrected">Re-identified as <b>${escapeHtml(state.label)}</b> — the model said “${escapeHtml(state.classification.claimed)}”, but the evidence on the card says otherwise. ${escapeHtml(state.classification.reason || '')}</div>`
    : '';

  const retake = state && state.status === 'retake_required'
    ? `<div class="type-corrected retake">This image could not be read reliably: ${escapeHtml(state.statusReason || '')} Retake tips: place the card flat on a dark surface, avoid flash glare, use the rear camera, fill the frame with all four corners, and upload the original photo (not a WhatsApp-compressed copy).</div>`
    : '';

  const unreadableNote = state && state.status === 'unreadable' && state.statusReason
    ? `<div class="type-corrected retake">${escapeHtml(state.statusReason)}</div>`
    : '';

  const remove = clientKey
    ? `<button type="button" data-remove-file="${escapeHtml(clientKey)}" aria-label="Remove file">Remove</button>`
    : (state && state.id ? `<button type="button" data-remove-doc="${escapeHtml(state.id)}" aria-label="Remove document">Remove</button>` : '');

  return `<div class="selected-file-wrap"><div class="selected-file"><b>${escapeHtml(name)}</b>${badge}${picker}${select}${
    size ? `<span>${Math.max(1, Math.round(size / 1024))} KB</span>` : ''
  }${remove}</div>${corrected}${retake}${unreadableNote}</div>`;
}

// --- upload ----------------------------------------------------------------

/**
 * Upload everything staged, into the CURRENT application only. Single-flight:
 * a second call while one is running queues exactly one follow-up instead of
 * sending the same bytes twice in parallel.
 */
function uploadPending() {
  if (uploadPromise) { uploadQueued = true; return uploadPromise; }
  uploadPromise = (async () => {
    try {
      do { uploadQueued = false; await uploadOnce(); } while (uploadQueued);
    } finally { uploadPromise = null; }
  })();
  return uploadPromise;
}

async function uploadOnce() {
  if (!document.querySelector('#fileConsent').checked || !selectedFiles.length) return;
  const pending = selectedFiles.filter(file => !uploaded.has(fileKey(file)));
  if (!pending.length) return;

  if (!(await sessionIsValid())) { requireFreshSignIn(); return; }
  const myEpoch = epoch;
  if (!currentApplicationId) {
    try { await startApplication(); } catch (error) { setMessage(error.message); return; }
    if (myEpoch !== epoch) return;
  }

  setMessage(`Reading ${pending.length} document${pending.length === 1 ? '' : 's'}…`);
  renderSelectedFiles();

  try {
    const [payload, hashes] = await Promise.all([
      Promise.all(pending.map(readFile)),
      Promise.all(pending.map(hashFile))
    ]);
    if (myEpoch !== epoch) return;

    const response = await fetch(`/api/v1/applications/${encodeURIComponent(currentApplicationId)}/documents`, {
      method: 'POST', headers: authed(),
      body: JSON.stringify({ consent: true, files: payload, source: payload.some(f => f.relativePath) ? 'folder' : 'files' })
    });
    if (response.status === 401) { requireFreshSignIn(); return; }
    const data = await response.json();
    // A reset happened while the request was in flight: this response belongs
    // to an application the user has already left. Discard it entirely.
    if (myEpoch !== epoch) return;
    if (!response.ok) throw new Error(data.error || 'Extraction failed.');

    for (const file of pending) uploaded.add(fileKey(file));

    // Rebuild by server id, preserving client links. Removed rows are dropped
    // from the working set here — they exist only in the server's audit view.
    const previous = documents;
    documents = new Map();
    for (const item of data.documents || []) {
      if (item.status === 'removed_by_user') continue;
      documents.set(item.id, { ...(previous.get(item.id) || {}), ...item });
    }

    // Link uploads to files BY CONTENT HASH — exact, order-independent, and
    // covers fresh rows, reactivated rows and duplicate-skips alike.
    const byHash = new Map();
    pending.forEach((file, index) => { if (hashes[index]) byHash.set(hashes[index], fileKey(file)); });
    for (const item of documents.values()) {
      if (item.contentHash && byHash.has(item.contentHash)) {
        documents.set(item.id, { ...documents.get(item.id), clientKey: byHash.get(item.contentHash) });
      }
    }

    autoSelectReady();

    const notes = [countsMessage()];
    const duplicates = (data.skipped || []).filter(item => /^duplicate/.test(item.reason || ''));
    const otherSkipped = (data.skipped || []).filter(item => !/^duplicate/.test(item.reason || ''));
    if (duplicates.length) notes.push(`${duplicates.length} file(s) had identical content to a document already here and were not added again.`);
    if ((data.reactivated || []).length) notes.push(`${data.reactivated.length} previously removed document(s) were brought back by re-uploading the same file.`);
    if (otherSkipped.length) notes.push(`${otherSkipped.length} file(s) skipped: ${otherSkipped.map(s => s.reason).join(', ')}.`);
    if ((data.limitsHit || []).length) notes.push(`Upload limit reached (${data.limitsHit.join(', ')}).`);
    setMessage(notes.join(' '));
  } catch (error) {
    if (myEpoch === epoch) setMessage(error.message);
  }
  if (myEpoch === epoch) renderSelectedFiles();
}

document.querySelector('#fileConsent').onchange = () => { uploadPending(); };

document.querySelector('#documentOptions').onclick = e => {
  const button = e.target.closest('.fetch-document');
  if (!button) return;
  const name = button.closest('.document-option').querySelector('.document-name').textContent;
  setMessage(`${name} fetch is not connected in this prototype. An approved issuer API and your explicit authorization are required.`);
};

const addFiles = fileList => {
  const existing = new Set(selectedFiles.map(fileKey));
  for (const file of fileList) if (!existing.has(fileKey(file))) { selectedFiles.push(file); existing.add(fileKey(file)); }
  renderSelectedFiles();
  uploadPending();
};

document.querySelector('#files').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
const folderInput = document.querySelector('#folders');
if (folderInput) folderInput.onchange = e => { addFiles(e.target.files); e.target.value = ''; };

// Drag and drop, including folders.
const dropZone = document.querySelector('.document-upload');
if (dropZone) {
  ['dragenter', 'dragover'].forEach(type => dropZone.addEventListener(type, e => {
    e.preventDefault(); dropZone.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach(type => dropZone.addEventListener(type, e => {
    e.preventDefault(); dropZone.classList.remove('dragging');
  }));
  dropZone.addEventListener('drop', async e => {
    const items = [...(e.dataTransfer.items || [])];
    const entries = items.map(item => item.webkitGetAsEntry && item.webkitGetAsEntry()).filter(Boolean);
    if (entries.length) {
      const collected = [];
      await Promise.all(entries.map(entry => walkEntry(entry, collected)));
      if (collected.length) return addFiles(collected);
    }
    addFiles(e.dataTransfer.files || []);
  });
}

/** Recursively collect files from a dropped directory entry. */
function walkEntry(entry, collected, prefix = '') {
  return new Promise(resolve => {
    if (entry.isFile) {
      entry.file(file => {
        try { Object.defineProperty(file, 'webkitRelativePath', { value: prefix + entry.name }); } catch { /* read-only in some browsers */ }
        collected.push(file);
        resolve();
      }, resolve);
      return;
    }
    if (!entry.isDirectory) return resolve();
    const reader = entry.createReader();
    const readBatch = () => reader.readEntries(async children => {
      if (!children.length) return resolve();
      await Promise.all(children.map(child => walkEntry(child, collected, `${prefix + entry.name}/`)));
      readBatch();
    }, resolve);
    readBatch();
  });
}

// --- removal ---------------------------------------------------------------

/** Remove a document on the server. Returns true when it is gone. */
async function removeOnServer(documentId) {
  if (!currentApplicationId) return true;
  try {
    const response = await fetch(`/api/v1/applications/${encodeURIComponent(currentApplicationId)}/documents/${encodeURIComponent(documentId)}`, {
      method: 'DELETE', headers: authed()
    });
    if (response.status === 401) { requireFreshSignIn(); return false; }
    // 409 already_removed: the server got there first — same outcome.
    return response.ok || response.status === 409;
  } catch { return false; }
}

document.querySelector('#fileNames').onclick = async e => {
  const removeFile = e.target.closest('[data-remove-file]');
  if (removeFile) {
    const key = removeFile.dataset.removeFile;
    const linked = [...documents.entries()].filter(([, item]) => item.clientKey === key);

    // Awaited and verified — a fire-and-forget delete that failed used to
    // leave the document active on the server while the client forgot it.
    let failed = false;
    for (const [id] of linked) {
      if (!(await removeOnServer(id))) failed = true;
    }
    if (failed) {
      setMessage('Removal failed — the document is still part of this application. Please try again.');
      renderSelectedFiles();
      return;
    }
    selectedFiles = selectedFiles.filter(file => fileKey(file) !== key);
    uploaded.delete(key);
    for (const [id] of linked) { documents.delete(id); selectedDocs.delete(id); }
    setMessage(activeDocuments().length ? countsMessage() : '');
    renderSelectedFiles();
    return;
  }
  const removeDoc = e.target.closest('[data-remove-doc]');
  if (removeDoc) {
    const id = removeDoc.dataset.removeDoc;
    if (!(await removeOnServer(id))) {
      setMessage('Removal failed — the document is still part of this application. Please try again.');
      return;
    }
    documents.delete(id);
    selectedDocs.delete(id);
    setMessage(activeDocuments().length ? countsMessage() : '');
    renderSelectedFiles();
  }
};

/** Type overrides and comparison selection share the change listener. */
document.querySelector('#fileNames').onchange = async e => {
  const tick = e.target.closest('[data-select-doc]');
  if (tick) {
    const id = tick.dataset.selectDoc;
    if (tick.checked) {
      selectedDocs.add(id);
      const doc = documents.get(id);
      if (doc) documents.set(id, { ...doc, userDeselected: false });
    } else {
      selectedDocs.delete(id);
      const doc = documents.get(id);
      if (doc) documents.set(id, { ...doc, userDeselected: true });
    }
    renderCompareManifest();
    return;
  }

  const picker = e.target.closest('[data-type-for]');
  if (!picker || !currentApplicationId) return;

  const documentId = picker.dataset.typeFor;
  const type = picker.value;
  const response = await fetch(`/api/v1/applications/${encodeURIComponent(currentApplicationId)}/documents/${encodeURIComponent(documentId)}/field`, {
    method: 'PATCH', headers: authed(), body: JSON.stringify({ field: 'document_type', value: type })
  });
  if (response.status === 401) { requireFreshSignIn(); return; }
  if (!response.ok) return;
  const data = await response.json();
  documents.set(documentId, { ...documents.get(documentId), ...data.document });
  setMessage(`Set to ${DOC_LABELS[type] || type}.`);
  renderSelectedFiles();
};

// --- verdict rendering -----------------------------------------------------

const renderDiff = diff => escapeHtml(diff).replace(/\[([^\]]*)\]/g, '<mark class="diff-change">[$1]</mark>');

function severityClass(field) {
  if (field.severity === 'reject') return 'sev-reject';
  if (field.severity === 'needs_confirmation') return 'sev-confirm';
  if (field.severity === 'warn') return 'sev-warn';
  if (field.severity === 'info') return 'sev-info';
  return 'sev-ok';
}

/** Distinct document corroboration, falling back for older payload shapes. */
const supportOf = field => field.corroboration ?? (field.agreeing ? field.agreeing.length : 0);

/**
 * One document providing a value is not agreement — there is nothing for it to
 * agree with. Labelling it AGREED would imply corroboration that does not exist.
 */
function statusLabel(field) {
  if (field.severity === 'reject') return 'Mismatch';
  if (field.severity === 'needs_confirmation') return 'Confirm';
  if (field.severity === 'warn') return 'Check';
  if (field.status === 'single_source') return 'Single-source';
  if (field.status === 'not_extracted') return 'Not read';
  if (field.severity === 'info') return 'Note';
  return supportOf(field) >= 2 ? 'Agreed' : 'Single-source';
}

function fieldRow(field, docs) {
  if (field.label === 'face') return '';

  const single = field.status === 'single_source' || (supportOf(field) <= 1 && !field.dissenting.length);
  const agreeing = field.agreeing.length
    ? (single
      ? `Provided by: ${field.agreeing.map(docLabel).join(', ')}`
      : field.agreeing.map(docLabel).join(', '))
    : '—';
  const dissent = field.dissenting.map(item =>
    `<div class="dissent"><b>${escapeHtml(docLabel(item.type))}</b> says “${escapeHtml(item.value)}”${
      item.diff ? `<div class="diff">${renderDiff(item.diff)}</div>` : ''
    }${item.explanation ? `<div class="dissent-why">${escapeHtml(item.explanation)}</div>` : ''}</div>`
  ).join('');

  // Documents that agree but wrote the value differently — spacing, word
  // order, capitalisation — plus variations the holder explicitly confirmed.
  const variants = (field.variants || []).length
    ? `<div class="variant-note">${field.variants.map(item =>
        item.holderConfirmed
          ? `${escapeHtml(docLabel(item.type))} reads “${escapeHtml(item.value)}” — <b>confirmed by you</b> as the same person${item.confirmedAt ? ` on ${escapeHtml(new Date(item.confirmedAt).toLocaleString())}` : ''}`
          : `${escapeHtml(docLabel(item.type))} reads “${escapeHtml(item.value)}” — ${escapeHtml(item.explanation || 'same value, written differently')}`
      ).join('<br>')}</div>`
    : '';

  const unreadable = (field.unreadable || []).length
    ? `<div class="missing-note">Could not be read on: ${field.unreadable.map(item =>
        `${escapeHtml(docLabel(item.type))}${item.detail ? ` (${escapeHtml(item.detail)})` : ''}`).join(', ')}</div>`
    : '';

  // Documents that did not supply this field abstain, with the reason. This is
  // what stops "the Voter ID shows no date of birth" being read as the Voter ID
  // disagreeing about the date of birth.
  const abstained = (field.abstained || []).length
    ? `<div class="abstain-note">${field.abstained.map(item => {
        if (item.reason === 'holder_asserted') {
          return `${escapeHtml(docLabel(item.type))}: you entered “${escapeHtml(item.observedValue || '')}” — <b>Applicant supplied; not verified from the uploaded document.</b>`;
        }
        const observed = item.observedValue
          ? ` <span class="observed">read “${escapeHtml(item.observedValue)}” but could not locate it on the page, so it is not compared</span>`
          : '';
        return `${escapeHtml(docLabel(item.type))}: ${escapeHtml(item.detail || 'abstains')}${observed}`;
      }).join('<br>')}</div>`
    : '';

  const evidence = (field.evidence || field.sources || []).length
    ? `<div class="evidence-note">Evidence: ${(field.evidence || field.sources).map(escapeHtml).join(', ')}</div>`
    : '';

  const fixable = field.severity === 'reject' || field.severity === 'needs_confirmation' || field.requiresManualEntry;
  const options = docs
    .filter(document_ => document_.status === 'ready')
    .map(document_ => `<option value="${escapeHtml(document_.id)}">${escapeHtml(docLabel(document_.type))}</option>`)
    .join('');

  const fix = fixable ? `<div class="fix-field">
      <label>Correct this field
        <select data-fix-doc="${escapeHtml(field.label)}">${options}</select>
      </label>
      <input data-fix-value="${escapeHtml(field.label)}" placeholder="${escapeHtml(field.value || 'Enter the value exactly as printed')}">
      <button type="button" class="secondary" data-fix-apply="${escapeHtml(field.label)}">Apply &amp; re-check</button>
      <div class="fix-note">If the document does not actually print this field, your entry is recorded as supplied by you — not as verified document evidence.</div>
    </div>` : '';

  return `<tr class="${severityClass(field)}${single ? ' sev-single' : ''}">
    <th scope="row">${escapeHtml(FIELD_LABELS[field.label] || field.label)}
      <span class="sev-tag">${escapeHtml(statusLabel(field))}</span></th>
    <td class="agreed-value">${escapeHtml(field.value || '—')}</td>
    <td class="agreeing-docs">${escapeHtml(agreeing)}${evidence}</td>
    <td>${dissent || (variants ? '' : '<span class="no-dissent">—</span>')}${variants}${unreadable}${abstained}${fix}</td>
  </tr>`;
}

function facePanel(face) {
  if (!face) return '';
  const rows = (face.pairs || []).map(pair =>
    `<li><b>${escapeHtml(docLabel(pair.a))} ↔ ${escapeHtml(docLabel(pair.b))}</b>
      <span class="${pair.match ? 'face-ok' : 'face-low'}">${Number(pair.similarity).toFixed(2)}</span>
      ${pair.match ? 'similar' : 'below threshold'}</li>`).join('');

  const missing = (face.withoutFace || []).length
    ? `<p class="face-missing">No usable photograph on: ${face.withoutFace.map(t => escapeHtml(docLabel(t))).join(', ')}. Those documents are excluded.</p>`
    : '';

  return `<section class="face-panel">
    <h3>Photo comparison <span class="advisory-tag">Advisory only</span></h3>
    ${rows ? `<ul class="face-pairs">${rows}</ul>` : ''}
    ${missing}
    <p class="face-note">${escapeHtml(face.note || '')}</p>
    <p class="face-note"><b>This never blocks a Golden ID.</b> These scores are uncalibrated against real document photographs and must not be read as proof of identity.</p>
  </section>`;
}

function integrityPanel(integrity) {
  if (!integrity || integrity.ok !== false) return '';
  return `<section class="integrity-panel">
    <h3>Integrity check failed</h3>
    <ul>${(integrity.failures || []).map(f => `<li>${escapeHtml(f.detail)}</li>`).join('')}</ul>
    <p>Issuance is blocked and this has been recorded in the audit trail. This is not something you can confirm past.</p>
  </section>`;
}

function renderVerdict(data) {
  const verdict = data.verdict || {};
  const fields = (verdict.fields || []).filter(field => field.label !== 'face');
  const docs = data.documents || [];

  const table = `<table class="verdict-table">
    <thead><tr><th>Field</th><th>Agreed value</th><th>Documents that agree</th><th>Differences</th></tr></thead>
    <tbody>${fields.map(field => fieldRow(field, docs)).join('')}</tbody>
  </table>`;

  const compared = (data.selected || []).length && docs.length
    ? `<p class="source-note">Compared exactly: ${(data.selected || [])
        .map(id => { const doc = docs.find(d => d.id === id); return doc ? doc.file : null; })
        .filter(Boolean).map(escapeHtml).join(', ')}</p>`
    : '';

  const sources = docs.length
    ? `<p class="source-note">Read by: ${docs.map(d =>
        `${escapeHtml(docLabel(d.type))} <em>(${escapeHtml(d.source || 'unknown')}${d.validation && d.validation.repaired ? ', number repaired' : ''})</em>`
      ).join(' · ')}</p>`
    : '';

  return `${integrityPanel(data.integrity)}${table}${compared}${sources}${facePanel(data.face)}`;
}

function renderCard(data) {
  const fields = (data.record && data.record.fields) || {};
  const fieldText = key => {
    const field = fields[key];
    if (!field) return '';
    return field.verificationStatus === 'unverified'
      ? `${field.value} (applicant supplied, unverified)`
      : field.value;
  };
  const nameSources = ((fields.holder_name && fields.holder_name.sources) || []).map(docLabel);
  const nameLine = nameSources.length >= 2
    ? `Name agreed by: ${nameSources.join(', ')}`
    : `Name from: ${nameSources.join(', ') || '—'} (single document)`;

  return `<div class="card">
    <small>GOLDEN ID • ${escapeHtml((data.record && data.record.status) || 'verified_demo')}</small>
    <h2>${escapeHtml(fieldText('holder_name'))}</h2>
    <p>${escapeHtml(fieldText('dob'))} · ${escapeHtml(fieldText('gender'))}</p>
    <p class="gid">${escapeHtml(data.gid)}</p>
    <div class="docs">${(data.record.documents || []).map(d =>
      `${escapeHtml(docLabel(d.type).toUpperCase())} ••••${escapeHtml(d.numberSuffix || '')} ${d.valid ? '✓' : '?'}`
    ).join(' &nbsp; ')}</div>
    <p class="ok">${escapeHtml(nameLine)}</p>
    ${data.alreadyIssued ? '<p class="ok">You already hold this Golden ID — a second one was not issued.</p>' : ''}
    <p class="token">Share link (expires ${escapeHtml(new Date(data.shareExpiresAt).toLocaleTimeString())}): <a href="${escapeHtml(data.verifyUrl)}&amp;token=${encodeURIComponent(data.shareToken)}">open</a></p>
  </div>`;
}

// --- comparison ------------------------------------------------------------

/** Render a comparison (or confirmation) response. Shared by both flows. */
function renderComparisonOutcome(data) {
  (data.documents || []).forEach(document_ => {
    if (document_.status === 'removed_by_user') { documents.delete(document_.id); return; }
    const previous = documents.get(document_.id) || {};
    documents.set(document_.id, { ...previous, ...document_ });
  });
  pruneSelection();

  if (data.issued && data.gid) {
    document.querySelector('#compareSteps').innerHTML = '<b>1 Upload ✓</b><b>2 Match ✓</b><b class="active">3 Golden ID</b>';
    result.innerHTML = renderCard(data) + renderVerdict(data);
    return;
  }

  const copy = DECISION_COPY[data.decision] || { tone: 'warn', title: 'Review needed' };
  document.querySelector('#compareSteps').innerHTML =
    `<b>1 Upload ✓</b><b class="active">2 ${escapeHtml(copy.title)}</b><b>3 Golden ID</b>`;

  const issuanceNote = data.issuanceNote
    ? `<p class="issuance-note">${escapeHtml(data.issuanceNote)}</p>` : '';
  const reasons = (data.reasons || []).length
    ? `<ul class="reason-list">${data.reasons.map(r => `<li>${escapeHtml(r.detail)}</li>`).join('')}</ul>` : '';

  result.innerHTML = `<div class="verdict-head ${copy.tone === 'error' ? 'error' : 'warn-box'}">
      <b>${escapeHtml(copy.title)}</b>
      <p>${escapeHtml(data.summary || data.error || '')}</p>
      ${reasons}${issuanceNote}
    </div>${renderVerdict(data)}`;

  if (data.decision === 'likely_match_needs_confirmation' && ((data.verdict || {}).confirmable || []).length) {
    showConfirmationDialog(data);
  }
}

async function runComparison() {
  if (!currentApplicationId) {
    result.innerHTML = '<div class="error">Start an application before comparing.</div>';
    return;
  }

  pruneSelection();
  const chosen = activeDocuments().filter(d => selectedDocs.has(d.id) && d.status === 'ready');
  if (chosen.length < 2) {
    result.innerHTML = '<div class="error">Select at least two readable documents (tick “Compare” next to each) before comparing.</div>';
    return;
  }

  const myEpoch = epoch;
  if (compareController) compareController.abort();
  compareController = new AbortController();

  document.querySelector('#compareSteps').innerHTML = '<b>1 Upload ✓</b><b class="active">2 Comparing…</b><b>3 Golden ID</b>';
  result.innerHTML = `<p>Comparing ${chosen.length} documents: ${chosen.map(d => escapeHtml(d.file)).join(', ')}…</p>`;

  try {
    const response = await fetch(`/api/v1/applications/${encodeURIComponent(currentApplicationId)}/compare`, {
      method: 'POST', headers: authed(), signal: compareController.signal,
      body: JSON.stringify({ consent: true, documentIds: chosen.map(d => d.id) })
    });
    if (response.status === 401) { requireFreshSignIn(); return; }
    const data = await response.json();
    if (myEpoch !== epoch) return; // superseded by a reset — this verdict belongs to a previous application

    if (response.status === 409 && data.pending) {
      result.innerHTML = `<div class="verdict-head warn-box"><b>Still reading your documents</b><p>${escapeHtml(data.error)}</p></div>`;
      return;
    }
    if (response.status === 400) {
      result.innerHTML = `<div class="error">${escapeHtml(data.error || 'Invalid comparison request.')}</div>`;
      if (data.code === 'removed_document_selected') {
        for (const id of data.ids || []) selectedDocs.delete(id);
        await resyncFromServer();
      }
      return;
    }

    renderComparisonOutcome(data);
  } catch (error) {
    if (error && error.name === 'AbortError') return;
    if (myEpoch !== epoch) return;
    document.querySelector('#compareSteps').innerHTML = '<b>1 Upload ✓</b><b class="active">2 Interrupted</b><b>3 Golden ID</b>';
    result.innerHTML = '<div class="error">Comparison was interrupted. Use “Add document” and try again.</div>';
  }
}

document.querySelector('#compareFiles').onclick = async () => {
  if (!document.querySelector('#fileConsent').checked) {
    result.innerHTML = '<div class="error">Please provide consent below the file list before comparing your documents.</div>';
    showCompareStage();
    return;
  }
  if (!(await sessionIsValid())) { requireFreshSignIn(); return; }
  result.innerHTML = '';
  showCompareStage();
  await uploadPending();
  await runComparison();
};

// --- soft-variation confirmation -------------------------------------------

/**
 * The holder decides whether two very similar values describe the same
 * person. Only differences the ENGINE marked confirmable ever reach this
 * dialog — a hard conflict has no confirm button anywhere.
 */
function showConfirmationDialog(data) {
  document.querySelector('.confirm-overlay')?.remove();

  const verdict = data.verdict || {};
  const field = (verdict.confirmable || [])[0];
  const entry = (verdict.fields || []).find(item => item.label === field);
  if (!entry) return;
  const others = (entry.dissenting || []).filter(item => item.needsConfirmation || item.likely_ocr_variant);

  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  overlay.innerHTML = `<div class="confirm-panel" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
    <h3 id="confirmTitle">These ${escapeHtml((FIELD_LABELS[field] || field).toLowerCase())}s are very similar but not identical.</h3>
    <ul class="confirm-values">
      <li><b>${escapeHtml(entry.value)}</b> — per ${escapeHtml(entry.agreeing.map(docLabel).join(', ') || 'the winning reading')}</li>
      ${others.map(item => `<li><b>${escapeHtml(item.value)}</b> — per ${escapeHtml(docLabel(item.type))}${
        item.diff ? `<div class="diff">${renderDiff(item.diff)}</div>` : ''}</li>`).join('')}
    </ul>
    <p>If both are your documents, small spelling and transliteration differences are normal. Your confirmation is recorded in the audit trail; both original values are preserved.</p>
    <div class="confirm-actions">
      <button type="button" class="primary" data-confirm-same>Confirm same person and continue</button>
      <button type="button" class="secondary" data-confirm-review>Review the documents</button>
      <button type="button" class="secondary" data-confirm-different>These documents belong to different people</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('[data-confirm-review]').onclick = () => overlay.remove();
  overlay.querySelector('[data-confirm-different]').onclick = () => {
    overlay.remove();
    result.insertAdjacentHTML('afterbegin',
      '<div class="verdict-head warn-box"><b>Understood — nothing was merged.</b><p>Remove the document that does not belong to this person, or start a new application for the other person. No confirmation was recorded.</p></div>');
  };
  overlay.querySelector('[data-confirm-same]').onclick = async () => {
    const button = overlay.querySelector('[data-confirm-same]');
    button.disabled = true;
    button.textContent = 'Recording…';
    const myEpoch = epoch;
    try {
      const response = await fetch(`/api/v1/applications/${encodeURIComponent(currentApplicationId)}/confirmations`, {
        method: 'POST', headers: authed(),
        body: JSON.stringify({ consent: true, comparisonId: data.comparisonId, field, decision: 'same_person' })
      });
      if (response.status === 401) { requireFreshSignIn(); overlay.remove(); return; }
      const outcome = await response.json();
      if (myEpoch !== epoch) { overlay.remove(); return; }
      overlay.remove();
      if (!response.ok) {
        result.insertAdjacentHTML('afterbegin', `<div class="error">${escapeHtml(outcome.error || 'Could not record the confirmation.')}</div>`);
        return;
      }
      renderComparisonOutcome(outcome);
    } catch {
      overlay.remove();
      result.insertAdjacentHTML('afterbegin', '<div class="error">The confirmation could not be recorded. Please try again.</div>');
    }
  };
}

/** Inline per-field correction: patch one field on one document, then re-compare. */
result.addEventListener('click', async e => {
  const button = e.target.closest('[data-fix-apply]');
  if (!button || !currentApplicationId) return;

  const field = button.dataset.fixApply;
  const documentId = result.querySelector(`[data-fix-doc="${CSS.escape(field)}"]`).value;
  const value = result.querySelector(`[data-fix-value="${CSS.escape(field)}"]`).value.trim();
  if (!documentId || !value) return;

  button.disabled = true;
  button.textContent = 'Applying…';
  try {
    const response = await fetch(`/api/v1/applications/${encodeURIComponent(currentApplicationId)}/documents/${encodeURIComponent(documentId)}/field`, {
      method: 'PATCH', headers: authed(), body: JSON.stringify({ field, value })
    });
    if (response.status === 401) { requireFreshSignIn(); return; }
    if (!response.ok) throw new Error((await response.json()).error || 'Could not apply that correction.');
    await runComparison();
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Apply & re-check';
    result.insertAdjacentHTML('afterbegin', `<div class="error">${escapeHtml(error.message)}</div>`);
  }
});

// --- boot ------------------------------------------------------------------

// An accidental implicit form submit navigates the page and orphans the
// application; the form is a workspace, not a submission.
document.querySelector('#form').addEventListener('submit', e => e.preventDefault());

// The back/forward cache restores this page with frozen in-memory state;
// re-fetch the server's truth before the user acts on a stale view.
window.addEventListener('pageshow', event => { if (event.persisted) resyncFromServer(); });

(async () => {
  renderSelectedFiles();
  if (sessionToken && await sessionIsValid()) {
    await resumeApplication();
  }
})();
