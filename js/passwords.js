// passwords.js — encrypted password vault module.
// Entries are decrypted into memory only while the vault is unlocked; on disk
// each entry is an AES-GCM blob (see crypto.js).
import { db, uid } from './db.js';
import { encryptJSON, decryptJSON, getKey } from './crypto.js';
import { toast, openSheet, closeSheet } from './ui.js';
import { escapeHtml } from './util.js';

const CATEGORIES = ['Login', 'Card', 'Bank', 'Email', 'Social', 'Work', 'Wi‑Fi', 'Secure note', 'Other'];
const CAT_ICON = { Login: 'ti-key', Card: 'ti-credit-card', Bank: 'ti-building-bank', Email: 'ti-mail', Social: 'ti-share', Work: 'ti-briefcase', 'Wi‑Fi': 'ti-wifi', 'Secure note': 'ti-note', Other: 'ti-lock' };

let entries = [];
let search = '';
let hubHandler = null;
let clipTimer = null;
export function setPwHubHandler(fn) { hubHandler = fn; }

const $app = () => document.getElementById('app');

export async function mountPasswords() {
  await loadEntries();
  search = '';
  render();
}

async function loadEntries() {
  const rows = await db.all('vault');
  const key = getKey();
  const out = [];
  for (const r of rows) {
    try { out.push({ id: r.id, updatedAt: r.updatedAt, ...(await decryptJSON(r.blob, key)) }); }
    catch { /* skip undecryptable */ }
  }
  entries = out.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
}

async function saveEntry(e) {
  const blob = await encryptJSON({
    title: e.title, username: e.username, password: e.password,
    url: e.url, notes: e.notes, category: e.category,
  }, getKey());
  await db.put('vault', { id: e.id, blob, updatedAt: Date.now() });
  await loadEntries();
}

// --- rendering --------------------------------------------------------------
function render() {
  let list = entries;
  if (search) {
    const q = search.toLowerCase();
    list = entries.filter((e) => [e.title, e.username, e.url, e.category].some((v) => (v || '').toLowerCase().includes(q)));
  }
  $app().innerHTML = `<div class="view">
    <div class="app-header">
      <div class="title">
        <button class="header-btn" data-hub aria-label="All apps"><i class="ti ti-apps"></i></button>
        <h1 class="mod-title"><i class="ti ti-lock" style="color:var(--gold)"></i> Passwords</h1>
      </div>
      <button class="header-btn" data-add aria-label="Add"><i class="ti ti-plus"></i></button>
    </div>
    <div class="field"><input class="input" id="pw-search" placeholder="Search vault…" value="${escapeHtml(search)}"></div>
    <div class="tiny muted spread" style="margin:2px 4px 10px">
      <span>${entries.length} item${entries.length === 1 ? '' : 's'} · encrypted on device</span>
      <span><i class="ti ti-shield-lock" style="color:var(--green)"></i> AES‑256</span>
    </div>
    ${list.length ? `<div class="card list">${list.map(rowHTML).join('')}</div>`
      : emptyHTML()}
    <button class="btn primary mt2" data-add><i class="ti ti-plus"></i> Add password</button>
    <button class="btn ghost mt" data-gen><i class="ti ti-dice-5"></i> Password generator</button>
  </div>`;
  bind();
}

function rowHTML(e) {
  const initial = (e.title || '?').trim().charAt(0).toUpperCase();
  const hue = hueOf(e.title || e.id);
  return `<div class="row tappable" data-open="${e.id}">
    <div class="ic avatar" style="background:hsl(${hue} 55% 22%);color:hsl(${hue} 80% 72%)">${escapeHtml(initial)}</div>
    <div class="main"><div class="t">${escapeHtml(e.title || 'Untitled')}</div>
      <div class="s">${escapeHtml(e.username || e.url || e.category || '')}</div></div>
    <button class="mini-btn" data-copy="${e.id}" aria-label="Copy password"><i class="ti ti-copy"></i></button>
  </div>`;
}

function emptyHTML() {
  return `<div class="empty"><span class="em"><i class="ti ti-shield-lock"></i></span>
    <div>Your vault is empty</div><div class="tiny mt">Add your first login — it's encrypted before it's stored.</div></div>`;
}

function hueOf(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }

function bind() {
  const root = $app();
  root.querySelector('[data-hub]')?.addEventListener('click', () => hubHandler && hubHandler());
  root.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => entrySheet()));
  root.querySelector('[data-gen]')?.addEventListener('click', () => generatorSheet());
  const s = root.querySelector('#pw-search');
  if (s) s.addEventListener('input', (e) => { search = e.target.value; const sc = window.scrollY; render(); window.scrollTo(0, sc); const n = document.getElementById('pw-search'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } });
  root.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-copy]')) return;
    entrySheet(entries.find((x) => x.id === el.dataset.open));
  }));
  root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const e = entries.find((x) => x.id === b.dataset.copy);
    if (e) copyToClipboard(e.password, 'Password');
  }));
}

// --- entry editor -----------------------------------------------------------
function entrySheet(existing) {
  const e = existing || { id: uid('v_'), title: '', username: '', password: '', url: '', notes: '', category: 'Login' };
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>${existing ? 'Edit item' : 'Add item'}</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="field"><label>Title</label><input class="input" id="e-title" value="${escapeHtml(e.title)}" placeholder="e.g. Google"></div>
    <div class="field"><label>Category</label><select class="input" id="e-cat">${CATEGORIES.map((c) => `<option ${c === e.category ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
    <div class="field"><label>Username / email</label>
      <div class="input-row"><input class="input" id="e-user" value="${escapeHtml(e.username)}" placeholder="you@example.com">
      <button class="mini-btn" data-cp="e-user" aria-label="Copy"><i class="ti ti-copy"></i></button></div></div>
    <div class="field"><label>Password</label>
      <div class="input-row"><input class="input mono" id="e-pass" type="password" value="${escapeHtml(e.password)}" placeholder="••••••••">
      <button class="mini-btn" data-reveal="e-pass" aria-label="Reveal"><i class="ti ti-eye"></i></button>
      <button class="mini-btn" data-cp="e-pass" aria-label="Copy"><i class="ti ti-copy"></i></button></div>
      <div id="e-strength" class="strength mt"></div>
      <button class="btn ghost mt" id="e-gen"><i class="ti ti-dice-5"></i> Generate strong password</button>
    </div>
    <div class="field"><label>Website</label><input class="input" id="e-url" value="${escapeHtml(e.url)}" placeholder="https://"></div>
    <div class="field"><label>Notes</label><textarea class="input" id="e-notes" placeholder="Optional">${escapeHtml(e.notes)}</textarea></div>
    <button class="btn primary" id="e-save"><i class="ti ti-device-floppy"></i> ${existing ? 'Save' : 'Add'}</button>
    ${existing ? `<button class="btn danger mt" id="e-del"><i class="ti ti-trash"></i> Delete</button>` : ''}
  `);

  const passEl = sheet.querySelector('#e-pass');
  const updateStrength = () => renderStrength(sheet.querySelector('#e-strength'), passEl.value);
  passEl.addEventListener('input', updateStrength);
  updateStrength();

  sheet.querySelectorAll('[data-reveal]').forEach((b) => b.addEventListener('click', () => {
    const el = sheet.querySelector('#' + b.dataset.reveal);
    const showing = el.type === 'text';
    el.type = showing ? 'password' : 'text';
    b.innerHTML = `<i class="ti ti-eye${showing ? '' : '-off'}"></i>`;
  }));
  sheet.querySelectorAll('[data-cp]').forEach((b) => b.addEventListener('click', () => {
    const el = sheet.querySelector('#' + b.dataset.cp);
    copyToClipboard(el.value, b.dataset.cp === 'e-pass' ? 'Password' : 'Username');
  }));
  sheet.querySelector('#e-gen').addEventListener('click', () => {
    generatorSheet((pw) => { passEl.value = pw; passEl.type = 'text'; updateStrength(); });
  });

  sheet.querySelector('#e-save').addEventListener('click', async () => {
    const rec = {
      id: e.id,
      title: sheet.querySelector('#e-title').value.trim(),
      category: sheet.querySelector('#e-cat').value,
      username: sheet.querySelector('#e-user').value.trim(),
      password: sheet.querySelector('#e-pass').value,
      url: sheet.querySelector('#e-url').value.trim(),
      notes: sheet.querySelector('#e-notes').value,
    };
    if (!rec.title) return toast('Enter a title', true);
    await saveEntry(rec);
    closeSheet(); render(); toast(existing ? 'Saved' : 'Added');
  });
  const del = sheet.querySelector('#e-del');
  if (del) del.addEventListener('click', () => {
    const s2 = openSheet(`<div class="center"><div style="font-size:30px"><i class="ti ti-trash"></i></div>
      <h2 style="margin:10px 0 6px">Delete “${escapeHtml(e.title)}”?</h2><p class="muted tiny">This can't be undone.</p></div>
      <button class="btn danger" id="d-yes">Delete</button><button class="btn ghost mt" data-close>Cancel</button>`);
    s2.querySelector('#d-yes').addEventListener('click', async () => {
      await db.del('vault', e.id); await loadEntries(); closeSheet(); render(); toast('Deleted');
    });
  });
}

// --- generator --------------------------------------------------------------
function generatorSheet(onUse) {
  const opts = { length: 20, upper: true, lower: true, digits: true, symbols: true };
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Password generator</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="card gen-out"><span id="g-value" class="mono"></span>
      <button class="mini-btn" id="g-refresh" aria-label="Regenerate"><i class="ti ti-refresh"></i></button></div>
    <div id="g-strength" class="strength mt"></div>
    <div class="field mt"><label>Length: <span id="g-len">20</span></label>
      <input type="range" min="8" max="48" value="20" id="g-length" class="range"></div>
    <div class="chips" id="g-opts">
      ${[['upper', 'A‑Z'], ['lower', 'a‑z'], ['digits', '0‑9'], ['symbols', '!@#']].map(([k, l]) =>
        `<button class="chip ${opts[k] ? 'active' : ''}" data-opt="${k}">${l}</button>`).join('')}
    </div>
    <button class="btn primary mt2" id="g-use"><i class="ti ti-check"></i> ${onUse ? 'Use this password' : 'Copy'}</button>
  `);
  const valueEl = sheet.querySelector('#g-value');
  const regen = () => {
    const pw = generatePassword(opts);
    valueEl.textContent = pw;
    renderStrength(sheet.querySelector('#g-strength'), pw);
  };
  sheet.querySelector('#g-length').addEventListener('input', (e) => { opts.length = +e.target.value; sheet.querySelector('#g-len').textContent = e.target.value; regen(); });
  sheet.querySelectorAll('[data-opt]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.opt;
    if (opts[k] && Object.values({ upper: opts.upper, lower: opts.lower, digits: opts.digits, symbols: opts.symbols }).filter(Boolean).length === 1) return;
    opts[k] = !opts[k]; b.classList.toggle('active', opts[k]); regen();
  }));
  sheet.querySelector('#g-refresh').addEventListener('click', regen);
  sheet.querySelector('#g-use').addEventListener('click', () => {
    const pw = valueEl.textContent;
    if (onUse) { onUse(pw); closeSheet(); }
    else copyToClipboard(pw, 'Password');
  });
  regen();
}

const SETS = {
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  lower: 'abcdefghijkmnpqrstuvwxyz',
  digits: '23456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?',
};
function generatePassword(opts) {
  let pool = '';
  for (const k of ['upper', 'lower', 'digits', 'symbols']) if (opts[k]) pool += SETS[k];
  if (!pool) pool = SETS.lower;
  const rnd = crypto.getRandomValues(new Uint32Array(opts.length));
  let out = '';
  for (let i = 0; i < opts.length; i++) out += pool[rnd[i] % pool.length];
  return out;
}

// --- strength ---------------------------------------------------------------
function strengthScore(pw) {
  if (!pw) return { score: 0, label: 'Empty', bits: 0 };
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 30;
  const bits = Math.round(pw.length * Math.log2(pool || 1));
  let score = 0, label = 'Weak';
  if (bits >= 40) { score = 1; label = 'Fair'; }
  if (bits >= 60) { score = 2; label = 'Good'; }
  if (bits >= 80) { score = 3; label = 'Strong'; }
  if (bits >= 100) { score = 4; label = 'Excellent'; }
  return { score, label, bits };
}
function renderStrength(el, pw) {
  if (!el) return;
  const { score, label, bits } = strengthScore(pw);
  const colors = ['var(--red)', '#f97316', 'var(--gold)', '#84cc16', 'var(--green)'];
  const c = colors[score];
  el.innerHTML = `<div class="strength-bar">${[0, 1, 2, 3].map((i) => `<span style="background:${i < Math.max(score, pw ? 1 : 0) ? c : 'var(--surface-2)'}"></span>`).join('')}</div>
    <div class="tiny spread mt"><span style="color:${c}">${label}</span><span class="muted">${bits} bits</span></div>`;
}

// --- clipboard --------------------------------------------------------------
async function copyToClipboard(text, what) {
  if (!text) return toast('Nothing to copy', true);
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied — clears in 25s`);
    clearTimeout(clipTimer);
    clipTimer = setTimeout(async () => { try { await navigator.clipboard.writeText(''); } catch {} }, 25000);
  } catch { toast('Copy failed (permission?)', true); }
}
