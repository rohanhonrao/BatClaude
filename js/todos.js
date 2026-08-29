// todos.js — SLATE (module id stays `todos`): a personal task list.
// Deliberately NOT shared: no sync, no pairing, nothing leaves the device.
// Hearth is where shared things live.
//
// The design bet is that a to-do app lives or dies on how fast you can capture
// something. So the whole surface is one text box that understands dates
// ("pay rent friday", "gym every monday", "call dad in 3 days") and priority
// ("!" / "!!"), and everything else is optional editing afterwards.
//
// Tasks are grouped by when they are due rather than by folder, because the
// useful question is "what needs doing now", not "where did I file this".
import { db, uid } from './db.js';
import { escapeHtml, todayISO, fmtDateShort, relativeDay } from './util.js';
import { toast, openSheet, closeSheet } from './ui.js';
import { parseWhen, bucketOf, nextDue, repeatLabel, addDaysISO } from './when.js';

const BUCKETS = [
  { id: 'overdue',  label: 'Overdue',   icon: 'ti-alert-triangle' },
  { id: 'today',    label: 'Today',     icon: 'ti-sun' },
  { id: 'tomorrow', label: 'Tomorrow',  icon: 'ti-sunrise' },
  { id: 'week',     label: 'This week', icon: 'ti-calendar' },
  { id: 'later',    label: 'Later',     icon: 'ti-calendar-plus' },
  { id: 'someday',  label: 'No date',   icon: 'ti-inbox' },
];
const PRIORITY = ['', 'p-high', 'p-urgent'];
const REPEATS = [
  ['', 'Does not repeat'], ['day:1', 'Daily'], ['week:1', 'Weekly'],
  ['week:2', 'Every 2 weeks'], ['month:1', 'Monthly'], ['month:12', 'Yearly'],
];

let todos = [];
let showDone = false;
let focus = 'all';        // 'all' | 'today' — "today" narrows to what is actually due
let hubHandler = null;
export function setTodosHubHandler(fn) { hubHandler = fn; }

const $app = () => document.getElementById('app');
const packRepeat = (r) => (r ? `${r.unit}:${r.interval || 1}` : '');
const unpackRepeat = (s) => {
  if (!s) return null;
  const [unit, interval] = String(s).split(':');
  return { unit, interval: Number(interval) || 1 };
};

async function load() {
  todos = (await db.all('todos')).sort((a, b) =>
    (b.priority || 0) - (a.priority || 0) ||
    String(a.due || '9999').localeCompare(String(b.due || '9999')) ||
    (a.createdAt || 0) - (b.createdAt || 0));
}

const save = async (t) => { t.updatedAt = Date.now(); await db.put('todos', t); await load(); };

export async function mountTodos() {
  await load();
  render();
}

// --- render ------------------------------------------------------------------
function render() {
  const today = todayISO();
  const open = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);

  const visible = focus === 'today'
    ? open.filter((t) => t.due && t.due <= today)
    : open;

  const groups = {};
  for (const t of visible) (groups[bucketOf(t, today)] ||= []).push(t);

  const dueToday = open.filter((t) => t.due && t.due <= today).length;
  const doneToday = done.filter((t) => t.doneAt && t.doneAt.slice(0, 10) === today).length;

  const body = visible.length
    ? BUCKETS.filter((b) => groups[b.id]).map((b) => `
        <div class="td-group">
          <div class="td-group-head ${b.id}">
            <span><i class="ti ${b.icon}"></i> ${b.label}</span>
            <span class="td-n">${groups[b.id].length}</span>
          </div>
          <div class="card td-card">${groups[b.id].map(rowHTML).join('')}</div>
        </div>`).join('')
    : `<div class="empty"><span class="em"><i class="ti ti-checkbox"></i></span>
        <div>${focus === 'today' ? 'Nothing due' : 'Nothing to do'}</div>
        <div class="tiny mt">${focus === 'today' ? 'Everything due is done.' : 'Type above to add your first task.'}</div></div>`;

  $app().innerHTML = `<div class="view">
    <div class="app-header">
      <div class="title">
        <button class="header-btn" data-hub aria-label="All apps"><i class="ti ti-apps"></i></button>
        <h1 class="mod-title">Slate</h1>
      </div>
      <button class="header-btn" data-td-help aria-label="How to type dates"><i class="ti ti-wand"></i></button>
    </div>

    <div class="hero td-hero">
      <div class="td-count">${dueToday}</div>
      <div class="td-sub">${dueToday === 1 ? 'thing due' : 'things due'}${
        doneToday ? ` · ${doneToday} done today` : ''}</div>
    </div>

    <div class="input-row td-add-row">
      <input class="input" id="td-add" autocomplete="off" enterkeyhint="done"
        placeholder="Add a task — try &quot;pay rent friday&quot;">
      <button class="mini-btn primary-btn" data-td-quickadd aria-label="Add"><i class="ti ti-plus"></i></button>
    </div>
    <div class="td-parse" id="td-parse"></div>

    <div class="seg mt" id="td-focus">
      <button data-td-focus="all" class="${focus === 'all' ? 'active' : ''}">Everything</button>
      <button data-td-focus="today" class="${focus === 'today' ? 'active' : ''}">Due now</button>
    </div>

    ${body}

    ${done.length ? `
      <button class="chip mt2" data-td-toggledone>
        <i class="ti ti-${showDone ? 'eye-off' : 'eye'}"></i> ${showDone ? 'Hide' : 'Show'} completed · ${done.length}</button>
      ${showDone ? `<div class="card td-card mt">${done.slice(0, 50).map(rowHTML).join('')}</div>
        <button class="chip mt" data-td-clear><i class="ti ti-trash"></i> Clear completed</button>` : ''}
    ` : ''}
  </div>`;
  bind();
}

function rowHTML(t) {
  const meta = [
    t.due ? `<span class="td-due ${dueClass(t)}">${escapeHtml(relativeDay(t.due))}</span>` : '',
    t.repeat ? `<span><i class="ti ti-repeat"></i> ${escapeHtml(repeatLabel(t.repeat))}</span>` : '',
    t.notes ? '<i class="ti ti-note"></i>' : '',
  ].filter(Boolean).join(' · ');
  return `<div class="row td-row ${t.done ? 'done' : ''} ${PRIORITY[t.priority || 0]}">
    <button class="td-check" data-td-toggle="${t.id}" aria-label="Toggle">
      <i class="ti ti-${t.done ? 'circle-check-filled' : 'circle'}"></i></button>
    <div class="main tappable" data-td-edit="${t.id}">
      <div class="t">${escapeHtml(t.title)}</div>
      ${meta ? `<div class="s">${meta}</div>` : ''}
    </div>
  </div>`;
}

function dueClass(t) {
  const today = todayISO();
  if (t.done) return '';
  if (t.due < today) return 'overdue';
  if (t.due === today) return 'now';
  return '';
}

// --- actions -----------------------------------------------------------------
async function quickAdd(text) {
  const p = parseWhen(text, todayISO());
  if (!p.title) return toast('Give the task a name', true);
  await save({
    id: uid('td_'), title: p.title, notes: '', due: p.due, priority: p.priority,
    repeat: p.repeat, done: false, doneAt: null, createdAt: Date.now(),
  });
  render();
}

// Completing a repeating task rolls it forward instead of ending it — that is
// the whole point of a repeat, and it is why `done` is never simply set.
async function toggle(id) {
  const t = todos.find((x) => x.id === id);
  if (!t) return;
  if (!t.done && t.repeat) {
    const next = nextDue(t, todayISO());
    await save({ ...t, due: next });
    toast(`Done — next ${relativeDay(next)}`);
  } else {
    await save({ ...t, done: !t.done, doneAt: t.done ? null : new Date().toISOString() });
  }
  render();
}

// --- editor ------------------------------------------------------------------
function editor(t) {
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Task</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="field"><label>Task</label><input class="input" id="e-title" value="${escapeHtml(t.title)}"></div>
    <div class="field"><label>Notes</label><textarea class="input" id="e-notes" rows="3"
      placeholder="Optional">${escapeHtml(t.notes || '')}</textarea></div>
    <div class="grid2">
      <div class="field"><label>Due</label><input class="input" type="date" id="e-due" value="${t.due || ''}"></div>
      <div class="field"><label>Repeats</label><select class="input" id="e-rep">
        ${REPEATS.map(([v, l]) => `<option value="${v}" ${v === packRepeat(t.repeat) ? 'selected' : ''}>${l}</option>`).join('')}
      </select></div>
    </div>
    <div class="td-quick-dates">
      <button class="chip" data-e-day="0">Today</button>
      <button class="chip" data-e-day="1">Tomorrow</button>
      <button class="chip" data-e-day="7">Next week</button>
      <button class="chip" data-e-day="">Clear</button>
    </div>
    <div class="field mt"><label>Priority</label><div class="seg" id="e-pri">
      <button data-p="0" class="${!t.priority ? 'active' : ''}">Normal</button>
      <button data-p="1" class="${t.priority === 1 ? 'active' : ''}">High</button>
      <button data-p="2" class="${t.priority === 2 ? 'active' : ''}">Urgent</button>
    </div></div>
    <button class="btn primary mt" id="e-save">Save</button>
    <button class="btn danger mt" id="e-del"><i class="ti ti-trash"></i> Delete</button>
  `);

  let priority = t.priority || 0;
  sheet.querySelectorAll('#e-pri button').forEach((b) => b.addEventListener('click', () => {
    priority = Number(b.dataset.p);
    sheet.querySelectorAll('#e-pri button').forEach((x) => x.classList.toggle('active', x === b));
  }));
  sheet.querySelectorAll('[data-e-day]').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.eDay;
    sheet.querySelector('#e-due').value = v === '' ? '' : addDaysISO(todayISO(), Number(v));
  }));
  sheet.querySelector('#e-save').addEventListener('click', async () => {
    const title = sheet.querySelector('#e-title').value.trim();
    if (!title) return toast('Give the task a name', true);
    await save({ ...t, title, notes: sheet.querySelector('#e-notes').value.trim(),
      due: sheet.querySelector('#e-due').value || null,
      repeat: unpackRepeat(sheet.querySelector('#e-rep').value), priority });
    closeSheet(); render(); toast('Saved');
  });
  sheet.querySelector('#e-del').addEventListener('click', async () => {
    await db.del('todos', t.id); await load();
    closeSheet(); render(); toast('Deleted');
  });
}

function helpSheet() {
  openSheet(`
    <div class="sheet-title-row"><h2>Typing dates</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="hint">Write the task normally and include when it is due. The date is taken out of the title automatically.</div>
    <div class="card mt"><div class="td-help">
      ${[
        ['today · tonight', 'due today'],
        ['tomorrow · tmrw', 'due tomorrow'],
        ['friday · next friday', 'that weekday'],
        ['in 3 days · in 2 weeks', 'counted from today'],
        ['next week · next month', 'a week or month out'],
        ['every monday · daily · monthly', 'repeats, and rolls forward when ticked'],
        ['! · !!', 'high · urgent'],
      ].map(([a, b]) => `<div><code>${escapeHtml(a)}</code><span>${escapeHtml(b)}</span></div>`).join('')}
    </div></div>
    <div class="hint mt">Nothing is guessed: if a phrase isn't recognised it simply stays in the title.</div>
  `);
}

// --- wiring ------------------------------------------------------------------
function bind() {
  const root = $app();
  root.querySelector('[data-hub]').addEventListener('click', () => hubHandler && hubHandler());
  root.querySelector('[data-td-help]').addEventListener('click', helpSheet);

  const input = root.querySelector('#td-add');
  const preview = root.querySelector('#td-parse');
  const add = async () => {
    const v = input.value.trim();
    if (!v) return;
    input.value = '';
    preview.innerHTML = '';
    await quickAdd(v);
  };
  root.querySelector('[data-td-quickadd]').addEventListener('click', add);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

  // Show what the line will become before it is committed, so the parsing is
  // never a surprise.
  input.addEventListener('input', () => {
    const v = input.value.trim();
    if (!v) return void (preview.innerHTML = '');
    const p = parseWhen(v, todayISO());
    const bits = [
      p.due ? `<span class="chip mini"><i class="ti ti-calendar"></i> ${escapeHtml(relativeDay(p.due))}</span>` : '',
      p.repeat ? `<span class="chip mini"><i class="ti ti-repeat"></i> ${escapeHtml(repeatLabel(p.repeat))}</span>` : '',
      p.priority ? `<span class="chip mini ${p.priority === 2 ? 'urgent' : 'high'}">${p.priority === 2 ? 'urgent' : 'high'}</span>` : '',
    ].filter(Boolean).join('');
    preview.innerHTML = bits ? `${bits}<span class="td-parse-title">${escapeHtml(p.title)}</span>` : '';
  });

  root.querySelectorAll('[data-td-toggle]').forEach((b) =>
    b.addEventListener('click', () => toggle(b.dataset.tdToggle)));
  root.querySelectorAll('[data-td-edit]').forEach((el) =>
    el.addEventListener('click', () => editor(todos.find((x) => x.id === el.dataset.tdEdit))));
  root.querySelectorAll('#td-focus button').forEach((b) =>
    b.addEventListener('click', () => { focus = b.dataset.tdFocus; render(); }));
  root.querySelector('[data-td-toggledone]')?.addEventListener('click', () => { showDone = !showDone; render(); });
  root.querySelector('[data-td-clear]')?.addEventListener('click', async () => {
    for (const t of todos.filter((x) => x.done)) await db.del('todos', t.id);
    await load(); render(); toast('Cleared');
  });
}
