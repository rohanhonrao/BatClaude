// hearth.js — the shared half of the house, in one place.
//
// Household (lists) and Joint (money) were separate sub-apps, but they are the
// same thing from the user's side: the stuff two people run together. They also
// already shared one encrypted sync room, so keeping them apart meant two
// pairing screens for one connection and two places to look.
//
// Hearth owns what the two have in common — the header, the tab switch, the hub
// button, and the single "Share live" sheet — and each tab keeps its own logic
// in household.js / joint.js. Sync is started **once, here, for every store**,
// so both tabs go live together.
import { db } from './db.js';
import { openSheet, closeSheet, toast } from './ui.js';
import { escapeHtml } from './util.js';
import * as Sync from './sync.js';
import { mountHousehold, setHouseholdHubHandler } from './household.js';
import { mountJoint, setJointHubHandler } from './joint.js';

export const LIST_STORES = ['grocery', 'lists'];
export const MONEY_STORES = ['jointPeople', 'jointCategories', 'jointExpenses',
  'jointSettlements', 'jointRecurring', 'jointMeta'];
export const ALL_STORES = LIST_STORES.concat(MONEY_STORES);

const TABS = [
  { id: 'lists', label: 'Lists', icon: 'ti-basket' },
  { id: 'money', label: 'Money', icon: 'ti-users' },
];

let tab = 'lists';
let hubHandler = null;
let refresh = null;   // set by whichever tab is currently mounted

export function setHearthHubHandler(fn) { hubHandler = fn; }

// A tab registers how to redraw itself, so a sync push from the other phone
// updates whichever tab happens to be open without either module needing to
// know about the other.
export function onHearthRefresh(fn) { refresh = fn; }

export async function mountHearth() {
  tab = (await db.get('settings', 'hearthTab'))?.value || 'lists';
  await Sync.loadConfig();
  await mountTab();
  if (Sync.isConfigured()) {
    Sync.start(ALL_STORES, async () => { if (refresh) await refresh(); });
    Sync.pushAll(ALL_STORES);   // reconcile anything changed while offline
  }
}

async function mountTab() {
  if (tab === 'money') { setJointHubHandler(() => hubHandler && hubHandler()); await mountJoint(); }
  else { setHouseholdHubHandler(() => hubHandler && hubHandler()); await mountHousehold(); }
}

export async function switchTab(next) {
  if (next === tab) return;
  tab = next;
  await db.put('settings', { key: 'hearthTab', value: tab });
  await mountTab();
}

// --- the shared header -------------------------------------------------------
// `actions` is the tab's own header button (manage lists / settings); it sits to
// the left of the sharing indicator, which is common to both.
export function hearthHeader(active, actions = '') {
  const live = Sync.isConfigured();
  return `
    <div class="app-header">
      <div class="title">
        <button class="header-btn" data-hub aria-label="All apps"><i class="ti ti-apps"></i></button>
        <h1 class="mod-title">Hearth</h1>
      </div>
      <div class="header-actions">
        ${actions}
        <button class="header-btn ${live ? 'live' : ''}" data-he-share
          aria-label="${live ? 'Sharing live' : 'Share live'}"><i class="ti ti-${live ? 'wifi' : 'users'}"></i></button>
      </div>
    </div>
    <div class="seg he-tabs">
      ${TABS.map((t) => `<button data-he-tab="${t.id}" class="${t.id === active ? 'active' : ''}">
        <i class="ti ${t.icon}"></i> ${t.label}</button>`).join('')}
    </div>`;
}

export function bindHearthHeader(root) {
  root.querySelector('[data-hub]')?.addEventListener('click', () => hubHandler && hubHandler());
  root.querySelector('[data-he-share]')?.addEventListener('click', shareSheet);
  root.querySelectorAll('[data-he-tab]').forEach((b) =>
    b.addEventListener('click', () => switchTab(b.dataset.heTab)));
}

// --- real-time sharing -------------------------------------------------------
// One person creates the room (needs a free Firebase Realtime Database URL);
// the other pastes the pairing code, which carries the URL, the room id and the
// passphrase. Contents are encrypted before upload — see sync.js.
//
// One sheet for the whole sub-app: pairing once covers lists and money, which
// is why this lives here rather than in either tab.
export function shareSheet() {
  const on = Sync.isConfigured();
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Share live</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    ${on ? `
      <div class="alert warn"><i class="ti ti-wifi"></i> Live. Lists and money both appear on the other phone within a second.</div>
      <div class="field mt"><label>Pairing code — send this to the other phone</label>
        <textarea class="input mono" id="he-code" rows="3" readonly>${escapeHtml(Sync.makePairingCode())}</textarea></div>
      <button class="btn primary" id="he-copy"><i class="ti ti-copy"></i> Copy pairing code</button>
      <div class="hint mt">The code is the key. Send it privately — anyone holding it can read everything in Hearth.</div>
      <button class="btn danger mt" id="he-off"><i class="ti ti-plug-off"></i> Stop sharing on this phone</button>
    ` : `
      <div class="hint">Two phones stay in sync in real time — shopping lists and shared expenses together. Everything is encrypted on this device first, so the server only ever stores unreadable data.</div>
      <div class="field mt"><label>Paste a pairing code</label>
        <textarea class="input mono" id="he-in" rows="3" placeholder="Paste the code from the other phone"></textarea></div>
      <button class="btn primary" id="he-join"><i class="ti ti-link"></i> Join</button>
      <div class="section-title">Or start the connection here</div>
      <div class="field"><label>Firebase Realtime Database URL</label>
        <input class="input" id="he-url" placeholder="https://your-app-default-rtdb.firebaseio.com"></div>
      <button class="btn" id="he-create"><i class="ti ti-plus"></i> Create shared connection</button>
      <div class="hint mt">One free Firebase project covers all of Hearth. Steps are in SETUP-SYNC.md.</div>
    `}
  `);

  const goLive = async () => {
    Sync.start(ALL_STORES, async () => { if (refresh) await refresh(); });
    await Sync.pushAll(ALL_STORES);
  };

  sheet.querySelector('#he-copy')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(Sync.makePairingCode()); toast('Pairing code copied'); }
    catch { toast('Copy failed', true); }
  });
  sheet.querySelector('#he-off')?.addEventListener('click', async () => {
    await Sync.clearConfig(); Sync.stop(); closeSheet(); await mountTab(); toast('Sharing stopped');
  });
  sheet.querySelector('#he-join')?.addEventListener('click', async () => {
    try {
      await Sync.saveConfig(Sync.parsePairingCode(sheet.querySelector('#he-in').value));
      await goLive();
      closeSheet(); await mountTab(); toast('Connected');
    } catch { toast('That code doesn’t look right', true); }
  });
  sheet.querySelector('#he-create')?.addEventListener('click', async () => {
    const dbUrl = sheet.querySelector('#he-url').value.trim();
    if (!/^https:\/\/.+firebase/.test(dbUrl)) return toast('Paste your Realtime Database URL', true);
    await Sync.saveConfig(Sync.newRoom(dbUrl));
    await goLive();
    // Replace the sheet in place so the pairing code is right there: closing
    // first lets the pending popstate shut the replacement (see ARCHITECTURE §11).
    await mountTab(); shareSheet();
    toast('Connection created');
  });
}
