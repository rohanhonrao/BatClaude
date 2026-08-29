// docs.js — STRONGBOX (module id stays `docs`): passports, licences, IDs
// and other sensitive records. Unlike other modules it does NOT use the app's
// transparent device key: it has its own passcode/biometric lock (vaultlock.js),
// so the encryption key is never stored in usable form and the documents are
// unreadable at rest without the passcode — even to someone holding the phone.
import { db, uid } from './db.js';
import { makeVault } from './vaultlock.js';
import { toast, openSheet, closeSheet } from './ui.js';
import { escapeHtml, fmtDate } from './util.js';

const vault = makeVault('docs');
const AUTO_LOCK_MS = 90 * 1000;

const TYPES = ['Passport', 'Driver’s license', 'State ID', 'SSN card', 'Green card / Visa', 'Birth certificate', 'Insurance', 'Vehicle title', 'Bank / Card', 'Other'];
const TYPE_ICON = {
  'Passport': 'ti-plane', 'Driver’s license': 'ti-car', 'State ID': 'ti-id',
  'SSN card': 'ti-shield-lock', 'Green card / Visa': 'ti-world', 'Birth certificate': 'ti-baby-carriage',
  'Insurance': 'ti-umbrella', 'Vehicle title': 'ti-car-suv', 'Bank / Card': 'ti-credit-card', 'Other': 'ti-file',
};

let items = [];          // decrypted, in memory only while unlocked
let hubHandler = null;
let idleTimer = null;
let active = false;      // is Strongbox the current view?
let listenersReady = false;
export function setDocsHubHandler(fn) { hubHandler = fn; }

const $app = () => document.getElementById('app');
const $id = (id) => document.getElementById(id);

export async function mountDocs() {
  active = true;
  ensureListeners();
  if (!(await vault.bio.available())) return showNoBio();
  if (!(await vault.isSetUp())) return showEnable();
  if (!vault.isUnlocked()) return showLock();
  await loadItems();
  renderList();
  armIdle();
}

// --- lock lifecycle ---------------------------------------------------------
function ensureListeners() {
  if (listenersReady) return;
  listenersReady = true;
  // Backgrounding the app (or switching tabs) relocks immediately.
  document.addEventListener('visibilitychange', () => { if (document.hidden && active) lockNow(); });
  // Any interaction while unlocked resets the idle timer.
  document.addEventListener('pointerdown', () => { if (active && vault.isUnlocked()) armIdle(); }, true);
}
function armIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (active && vault.isUnlocked()) lockNow(); }, AUTO_LOCK_MS); }
function lockNow() { vault.lock(); items = []; clearTimeout(idleTimer); closeSheet(); if (active) showLock(); }
function leaveToHub() { active = false; vault.lock(); items = []; clearTimeout(idleTimer); closeSheet(); hubHandler && hubHandler(); }

// --- setup / unlock screens (biometric-only) --------------------------------
function showEnable() {
  $app().innerHTML = `<div class="view lock">
    <div class="lock-ic"><i class="ti ti-fingerprint"></i></div>
    <h1>Strongbox</h1>
    <p class="muted">Lock your IDs behind this device's Face ID / fingerprint. They're encrypted so they can only be opened here, with your biometrics.</p>
    <p class="muted tiny" style="color:var(--gold)"><i class="ti ti-alert-triangle"></i> For now there's no backup unlock — if this device's biometrics are reset, these documents can't be recovered. Recovery is coming later.</p>
    <div class="lock-form">
      <button class="btn primary" id="d-enable"><i class="ti ti-fingerprint"></i> Turn on biometric lock</button>
      <button class="btn ghost mt" data-hub>Back</button>
    </div>
  </div>`;
  $app().querySelector('[data-hub]').addEventListener('click', leaveToHub);
  $id('d-enable').addEventListener('click', async () => {
    try { await vault.setupBiometric(); toast('Biometric lock on'); await loadItems(); renderList(); armIdle(); }
    catch (e) { toast(e.message || 'Could not enable biometric lock', true); }
  });
}

function showLock() {
  $app().innerHTML = `<div class="view lock">
    <div class="lock-ic"><i class="ti ti-lock"></i></div>
    <h1>Locked</h1>
    <p class="muted">Unlock your documents with Face ID / fingerprint.</p>
    <div class="lock-form">
      <button class="btn primary" id="d-unlock"><i class="ti ti-fingerprint"></i> Unlock</button>
      <button class="btn ghost mt" data-hub>Back</button>
    </div>
  </div>`;
  $app().querySelector('[data-hub]').addEventListener('click', leaveToHub);
  $id('d-unlock').addEventListener('click', async () => {
    try { if (await vault.bio.unlock()) { await loadItems(); renderList(); armIdle(); } else toast('Unlock failed', true); }
    catch { toast('Unlock cancelled', true); }
  });
}

function showNoBio() {
  $app().innerHTML = `<div class="view lock">
    <div class="lock-ic"><i class="ti ti-mood-sad"></i></div>
    <h1>Biometrics needed</h1>
    <p class="muted">This module unlocks with your device's Face ID / fingerprint, which isn't available in this browser. Open Sanctum on your phone to set it up.</p>
    <button class="btn ghost mt" data-hub>Back to apps</button>
  </div>`;
  $app().querySelector('[data-hub]').addEventListener('click', leaveToHub);
}

// --- data -------------------------------------------------------------------
async function loadItems() {
  const rows = await db.all('docs');
  const out = [];
  for (const r of rows) {
    try { out.push({ id: r.id, updatedAt: r.updatedAt, ...(await vault.decrypt(r.blob)) }); }
    catch { /* undecryptable — skip */ }
  }
  items = out.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
}
async function saveItem(rec) {
  const { id, updatedAt, ...data } = rec;
  await db.put('docs', { id, blob: await vault.encrypt(data), updatedAt: Date.now() });
  await loadItems();
}

// --- list -------------------------------------------------------------------
function renderList() {
  $app().innerHTML = `<div class="view">
    <div class="app-header">
      <div class="title"><button class="header-btn" data-hub aria-label="All apps"><i class="ti ti-apps"></i></button>
        <h1 class="mod-title"><i class="ti ti-id" style="color:var(--gold)"></i> Strongbox</h1></div>
      <div class="header-actions">
        <button class="header-btn" data-lock aria-label="Lock now"><i class="ti ti-lock"></i></button>
        <button class="header-btn" data-add aria-label="Add document"><i class="ti ti-plus"></i></button>
      </div>
    </div>
    <div class="tiny muted spread" style="margin:2px 4px 12px">
      <span>${items.length} document${items.length === 1 ? '' : 's'} · locked with your passcode</span>
      <span><i class="ti ti-shield-lock" style="color:var(--green)"></i> AES‑256</span>
    </div>
    ${items.length ? `<div class="doc-list">${items.map(cardHTML).join('')}</div>` : emptyHTML()}
    <button class="btn primary mt2" data-add><i class="ti ti-plus"></i> Add document</button>
    <button class="btn ghost mt" data-lock><i class="ti ti-lock"></i> Lock now</button>
  </div>`;
  bindList();
}

function cardHTML(d) {
  const files = (d.files || []).length;
  return `<button class="doc-card" data-open="${d.id}">
    <span class="doc-ic"><i class="ti ${TYPE_ICON[d.type] || 'ti-file'}"></i></span>
    <span class="doc-main"><span class="doc-t">${escapeHtml(d.title || 'Untitled')}</span>
      <span class="doc-s">${escapeHtml(d.type || '')}${d.number ? ` · ${mask(d.number)}` : ''}</span></span>
    <span class="doc-meta">${files ? `<span class="tiny muted"><i class="ti ti-paperclip"></i> ${files}</span>` : ''}${expiryBadge(d.expiry)}</span>
  </button>`;
}

function bindList() {
  const r = $app();
  r.querySelector('[data-hub]').addEventListener('click', leaveToHub);
  r.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => editorSheet()));
  r.querySelectorAll('[data-lock]').forEach((b) => b.addEventListener('click', lockNow));
  r.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => detailSheet(items.find((x) => x.id === b.dataset.open))));
}

function emptyHTML() {
  return `<div class="empty"><span class="em"><i class="ti ti-id"></i></span>
    <div>No documents yet</div><div class="tiny mt">Add a passport, license, or ID — it's encrypted with your passcode.</div></div>`;
}

// --- detail -----------------------------------------------------------------
function detailSheet(d) {
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>${escapeHtml(d.title || 'Document')}</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="row" style="border:none"><div class="ic" style="background:var(--surface-2)"><i class="ti ${TYPE_ICON[d.type] || 'ti-file'}"></i></div>
      <div class="main"><div class="t">${escapeHtml(d.type || '—')}</div>${d.expiry ? `<div class="s">Expires ${escapeHtml(fmtDate(d.expiry))}</div>` : ''}</div></div>
    ${d.number ? `<div class="field mt"><label>Number</label><div class="input-row">
      <input class="input mono" id="dv-num" type="password" value="${escapeHtml(d.number)}" readonly>
      <button class="mini-btn" data-reveal aria-label="Reveal"><i class="ti ti-eye"></i></button>
      <button class="mini-btn" data-cp aria-label="Copy"><i class="ti ti-copy"></i></button></div></div>` : ''}
    ${d.notes ? `<div class="field"><label>Notes</label><div class="doc-notes">${escapeHtml(d.notes)}</div></div>` : ''}
    ${(d.files && d.files.length) ? `<div class="field"><label>Attachments</label><div class="doc-files">${d.files.map(fileHTML).join('')}</div></div>` : ''}
    <button class="btn mt" data-edit><i class="ti ti-edit"></i> Edit</button>
    <button class="btn danger mt" data-del><i class="ti ti-trash"></i> Delete</button>
  `);
  sheet.querySelector('[data-reveal]')?.addEventListener('click', () => {
    const el = sheet.querySelector('#dv-num'); el.type = el.type === 'text' ? 'password' : 'text';
  });
  sheet.querySelector('[data-cp]')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(d.number); toast('Copied'); } catch { toast('Copy failed', true); }
  });
  sheet.querySelectorAll('[data-viewimg]').forEach((b) => b.addEventListener('click', () => imageSheet(d.files[+b.dataset.viewimg])));
  sheet.querySelectorAll('[data-dl]').forEach((b) => b.addEventListener('click', () => downloadFile(d.files[+b.dataset.dl])));
  sheet.querySelector('[data-edit]').addEventListener('click', () => editorSheet(d));
  sheet.querySelector('[data-del]').addEventListener('click', () => confirmDelete(d));
}

function fileHTML(f, i) {
  if ((f.mime || '').startsWith('image/')) return `<button class="doc-thumb" data-viewimg="${i}"><img src="data:${f.mime};base64,${f.data}" alt="${escapeHtml(f.name || '')}"></button>`;
  return `<button class="doc-file" data-dl="${i}"><i class="ti ti-file"></i> ${escapeHtml(f.name || 'file')}</button>`;
}
function imageSheet(f) {
  const s = openSheet(`<div class="sheet-title-row"><h2>${escapeHtml(f.name || 'Image')}</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <img class="doc-full" src="data:${f.mime};base64,${f.data}" alt="${escapeHtml(f.name || '')}">
    <button class="btn mt" id="im-dl"><i class="ti ti-download"></i> Download</button>`);
  s.querySelector('#im-dl').addEventListener('click', () => downloadFile(f));
}
function downloadFile(f) {
  const a = document.createElement('a');
  a.href = `data:${f.mime};base64,${f.data}`;
  a.download = f.name || 'document';
  a.click();
}

// --- editor -----------------------------------------------------------------
function editorSheet(existing) {
  const d = existing || { id: uid('doc_'), title: '', type: 'Passport', number: '', expiry: '', notes: '', files: [] };
  const files = (d.files || []).map((f) => ({ ...f }));
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>${existing ? 'Edit document' : 'Add document'}</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="field"><label>Title</label><input class="input" id="e-title" value="${escapeHtml(d.title)}" placeholder="e.g. Rohan — Passport"></div>
    <div class="field"><label>Type</label><select class="input" id="e-type">${TYPES.map((t) => `<option ${t === d.type ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    <div class="field"><label>Number</label><input class="input mono" id="e-num" type="text" value="${escapeHtml(d.number)}" placeholder="Document number"></div>
    <div class="field"><label>Expiry <span class="muted tiny">(optional)</span></label><input class="input" id="e-exp" type="date" value="${d.expiry || ''}"></div>
    <div class="field"><label>Photos / scans</label>
      <div id="e-files" class="doc-files"></div>
      <label class="btn ghost mt" style="cursor:pointer"><i class="ti ti-camera"></i> Add photo or file
        <input type="file" id="e-fileinput" accept="image/*,application/pdf" multiple hidden></label></div>
    <div class="field"><label>Notes</label><textarea class="input" id="e-notes" placeholder="Optional">${escapeHtml(d.notes)}</textarea></div>
    <button class="btn primary" id="e-save"><i class="ti ti-device-floppy"></i> ${existing ? 'Save' : 'Add'}</button>
  `);
  const renderFiles = () => {
    const box = sheet.querySelector('#e-files');
    box.innerHTML = files.length ? files.map((f, i) => `<div class="doc-fileedit">
      ${(f.mime || '').startsWith('image/') ? `<img src="data:${f.mime};base64,${f.data}" alt="">` : `<span class="doc-file"><i class="ti ti-file"></i> ${escapeHtml(f.name || 'file')}</span>`}
      <button class="mini-btn ghost" data-rmf="${i}" aria-label="Remove"><i class="ti ti-x"></i></button></div>`).join('')
      : `<div class="tiny muted">No files yet.</div>`;
    box.querySelectorAll('[data-rmf]').forEach((b) => b.addEventListener('click', () => { files.splice(+b.dataset.rmf, 1); renderFiles(); }));
  };
  renderFiles();
  sheet.querySelector('#e-fileinput').addEventListener('change', async (e) => {
    for (const file of e.target.files) {
      if (file.size > 8 * 1024 * 1024) { toast(`${file.name} is too large (max 8 MB)`, true); continue; }
      try { files.push({ name: file.name, mime: file.type || 'application/octet-stream', data: await fileToB64(file) }); }
      catch { toast('Could not read that file', true); }
    }
    renderFiles();
    e.target.value = '';
  });
  sheet.querySelector('#e-save').addEventListener('click', async () => {
    const rec = {
      id: d.id, title: $id('e-title').value.trim(), type: $id('e-type').value,
      number: $id('e-num').value.trim(), expiry: $id('e-exp').value || '',
      notes: $id('e-notes').value, files,
    };
    if (!rec.title) return toast('Enter a title', true);
    await saveItem(rec); closeSheet(); renderList(); toast(existing ? 'Saved' : 'Added');
  });
}

function confirmDelete(d) {
  const s = openSheet(`<div class="center"><div style="font-size:30px"><i class="ti ti-trash"></i></div>
    <h2 style="margin:10px 0 6px">Delete “${escapeHtml(d.title)}”?</h2><p class="muted tiny">This permanently removes the document and its files.</p></div>
    <button class="btn danger" id="dd-yes">Delete</button><button class="btn ghost mt" data-close>Cancel</button>`);
  s.querySelector('#dd-yes').addEventListener('click', async () => {
    await db.del('docs', d.id); await loadItems(); closeSheet(); renderList(); toast('Deleted');
  });
}

// --- helpers ----------------------------------------------------------------
function fileToB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}
function mask(n) { const s = String(n || ''); return s.length <= 4 ? s.replace(/./g, '•') : '•••• ' + s.slice(-4); }
function expiryBadge(iso) {
  if (!iso) return '';
  const days = Math.round((new Date(iso + 'T00:00:00') - new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00')) / 86400000);
  if (days < 0) return `<span class="doc-exp red">Expired</span>`;
  if (days <= 60) return `<span class="doc-exp gold">Expires ${days}d</span>`;
  return '';
}
