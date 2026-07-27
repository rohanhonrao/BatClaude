// move.js — Move HQ: an interactive moving checklist with per-task status,
// subtasks, dependencies, and due dates. Local-first like every module.
import { db, uid } from './db.js';
import { toast, openSheet, closeSheet } from './ui.js';
import { escapeHtml, getSetting, setSetting, fmtDate, todayISO } from './util.js';

// --- Status model -----------------------------------------------------------
// Stored status is one of these four. "Blocked" is *derived* — a task whose
// dependencies aren't all done shows a lock until they are.
const STATUS = {
  todo:    { label: 'To do',       color: 'var(--muted)',  chip: 'var(--surface-2)',        icon: 'ti-circle' },
  doing:   { label: 'In progress', color: 'var(--blue)',   chip: 'rgba(74,168,255,.14)',    icon: 'ti-loader-2' },
  waiting: { label: 'Waiting',     color: 'var(--purple)', chip: 'rgba(185,139,255,.14)',   icon: 'ti-hourglass' },
  done:    { label: 'Done',        color: 'var(--green)',  chip: 'rgba(61,220,132,.14)',    icon: 'ti-check' },
};
const CYCLE = ['todo', 'doing', 'waiting', 'done'];

const CATS = ['Housing', 'Sell', 'Utilities', 'Logistics'];
const CAT_ICON = { Housing: 'ti-home', Sell: 'ti-tag', Utilities: 'ti-plug', Logistics: 'ti-truck-delivery' };

let tasks = [];
let filter = 'all';
let hubHandler = null;
export function setMoveHubHandler(fn) { hubHandler = fn; }

const $app = () => document.getElementById('app');

export async function mountMove() {
  await seedIfEmpty();
  await load();
  filter = 'all';
  render();
}

async function load() {
  tasks = (await db.all('tasks')).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
async function save(t) {
  t.updatedAt = Date.now();
  await db.put('tasks', t);
  await load();
}

// --- Derived helpers --------------------------------------------------------
function byId(id) { return tasks.find((t) => t.id === id); }
function isDone(t) { return t.status === 'done'; }
function subProgress(t) {
  const subs = t.subtasks || [];
  const done = subs.filter((s) => s.done).length;
  return { done, total: subs.length };
}
// A task is blocked when it isn't done and any prerequisite isn't done.
function blockers(t) {
  if (isDone(t)) return [];
  return (t.dependsOn || []).map(byId).filter((d) => d && !isDone(d));
}
function isBlocked(t) { return blockers(t).length > 0; }

function counts() {
  const total = tasks.length;
  const done = tasks.filter(isDone).length;
  const blocked = tasks.filter(isBlocked).length;
  return { total, done, blocked };
}
function daysUntil(iso) {
  return Math.round((new Date(iso + 'T00:00:00') - new Date(todayISO() + 'T00:00:00')) / 86400000);
}

// --- Render -----------------------------------------------------------------
function render() {
  const c = counts();
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  const list = filter === 'all' ? tasks : tasks.filter((t) => t.category === filter);

  $app().innerHTML = `<div class="view">
    <div class="app-header">
      <div class="title">
        <button class="header-btn" data-hub aria-label="All apps"><i class="ti ti-apps"></i></button>
        <h1 class="mod-title"><i class="ti ti-map-pin" style="color:var(--gold)"></i> Move HQ</h1>
      </div>
      <button class="header-btn" data-add aria-label="Add task"><i class="ti ti-plus"></i></button>
    </div>

    <div class="hero mv-hero">
      <div class="spread">
        <span class="label">Move-out progress</span>
        ${countdownHTML()}
      </div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-top:4px">
        <span class="mv-big">${c.done}<span style="color:var(--faint)">/${c.total}</span></span>
        <span class="tiny muted">done${c.blocked ? ` · ${c.blocked} blocked` : ''}</span>
      </div>
      <div class="bar"><span style="width:${pct}%"></span></div>
    </div>

    <div class="chips mv-filters">
      <button class="chip ${filter === 'all' ? 'active' : ''}" data-filter="all">All ${c.total}</button>
      ${CATS.map((cat) => {
        const n = tasks.filter((t) => t.category === cat).length;
        return n ? `<button class="chip ${filter === cat ? 'active' : ''}" data-filter="${cat}"><i class="ti ${CAT_ICON[cat]}"></i> ${cat}</button>` : '';
      }).join('')}
    </div>

    <div class="mv-list">
      ${list.length ? list.map(taskHTML).join('') : `<div class="empty"><span class="em"><i class="ti ti-clipboard-check"></i></span><div>Nothing here</div></div>`}
    </div>

    <button class="btn primary mt2" data-add><i class="ti ti-plus"></i> Add task</button>
    <div class="btn-row">
      <button class="btn ghost" data-share><i class="ti ti-send"></i> Share list</button>
      <button class="btn ghost" data-import><i class="ti ti-download"></i> Import</button>
    </div>
    <div class="center muted tiny mt2"><i class="ti ti-shield-check" style="color:var(--green)"></i> Saved on this device</div>
  </div>`;
  bind();
}

function countdownHTML() {
  const md = getSetting('moveDate');
  if (!md) return `<button class="mv-setdate" data-setdate><i class="ti ti-calendar-plus"></i> Set move date</button>`;
  const d = daysUntil(md);
  const label = d > 0 ? `in ${d} day${d === 1 ? '' : 's'}` : d === 0 ? 'today' : `${-d} day${d === -1 ? '' : 's'} ago`;
  const col = d < 0 ? 'var(--red)' : d <= 7 ? 'var(--gold)' : 'var(--muted)';
  return `<button class="mv-setdate" data-setdate style="color:${col}"><i class="ti ti-plane-departure"></i> Move ${label}</button>`;
}

function taskHTML(t) {
  const st = STATUS[t.status] || STATUS.todo;
  const blocked = isBlocked(t);
  const { done, total } = subProgress(t);
  const spin = t.status === 'doing' ? ' mv-spin' : '';
  const check = isDone(t)
    ? `<span class="mv-tick done"><i class="ti ti-check"></i></span>`
    : `<span class="mv-tick" style="border-color:${st.color};color:${st.color}"><i class="ti ${st.icon}${spin}"></i></span>`;

  let badge;
  if (blocked) {
    badge = `<span class="mv-pill" style="background:rgba(184,146,42,.16);color:var(--gold)"><i class="ti ti-lock"></i> Blocked</span>`;
  } else if (t.due && !isDone(t)) {
    const d = daysUntil(t.due);
    const overdue = d < 0, soon = d >= 0 && d <= 3;
    const col = overdue ? 'var(--red)' : soon ? 'var(--gold)' : 'var(--muted)';
    badge = `<span class="mv-pill" style="background:${overdue ? 'rgba(255,90,95,.14)' : soon ? 'rgba(245,197,66,.14)' : 'var(--surface-2)'};color:${col}"><i class="ti ti-clock"></i> ${overdue ? `${-d}d late` : d === 0 ? 'today' : `${d}d`}</span>`;
  } else {
    badge = `<span class="mv-pill" style="background:${st.chip};color:${st.color}">${st.label}</span>`;
  }

  let detail = '';
  if (blocked) {
    const names = blockers(t).map((b) => escapeHtml(b.title)).join(', ');
    detail = `<div class="mv-sub"><i class="ti ti-arrow-back-up" style="color:var(--gold-dim)"></i> Waiting on <b>${names}</b></div>`;
  } else if (total) {
    const subpct = Math.round((done / total) * 100);
    detail = `<div class="mv-subwrap">
      <div class="mv-subbar"><span style="width:${subpct}%;background:${isDone(t) ? 'var(--green)' : 'var(--blue)'}"></span></div>
      <div class="spread mt-xs"><span class="mv-sub">${escapeHtml((t.subtasks || []).map((s) => s.title).slice(0, 4).join(' · '))}${total > 4 ? '…' : ''}</span><span class="tiny muted">${done}/${total}</span></div>
    </div>`;
  } else if (t.notes) {
    detail = `<div class="mv-sub">${escapeHtml(t.notes)}</div>`;
  }

  return `<div class="mv-task ${isDone(t) ? 'is-done' : ''} ${blocked ? 'is-blocked' : ''}" data-open="${t.id}">
    <div class="mv-row">
      <button class="mv-tickbtn" data-cycle="${t.id}" aria-label="Change status">${check}</button>
      <span class="mv-title">${escapeHtml(t.title)}</span>
      ${badge}
    </div>
    ${detail ? `<div class="mv-detail">${detail}</div>` : ''}
  </div>`;
}

function bind() {
  const root = $app();
  root.querySelector('[data-hub]')?.addEventListener('click', () => hubHandler && hubHandler());
  root.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => taskSheet()));
  root.querySelector('[data-setdate]')?.addEventListener('click', (e) => { e.stopPropagation(); moveDateSheet(); });
  root.querySelector('[data-share]')?.addEventListener('click', () => shareSheet());
  root.querySelector('[data-import]')?.addEventListener('click', () => importSheet());
  root.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.filter; render(); }));
  root.querySelectorAll('[data-cycle]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); cycleStatus(b.dataset.cycle); }));
  root.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-cycle]')) return;
    taskSheet(byId(el.dataset.open));
  }));
}

// Tapping the status dot advances To do → In progress → Waiting → Done → To do.
async function cycleStatus(id) {
  const t = byId(id);
  if (!t) return;
  const i = CYCLE.indexOf(t.status);
  const next = CYCLE[(i + 1) % CYCLE.length];
  t.status = next;
  // Completing a task with subtasks ticks them all; un-completing leaves them.
  if (next === 'done') (t.subtasks || []).forEach((s) => (s.done = true));
  await save(t);
  render();
  if (next === 'done') {
    const freed = tasks.filter((x) => (x.dependsOn || []).includes(id) && !isBlocked(x) && !isDone(x));
    if (freed.length) toast(`Unlocked: ${freed.map((x) => x.title).join(', ')}`);
    else toast('Marked done');
  }
}

// --- Task editor sheet ------------------------------------------------------
function taskSheet(existing) {
  const t = existing || { id: uid('t_'), order: (tasks.at(-1)?.order ?? 0) + 1, title: '', category: 'Logistics', status: 'todo', due: '', dependsOn: [], subtasks: [], notes: '' };
  const others = tasks.filter((x) => x.id !== t.id);

  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>${existing ? 'Edit task' : 'New task'}</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="field"><label>Task</label><input class="input" id="t-title" value="${escapeHtml(t.title)}" placeholder="e.g. Sell dining table"></div>

    <div class="field"><label>Status</label>
      <div class="seg" id="t-status">${CYCLE.map((s) => `<button data-v="${s}" class="${t.status === s ? 'active' : ''}" style="${t.status === s ? `color:${STATUS[s].color}` : ''}">${STATUS[s].label}</button>`).join('')}</div>
    </div>

    <div class="field"><label>Category</label>
      <select class="input" id="t-cat">${CATS.map((c) => `<option ${c === t.category ? 'selected' : ''}>${c}</option>`).join('')}</select></div>

    <div class="field"><label>Due date <span class="muted tiny">(optional)</span></label>
      <input class="input" id="t-due" type="date" value="${t.due || ''}"></div>

    <div class="field"><label>Steps / checklist</label>
      <div id="t-subs" class="mv-subedit"></div>
      <div class="input-row mt"><input class="input" id="t-subnew" placeholder="Add a step, press Enter"><button class="mini-btn" id="t-subadd" aria-label="Add step"><i class="ti ti-plus"></i></button></div>
    </div>

    ${others.length ? `<div class="field"><label>Blocked until these are done</label>
      <div class="chips" id="t-deps">${others.map((o) => `<button type="button" class="chip ${(t.dependsOn || []).includes(o.id) ? 'active' : ''}" data-dep="${o.id}">${escapeHtml(o.title)}</button>`).join('')}</div></div>` : ''}

    <div class="field"><label>Notes</label><textarea class="input" id="t-notes" placeholder="Buyer contacts, negotiation notes…">${escapeHtml(t.notes || '')}</textarea></div>

    <button class="btn primary" id="t-save"><i class="ti ti-device-floppy"></i> ${existing ? 'Save' : 'Add task'}</button>
    ${existing ? `<button class="btn danger mt" id="t-del"><i class="ti ti-trash"></i> Delete task</button>` : ''}
  `);

  // local working copies
  let status = t.status;
  const subs = (t.subtasks || []).map((s) => ({ ...s }));
  const deps = new Set(t.dependsOn || []);

  const renderSubs = () => {
    const box = sheet.querySelector('#t-subs');
    box.innerHTML = subs.length ? subs.map((s, i) => `<label class="mv-subitem">
      <input type="checkbox" data-si="${i}" ${s.done ? 'checked' : ''}>
      <span class="${s.done ? 'mv-struck' : ''}">${escapeHtml(s.title)}</span>
      <button class="mini-btn ghost" data-sdel="${i}" aria-label="Remove"><i class="ti ti-x"></i></button>
    </label>`).join('') : `<div class="tiny muted" style="padding:2px 2px 6px">No steps yet.</div>`;
    box.querySelectorAll('[data-si]').forEach((c) => c.addEventListener('change', () => { subs[+c.dataset.si].done = c.checked; renderSubs(); }));
    box.querySelectorAll('[data-sdel]').forEach((b) => b.addEventListener('click', () => { subs.splice(+b.dataset.sdel, 1); renderSubs(); }));
  };
  renderSubs();

  const addSub = () => {
    const inp = sheet.querySelector('#t-subnew');
    const v = inp.value.trim();
    if (!v) return;
    subs.push({ id: uid('s_'), title: v, done: false });
    inp.value = ''; inp.focus(); renderSubs();
  };
  sheet.querySelector('#t-subadd').addEventListener('click', addSub);
  sheet.querySelector('#t-subnew').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSub(); } });

  sheet.querySelectorAll('#t-status button').forEach((b) => b.addEventListener('click', () => {
    status = b.dataset.v;
    sheet.querySelectorAll('#t-status button').forEach((x) => { x.classList.toggle('active', x === b); x.style.color = x === b ? STATUS[status].color : ''; });
  }));
  sheet.querySelectorAll('[data-dep]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.dep;
    if (deps.has(id)) deps.delete(id); else deps.add(id);
    b.classList.toggle('active');
  }));

  sheet.querySelector('#t-save').addEventListener('click', async () => {
    const title = sheet.querySelector('#t-title').value.trim();
    if (!title) return toast('Enter a task name', true);
    if (subs.length && subs.every((s) => s.done) && status !== 'done') status = 'done';
    const rec = {
      id: t.id, order: t.order, title,
      category: sheet.querySelector('#t-cat').value,
      status,
      due: sheet.querySelector('#t-due').value || '',
      dependsOn: [...deps],
      subtasks: subs,
      notes: sheet.querySelector('#t-notes').value.trim(),
    };
    await save(rec);
    closeSheet(); render(); toast(existing ? 'Saved' : 'Added');
  });

  const del = sheet.querySelector('#t-del');
  if (del) del.addEventListener('click', () => {
    const s2 = openSheet(`<div class="center"><div style="font-size:30px"><i class="ti ti-trash"></i></div>
      <h2 style="margin:10px 0 6px">Delete “${escapeHtml(t.title)}”?</h2><p class="muted tiny">This can't be undone.</p></div>
      <button class="btn danger" id="d-yes">Delete</button><button class="btn ghost mt" data-close>Cancel</button>`);
    s2.querySelector('#d-yes').addEventListener('click', async () => {
      // Drop this task from any dependency lists so nothing stays falsely blocked.
      for (const o of tasks) {
        if ((o.dependsOn || []).includes(t.id)) { o.dependsOn = o.dependsOn.filter((x) => x !== t.id); await db.put('tasks', o); }
      }
      await db.del('tasks', t.id); await load(); closeSheet(); render(); toast('Deleted');
    });
  });
}

// --- Move date sheet --------------------------------------------------------
function moveDateSheet() {
  const cur = getSetting('moveDate') || '';
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Move-out date</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <p class="muted tiny">Sets the countdown at the top. You can change it anytime.</p>
    <div class="field mt"><input class="input" id="md-date" type="date" value="${cur}"></div>
    <button class="btn primary" id="md-save"><i class="ti ti-check"></i> Save</button>
    ${cur ? `<button class="btn ghost mt" id="md-clear">Clear date</button>` : ''}
  `);
  sheet.querySelector('#md-save').addEventListener('click', async () => {
    const v = sheet.querySelector('#md-date').value;
    if (!v) return toast('Pick a date', true);
    await setSetting('moveDate', v);
    closeSheet(); render(); toast(`Move date: ${fmtDate(v)}`);
  });
  sheet.querySelector('#md-clear')?.addEventListener('click', async () => {
    await setSetting('moveDate', ''); closeSheet(); render();
  });
}

// --- Share / import (phone-to-phone, no server) -----------------------------
// The list travels as a small JSON payload — sent as a file via the OS share
// sheet, or as a copy-paste base64 code. Importing replaces the list on the
// receiving phone. Nothing leaves the device except when the user shares.
function buildPayload() {
  return { app: 'batvault-move', v: 1, exportedAt: new Date().toISOString(), moveDate: getSetting('moveDate') || '', tasks };
}
function b64encode(s) { return btoa(unescape(encodeURIComponent(s))); }
function b64decode(s) { return decodeURIComponent(escape(atob(s))); }
function parsePayload(raw) {
  let json;
  try { json = JSON.parse(raw); } catch { /* not raw JSON */ }
  if (!json) { try { json = JSON.parse(b64decode(raw)); } catch { /* not base64 */ } }
  if (!json || json.app !== 'batvault-move' || !Array.isArray(json.tasks)) throw new Error('That doesn’t look like a Move HQ list');
  return json;
}
function downloadText(name, text) {
  const b = new Blob([text], { type: 'text/plain' });
  const u = URL.createObjectURL(b);
  const a = document.createElement('a');
  a.href = u; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}

function shareSheet() {
  const json = JSON.stringify(buildPayload());
  const code = b64encode(json);
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Share list</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <p class="muted tiny">Send your ${tasks.length}-task list to another phone. There, open Move HQ → <b>Import</b> and pick the file or paste the code. It replaces the list on that phone.</p>
    <button class="btn primary mt" id="sh-share"><i class="ti ti-send"></i> Share…</button>
    <div class="btn-row">
      <button class="btn ghost" id="sh-copy"><i class="ti ti-copy"></i> Copy code</button>
      <button class="btn ghost" id="sh-file"><i class="ti ti-file-download"></i> Save file</button>
    </div>
    <div class="field mt"><label>Or copy this code manually</label>
      <div class="mono share-text" style="max-height:120px;overflow:auto">${escapeHtml(code)}</div></div>
  `);
  const copyCode = async () => {
    try { await navigator.clipboard.writeText(code); toast('Code copied — send it to her'); }
    catch { toast('Copy failed', true); }
  };
  sheet.querySelector('#sh-copy').addEventListener('click', copyCode);
  sheet.querySelector('#sh-file').addEventListener('click', () => downloadText('move-hq.json', json));
  sheet.querySelector('#sh-share').addEventListener('click', async () => {
    const file = new File([json], 'move-hq.json', { type: 'application/json' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Move HQ list' }); return; }
      if (navigator.share) { await navigator.share({ title: 'Move HQ list', text: code }); return; }
    } catch { return; /* user cancelled the share sheet */ }
    copyCode(); // no native share available
  });
}

function importSheet() {
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Import a list</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <p class="muted tiny">Paste a shared code, or choose a shared file. This <b>replaces</b> your current Move HQ list.</p>
    <div class="field mt"><label>Paste code</label><textarea class="input mono" id="im-code" rows="4" placeholder="Paste the code she sent…"></textarea></div>
    <div class="field"><label>…or choose a file</label><input class="input" type="file" id="im-file" accept=".json,.txt,application/json,text/plain"></div>
    <button class="btn primary" id="im-go"><i class="ti ti-arrow-bar-to-down"></i> Replace my list</button>
  `);
  let fileText = '';
  sheet.querySelector('#im-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) { try { fileText = await f.text(); } catch { toast('Could not read that file', true); } }
  });
  sheet.querySelector('#im-go').addEventListener('click', () => {
    const raw = sheet.querySelector('#im-code').value.trim() || fileText.trim();
    if (!raw) return toast('Paste a code or choose a file', true);
    let payload;
    try { payload = parsePayload(raw); } catch (err) { return toast(err.message, true); }
    const n = payload.tasks.length;
    const s2 = openSheet(`<div class="center"><div style="font-size:30px;color:var(--gold)"><i class="ti ti-alert-triangle"></i></div>
      <h2 style="margin:10px 0 6px">Replace your list?</h2><p class="muted tiny">Imports ${n} task${n === 1 ? '' : 's'} and removes what's on this phone now.</p></div>
      <button class="btn primary" id="ir-yes">Replace list</button><button class="btn ghost mt" data-close>Cancel</button>`);
    s2.querySelector('#ir-yes').addEventListener('click', async () => {
      await db.clear('tasks');
      if (payload.tasks.length) await db.bulkPut('tasks', payload.tasks);
      await setSetting('moveDate', payload.moveDate || '');
      await load(); closeSheet(); render(); toast(`Imported ${n} task${n === 1 ? '' : 's'}`);
    });
  });
}

// --- Seed from the user's real move-out list --------------------------------
function sub(...titles) { return titles.map((title) => ({ id: uid('s_'), title, done: false })); }

async function seedIfEmpty() {
  const existing = await db.all('tasks');
  if (existing.length) return;
  const seed = [
    { title: 'SilverLake rental application', category: 'Housing', subtasks: sub('Application', 'Approval', 'Co-applicant') },
    { title: 'Selling car', category: 'Sell', subtasks: sub('Pay off Chase loan (negotiate)', 'Get title transferred to my name', 'Talk to Jiju + car service', 'Selling process') },
    { title: 'Selling furniture', category: 'Sell', subtasks: sub('Couch', 'Coffee table', 'TV table', '3 side tables', 'Office chair', 'Dining table + chairs', 'Wooden shoe rack', 'Shoe rack', 'Dresser', 'Bedroom side table', 'Study table', '3 lamps') },
    { title: 'Selling appliances + electronics', category: 'Sell', subtasks: sub('TV', 'Microwave', 'Rice cooker', 'Mixer / Blender', 'Iron + board', 'Monitor') },
    { title: 'Sell bed frame + mattress', category: 'Sell', subtasks: [] },
    { title: 'Spectrum internet closure + modem return', category: 'Utilities', subtasks: sub('Schedule closure', 'Return modem') },
    { title: '2 Japanese mattresses — sell or give away', category: 'Sell', subtasks: [] },
    { title: 'PRC notice + move out', category: 'Housing', subtasks: sub('30-day notice', 'Inspection 1', 'Inspection 2', 'Final move-out fee') },
    { title: 'Rohan flight tickets to Pittsburgh (Aug 17–20)', category: 'Logistics', subtasks: [], depIdx: 0 },
    { title: 'Figure out what moving service to use', category: 'Logistics', subtasks: sub('Compare Lugless etc.', 'Get quotes', 'Book'), notes: 'Lugless, etc?' },
  ];
  const ids = seed.map(() => uid('t_'));
  const rows = seed.map((s, i) => ({
    id: ids[i], order: i + 1, title: s.title, category: s.category,
    status: 'todo', due: '', notes: s.notes || '',
    dependsOn: s.depIdx != null ? [ids[s.depIdx]] : [],
    subtasks: s.subtasks, updatedAt: Date.now(),
  }));
  await db.bulkPut('tasks', rows);
}
