const result = document.querySelector('#result');
let sessionToken = sessionStorage.getItem('goldenSession') || '';
let challengeId = '';

// APPLICATION-SCOPED STATE.
//
// The contamination bug lived here: `selectedFiles` and `extracted` were
// page-lifetime globals cleared only on logout, so uploading a second person's
// documents without logging out left the first person's files in the comparison
// set. Everything below now hangs off `currentApplicationId`, and starting a new
// application resets all of it. The server enforces the same boundary
// independently — neither side is trusted alone.

let currentApplicationId = null;
let selectedFiles = [];              // File objects staged for THIS application
let documents = new Map();           // documentId -> server-side document state
let uploaded = new Set();            // fileKey of every file already sent
let lastComparison = null;

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
  resetApplicationState();
  document.querySelector('#authError').innerHTML = `<div class="error">${escapeHtml(message)}</div>`;
  document.querySelector('#verifyOtp').classList.add('hidden');
  document.querySelector('#requestOtp').classList.remove('hidden');
  show('auth');
}

const authed = () => ({ 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` });

/** Wipe every trace of the previous applicant. Called on new application and logout. */
function resetApplicationState() {
  currentApplicationId = null;
  selectedFiles = [];
  documents = new Map();
  uploaded = new Set();
  lastComparison = null;
  result.innerHTML = '';
  const message = document.querySelector('#fetchMessage');
  if (message) message.textContent = '';
  renderSelectedFiles();
}

/** Open a brand-new application on the server. */
async function startApplication() {
  const response = await fetch('/api/v1/applications', {
    method: 'POST', headers: authed(), body: JSON.stringify({ consent: true })
  });
  if (response.status === 401) { requireFreshSignIn(); return null; }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not start an application.');
  currentApplicationId = data.applicationId;
  return data;
}

document.querySelector('#begin').onclick = async () => {
  if (await sessionIsValid()) show('app');
  else if (sessionToken) requireFreshSignIn('Your previous session is no longer active. Please sign in again.');
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
  document.querySelector('#appWelcome').classList.add('hidden');
  document.querySelector('#startPanel').classList.add('hidden');
  document.querySelector('#uploadPanel').classList.remove('hidden');
  document.querySelector('#workspace').classList.add('workflow-open');
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
  document.querySelector('#fileConsent').checked = false;
  try {
    await startApplication();
  } catch (error) {
    result.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    return;
  }
  showUploadStage();
  document.querySelector('#fetchMessage').textContent = 'Started a new application. No documents from the previous one are carried over.';
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
  resetApplicationState();
  show('app');
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

function renderSelectedFiles() {
  const list = document.querySelector('#fileNames');
  if (!list) return;

  const rows = [];
  for (const file of selectedFiles) {
    const key = fileKey(file);
    const state = [...documents.values()].find(document => document.clientKey === key);
    rows.push(fileRow(file.name, file.size, state, key));
  }
  // Documents the server discovered (PDF pages, ZIP entries) that have no
  // corresponding File object.
  for (const document of documents.values()) {
    if (document.clientKey && selectedFiles.some(file => fileKey(file) === document.clientKey)) continue;
    rows.push(fileRow(document.file, 0, document, null));
  }

  list.innerHTML = rows.length ? rows.join('') : '<span class="empty-files">No documents added yet</span>';

  document.querySelectorAll('.document-option').forEach(option => {
    const uploaded = [...documents.values()].some(item => item.type === option.dataset.document && item.status === 'ready');
    option.classList.toggle('uploaded', uploaded);
    option.querySelector('.document-status').textContent = uploaded ? '✓' : '○';
  });
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

  const corrected = state && state.classification && state.classification.corrected
    ? `<div class="type-corrected">Re-identified as <b>${escapeHtml(state.label)}</b> — the model said “${escapeHtml(state.classification.claimed)}”, but the evidence on the card says otherwise. ${escapeHtml(state.classification.reason || '')}</div>`
    : '';

  const retake = state && state.status === 'retake_required'
    ? `<div class="type-corrected retake">This image could not be read reliably: ${escapeHtml(state.statusReason || '')} Please retake it rather than accepting a guess.</div>`
    : '';

  const remove = clientKey
    ? `<button type="button" data-remove-file="${escapeHtml(clientKey)}" aria-label="Remove file">Remove</button>`
    : (state && state.id ? `<button type="button" data-remove-doc="${escapeHtml(state.id)}" aria-label="Remove document">Remove</button>` : '');

  return `<div class="selected-file-wrap"><div class="selected-file"><b>${escapeHtml(name)}</b>${badge}${picker}${
    size ? `<span>${Math.max(1, Math.round(size / 1024))} KB</span>` : ''
  }${remove}</div>${corrected}${retake}</div>`;
}

/** Upload everything staged, into the CURRENT application only. */
async function uploadPending() {
  if (!document.querySelector('#fileConsent').checked || !selectedFiles.length) return;
  if (!(await sessionIsValid())) { requireFreshSignIn(); return; }
  if (!currentApplicationId) {
    try { await startApplication(); } catch (error) {
      document.querySelector('#fetchMessage').textContent = error.message;
      return;
    }
  }

  // `uploaded` records which staged files have already been sent, keyed by the
  // file itself. Working this out from `documents` used to fail: the server
  // returns EVERY document in the application, but the client matched them to
  // staged files by array index against only the newly-pending ones. Anything
  // already uploaded therefore lost its link to its file, was treated as
  // pending again on the next add, and got re-sent — producing duplicate
  // document rows that then showed up in the comparison as phantom extras.
  const pending = selectedFiles.filter(file => !uploaded.has(fileKey(file)));
  if (!pending.length) return;

  const message = document.querySelector('#fetchMessage');
  message.textContent = `Reading ${pending.length} document${pending.length === 1 ? '' : 's'}…`;
  renderSelectedFiles();

  try {
    const payload = await Promise.all(pending.map(readFile));
    const response = await fetch(`/api/v1/applications/${encodeURIComponent(currentApplicationId)}/documents`, {
      method: 'POST', headers: authed(),
      body: JSON.stringify({ consent: true, files: payload, source: payload.some(f => f.relativePath) ? 'folder' : 'files' })
    });
    if (response.status === 401) { requireFreshSignIn(); return; }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Extraction failed.');

    // Mark every staged file as sent, whatever the server made of it, so it is
    // never uploaded twice.
    for (const file of pending) uploaded.add(fileKey(file));

    // Documents are keyed by their SERVER id — the only stable identifier.
    // Existing client-side links are preserved rather than rebuilt by position.
    const previous = documents;
    documents = new Map();
    for (const item of data.documents) {
      documents.set(item.id, { ...(previous.get(item.id) || {}), ...item });
    }

    // Link the newly-created documents to the files that produced them, by
    // content, using the order the server reports NEW documents in.
    const fresh = data.documents.filter(item => !previous.has(item.id));
    fresh.forEach((item, index) => {
      const file = pending[index];
      if (file) documents.set(item.id, { ...documents.get(item.id), clientKey: fileKey(file) });
    });

    const notes = [];
    const ready = data.documents.filter(d => d.status === 'ready').length;
    notes.push(`${ready} of ${data.documents.length} document${data.documents.length === 1 ? '' : 's'} identified.`);
    if (data.skipped && data.skipped.length) notes.push(`${data.skipped.length} file(s) skipped: ${data.skipped.map(s => s.reason).join(', ')}.`);
    if (data.limitsHit && data.limitsHit.length) notes.push(`Upload limit reached (${data.limitsHit.join(', ')}).`);
    message.textContent = notes.join(' ');
  } catch (error) {
    message.textContent = error.message;
  }
  renderSelectedFiles();
}

document.querySelector('#fileConsent').onchange = uploadPending;

document.querySelector('#documentOptions').onclick = e => {
  const button = e.target.closest('.fetch-document');
  if (!button) return;
  const name = button.closest('.document-option').querySelector('.document-name').textContent;
  document.querySelector('#fetchMessage').textContent = `${name} fetch is not connected in this prototype. An approved issuer API and your explicit authorization are required.`;
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

document.querySelector('#fileNames').onclick = async e => {
  const removeFile = e.target.closest('[data-remove-file]');
  if (removeFile) {
    const key = removeFile.dataset.removeFile;
    selectedFiles = selectedFiles.filter(file => fileKey(file) !== key);
    uploaded.delete(key);
    for (const [id, document_] of documents) {
      if (document_.clientKey !== key) continue;
      // Tell the server too, or the document stays in the application and
      // reappears in the next comparison.
      if (currentApplicationId) {
        fetch(`/api/v1/applications/${encodeURIComponent(currentApplicationId)}/documents/${encodeURIComponent(id)}`, {
          method: 'DELETE', headers: authed()
        }).catch(() => {});
      }
      documents.delete(id);
    }
    renderSelectedFiles();
    return;
  }
  const removeDoc = e.target.closest('[data-remove-doc]');
  if (removeDoc && currentApplicationId) {
    await fetch(`/api/v1/applications/${encodeURIComponent(currentApplicationId)}/documents/${encodeURIComponent(removeDoc.dataset.removeDoc)}`, {
      method: 'DELETE', headers: authed()
    });
    documents.delete(removeDoc.dataset.removeDoc);
    renderSelectedFiles();
  }
};

/** The holder overrules the backend on which document this is. */
document.querySelector('#fileNames').onchange = async e => {
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
  document.querySelector('#fetchMessage').textContent = `Set to ${DOC_LABELS[type] || type}.`;
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
  return field.agreeing && field.agreeing.length >= 2 ? 'Agreed' : 'Single-source';
}

function fieldRow(field, docs) {
  if (field.label === 'face') return '';

  const single = field.status === 'single_source' || (field.agreeing.length === 1 && !field.dissenting.length);
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
  // order, capitalisation. Shown so nothing is hidden, but they are agreement,
  // not something to confirm.
  const variants = (field.variants || []).length
    ? `<div class="variant-note">${field.variants.map(item =>
        `${escapeHtml(docLabel(item.type))} reads “${escapeHtml(item.value)}” — ${escapeHtml(item.explanation || 'same value, written differently')}`
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
      <input data-fix-value="${escapeHtml(field.label)}" placeholder="${escapeHtml(field.value || 'Enter the printed value')}">
      <button type="button" class="secondary" data-fix-apply="${escapeHtml(field.label)}">Apply &amp; re-check</button>
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

  const sources = docs.length
    ? `<p class="source-note">Read by: ${docs.map(d =>
        `${escapeHtml(docLabel(d.type))} <em>(${escapeHtml(d.source || 'unknown')}${d.validation && d.validation.repaired ? ', number repaired' : ''})</em>`
      ).join(' · ')}</p>`
    : '';

  return `${integrityPanel(data.integrity)}${table}${sources}${facePanel(data.face)}`;
}

function renderCard(data) {
  const fields = (data.record && data.record.fields) || {};
  const value = key => (fields[key] ? fields[key].value : '');
  const provenance = key => (fields[key] ? fields[key].sources.map(docLabel).join(', ') : '');

  return `<div class="card">
    <small>GOLDEN ID • ${escapeHtml((data.record && data.record.status) || 'verified_demo')}</small>
    <h2>${escapeHtml(value('holder_name'))}</h2>
    <p>${escapeHtml(value('dob'))} · ${escapeHtml(value('gender'))}</p>
    <p class="gid">${escapeHtml(data.gid)}</p>
    <div class="docs">${(data.record.documents || []).map(d =>
      `${escapeHtml(docLabel(d.type).toUpperCase())} ••••${escapeHtml(d.numberSuffix || '')} ${d.valid ? '✓' : '?'}`
    ).join(' &nbsp; ')}</div>
    <p class="ok">Name agreed by: ${escapeHtml(provenance('holder_name') || '—')}</p>
    ${data.alreadyIssued ? '<p class="ok">You already hold this Golden ID — a second one was not issued.</p>' : ''}
    <p class="token">Share link (expires ${escapeHtml(new Date(data.shareExpiresAt).toLocaleTimeString())}): <a href="${escapeHtml(data.verifyUrl)}&amp;token=${encodeURIComponent(data.shareToken)}">open</a></p>
  </div>`;
}

// --- comparison ------------------------------------------------------------

async function runComparison() {
  if (!currentApplicationId) {
    result.innerHTML = '<div class="error">Start an application before comparing.</div>';
    return;
  }

  // Only this application's ready documents are ever compared. The server
  // enforces the same rule independently.
  const ready = [...documents.values()].filter(d => d.status === 'ready');
  if (ready.length < 2) {
    result.innerHTML = '<div class="error">At least two readable documents are needed before they can be compared.</div>';
    return;
  }

  document.querySelector('#compareSteps').innerHTML = '<b>1 Upload ✓</b><b class="active">2 Comparing…</b><b>3 Golden ID</b>';
  result.innerHTML = '<p>Comparing identity fields across your documents…</p>';

  try {
    const response = await fetch(`/api/v1/applications/${encodeURIComponent(currentApplicationId)}/compare`, {
      method: 'POST', headers: authed(),
      body: JSON.stringify({ consent: true, documentIds: ready.map(d => d.id) })
    });
    if (response.status === 401) { requireFreshSignIn(); return; }
    const data = await response.json();
    lastComparison = data;

    if (response.status === 409 && data.pending) {
      result.innerHTML = `<div class="verdict-head warn-box"><b>Still reading your documents</b><p>${escapeHtml(data.error)}</p></div>`;
      return;
    }

    (data.documents || []).forEach(document_ => {
      const previous = documents.get(document_.id) || {};
      documents.set(document_.id, { ...previous, ...document_ });
    });

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
  } catch {
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
  showCompareStage();
  await uploadPending();
  await runComparison();
};

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

renderSelectedFiles();
