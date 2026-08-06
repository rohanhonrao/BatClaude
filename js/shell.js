// shell.js — app entry. Owns the lock screen, the module hub, auto-lock, and
// mounting each module. Everything sits behind the encrypted lock.
import { loadSettings, getSetting } from './util.js';
import {
  isInitialized, isUnlocked, autoUnlock, setupMaster, unlockMaster, lock, changeMaster,
  setupRecovery, recoverWithShares, recoveryEnabled,
  biometricAvailable, biometricEnabled, enableBiometric, disableBiometric, unlockBiometric,
} from './crypto.js';
import { toast, openSheet, closeSheet, pushNav, isSheetOpen } from './ui.js';
import * as AppLock from './applock.js';
import { mountFinance, setHubHandler, financeBack } from './app.js';
import { mountPasswords, setPwHubHandler } from './passwords.js';
import { mountMove, setMoveHubHandler } from './move.js';
import { mountDocs, setDocsHubHandler } from './docs.js';
import { mountGrocery, setGroceryHubHandler } from './grocery.js';
import { mountConcerts, setConcertsHubHandler } from './concerts.js';

const $app = () => document.getElementById('app');
const chrome = () => document.getElementById('chrome');
let lockTimer = null;
const AUTO_LOCK_MS = 5 * 60 * 1000;
export const APP_VERSION = '24';

// Wide, sharp bat emblem (viewBox 0 0 300 86), symmetric about x=150.
// Sanctum mark — a minimal pointed arch (a doorway to a private room),
// drawn as a single stroke so it stays crisp from favicon to splash.
const ARCH_D = 'M6,43 L6,24 C6,13 12.5,6.5 20,2.5 C27.5,6.5 34,13 34,24 L34,43';
function BAT(size = 46) {
  const w = Math.round(size * 40 / 46);
  return `<svg width="${w}" height="${size}" viewBox="0 0 40 46" fill="none" stroke="var(--accent)"
    stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ARCH_D}"/></svg>`;
}

// --- Modules registry -------------------------------------------------------
const MODULES = [
  { id: 'finance', name: 'Finance', icon: 'ti-wallet', desc: 'Net worth, budgets, converter', ready: true },
  { id: 'passwords', name: 'Passwords', icon: 'ti-lock', desc: 'Encrypted vault', ready: true },
  { id: 'docs', name: 'Documents', icon: 'ti-id', desc: 'IDs & records · biometric‑locked', ready: true },
  { id: 'grocery', name: 'Grocery', icon: 'ti-shopping-cart', desc: 'Shared shopping list', ready: true },
  { id: 'move', name: 'Move HQ', icon: 'ti-map-pin', desc: 'Moving checklist · LA → NJ', ready: true },
  { id: 'concerts', name: 'Concerts', icon: 'ti-music', desc: 'Gigs near you · your artists', ready: true },
  { id: 'movies', name: 'Movies', icon: 'ti-movie', desc: 'Ratings, watchlist, radar', ready: false },
  { id: 'sports', name: 'Sports', icon: 'ti-ball-basketball', desc: 'Teams, fixtures, analysis', ready: false },
  { id: 'stocks', name: 'Stocks', icon: 'ti-chart-candle', desc: 'Daily buy/sell signals', ready: false },
];

// --- Lock / setup screens ---------------------------------------------------
function showSetup() {
  hideChrome();
  $app().innerHTML = `<div class="view lock">
    ${BAT(52)}
    <h1 class="brand">SANCTUM</h1>
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
    <h1 class="brand">SANCTUM</h1>
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
  document.getElementById('rk-download').addEventListener('click', () => downloadText('sanctum-recovery-kit.txt', recoveryFileText(shares)));
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
  return `SANCTUM RECOVERY KIT
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

To recover: open Sanctum, tap "Forgot master password?", enter any two shares,
then choose a new master password.
`;
}

// --- Hub --------------------------------------------------------------------
function goHub() { currentModule = null; showHub(); }

function showHub() {
  hideChrome();
  currentModule = null;
  setHubHandler(goHub);
  setPwHubHandler(goHub);
  setMoveHubHandler(goHub);
  setDocsHubHandler(goHub);
  setGroceryHubHandler(goHub);
  setConcertsHubHandler(goHub);
  const name = getSetting('name') || 'Wayne';
  $app().innerHTML = `<div class="view">
    <div class="app-header">
      <div class="title">${BAT(24)}<h1 class="brand">SANCTUM</h1></div>
      <button class="header-btn" id="h-settings" aria-label="Settings"><i class="ti ti-settings"></i></button>
    </div>
    <div class="hub-greet">Good to see you, <b>${escapeHtml(name)}</b>.</div>
    <div id="install-slot"></div>
    <div id="update-slot"></div>
    <div class="hub-grid">
      ${MODULES.map((m) => `<button class="hub-card ${m.ready ? '' : 'soon'}" data-mod="${m.id}">
        <span class="hub-ic"><i class="ti ${m.icon}"></i></span>
        <span class="hub-name">${m.name}</span>
        <span class="hub-desc">${m.desc}</span>
        ${m.ready ? '' : '<span class="hub-badge">Soon</span>'}
      </button>`).join('')}
    </div>
    <div class="center muted tiny mt2">
      <i class="ti ti-shield-check" style="color:var(--green)"></i> On this device only · v${APP_VERSION}
    </div>
  </div>`;

  $app().querySelectorAll('[data-mod]').forEach((b) => b.addEventListener('click', () => openModule(b.dataset.mod)));
  document.getElementById('h-settings').addEventListener('click', settingsSheet);
  renderInstallBanner();
  renderUpdateBanner();
  checkForUpdate();
}

let currentModule = null;
function openModule(id) {
  const m = MODULES.find((x) => x.id === id);
  if (!m.ready) return toast(`${m.name} — coming soon`);
  currentModule = id;
  pushNav('module');
  if (id === 'finance') mountFinance();
  else if (id === 'passwords') mountPasswords();
  else if (id === 'move') mountMove();
  else if (id === 'docs') mountDocs();
  else if (id === 'grocery') mountGrocery();
  else if (id === 'concerts') mountConcerts();
}

// --- Android back gesture ----------------------------------------------------
// One history entry per navigation step; a back press pops exactly one and we
// decide what it meant. Only a press at the hub is allowed to exit the app.
function onPopState() {
  if (isSheetOpen()) { closeSheet(true); return; }
  if (currentModule) {
    // Let the module retrace its own screens first (Finance has sub-pages).
    if (currentModule === 'finance' && financeBack()) return;
    returnToHub();
    return;
  }
  // At the hub we're at the root: let the press close the app, which is the
  // behaviour Android users expect.
}

function returnToHub() {
  currentModule = null;
  const c = chrome();
  if (c) c.style.display = 'none';
  closeSheet(true);
  showHub();
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

// --- Install -----------------------------------------------------------------
// Chrome fires beforeinstallprompt only when the app is genuinely installable.
// Capturing it lets us offer Install inside the app instead of making the user
// hunt through Chrome's menu — and its absence is itself a useful diagnostic.
let installPrompt = null;
let installOffered = false;

const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches ||
  matchMedia('(display-mode: fullscreen)').matches ||
  window.navigator.standalone === true;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  installOffered = true;
  renderInstallBanner();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  renderInstallBanner();
  toast('Sanctum installed');
});

function renderInstallBanner() {
  const slot = document.getElementById('install-slot');
  if (!slot) return;
  if (!installPrompt || isStandalone()) { slot.innerHTML = ''; return; }
  slot.innerHTML = `<div class="update-card">
    <div><i class="ti ti-device-mobile-down"></i> <b>Install Sanctum</b>
      <div class="tiny muted">Add it to your home screen — runs full-screen and offline.</div></div>
    <button class="btn primary" id="do-install" style="width:auto;padding:10px 16px">Install</button>
  </div>`;
  document.getElementById('do-install').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') { installPrompt = null; renderInstallBanner(); }
    else toast('Install dismissed');
  });
}

// --- Updates -----------------------------------------------------------------
let swReg = null;
let updateReady = false;

function renderUpdateBanner() {
  const slot = document.getElementById('update-slot');
  if (!slot) return;
  if (!updateReady) { slot.innerHTML = ''; return; }
  slot.innerHTML = `<div class="update-card">
    <div><i class="ti ti-sparkles"></i> <b>Update available</b>
      <div class="tiny muted">A newer version of Sanctum is ready.</div></div>
    <button class="btn primary" id="do-update" style="width:auto;padding:10px 16px"><i class="ti ti-refresh"></i> Refresh</button>
  </div>`;
  document.getElementById('do-update').addEventListener('click', applyUpdate);
}

async function applyUpdate() {
  try {
    const waiting = swReg && swReg.waiting;
    if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' });
    // Drop caches so the reload definitely pulls the new files.
    if (window.caches) { for (const k of await caches.keys()) await caches.delete(k); }
  } catch {}
  location.reload();
}

async function checkForUpdate({ manual = false } = {}) {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) {
    if (manual) toast('Updates only work on the installed app');
    return;
  }
  try {
    swReg = swReg || await navigator.serviceWorker.getRegistration();
    if (!swReg) { if (manual) toast('No update information yet'); return; }
    await swReg.update();
    if (swReg.waiting || swReg.installing) {
      updateReady = true; renderUpdateBanner();
      if (manual) toast('Update found');
    } else if (manual) {
      toast('You’re on the latest version');
    }
  } catch { if (manual) toast('Could not check for updates', true); }
}

function watchForUpdates(reg) {
  swReg = reg;
  if (reg.waiting) { updateReady = true; renderUpdateBanner(); }
  reg.addEventListener('updatefound', () => {
    const nw = reg.installing;
    if (!nw) return;
    nw.addEventListener('statechange', () => {
      // A new worker finishing install while one already controls the page
      // means there is genuinely a newer version waiting.
      if (nw.state === 'installed' && navigator.serviceWorker.controller) {
        updateReady = true; renderUpdateBanner();
      }
    });
  });
}

// --- Settings ----------------------------------------------------------------
async function settingsSheet() {
  const bioAvail = await AppLock.available();
  const bioOn = await AppLock.isEnabled();
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Settings</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="row" style="border:none">
      <div class="ic"><i class="ti ti-fingerprint"></i></div>
      <div class="main"><div class="t">Unlock with biometrics</div>
        <div class="s">${bioAvail ? 'Require Face/fingerprint to open Sanctum' : 'Not available on this device'}</div></div>
      <label class="switch"><input type="checkbox" id="set-bio" ${bioOn ? 'checked' : ''} ${bioAvail ? '' : 'disabled'}><span></span></label>
    </div>
    <button class="btn mt" id="set-update"><i class="ti ti-refresh"></i> Check for updates</button>
    <button class="btn mt" id="set-install"><i class="ti ti-device-mobile-down"></i> Install to home screen</button>
    <div class="hint mt" id="install-diag"></div>
    <div class="hint center mt2">Sanctum v${APP_VERSION} · everything stays on this device</div>
  `);
  const diag = sheet.querySelector('#install-diag');
  const btn = sheet.querySelector('#set-install');
  if (isStandalone()) {
    btn.style.display = 'none';
    diag.textContent = 'Already running as an installed app.';
  } else if (installPrompt) {
    diag.textContent = 'Ready to install.';
  } else {
    btn.disabled = true;
    diag.innerHTML = installOffered
      ? 'Chrome offered install earlier in this session but the prompt is spent — reload the page and try again.'
      : 'Chrome has not offered installation. That almost always means the old app is <b>still registered on the device</b>: open Android <b>Settings → Apps</b>, find <b>Sanctum</b> or <b>BatVault</b>, and uninstall it there. Removing the home-screen icon alone does not remove it.';
  }
  btn.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') { installPrompt = null; closeSheet(); }
  });
  sheet.querySelector('#set-bio').addEventListener('change', async (e) => {
    if (e.target.checked) {
      try { await AppLock.enable(); toast('Biometric unlock on'); }
      catch (err) { e.target.checked = false; toast(err.message || 'Could not enable', true); }
    } else {
      await AppLock.disable(); toast('Biometric unlock off');
    }
  });
  sheet.querySelector('#set-update').addEventListener('click', () => checkForUpdate({ manual: true }));
}

// --- App lock screen ---------------------------------------------------------
function showAppLock() {
  hideChrome();
  $app().innerHTML = `<div class="view lock">
    ${BAT(52)}
    <h1 class="brand">SANCTUM</h1>
    <p class="muted">Locked. Use your fingerprint or face to continue.</p>
    <div class="lock-form">
      <button class="btn primary" id="al-go"><i class="ti ti-fingerprint"></i> Unlock</button>
    </div>
  </div>`;
  const tryUnlock = async () => {
    try {
      if (await AppLock.verify()) { goHub(); }
      else toast('Unlock failed', true);
    } catch { toast('Unlock cancelled', true); }
  };
  document.getElementById('al-go').addEventListener('click', tryUnlock);
  tryUnlock(); // prompt immediately on open
}

// --- Boot -------------------------------------------------------------------
async function boot() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').then(watchForUpdates).catch(() => {});
  }
  await loadSettings();
  // Master-password encryption is still deferred; the device key keeps modules
  // working, and the optional biometric gate below guards the UI.
  await autoUnlock();

  history.replaceState({ sanctum: 'root' }, '');
  window.addEventListener('popstate', onPopState);

  if (await AppLock.isEnabled()) showAppLock();
  else showHub();
}
boot();
