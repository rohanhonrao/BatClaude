// household.js — everything the house needs to buy, organised by list (usually
// a store). Supersedes the old Grocery module; existing grocery items are
// migrated into a default "Groceries" list on first run, so nothing is lost.
//
// Items live in the `grocery` store (kept for continuity) and now carry a
// listId, priority, due date, note and link.
import { db, uid } from './db.js';
import { escapeHtml, todayISO, fmtDateShort, relativeDay, addDays } from './util.js';
import { toast, openSheet, closeSheet } from './ui.js';

const PRIORITY = [
  { v: 0, label: 'Normal', cls: '' },
  { v: 1, label: 'High', cls: 'p-high' },
  { v: 2, label: 'Urgent', cls: 'p-urgent' },
];
const LIST_ICONS = ['ti-shopping-cart', 'ti-building-store', 'ti-basket', 'ti-tools',
  'ti-pill', 'ti-paw', 'ti-plant-2', 'ti-bulb', 'ti-home', 'ti-gift'];

let lists = [];
let items = [];
let activeList = 'all';   // 'all' | list id
let showDone = false;
let hubHandler = null;
export function setHouseholdHubHandler(fn) { hubHandler = fn; }

const $app = () => document.getElementById('app');

// --- data -------------------------------------------------------------------
async function load() {
  lists = (await db.all('lists')).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  items = (await db.all('grocery')).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

async function migrate() {
  if (lists.length) return;
  // First run: create a default list and adopt any existing grocery items.
  const groceries = { id: uid('l_'), name: 'Groceries', icon: 'ti-shopping-cart', order: 0 };
  await db.put('lists', groceries);
  for (const it of items) {
    if (!it.listId) { it.listId = groceries.id; await db.put('grocery', it); }
  }
  await load();
}

export async function mountHousehold() {
  await load();
  await migrate();
  activeList = 'all';
  render();
}

const saveItem = async (it) => { it.updatedAt = Date.now(); await db.put('grocery', it); await load(); };
const listOf = (id) => lists.find((l) => l.id === id);
const nextOrder = () => (items.length ? Math.max(...items.map((i) => i.order ?? 0)) + 1 : 0);

// --- helpers ----------------------------------------------------------------
function dueClass(due) {
  if (!due) return '';
  if (due < todayISO()) return 'overdue';
  if (due <= addDays(todayISO(), 2)) return 'soon';
  return '';
}
function visible() {
  let list = items.filter((i) => showDone || !i.checked);
  if (activeList !== 'all') list = list.filter((i) => i.listId === activeList);
  // urgent first, then anything with a due date, then original order
  return list.sort((a, b) =>
    (b.priority || 0) - (a.priority || 0) ||
    String(a.due || '9999').localeCompare(String(b.due || '9999')) ||
    (a.order ?? 0) - (b.order ?? 0));
}

// --- render -----------------------------------------------------------------
function render() {
  const shown = visible();
  const openCount = (id) => items.filter((i) => !i.checked && (id === 'all' || i.listId === id)).length;
  const doneCount = items.filter((i) => i.checked).length;

  const groups = {};
  for (const i of shown) (groups[i.listId] ||= []).push(i);

  // Done items sink to the bottom of their group rather than holding position.
  const sink = (arr) => arr.filter((i) => !i.checked).concat(arr.filter((i) => i.checked));

  const listBlock = (l, arr) => `
    <div class="hh-group">
      <div class="hh-group-head">
        <span class="hh-group-name"><i class="ti ${escapeHtml(l.icon || 'ti-basket')}"></i> ${escapeHtml(l.name)}</span>
        <span class="hh-group-n">${arr.filter((i) => !i.checked).length} left</span>
      </div>
      <div class="card hh-card">${sink(arr).map(itemHTML).join('')}</div>
    </div>`;

  const body = shown.length
    ? (activeList === 'all'
        ? lists.filter((l) => groups[l.id]).map((l) => listBlock(l, groups[l.id])).join('')
        : `<div class="hh-group"><div class="card hh-card">${sink(shown).map(itemHTML).join('')}</div></div>`)
    : `<div class="hh-group"><div class="empty"><span class="em"><i class="ti ti-basket"></i></span>
        <div>${showDone ? 'Nothing here yet' : 'Nothing to buy'}</div>
        <div class="tiny mt">Type above to add${activeList === 'all' ? '' : ' to ' + escapeHtml(listOf(activeList)?.name || '')}.</div></div></div>`;

  const active = activeList === 'all' ? null : listOf(activeList);
  const total = activeList === 'all' ? items.length : items.filter((i) => i.listId === activeList).length;
  const open = openCount(activeList);
  const pct = total ? Math.round(((total - open) / total) * 100) : 0;

  $app().innerHTML = `<div class="view">
    <div class="app-header">
      <div class="title">
        <button class="header-btn" data-hub aria-label="All apps"><i class="ti ti-apps"></i></button>
        <h1 class="mod-title">Household</h1>
      </div>
      <button class="header-btn" data-hh-lists aria-label="Manage lists"><i class="ti ti-adjustments"></i></button>
    </div>

    <div class="hh-chips">
      <button class="chip ${activeList === 'all' ? 'active' : ''}" data-hh-list="all">All${openCount('all') ? ` · ${openCount('all')}` : ''}</button>
      ${lists.map((l) => `<button class="chip ${activeList === l.id ? 'active' : ''}" data-hh-list="${l.id}">
        <i class="ti ${escapeHtml(l.icon || 'ti-basket')}"></i>${escapeHtml(l.name)}${openCount(l.id) ? ` · ${openCount(l.id)}` : ''}</button>`).join('')}
      <button class="chip chip-add" data-hh-lists aria-label="New list"><i class="ti ti-plus"></i></button>
    </div>

    <div class="hh-bar">
      <div class="hh-bar-top">
        <span>${open ? `${open} to buy` : 'All done'}${active ? ` · ${escapeHtml(active.name)}` : ''}</span>
        ${total ? `<span class="hh-bar-pct">${pct}%</span>` : ''}
      </div>
      ${total ? `<div class="bar"><span style="width:${pct}%"></span></div>` : ''}
    </div>

    <div class="input-row hh-add-row">
      <input class="input" id="hh-add" autocomplete="off"
        placeholder="Add${active ? ' to ' + escapeHtml(active.name) : ' an item'}…">
      <button class="mini-btn primary-btn" data-hh-quickadd aria-label="Add"><i class="ti ti-plus"></i></button>
    </div>

    ${body}

    <div class="hh-foot">
      <button class="chip" data-hh-toggledone>
        <i class="ti ti-${showDone ? 'eye-off' : 'eye'}"></i> ${showDone ? 'Hide done' : `Done${doneCount ? ` · ${doneCount}` : ''}`}</button>
      ${doneCount ? `<button class="chip" data-hh-clear><i class="ti ti-trash"></i> Clear done</button>` : ''}
      <button class="chip" data-hh-share><i class="ti ti-share"></i> Share</button>
    </div>
  </div>`;
  bind();
}

function itemHTML(i) {
  const p = PRIORITY[i.priority || 0];
  const dc = dueClass(i.due);
  const meta = [
    i.qty && String(i.qty) !== '1' ? `×${escapeHtml(String(i.qty))}` : '',
    activeList !== 'all' ? '' : '',
    i.due ? `<span class="hh-due ${dc}">${escapeHtml(relativeDay(i.due))}</span>` : '',
    i.note ? '<i class="ti ti-note"></i>' : '',
    i.url ? '<i class="ti ti-link"></i>' : '',
  ].filter(Boolean).join(' · ');
  return `<div class="row hh-row ${i.checked ? 'done' : ''} ${p.cls}">
    <button class="hh-check" data-hh-toggle="${i.id}" aria-label="Toggle">
      <i class="ti ti-${i.checked ? 'circle-check-filled' : 'circle'}"></i></button>
    <div class="main tappable" data-hh-edit="${i.id}">
      <div class="t">${escapeHtml(i.name)}</div>
      ${meta ? `<div class="s">${meta}</div>` : ''}
    </div>
    ${i.priority ? `<span class="hh-flag">${p.label}</span>` : ''}
  </div>`;
}

// --- interactions -----------------------------------------------------------
function bind() {
  const root = $app();
  root.querySelector('[data-hub]').addEventListener('click', () => hubHandler && hubHandler());
  root.querySelectorAll('[data-hh-lists]').forEach((b) => b.addEventListener('click', listsSheet));
  root.querySelector('[data-hh-share]').addEventListener('click', shareSheet);

  const input = root.querySelector('#hh-add');
  const add = async () => {
    const name = input.value.trim();
    if (!name) return;
    input.value = '';
    await quickAdd(name);
  };
  root.querySelector('[data-hh-quickadd]').addEventListener('click', add);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

  root.querySelectorAll('[data-hh-list]').forEach((b) => b.addEventListener('click', () => {
    activeList = b.dataset.hhList; render();
  }));
  root.querySelectorAll('[data-hh-toggle]').forEach((b) => b.addEventListener('click', async () => {
    const it = items.find((x) => x.id === b.dataset.hhToggle);
    if (!it) return;
    it.checked = !it.checked;
    await saveItem(it); render();
  }));
  root.querySelectorAll('[data-hh-edit]').forEach((el) => el.addEventListener('click', () => {
    itemSheet(items.find((x) => x.id === el.dataset.hhEdit));
  }));
  root.querySelector('[data-hh-toggledone]').addEventListener('click', () => { showDone = !showDone; render(); });
  root.querySelector('[data-hh-clear]')?.addEventListener('click', async () => {
    for (const it of items.filter((i) => i.checked)) await db.del('grocery', it.id);
    await load(); render(); toast('Cleared');
  });
}

async function quickAdd(name) {
  if (!lists.length) await migrate();
  // Adding while a list is selected files it there; otherwise the first list.
  const listId = activeList !== 'all' ? activeList : lists[0].id;
  await saveItem({
    id: uid('h_'), listId, name, qty: 1, priority: 0,
    due: '', note: '', url: '', checked: false, order: nextOrder(),
  });
  render();
}

function itemSheet(it) {
  if (!it) return;
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Edit item</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="field"><label>Item</label><input class="input" id="i-name" value="${escapeHtml(it.name)}"></div>
    <div class="grid2">
      <div class="field"><label>List</label><select class="input" id="i-list">
        ${lists.map((l) => `<option value="${l.id}" ${l.id === it.listId ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Quantity</label><input class="input" id="i-qty" inputmode="decimal" value="${escapeHtml(String(it.qty ?? 1))}"></div>
    </div>
    <div class="field"><label>Priority</label>
      <div class="seg" id="i-prio">${PRIORITY.map((p) => `<button data-p="${p.v}" class="${(it.priority || 0) === p.v ? 'active' : ''}">${p.label}</button>`).join('')}</div></div>
    <div class="field"><label>Needed by (optional)</label><input class="input" type="date" id="i-due" value="${escapeHtml(it.due || '')}"></div>
    <div class="field"><label>Link (optional)</label><input class="input" id="i-url" value="${escapeHtml(it.url || '')}" placeholder="https://"></div>
    <div class="field"><label>Notes</label><textarea class="input" id="i-note" placeholder="Brand, model, size…">${escapeHtml(it.note || '')}</textarea></div>
    ${it.url ? `<a class="btn mt" href="${escapeHtml(it.url)}" target="_blank" rel="noopener"><i class="ti ti-external-link"></i> Open link</a>` : ''}
    <button class="btn primary mt" id="i-save"><i class="ti ti-device-floppy"></i> Save</button>
    <button class="btn danger mt" id="i-del"><i class="ti ti-trash"></i> Delete</button>
  `);
  let prio = it.priority || 0;
  sheet.querySelectorAll('#i-prio button').forEach((b) => b.addEventListener('click', () => {
    prio = Number(b.dataset.p);
    sheet.querySelectorAll('#i-prio button').forEach((x) => x.classList.toggle('active', x === b));
  }));
  sheet.querySelector('#i-save').addEventListener('click', async () => {
    const name = sheet.querySelector('#i-name').value.trim();
    if (!name) return toast('Give it a name', true);
    Object.assign(it, {
      name, listId: sheet.querySelector('#i-list').value,
      qty: sheet.querySelector('#i-qty').value.trim() || 1,
      priority: prio,
      due: sheet.querySelector('#i-due').value || '',
      url: sheet.querySelector('#i-url').value.trim(),
      note: sheet.querySelector('#i-note').value.trim(),
    });
    await saveItem(it); closeSheet(); render(); toast('Saved');
  });
  sheet.querySelector('#i-del').addEventListener('click', async () => {
    await db.del('grocery', it.id); await load(); closeSheet(); render(); toast('Deleted');
  });
}

function listsSheet() {
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Lists</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="field"><label>New list</label>
      <div class="input-row"><input class="input" id="l-name" placeholder="e.g. Costco, Hardware">
      <button class="mini-btn" id="l-add" aria-label="Add"><i class="ti ti-plus"></i></button></div></div>
    <div class="card" id="l-list"></div>
    <div class="hint center mt2">Deleting a list moves its items to the first list rather than losing them.</div>
  `);
  const paint = () => {
    sheet.querySelector('#l-list').innerHTML = lists.map((l) => `
      <div class="row">
        <div class="ic"><i class="ti ${escapeHtml(l.icon || 'ti-basket')}"></i></div>
        <div class="main"><div class="t">${escapeHtml(l.name)}</div>
          <div class="s">${items.filter((i) => i.listId === l.id && !i.checked).length} open</div></div>
        <button class="mini-btn" data-l-icon="${l.id}" aria-label="Icon"><i class="ti ti-palette"></i></button>
        ${lists.length > 1 ? `<button class="mini-btn" data-l-del="${l.id}" aria-label="Delete"><i class="ti ti-trash"></i></button>` : ''}
      </div>`).join('');
    sheet.querySelectorAll('[data-l-del]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.lDel;
      const fallback = lists.find((l) => l.id !== id);
      for (const it of items.filter((i) => i.listId === id)) { it.listId = fallback.id; await db.put('grocery', it); }
      await db.del('lists', id); await load();
      if (activeList === id) activeList = 'all';
      paint(); render();
    }));
    sheet.querySelectorAll('[data-l-icon]').forEach((b) => b.addEventListener('click', async () => {
      const l = listOf(b.dataset.lIcon);
      l.icon = LIST_ICONS[(LIST_ICONS.indexOf(l.icon) + 1) % LIST_ICONS.length];
      await db.put('lists', l); await load(); paint(); render();
    }));
  };
  const addList = async () => {
    const name = sheet.querySelector('#l-name').value.trim();
    if (!name) return;
    await db.put('lists', { id: uid('l_'), name, icon: LIST_ICONS[lists.length % LIST_ICONS.length], order: lists.length });
    sheet.querySelector('#l-name').value = '';
    await load(); paint(); render();
  };
  sheet.querySelector('#l-add').addEventListener('click', addList);
  sheet.querySelector('#l-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') addList(); });
  paint();
}

// --- share / import ---------------------------------------------------------
const b64encode = (s) => btoa(unescape(encodeURIComponent(s)));
const b64decode = (s) => decodeURIComponent(escape(atob(s)));

function shareSheet() {
  const scope = activeList === 'all' ? items : items.filter((i) => i.listId === activeList);
  const payload = {
    app: 'batvault-grocery', v: 2, exportedAt: new Date().toISOString(),
    lists: lists.filter((l) => activeList === 'all' || l.id === activeList),
    items: scope,
  };
  const code = b64encode(JSON.stringify(payload));
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Share list</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="hint">${scope.length} item${scope.length === 1 ? '' : 's'} from ${activeList === 'all' ? 'every list' : escapeHtml(listOf(activeList)?.name || '')}. Send this code — the other phone pastes it below.</div>
    <div class="card mt"><div class="mono share-text">${escapeHtml(code.slice(0, 400))}${code.length > 400 ? '…' : ''}</div></div>
    <button class="btn primary mt" id="s-copy"><i class="ti ti-copy"></i> Copy code</button>
    <div class="field mt2"><label>Import a code</label><textarea class="input mono" id="s-in" rows="3" placeholder="Paste here"></textarea></div>
    <button class="btn" id="s-import"><i class="ti ti-download"></i> Import</button>
  `);
  sheet.querySelector('#s-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(code); toast('Copied'); } catch { toast('Copy failed', true); }
  });
  sheet.querySelector('#s-import').addEventListener('click', async () => {
    try {
      const json = JSON.parse(b64decode(sheet.querySelector('#s-in').value.trim()));
      if (!json || !Array.isArray(json.items)) throw new Error('bad');
      const map = {};
      for (const l of json.lists || []) {
        const existing = lists.find((x) => x.name.toLowerCase() === String(l.name).toLowerCase());
        if (existing) { map[l.id] = existing.id; continue; }
        const nl = { id: uid('l_'), name: l.name, icon: l.icon || 'ti-basket', order: lists.length };
        await db.put('lists', nl); map[l.id] = nl.id; await load();
      }
      let n = 0;
      for (const it of json.items) {
        await db.put('grocery', { ...it, id: uid('h_'), listId: map[it.listId] || lists[0].id, order: nextOrder() + n });
        n++;
      }
      await load(); closeSheet(); render(); toast(`Imported ${n}`);
    } catch { toast('That code doesn’t look right', true); }
  });
}
