const docs = document.querySelector('#docs');
const result = document.querySelector('#result');
let sessionToken = sessionStorage.getItem('goldenSession') || '';
let challengeId = '';
const show = id => ['splash','auth','app'].forEach(x => document.querySelector('#'+x).classList.toggle('hidden', x !== id));
async function sessionIsValid() {
  if (!sessionToken) return false;
  try {
    const response = await fetch('/api/v1/auth/session',{headers:{authorization:`Bearer ${sessionToken}`}});
    return response.ok;
  } catch { return false; }
}
function requireFreshSignIn(message = 'Your session expired. Please request a new OTP to continue.') {
  sessionToken = '';
  sessionStorage.removeItem('goldenSession');
  document.querySelector('#authError').innerHTML = `<div class="error">${message}</div>`;
  document.querySelector('#verifyOtp').classList.add('hidden');
  document.querySelector('#requestOtp').classList.remove('hidden');
  show('auth');
}
document.querySelector('#begin').onclick = async () => {
  if (await sessionIsValid()) show('app');
  else {
    if (sessionToken) requireFreshSignIn('Your previous session is no longer active. Please sign in again.');
    else show('auth');
  }
};
document.querySelector('#letsGo').onclick = () => {
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
  document.querySelector('#manualConsent').checked = false;
  result.innerHTML = '';
}
document.querySelector('#addFromCompare').onclick = showUploadStage;
document.querySelector('#logout').onclick = () => {
  sessionToken = '';
  sessionStorage.removeItem('goldenSession');
  document.querySelector('#uploadPanel').classList.add('hidden');
  document.querySelector('#appWelcome').classList.remove('hidden');
  document.querySelector('#startPanel').classList.remove('hidden');
  document.querySelector('#workspace').classList.remove('workflow-open');
  document.querySelector('#verifyOtp').classList.add('hidden');
  document.querySelector('#requestOtp').classList.remove('hidden');
  document.querySelector('#otp').value = '';
  document.querySelector('#fileConsent').checked = false;
  document.querySelector('#manualConsent').checked = false;
  document.querySelector('#manualEntry').open = false;
  showUploadStage();
  document.querySelector('#authError').innerHTML = '';
  show('auth');
};
document.querySelector('#requestOtp').onsubmit = async e => {
  e.preventDefault(); document.querySelector('#authError').innerHTML = '';
  const r = await fetch('/api/v1/auth/request-otp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identifier:document.querySelector('#identifier').value})}); const d=await r.json();
  if(!r.ok){document.querySelector('#authError').innerHTML=`<div class="error">${d.error}</div>`;return} challengeId=d.challengeId; document.querySelector('#requestOtp').classList.add('hidden'); document.querySelector('#verifyOtp').classList.remove('hidden'); document.querySelector('#otpHint').textContent=`Demo OTP: ${d.demoOtp} • expires in 5 minutes`; document.querySelector('#otp').focus();
};
document.querySelector('#verifyOtp').onsubmit = async e => {
  e.preventDefault(); const r=await fetch('/api/v1/auth/verify-otp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({challengeId,otp:document.querySelector('#otp').value})}); const d=await r.json();
  if(!r.ok){document.querySelector('#authError').innerHTML=`<div class="error">${d.error}</div>`;return} sessionToken=d.sessionToken;sessionStorage.setItem('goldenSession',sessionToken);show('app');
};
document.querySelector('#back').onclick=()=>{document.querySelector('#verifyOtp').classList.add('hidden');document.querySelector('#requestOtp').classList.remove('hidden');document.querySelector('#authError').innerHTML=''};
let count = 0;
function addDoc(type) {
  const i = count++;
  const labels={birth_certificate:'Birth Certificate',aadhaar:'Aadhaar Card',pan:'PAN Card',passport:'Passport',voter:'Voter ID'};
  docs.insertAdjacentHTML('beforeend', `<div class="doc"><label class="wide">Mandatory document<input type="hidden" name="type-${i}" value="${type}"><input value="${labels[type]}" disabled></label><label>Name<input name="name-${i}" required placeholder="As printed"></label><label>Date of birth<input name="dob-${i}" required type="date"></label><label>Gender<input name="gender-${i}" placeholder="Enter exactly as printed"></label><label>Document number<input name="number-${i}" required placeholder="Required demo value"></label><label class="wide">Address (if printed on this ID)<input name="address-${i}" placeholder="Enter exactly as printed"></label></div>`);
}
['birth_certificate','aadhaar','pan','passport','voter'].forEach(addDoc);
let selectedFiles = [];
let identifiedDocuments = [];
const fileKey = file => `${file.name}:${file.size}:${file.lastModified}`;
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
function renderSelectedFiles() {
  const list = document.querySelector('#fileNames');
  list.innerHTML = selectedFiles.length ? selectedFiles.map((file,index)=>`<div class="selected-file"><b>${escapeHtml(file.name)}</b><span>${Math.max(1,Math.round(file.size/1024))} KB</span><button type="button" data-remove-file="${index}" aria-label="Remove file">Remove</button></div>`).join('') : '<span class="empty-files">No documents added yet</span>';
  document.querySelectorAll('.document-option').forEach(option => {
    const uploaded = identifiedDocuments.some(document => document.type === option.dataset.document);
    option.classList.toggle('uploaded', uploaded);
    option.querySelector('.document-status').textContent = uploaded ? '✓' : '○';
  });
}
const prepareImage = async file => {
  const bitmap = await createImageBitmap(file);
  const maxSide = 2200;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d', { alpha:false });
  context.fillStyle = '#fff'; context.fillRect(0,0,canvas.width,canvas.height);
  context.drawImage(bitmap,0,0,canvas.width,canvas.height);
  const colour = canvas.toDataURL('image/jpeg', .94);
  context.clearRect(0,0,canvas.width,canvas.height); context.fillStyle='#fff'; context.fillRect(0,0,canvas.width,canvas.height);
  context.filter = 'grayscale(1) contrast(1.45)';
  context.drawImage(bitmap,0,0,canvas.width,canvas.height); bitmap.close();
  return {colour,enhanced:canvas.toDataURL('image/jpeg', .94)};
};
const prepareFiles = () => Promise.all(selectedFiles.map(file => new Promise(async resolve => {
  if (file.type.startsWith('image/')) { try { const prepared=await prepareImage(file);resolve({name:file.name,type:'image/jpeg',data:prepared.colour,enhancedData:prepared.enhanced}); } catch { const reader=new FileReader(); reader.onload=()=>resolve({name:file.name,type:file.type,data:reader.result}); reader.readAsDataURL(file); } }
  else resolve({name:file.name,type:file.type,text:(await file.text()).slice(0,200000)});
})));
async function identifySelectedFiles() {
  if (!document.querySelector('#fileConsent').checked || !selectedFiles.length) return;
  if (!(await sessionIsValid())) { requireFreshSignIn(); return; }
  const message = document.querySelector('#fetchMessage');
  message.textContent = `Reading ${selectedFiles.length} selected file${selectedFiles.length === 1 ? '' : 's'} to identify the document type…`;
  document.querySelectorAll('.document-status').forEach(status => status.textContent = '…');
  try {
    const response = await fetch('/api/v1/documents/identify',{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${sessionToken}`},body:JSON.stringify({consent:true,files:await prepareFiles()})});
    if (response.status === 401) { requireFreshSignIn(); return; }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Document identification failed.');
    identifiedDocuments = data.documents;
    renderSelectedFiles();
    const unknown = data.documents.filter(document => document.type === 'document').length;
    message.textContent = unknown ? `${data.documents.length - unknown} identified; ${unknown} file could not be recognized. Try a clearer image.` : `${data.documents.length} document${data.documents.length === 1 ? '' : 's'} identified from file contents.`;
  } catch (error) {
    identifiedDocuments = [];
    renderSelectedFiles();
    message.textContent = error.message;
  }
}
document.querySelector('#fileConsent').onchange = identifySelectedFiles;
document.querySelector('#documentOptions').onclick = e => {
  const button = e.target.closest('.fetch-document');
  if (!button) return;
  const name = button.closest('.document-option').querySelector('.document-name').textContent;
  document.querySelector('#fetchMessage').textContent = `${name} fetch is not connected in this prototype. An approved issuer API and your explicit authorization are required.`;
};
document.querySelector('#files').onchange = e => {
  const existing = new Set(selectedFiles.map(fileKey));
  for (const file of e.target.files) if (!existing.has(fileKey(file))) { selectedFiles.push(file); existing.add(fileKey(file)); }
  e.target.value = '';
  identifiedDocuments = [];
  renderSelectedFiles();
  identifySelectedFiles();
};
document.querySelector('#fileNames').onclick = e => {
  const button = e.target.closest('[data-remove-file]');
  if (!button) return;
  selectedFiles.splice(Number(button.dataset.removeFile), 1);
  identifiedDocuments = [];
  renderSelectedFiles();
  identifySelectedFiles();
};
document.querySelector('#compareFiles').onclick = async () => {
  const selected = selectedFiles;
  if (selected.length < 2 || selected.length > 5) { result.innerHTML = '<div class="error">Choose between two and five documents to compare.</div>'; return; }
  if (!document.querySelector('#fileConsent').checked) { result.innerHTML = '<div class="error">Please provide consent below the file list before comparing your documents.</div>'; return; }
  if (!(await sessionIsValid())) { requireFreshSignIn(); return; }
  showCompareStage();
  document.querySelector('#compareSteps').innerHTML = '<b>1 Upload ✓</b><b class="active">2 Comparing…</b><b>3 Golden ID</b>';
  result.innerHTML = '<p>Optimising images and starting the text reader… The first scan may take a little longer.</p>';
  const files = await prepareFiles();
  result.innerHTML = `<p>Reading text from ${files.length} documents and comparing identity fields…</p>`;
  try {
    const response = await fetch('/api/v1/applications/compare-files',{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${sessionToken}`},body:JSON.stringify({consent:true,files})});
    if (response.status === 401) { requireFreshSignIn(); return; }
    const data = await response.json();
    if (!response.ok) {
      const corrections=(data.corrections||[]).map(x=>{const fields=x.extracted?`<div class="extracted-fields">${Object.entries(x.extracted).map(([key,value])=>`<span><b>${key}</b>: ${escapeHtml(value)}</span>`).join('')}</div>`:'';return `<li><b>${escapeHtml(x.file)}</b>: ${escapeHtml(x.reason)}${fields}</li>`}).join('');
      const mismatches=(data.mismatches||[]).map(m=>`<li><b>${m.field}</b>: ${m.values.map(v=>`${v.type||'document'} says “${v.value}”`).join('; ')}<br><small>${m.explanation||'These values do not match exactly.'}</small></li>`).join('');
      document.querySelector('#compareSteps').innerHTML = '<b>1 Upload ✓</b><b class="active">2 Rejected</b><b>3 Golden ID</b>';
      result.innerHTML=`<div class="error"><b>Documents could not be approved</b><p>${data.reason||data.error}</p><ul>${corrections}${mismatches}</ul><p>Correct the listed record with its issuing authority, or use manual entry if this demo cannot read the scan.</p></div>`; return;
    }
    document.querySelector('#compareSteps').innerHTML = '<b>1 Upload ✓</b><b>2 Match ✓</b><b class="active">3 Golden ID</b>';
    result.innerHTML=`<div class="card"><small>GOLDEN ID • TEXT-EXTRACTED DEMO</small><h2>${data.name}</h2><p>${data.dob} · ${data.gender}</p><p class="gid">${data.id}</p><div class="docs">${data.documents.map(d=>`${d.type.toUpperCase()} ${d.number} ✓`).join(' &nbsp; ')}</div><p class="ok">Uploaded identity fields are consistent</p></div>`;
  } catch (error) { document.querySelector('#compareSteps').innerHTML = '<b>1 Upload ✓</b><b class="active">2 Interrupted</b><b>3 Golden ID</b>'; result.innerHTML='<div class="error">Comparison was interrupted. Use “Add document” and try again.</div>'; }
};
document.querySelector('#form').onsubmit = async e => {
  e.preventDefault(); result.innerHTML = '<p>Comparing…</p>';
  const fd = new FormData(e.target); const documents = [];
  for (let i=0;i<count;i++) if (fd.get(`name-${i}`)) documents.push({type:fd.get(`type-${i}`),name:fd.get(`name-${i}`),dob:fd.get(`dob-${i}`),gender:fd.get(`gender-${i}`),number:fd.get(`number-${i}`),address:fd.get(`address-${i}`)});
  if (documents.length !== 5) {
    document.querySelector('#manualEntry').open = true;
    document.querySelector('#manualMessage').innerHTML = '<div class="error">Complete all five mandatory document records, including each document number.</div>';
    return;
  }
  if (!document.querySelector('#manualConsent').checked) { document.querySelector('#manualMessage').innerHTML = '<div class="error">Please provide consent inside the manual section before comparing these details.</div>'; return; }
  if (!(await sessionIsValid())) { requireFreshSignIn(); return; }
  document.querySelector('#manualMessage').innerHTML = '';
  showCompareStage();
  document.querySelector('#compareSteps').innerHTML = '<b>1 Upload ✓</b><b class="active">2 Comparing…</b><b>3 Golden ID</b>';
  try {
    const response = await fetch('/api/v1/applications',{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${sessionToken}`},body:JSON.stringify({consent:true,documents})});
    if (response.status === 401) { requireFreshSignIn(); return; }
    const data = await response.json();
    if (!response.ok) { const details=(data.mismatches||[]).map(m=>`<li><b>${m.field}</b>: ${m.values.map(v=>`${v.type} says “${v.value}”`).join('; ')}</li>`).join(''); result.innerHTML=`<div class="error"><b>Not eligible yet</b><p>${data.error||'Correct the differences with the issuing authority, then try again.'}</p><ul>${details}</ul></div>`; return; }
    result.innerHTML=`<div class="card"><small>GOLDEN ID • VERIFIED DEMO</small><h2>${data.name}</h2><p>${data.dob} · ${data.gender}</p><p class="gid">${data.id}</p><div class="docs">${data.documents.map(d=>`${d.type.toUpperCase()} ${d.number} ✓`).join(' &nbsp; ')}</div><p class="ok">Identity fields are consistent</p><p class="token">Holder API token: ${data.token}</p></div>`;
  } catch { result.innerHTML='<div class="error">Could not reach the local server.</div>'; }
};
