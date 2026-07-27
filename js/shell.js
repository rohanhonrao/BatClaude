// shell.js — app entry. Owns the lock screen, the module hub, auto-lock, and
// mounting each module. Everything sits behind the encrypted lock.
import { loadSettings, getSetting } from './util.js';
import {
  isInitialized, isUnlocked, autoUnlock, setupMaster, unlockMaster, lock, changeMaster,
  setupRecovery, recoverWithShares, recoveryEnabled,
  biometricAvailable, biometricEnabled, enableBiometric, disableBiometric, unlockBiometric,
} from './crypto.js';
import { toast, openSheet, closeSheet } from './ui.js';
import { mountFinance, setHubHandler } from './app.js';
import { mountPasswords, setPwHubHandler } from './passwords.js';
import { mountMove, setMoveHubHandler } from './move.js';
import { mountDocs, setDocsHubHandler } from './docs.js';
import { mountGrocery, setGroceryHubHandler } from './grocery.js';

const $app = () => document.getElementById('app');
const chrome = () => document.getElementById('chrome');
let lockTimer = null;
const AUTO_LOCK_MS = 5 * 60 * 1000;

const BAT_D = 'M100,20 C104,14 110,16 114,24 C118,30 120,30 126,26 C150,16 178,14 196,22 C184,34 172,40 160,40 C154,40 150,36 146,34 C140,44 128,54 118,54 C112,54 108,50 106,46 C104,52 102,58 100,64 C98,58 96,52 94,46 C92,50 88,54 82,54 C72,54 60,44 54,34 C50,36 46,40 40,40 C28,40 16,34 4,22 C22,14 50,16 74,26 C80,30 82,30 86,24 C90,16 96,14 100,20 Z';
function BAT(size = 46) {
  const w = Math.round(size * 200 / 62);
  return `<svg width="${w}" height="${size}" viewBox="0 8 200 62" fill="var(--gold)" aria-hidden="true"><path d="${BAT_D}"/></svg>`;
}

// --- Modules registry -------------------------------------------------------
const MODULES = [
  { id: 'finance', name: 'Finance', icon: 'ti-wallet', desc: 'Net worth, budgets, converter', ready: true },
  { id: 'passwords', name: 'Passwords', icon: 'ti-lock', desc: 'Encrypted vault', ready: true },
  { id: 'docs', name: 'Documents', icon: 'ti-id', desc: 'IDs & records · passcode‑locked', ready: true },
  { id: 'move', name: 'Move HQ', icon: 'ti-map-pin', desc: 'Moving checklist · LA → NJ', ready: true },
  { id: 'grocery', name: 'Grocery', icon: 'ti-shopping-cart', desc: 'Shared shopping list', ready: true },
  { id: 'movies', name: 'Movies', icon: 'ti-movie', desc: 'Ratings, watchlist, radar', ready: false },
  { id: 'sports', name: 'Sports', icon: 'ti-ball-basketball', desc: 'Teams, fixtures, analysis', ready: false },
  { id: 'stocks', name: 'Stocks', icon: 'ti-chart-candle', desc: 'Daily buy/sell signals', ready: false },
];

// --- Lock / setup screens ---------------------------------------------------
function showSetup() {
  hideChrome();
  $app().innerHTML = `<div class="view lock">
    ${BAT(52)}
    <h1 class="brand">BATVAULT</h1>
    <p class="muted">Create a master password. It encrypts everything and is never stored. Next, you'll get a recovery kit in case you forget it.</p>
    <div class="lock-form">
      <div class="field"><label>Master password</label><input class="input" type="password" id="s-pw" placeholder="At least 8 characters"></div>
      <div class="field"><label>Confirm</label><input class="input" type="password" id="s-pw2" placeholder="Repeat"></div>
      <button class="btn primary" id="s-go"><i class="ti ti-shield-lock"></i> Create secure vault</button>
    </div>
  </div>`;
  const go = async () => {
    const pw = document.getElementById('s-pw').value;
    const pw2 = document.getElementById('s-pw2').value;
    if (pw.length < 8) return toast('Use at least 8 characters', true);
    if (pw !== pw2) return toast('Passwords do not match', true);
    await setupMaster(pw);
    toast('Vault created');
    showRecoveryKit(async () => { await maybeOfferBiometric(); showHub(); });
  };
  document.getElementById('s-go').addEventListener('click', go);
  document.getElementById('s-pw2').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

function showLock() {
  hideChrome();
  $app().innerHTML = `<div class="view lock">
    ${BAT(52)}
    <h1 class="brand">BATVAULT</h1>
    <p class="muted">Locked. Enter your master password to continue.</p>
    <div class="lock-form">
      <div class="field"><input class="input" type="password" id="l-pw" placeholder="Master password" autofocus></div>
      <button class="btn primary" id="l-go"><i class="ti ti-lock-open"></i> Unlock</button>
      <button class="btn ghost mt" id="l-bio" style="display:none"><i class="ti ti-fingerprint"></i> Unlock with biometrics</button>
      <button class="btn ghost mt" id="l-forgot" style="display:none">Forgot master password?</button>
    </div>
  </div>`;
  const tryUnlock = async () => {
    const pw = document.getElementById('l-pw').value;
    if (!pw) return;
    if (await unlockMaster(pw)) { armAutoLock(); showHub(); }
    else toast('Incorrect password', true);
  };
  document.getElementById('l-go').addEventListener('click', tryUnlock);
  document.getElementById('l-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });

  (async () => {
    if (await biometricEnabled() && await biometricAvailable()) {
      const b = document.getElementById('l-bio');
      b.style.display = '';
      b.addEventListener('click', async () => {
        try {
          if (await unlockBiometric()) { armAutoLock(); showHub(); }
          else toast('Biometric unlock failed', true);
        } catch { toast('Biometric unlock cancelled', true); }
      });
    }
    if (await recoveryEnabled()) {
      const f = document.getElementById('l-forgot');
      f.style.display = '';
      f.addEventListener('click', showRecovery);
    }
  })();
}

// --- Recovery kit + recovery flow ------------------------------------------
async function showRecoveryKit(onDone) {
  hideChrome();
  let shares;
  try { shares = await setupRecovery(); }
  catch { return onDone(); }
  $app().innerHTML = `<div class="view">
    <div class="app-header"><div class="title">${BAT(20)}<h1>Recovery kit</h1></div></div>
    <div class="card"><p class="tiny muted">If you ever forget your master password, you can recover with <b>any 2 of these 3 shares</b>. Save each in a <b>different</b> place (cloud drive, printout, another device). One share alone reveals nothing.</p></div>
    ${shares.map((s, i) => `<div class="card mt">
      <div class="spread"><b>Share ${i + 1}</b><button class="mini-btn" data-copy-share="${i}" aria-label="Copy"><i class="ti ti-copy"></i></button></div>
      <div class="mono share-text mt">${s}</div></div>`).join('')}
    <button class="btn mt2" id="rk-download"><i class="ti ti-download"></i> Download all three as a file</button>
    <label class="check-row mt"><input type="checkbox" id="rk-ok"> I've saved my recovery shares in separate places</label>
    <button class="btn primary mt" id="rk-continue" disabled>Continue</button>
  </div>`;
  $app().querySelectorAll('[data-copy-share]').forEach((b) => b.addEventListener('click', async () => {
    const i = +b.dataset.copyShare;
    try { await navigator.clipboard.writeText(shares[i]); toast(`Share ${i + 1} copied`); } catch { toast('Copy failed', true); }
  }));
  document.getElementById('rk-download').addEventListener('click', () => downloadText('batvault-recovery-kit.txt', recoveryFileText(shares)));
  const ok = document.getElementById('rk-ok');
  const cont = document.getElementById('rk-continue');
  ok.addEventListener('change', () => { cont.disabled = !ok.checked; });
  cont.addEventListener('click', () => onDone());
}

function showRecovery() {
  hideChrome();
  $app().innerHTML = `<div class="view lock">
    ${BAT(46)}
    <h1>Recover vault</h1>
    <p class="muted">Enter any <b>2 of your 3</b> recovery shares, then set a new master password.</p>
    <div class="lock-form">
      <div class="field"><label>Share A</label><textarea class="input mono" id="rc-a" rows="2" placeholder="1:XXXX-XXXX-…"></textarea></div>
      <div class="field"><label>Share B</label><textarea class="input mono" id="rc-b" rows="2" placeholder="2:XXXX-XXXX-…"></textarea></div>
      <button class="btn primary" id="rc-go"><i class="ti ti-key"></i> Recover</button>
      <button class="btn ghost mt" id="rc-back">Back to lock</button>
    </div>
  </div>`;
  document.getElementById('rc-back').addEventListener('click', showLock);
  document.getElementById('rc-go').addEventListener('click', async () => {
    const a = document.getElementById('rc-a').value.trim();
    const b = document.getElementById('rc-b').value.trim();
    if (!a || !b) return toast('Enter two shares', true);
    let ok = false;
    try { ok = await recoverWithShares([a, b]); } catch { ok = false; }
    if (!ok) return toast('Could not recover with those shares', true);
    showResetPassword();
  });
}

function showResetPassword() {
  $app().innerHTML = `<div class="view lock">
    ${BAT(46)}
    <h1>Set a new password</h1>
    <p class="muted">Your vault is unlocked. Choose a new master password.</p>
    <div class="lock-form">
      <div class="field"><input class="input" type="password" id="rp-pw" placeholder="New master password (8+ chars)"></div>
      <div class="field"><input class="input" type="password" id="rp-pw2" placeholder="Confirm"></div>
      <button class="btn primary" id="rp-go">Save &amp; enter</button>
    </div>
  </div>`;
  document.getElementById('rp-go').addEventListener('click', async () => {
    const pw = document.getElementById('rp-pw').value, pw2 = document.getElementById('rp-pw2').value;
    if (pw.length < 8) return toast('Use at least 8 characters', true);
    if (pw !== pw2) return toast('Passwords do not match', true);
    await changeMaster(pw);
    armAutoLock(); toast('Password updated'); showHub();
  });
}

function downloadText(name, text) {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function recoveryFileText(shares) {
  return `BATVAULT RECOVERY KIT
=====================
Keep these safe. Anyone with ANY TWO of the three shares below can unlock your
vault, so store the three pieces in THREE DIFFERENT places. One share alone is
useless. There is no other way to recover a forgotten master password.

Share 1:
${shares[0]}

Share 2:
${shares[1]}

Share 3:
${shares[2]}

To recover: open BatVault, tap "Forgot master password?", enter any two shares,
then choose a new master password.
`;
}

// --- Hub --------------------------------------------------------------------
function showHub() {
  hideChrome();
  setHubHandler(showHub);
  setPwHubHandler(showHub);
  setMoveHubHandler(showHub);
  setDocsHubHandler(showHub);
  setGroceryHubHandler(showHub);
  const name = getSetting('name') || 'Wayne';
  $app().innerHTML = `<div class="view">
    <div class="app-header">
      <div class="title">${BAT(24)}<h1 class="brand">BATVAULT</h1></div>
    </div>
    <div class="hub-greet">Good to see you, <b>${escapeHtml(name)}</b>.</div>
    <div class="hub-grid">
      ${MODULES.map((m) => `<button class="hub-card ${m.ready ? '' : 'soon'}" data-mod="${m.id}">
        <span class="hub-ic"><i class="ti ${m.icon}"></i></span>
        <span class="hub-name">${m.name}</span>
        <span class="hub-desc">${m.desc}</span>
        ${m.ready ? '' : '<span class="hub-badge">Soon</span>'}
      </button>`).join('')}
    </div>
    <div class="center muted tiny mt2"><i class="ti ti-shield-check" style="color:var(--green)"></i> Encrypted on this device · master‑password lock coming soon</div>
  </div>`;

  $app().querySelectorAll('[data-mod]').forEach((b) => b.addEventListener('click', () => openModule(b.dataset.mod)));
}

function openModule(id) {
  const m = MODULES.find((x) => x.id === id);
  if (!m.ready) return toast(`${m.name} — coming soon`);
  if (id === 'finance') mountFinance();
  else if (id === 'passwords') mountPasswords();
  else if (id === 'move') mountMove();
  else if (id === 'docs') mountDocs();
  else if (id === 'grocery') mountGrocery();
}

// --- Security sheet ---------------------------------------------------------
async function securitySheet() {
  const bioAvail = await biometricAvailable();
  const bioOn = await biometricEnabled();
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Security</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="row" style="border:none">
      <div class="ic" style="background:var(--surface-2)"><i class="ti ti-fingerprint"></i></div>
      <div class="main"><div class="t">Biometric unlock</div><div class="s">${bioAvail ? 'Fingerprint / face on this device' : 'Not available on this device/browser'}</div></div>
      <label class="switch"><input type="checkbox" id="sec-bio" ${bioOn ? 'checked' : ''} ${bioAvail ? '' : 'disabled'}><span></span></label>
    </div>
    <button class="btn mt" id="sec-change"><i class="ti ti-key"></i> Change master password</button>
    <button class="btn danger mt" id="sec-lock"><i class="ti ti-lock"></i> Lock now</button>
    <div class="hint center mt2">Vault items use AES‑256‑GCM. Your master password is never stored.</div>
  `);
  sheet.querySelector('#sec-bio').addEventListener('change', async (e) => {
    if (e.target.checked) {
      try { await enableBiometric(); toast('Biometric unlock enabled'); }
      catch (err) { e.target.checked = false; toast(err.message || 'Could not enable biometrics', true); }
    } else { await disableBiometric(); toast('Biometric unlock disabled'); }
  });
  sheet.querySelector('#sec-lock').addEventListener('click', () => { closeSheet(); doLock(); });
  sheet.querySelector('#sec-change').addEventListener('click', changeMasterSheet);
}

function changeMasterSheet() {
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Change master password</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="field"><label>New master password</label><input class="input" type="password" id="cm-pw" placeholder="At least 8 characters"></div>
    <div class="field"><label>Confirm</label><input class="input" type="password" id="cm-pw2"></div>
    <button class="btn primary" id="cm-go">Update password</button>
    <div class="hint mt">Your recovery kit and biometric unlock keep working — the vault key doesn't change.</div>
  `);
  sheet.querySelector('#cm-go').addEventListener('click', async () => {
    const pw = document.getElementById('cm-pw').value;
    const pw2 = document.getElementById('cm-pw2').value;
    if (pw.length < 8) return toast('Use at least 8 characters', true);
    if (pw !== pw2) return toast('Passwords do not match', true);
    await changeMaster(pw);
    closeSheet();
    toast('Master password updated');
  });
}

// --- Lock lifecycle ---------------------------------------------------------
function doLock() { lock(); clearTimeout(lockTimer); hideChrome(); showLock(); }
function armAutoLock() {
  clearTimeout(lockTimer);
  lockTimer = setTimeout(() => { if (isUnlocked()) doLock(); }, AUTO_LOCK_MS);
}
function resetIdle() { if (isUnlocked()) armAutoLock(); }

function hideChrome() { const c = chrome(); if (c) c.style.display = 'none'; }

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function maybeOfferBiometric() {
  if (!(await biometricAvailable())) return;
  return new Promise((resolve) => {
    const sheet = openSheet(`
      <div class="center"><div style="font-size:34px;color:var(--gold)"><i class="ti ti-fingerprint"></i></div>
      <h2 style="margin:10px 0 6px">Enable biometric unlock?</h2>
      <p class="muted tiny">Use your fingerprint or face to unlock instead of typing the master password each time.</p></div>
      <button class="btn primary" id="bio-yes">Enable</button>
      <button class="btn ghost mt" id="bio-no">Not now</button>`);
    sheet.querySelector('#bio-yes').addEventListener('click', async () => {
      try { await enableBiometric(); toast('Biometric unlock enabled'); }
      catch (err) { toast(err.message || 'Could not enable', true); }
      closeSheet(); resolve();
    });
    sheet.querySelector('#bio-no').addEventListener('click', () => { closeSheet(); resolve(); });
  });
}

// --- Boot -------------------------------------------------------------------
async function boot() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  await loadSettings();
  // Security layer (master password / lock / biometric) is deferred; open the
  // hub directly with a transparent device key so modules work in the meantime.
  await autoUnlock();
  showHub();
}
boot();
