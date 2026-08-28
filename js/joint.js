// joint.js — shared finances for two people.
//
// Answers one question: "what do we owe each other right now?" That is a
// different question from the personal Finance module ("how am I doing?"), so
// the two are deliberately kept apart and share no data.
//
// Fixed costs (rent, insurance) and — per the user's decision — variable costs
// too are split by income ratio, but the rule lives on the *category*, so any
// category can be switched to an even split without touching code. Individual
// expenses can override the rule entirely.
//
// All maths lives in split.js so it can be unit-tested. Every store is synced
// through sync.js, encrypted before it leaves the device.
import { db, uid } from './db.js';
import { escapeHtml, todayISO, fmtDate, fmtDateShort, fmtMoney, parseAmount, addDays, addMonths } from './util.js';
import { toast, openSheet, closeSheet } from './ui.js';
import * as Sync from './sync.js';
import * as Split from './split.js';

const STORES = ['jointPeople', 'jointCategories', 'jointExpenses', 'jointSettlements', 'jointRecurring', 'jointMeta'];

const DEFAULT_CATEGORIES = [
  { name: 'Rent',       icon: 'ti-home',            kind: 'fixed',    rule: 'ratio' },
  { name: 'Mortgage',   icon: 'ti-building-bank',   kind: 'fixed',    rule: 'ratio' },
  { name: 'Utilities',  icon: 'ti-bolt',            kind: 'fixed',    rule: 'ratio' },
  { name: 'Insurance',  icon: 'ti-shield',          kind: 'fixed',    rule: 'ratio' },
  { name: 'Internet',   icon: 'ti-wifi',            kind: 'fixed',    rule: 'ratio' },
  { name: 'Groceries',  icon: 'ti-shopping-cart',   kind: 'variable', rule: 'ratio' },
  { name: 'Restaurants',icon: 'ti-tools-kitchen-2', kind: 'variable', rule: 'ratio' },
  { name: 'Gas',        icon: 'ti-gas-station',     kind: 'variable', rule: 'ratio' },
  { name: 'Household',  icon: 'ti-basket',          kind: 'variable', rule: 'ratio' },
  { name: 'Other',      icon: 'ti-dots',            kind: 'variable', rule: 'ratio' },
];

let people = [], cats = [], expenses = [], settlements = [], recurring = [], meta = null;
let meId = null;          // which person this phone is — device-local, never synced
let tab = 'week';         // 'week' | 'all'
let hubHandler = null;
export function setJointHubHandler(fn) { hubHandler = fn; }

const $app = () => document.getElementById('app');
const basis = () => (meta?.basis === 'gross' ? 'gross' : 'net');
const other = () => people.find((p) => p.id !== meId) || null;
const meP = () => people.find((p) => p.id === meId) || null;
const catOf = (id) => cats.find((c) => c.id === id);
const personOf = (id) => people.find((p) => p.id === id);

// --- data --------------------------------------------------------------------
async function load() {
  [people, cats, expenses, settlements, recurring] = await Promise.all(
    ['jointPeople', 'jointCategories', 'jointExpenses', 'jointSettlements', 'jointRecurring'].map((s) => db.all(s)));
  people.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  expenses.sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id));
  meta = (await db.get('jointMeta', 'config')) || null;
  meId = (await db.get('settings', 'jointMe'))?.value || null;
  if (meId && !people.some((p) => p.id === meId)) meId = null;   // partner deleted it
}

const save = async (store, rec) => {
  rec.updatedAt = Date.now();
  await db.put(store, rec);
  Sync.push(store, rec);
  await load();
};
const remove = async (store, id) => {
  await db.del(store, id);
  Sync.pushDelete(store, id);
  await load();
};

export async function mountJoint() {
  await load();
  await Sync.loadConfig();
  if (Sync.isConfigured()) {
    Sync.start(STORES, async () => { await load(); render(); });
    Sync.pushAll(STORES);
  }
  await materialiseRecurring();
  render();
}

// Fixed costs shouldn't need retyping every month: any scheduled item whose due
// date has arrived becomes a real expense, then rolls forward.
async function materialiseRecurring() {
  const today = todayISO();
  let created = false;
  for (const r of recurring) {
    if (r.paused) continue;
    let guard = 0;
    while (r.nextDate && r.nextDate <= today && guard++ < 24) {
      const already = expenses.some((e) => e.recurringId === r.id && e.date === r.nextDate);
      if (!already) {
        await db.put('jointExpenses', {
          id: uid('je_'), date: r.nextDate, desc: r.name, amount: r.amount,
          categoryId: r.categoryId, payerId: r.payerId, rule: r.rule || 'ratio',
          recurringId: r.id, updatedAt: Date.now(),
        });
        created = true;
      }
      r.nextDate = r.frequency === 'weekly' ? addDays(r.nextDate, 7)
        : r.frequency === 'yearly' ? addMonths(r.nextDate, 12)
        : addMonths(r.nextDate, 1);
      r.updatedAt = Date.now();
      await db.put('jointRecurring', r);
      Sync.push('jointRecurring', r);
    }
  }
  if (created) await load();
}

// --- render ------------------------------------------------------------------
function render() {
  if (!people.length || !meId) return renderSetup();

  const pos = Split.positions({ people, expenses, settlements, basis: basis() });
  const bal = Split.balanceBetween(people, pos.net);
  const weekOf = todayISO();
  const shown = tab === 'week' ? expenses.filter((e) => Split.inWeek(e.date, weekOf)) : expenses;

  const iOwe = !bal.settled && bal.debtor?.id === meId;
  const headline = bal.settled
    ? `<div class="j-amt settled">All square</div><div class="j-sub">Nothing owed either way</div>`
    : `<div class="j-amt ${iOwe ? 'owe' : 'owed'}">${fmtMoney(bal.amount)}</div>
       <div class="j-sub">${iOwe
          ? `You owe ${escapeHtml(bal.creditor.name)}`
          : `${escapeHtml(bal.debtor.name)} owes you`}</div>`;

  // Round the first share and derive the rest, so the percentages always read
  // as 100 — rounding each independently showed "53% / 48%".
  const r = pos.ratios;
  const pcts = people.map((p, i) =>
    i === people.length - 1
      ? 100 - people.slice(0, -1).reduce((s, q) => s + Math.round((r[q.id] || 0) * 100), 0)
      : Math.round((r[p.id] || 0) * 100));
  const weekTotal = shown.reduce((s, e) => s + Number(e.amount || 0), 0);

  $app().innerHTML = `<div class="view">
    <div class="app-header">
      <div class="title">
        <button class="header-btn" data-hub aria-label="All apps"><i class="ti ti-apps"></i></button>
        <h1 class="mod-title">Joint</h1>
      </div>
      <button class="header-btn" data-j-settings aria-label="Settings"><i class="ti ti-settings"></i></button>
    </div>

    <div class="hero j-hero">${headline}
      <div class="j-split">
        ${people.map((p, i) => `<div><span class="label">${escapeHtml(p.name)}${p.id === meId ? ' (you)' : ''}</span>
          <b>${pcts[i]}%</b></div>`).join('')}
      </div>
    </div>

    ${bal.settled ? '' : `<button class="btn primary mt" data-j-settle><i class="ti ti-arrows-exchange"></i> Settle up</button>`}

    <div class="seg mt" id="j-tab">
      <button data-j-tab="week" class="${tab === 'week' ? 'active' : ''}">This week</button>
      <button data-j-tab="all" class="${tab === 'all' ? 'active' : ''}">Everything</button>
    </div>

    <div class="j-meta">
      <span>${shown.length} expense${shown.length === 1 ? '' : 's'}</span>
      <span>${fmtMoney(weekTotal)} total</span>
    </div>

    <div class="card">${shown.length ? shown.map(expenseRow).join('')
      : `<div class="empty"><span class="em"><i class="ti ti-receipt"></i></span>
          <div>Nothing logged ${tab === 'week' ? 'this week' : 'yet'}</div>
          <div class="tiny mt">Add what you've paid for and the split works itself out.</div></div>`}</div>

    <button class="btn primary mt2" data-j-add><i class="ti ti-plus"></i> Add expense</button>
    <div class="j-foot">
      <button class="chip" data-j-recurring><i class="ti ti-calendar-repeat"></i> Fixed monthly</button>
      <button class="chip" data-j-history><i class="ti ti-history"></i> Settlements</button>
      <button class="chip ${Sync.isConfigured() ? 'active' : ''}" data-j-sync>
        <i class="ti ti-${Sync.isConfigured() ? 'wifi' : 'users'}"></i> ${Sync.isConfigured() ? 'Live' : 'Share live'}</button>
    </div>
  </div>`;
  bind();
}

function expenseRow(e) {
  const c = catOf(e.categoryId);
  const payer = personOf(e.payerId);
  const ratios = Split.incomeRatios(people, basis());
  const shares = Split.shareOf(Split.CENTS(e.amount), e, people, ratios);
  const mine = Split.DOLLARS(shares[meId] || 0);
  const ruleLabel = e.rule && e.rule !== (c?.rule || 'ratio')
    ? { payer: 'all theirs', other: 'all yours', equal: '50/50', custom: 'custom' }[e.rule] || '' : '';
  return `<div class="row tappable j-row" data-j-edit="${e.id}">
    <div class="ic"><i class="ti ${escapeHtml(c?.icon || 'ti-dots')}"></i></div>
    <div class="main">
      <div class="t">${escapeHtml(e.desc || c?.name || 'Expense')}</div>
      <div class="s">${escapeHtml(fmtDateShort(e.date))} · ${escapeHtml(payer?.name || '?')} paid${
        ruleLabel ? ` · ${ruleLabel}` : ''}</div>
    </div>
    <div class="j-amts">
      <div class="amt neg">${fmtMoney(e.amount)}</div>
      <div class="j-share">your ${fmtMoney(mine, { compact: true })}</div>
    </div>
  </div>`;
}

// --- first run ----------------------------------------------------------------
function renderSetup() {
  const existing = people.length === 2;
  $app().innerHTML = `<div class="view">
    <div class="app-header">
      <div class="title">
        <button class="header-btn" data-hub aria-label="All apps"><i class="ti ti-apps"></i></button>
        <h1 class="mod-title">Joint</h1>
      </div>
    </div>
    ${existing ? `
      <div class="hint">This phone hasn't been told which of you it belongs to.</div>
      <div class="card mt">${people.map((p) => `<div class="row tappable" data-j-iam="${p.id}">
        <div class="ic"><i class="ti ti-user"></i></div>
        <div class="main"><div class="t">I'm ${escapeHtml(p.name)}</div></div>
        <i class="ti ti-chevron-right muted"></i></div>`).join('')}</div>
      <button class="btn ghost mt2" data-j-sync><i class="ti ti-users"></i> Sharing settings</button>
    ` : `
      <div class="hint">Track what you both spend, split it by income, and see who owes whom. Set up once — your partner joins with a pairing code.</div>
      <div class="card mt">
        <div class="field"><label>Your name</label><input class="input" id="j-n1" placeholder="e.g. Rohan"></div>
        <div class="grid2">
          <div class="field"><label>Your gross</label><input class="input" id="j-g1" inputmode="decimal" placeholder="105000"></div>
          <div class="field"><label>Your take-home</label><input class="input" id="j-t1" inputmode="decimal" placeholder="72000"></div>
        </div>
      </div>
      <div class="card mt">
        <div class="field"><label>Partner's name</label><input class="input" id="j-n2" placeholder="e.g. Priya"></div>
        <div class="grid2">
          <div class="field"><label>Their gross</label><input class="input" id="j-g2" inputmode="decimal" placeholder="95000"></div>
          <div class="field"><label>Their take-home</label><input class="input" id="j-t2" inputmode="decimal" placeholder="70000"></div>
        </div>
      </div>
      <div class="hint mt">Annual or monthly — it only matters that both are the same. Only the ratio between them is used.</div>
      <button class="btn primary mt" id="j-create"><i class="ti ti-check"></i> Start</button>
      <div class="section-title">Already set up on the other phone?</div>
      <button class="btn ghost" data-j-sync><i class="ti ti-link"></i> Join with a pairing code</button>
      <div class="hint mt">Joining pulls the existing people and expenses across — don't enter them again here, or you'll end up with two of everyone.</div>
    `}
  </div>`;

  $app().querySelector('[data-hub]')?.addEventListener('click', () => hubHandler && hubHandler());
  $app().querySelector('[data-j-sync]')?.addEventListener('click', syncSheet);
  $app().querySelectorAll('[data-j-iam]').forEach((el) => el.addEventListener('click', async () => {
    await db.put('settings', { key: 'jointMe', value: el.dataset.jIam });
    await load(); render();
  }));
  $app().querySelector('#j-create')?.addEventListener('click', async () => {
    const n1 = $app().querySelector('#j-n1').value.trim();
    const n2 = $app().querySelector('#j-n2').value.trim();
    if (!n1 || !n2) return toast('Both names are needed', true);
    const p1 = { id: uid('jp_'), name: n1, incomeGross: parseAmount($app().querySelector('#j-g1').value), incomeNet: parseAmount($app().querySelector('#j-t1').value) };
    const p2 = { id: uid('jp_'), name: n2, incomeGross: parseAmount($app().querySelector('#j-g2').value), incomeNet: parseAmount($app().querySelector('#j-t2').value) };
    for (const p of [p1, p2]) await save('jointPeople', p);
    for (const c of DEFAULT_CATEGORIES) await save('jointCategories', { id: uid('jc_'), ...c });
    await save('jointMeta', { id: 'config', basis: 'net' });
    await db.put('settings', { key: 'jointMe', value: p1.id });
    await load(); render();
    toast('Ready — add your first expense');
  });
}

// --- expense editor -----------------------------------------------------------
function expenseSheet(existing) {
  const e = existing || {
    id: uid('je_'), date: todayISO(), desc: '', amount: '',
    categoryId: cats[0]?.id, payerId: meId, rule: '',
  };
  const cat = catOf(e.categoryId);
  const RULES = [
    ['', `Category default (${cat?.rule === 'equal' ? '50/50' : 'by income'})`],
    ['ratio', 'By income ratio'], ['equal', 'Split 50/50'],
    ['payer', 'All on whoever paid'], ['other', 'All on the other person'],
    ['custom', 'Custom %'],
  ];
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>${existing ? 'Edit' : 'Add'} expense</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <input class="input amount-input" id="j-amt" inputmode="decimal" placeholder="$0" value="${e.amount || ''}">
    <div class="field mt"><label>What for</label><input class="input" id="j-desc" value="${escapeHtml(e.desc || '')}" placeholder="e.g. Weekly shop"></div>
    <div class="field"><label>Category</label><select class="input" id="j-cat">
      ${cats.map((c) => `<option value="${c.id}" ${c.id === e.categoryId ? 'selected' : ''}>${escapeHtml(c.name)}${c.kind === 'fixed' ? ' (fixed)' : ''}</option>`).join('')}</select></div>
    <div class="field"><label>Who paid</label><div class="seg" id="j-payer">
      ${people.map((p) => `<button data-p="${p.id}" class="${p.id === e.payerId ? 'active' : ''}">${escapeHtml(p.name)}${p.id === meId ? ' (you)' : ''}</button>`).join('')}</div></div>
    <div class="field"><label>Split</label><select class="input" id="j-rule">
      ${RULES.map(([v, l]) => `<option value="${v}" ${v === (e.rule || '') ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select></div>
    <div class="field" id="j-custom-wrap" style="display:none"><label>Payer's share: <span id="j-pct-l">50</span>%</label>
      <input type="range" min="0" max="100" step="5" class="range" id="j-pct" value="${e.customPct || 50}"></div>
    <div class="field"><label>Date</label><input class="input" type="date" id="j-date" value="${e.date}"></div>
    <div class="j-preview" id="j-preview"></div>
    <button class="btn primary mt" id="j-save">${existing ? 'Save' : 'Add'} expense</button>
    ${existing ? `<button class="btn danger mt" id="j-del"><i class="ti ti-trash"></i> Delete</button>` : ''}
  `);

  let payerId = e.payerId || meId;
  const q = (s) => sheet.querySelector(s);
  const refresh = () => {
    const rule = q('#j-rule').value;
    q('#j-custom-wrap').style.display = rule === 'custom' ? '' : 'none';
    q('#j-pct-l').textContent = q('#j-pct').value;
    // Show exactly what each person ends up carrying, before saving.
    const amt = Split.CENTS(parseAmount(q('#j-amt').value));
    const c = catOf(q('#j-cat').value);
    const eff = rule || c?.rule || 'ratio';
    const shares = Split.shareOf(amt, { rule: eff, customPct: Number(q('#j-pct').value), payerId }, people,
      Split.incomeRatios(people, basis()));
    q('#j-preview').innerHTML = amt
      ? people.map((p) => `<div><span>${escapeHtml(p.name)}</span><b>${fmtMoney(Split.DOLLARS(shares[p.id]))}</b></div>`).join('')
      : '';
  };
  ['#j-amt', '#j-cat', '#j-rule', '#j-pct'].forEach((s) => {
    q(s).addEventListener('input', refresh); q(s).addEventListener('change', refresh);
  });
  sheet.querySelectorAll('#j-payer button').forEach((b) => b.addEventListener('click', () => {
    payerId = b.dataset.p;
    sheet.querySelectorAll('#j-payer button').forEach((x) => x.classList.toggle('active', x === b));
    refresh();
  }));
  refresh();

  q('#j-save').addEventListener('click', async () => {
    const amount = parseAmount(q('#j-amt').value);
    if (!amount) return toast('Enter an amount', true);
    await save('jointExpenses', {
      ...e, amount, desc: q('#j-desc').value.trim(), categoryId: q('#j-cat').value,
      payerId, rule: q('#j-rule').value, customPct: Number(q('#j-pct').value),
      date: q('#j-date').value || todayISO(),
    });
    closeSheet(); render(); toast(existing ? 'Saved' : 'Added');
  });
  q('#j-del')?.addEventListener('click', async () => {
    await remove('jointExpenses', e.id); closeSheet(); render(); toast('Deleted');
  });
  setTimeout(() => q('#j-amt').focus(), 100);
}

// --- settle up ----------------------------------------------------------------
function settleSheet() {
  const pos = Split.positions({ people, expenses, settlements, basis: basis() });
  const bal = Split.balanceBetween(people, pos.net);
  if (bal.settled) return toast('Already square');
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Settle up</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="hint">Record money actually handed over. This clears the balance — it doesn't move any real money.</div>
    <div class="hero mt center"><div class="label">${escapeHtml(bal.debtor.name)} pays ${escapeHtml(bal.creditor.name)}</div>
      <div class="amount">${fmtMoney(bal.amount)}</div></div>
    <div class="field mt"><label>Amount</label><input class="input" id="s-amt" inputmode="decimal" value="${bal.amount.toFixed(2)}"></div>
    <div class="field"><label>Note</label><input class="input" id="s-note" placeholder="Optional"></div>
    <button class="btn primary" id="s-go"><i class="ti ti-check"></i> Record payment</button>
  `);
  sheet.querySelector('#s-go').addEventListener('click', async () => {
    const amount = parseAmount(sheet.querySelector('#s-amt').value);
    if (!amount) return toast('Enter an amount', true);
    await save('jointSettlements', {
      id: uid('js_'), date: todayISO(), fromId: bal.debtor.id, toId: bal.creditor.id,
      amount, note: sheet.querySelector('#s-note').value.trim(),
    });
    closeSheet(); render(); toast('Settled');
  });
}

function historySheet() {
  const rows = [...settlements].sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id));
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Settlements</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="card">${rows.length ? rows.map((s) => `<div class="row">
      <div class="ic"><i class="ti ti-arrow-right"></i></div>
      <div class="main"><div class="t">${escapeHtml(personOf(s.fromId)?.name || '?')} → ${escapeHtml(personOf(s.toId)?.name || '?')}</div>
        <div class="s">${escapeHtml(fmtDate(s.date))}${s.note ? ' · ' + escapeHtml(s.note) : ''}</div></div>
      <div class="amt">${fmtMoney(s.amount)}</div>
      <button class="mini-btn" data-s-del="${s.id}" aria-label="Delete"><i class="ti ti-x"></i></button>
    </div>`).join('') : '<div class="tiny muted center" style="padding:16px">Nothing settled yet.</div>'}</div>
  `);
  sheet.querySelectorAll('[data-s-del]').forEach((b) => b.addEventListener('click', async () => {
    await remove('jointSettlements', b.dataset.sDel); closeSheet(); render(); toast('Removed');
  }));
}

// --- fixed monthly ------------------------------------------------------------
function recurringSheet() {
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Fixed monthly</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="hint">Rent, insurance and the like. These post themselves on their due date, so neither of you has to remember.</div>
    <div class="card mt">${recurring.length ? recurring.map((r) => `<div class="row tappable" data-r-edit="${r.id}">
      <div class="ic"><i class="ti ${escapeHtml(catOf(r.categoryId)?.icon || 'ti-calendar')}"></i></div>
      <div class="main"><div class="t">${escapeHtml(r.name)}</div>
        <div class="s">${escapeHtml(r.frequency || 'monthly')} · next ${escapeHtml(fmtDateShort(r.nextDate))} · ${escapeHtml(personOf(r.payerId)?.name || '?')} pays</div></div>
      <div class="amt neg">${fmtMoney(r.amount)}</div>
    </div>`).join('') : '<div class="tiny muted center" style="padding:16px">Nothing scheduled.</div>'}</div>
    <button class="btn primary mt2" id="r-add"><i class="ti ti-plus"></i> Add fixed expense</button>
  `);
  sheet.querySelector('#r-add').addEventListener('click', () => recurringEditor());
  sheet.querySelectorAll('[data-r-edit]').forEach((el) => el.addEventListener('click',
    () => recurringEditor(recurring.find((r) => r.id === el.dataset.rEdit))));
}

function recurringEditor(existing) {
  const r = existing || { id: uid('jr_'), name: '', amount: '', categoryId: cats.find((c) => c.kind === 'fixed')?.id || cats[0]?.id, payerId: meId, frequency: 'monthly', nextDate: todayISO(), rule: '' };
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>${existing ? 'Edit' : 'Add'} fixed expense</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="field"><label>Name</label><input class="input" id="r-name" value="${escapeHtml(r.name)}" placeholder="e.g. Rent"></div>
    <div class="field"><label>Amount</label><input class="input" id="r-amt" inputmode="decimal" value="${r.amount}"></div>
    <div class="field"><label>Category</label><select class="input" id="r-cat">
      ${cats.map((c) => `<option value="${c.id}" ${c.id === r.categoryId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Who pays it</label><div class="seg" id="r-payer">
      ${people.map((p) => `<button data-p="${p.id}" class="${p.id === r.payerId ? 'active' : ''}">${escapeHtml(p.name)}</button>`).join('')}</div></div>
    <div class="grid2">
      <div class="field"><label>Every</label><select class="input" id="r-freq">
        ${['weekly', 'monthly', 'yearly'].map((f) => `<option ${f === r.frequency ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
      <div class="field"><label>Next due</label><input class="input" type="date" id="r-date" value="${r.nextDate}"></div>
    </div>
    <button class="btn primary mt" id="r-save">${existing ? 'Save' : 'Add'}</button>
    ${existing ? `<button class="btn danger mt" id="r-del"><i class="ti ti-trash"></i> Delete</button>` : ''}
  `);
  let payerId = r.payerId;
  sheet.querySelectorAll('#r-payer button').forEach((b) => b.addEventListener('click', () => {
    payerId = b.dataset.p;
    sheet.querySelectorAll('#r-payer button').forEach((x) => x.classList.toggle('active', x === b));
  }));
  sheet.querySelector('#r-save').addEventListener('click', async () => {
    const name = sheet.querySelector('#r-name').value.trim();
    const amount = parseAmount(sheet.querySelector('#r-amt').value);
    if (!name || !amount) return toast('Name and amount are needed', true);
    await save('jointRecurring', { ...r, name, amount, payerId,
      categoryId: sheet.querySelector('#r-cat').value,
      frequency: sheet.querySelector('#r-freq').value,
      nextDate: sheet.querySelector('#r-date').value || todayISO(), paused: false });
    closeSheet(); await materialiseRecurring(); render(); toast('Saved');
  });
  sheet.querySelector('#r-del')?.addEventListener('click', async () => {
    await remove('jointRecurring', r.id); closeSheet(); render(); toast('Deleted');
  });
}

// --- settings -----------------------------------------------------------------
function settingsSheet() {
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Joint settings</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="field"><label>Split fixed costs using</label>
      <div class="seg" id="j-basis">
        <button data-b="net" class="${basis() === 'net' ? 'active' : ''}">Take-home</button>
        <button data-b="gross" class="${basis() === 'gross' ? 'active' : ''}">Gross</button>
      </div>
      <div class="hint mt">Take-home usually reflects what each of you can actually contribute.</div></div>
    <div class="section-title">Incomes</div>
    <div class="card">${people.map((p) => `<div class="row tappable" data-p-edit="${p.id}">
      <div class="ic"><i class="ti ti-user"></i></div>
      <div class="main"><div class="t">${escapeHtml(p.name)}${p.id === meId ? ' (you)' : ''}</div>
        <div class="s">gross ${fmtMoney(p.incomeGross || 0, { compact: true })} · take-home ${fmtMoney(p.incomeNet || 0, { compact: true })}</div></div>
      <i class="ti ti-chevron-right muted"></i></div>`).join('')}</div>
    <div class="section-title">Categories</div>
    <div class="card">${cats.map((c) => `<div class="row tappable" data-c-edit="${c.id}">
      <div class="ic"><i class="ti ${escapeHtml(c.icon)}"></i></div>
      <div class="main"><div class="t">${escapeHtml(c.name)}</div>
        <div class="s">${c.kind} · ${c.rule === 'equal' ? 'split 50/50' : 'by income'}</div></div>
      <i class="ti ti-chevron-right muted"></i></div>`).join('')}</div>
    <button class="btn ghost mt2" data-j-sync><i class="ti ti-users"></i> Sharing</button>
  `);
  sheet.querySelectorAll('#j-basis button').forEach((b) => b.addEventListener('click', async () => {
    await save('jointMeta', { id: 'config', basis: b.dataset.b });
    closeSheet(); render(); toast('Split basis updated');
  }));
  sheet.querySelectorAll('[data-p-edit]').forEach((el) => el.addEventListener('click',
    () => personEditor(personOf(el.dataset.pEdit))));
  sheet.querySelectorAll('[data-c-edit]').forEach((el) => el.addEventListener('click',
    () => categoryEditor(catOf(el.dataset.cEdit))));
  sheet.querySelector('[data-j-sync]').addEventListener('click', syncSheet);
}

function personEditor(p) {
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>${escapeHtml(p.name)}</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="field"><label>Name</label><input class="input" id="p-name" value="${escapeHtml(p.name)}"></div>
    <div class="grid2">
      <div class="field"><label>Gross</label><input class="input" id="p-g" inputmode="decimal" value="${p.incomeGross || 0}"></div>
      <div class="field"><label>Take-home</label><input class="input" id="p-t" inputmode="decimal" value="${p.incomeNet || 0}"></div>
    </div>
    <button class="btn primary" id="p-save">Save</button>
  `);
  sheet.querySelector('#p-save').addEventListener('click', async () => {
    await save('jointPeople', { ...p, name: sheet.querySelector('#p-name').value.trim() || p.name,
      incomeGross: parseAmount(sheet.querySelector('#p-g').value),
      incomeNet: parseAmount(sheet.querySelector('#p-t').value) });
    closeSheet(); render(); toast('Saved');
  });
}

function categoryEditor(c) {
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>${escapeHtml(c.name)}</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="field"><label>Name</label><input class="input" id="c-name" value="${escapeHtml(c.name)}"></div>
    <div class="field"><label>Type</label><div class="seg" id="c-kind">
      <button data-k="fixed" class="${c.kind === 'fixed' ? 'active' : ''}">Fixed</button>
      <button data-k="variable" class="${c.kind === 'variable' ? 'active' : ''}">Variable</button></div></div>
    <div class="field"><label>Split by default</label><div class="seg" id="c-rule">
      <button data-r="ratio" class="${c.rule !== 'equal' ? 'active' : ''}">Income ratio</button>
      <button data-r="equal" class="${c.rule === 'equal' ? 'active' : ''}">50/50</button></div></div>
    <button class="btn primary mt" id="c-save">Save</button>
    <button class="btn danger mt" id="c-del"><i class="ti ti-trash"></i> Delete category</button>
  `);
  let kind = c.kind, rule = c.rule || 'ratio';
  sheet.querySelectorAll('#c-kind button').forEach((b) => b.addEventListener('click', () => {
    kind = b.dataset.k; sheet.querySelectorAll('#c-kind button').forEach((x) => x.classList.toggle('active', x === b));
  }));
  sheet.querySelectorAll('#c-rule button').forEach((b) => b.addEventListener('click', () => {
    rule = b.dataset.r; sheet.querySelectorAll('#c-rule button').forEach((x) => x.classList.toggle('active', x === b));
  }));
  sheet.querySelector('#c-save').addEventListener('click', async () => {
    await save('jointCategories', { ...c, name: sheet.querySelector('#c-name').value.trim() || c.name, kind, rule });
    closeSheet(); render(); toast('Saved');
  });
  sheet.querySelector('#c-del').addEventListener('click', async () => {
    if (expenses.some((e) => e.categoryId === c.id)) return toast('Category is in use', true);
    await remove('jointCategories', c.id); closeSheet(); render(); toast('Deleted');
  });
}

// --- sharing ------------------------------------------------------------------
// Reuses the same encrypted room as Household; one pairing covers both.
function syncSheet() {
  const on = Sync.isConfigured();
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Share live</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    ${on ? `
      <div class="alert warn"><i class="ti ti-wifi"></i> Live. Both phones see expenses and settlements within a second.</div>
      <div class="field mt"><label>Pairing code — send to your partner</label>
        <textarea class="input mono" rows="3" readonly>${escapeHtml(Sync.makePairingCode())}</textarea></div>
      <button class="btn primary" id="y-copy"><i class="ti ti-copy"></i> Copy pairing code</button>
    ` : `
      <div class="hint">Joint uses the same encrypted connection as Household — pair once and both share. Contents are encrypted on this phone first.</div>
      <div class="field mt"><label>Paste a pairing code</label>
        <textarea class="input mono" id="y-in" rows="3" placeholder="Paste from the other phone"></textarea></div>
      <button class="btn primary" id="y-join"><i class="ti ti-link"></i> Join</button>
      <div class="section-title">Or start the connection here</div>
      <div class="field"><label>Firebase Realtime Database URL</label>
        <input class="input" id="y-url" placeholder="https://your-app-default-rtdb.firebaseio.com"></div>
      <button class="btn" id="y-create"><i class="ti ti-plus"></i> Create shared connection</button>
      <div class="hint mt">One free Firebase project covers Joint and Household together. Steps are in SETUP-SYNC.md.</div>
    `}
  `);
  sheet.querySelector('#y-create')?.addEventListener('click', async () => {
    const dbUrl = sheet.querySelector('#y-url').value.trim();
    if (!/^https:\/\/.+firebase/.test(dbUrl)) return toast('Paste your Realtime Database URL', true);
    await Sync.saveConfig(Sync.newRoom(dbUrl));
    Sync.start(STORES, async () => { await load(); render(); });
    await Sync.pushAll(STORES);
    render(); syncSheet();   // replace in place: closing first lets the pending popstate shut the new sheet
    toast('Connection created');
  });
  sheet.querySelector('#y-copy')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(Sync.makePairingCode()); toast('Copied'); } catch { toast('Copy failed', true); }
  });
  sheet.querySelector('#y-join')?.addEventListener('click', async () => {
    try {
      await Sync.saveConfig(Sync.parsePairingCode(sheet.querySelector('#y-in').value));
      Sync.start(STORES, async () => { await load(); render(); });
      await Sync.pushAll(STORES);
      closeSheet(); render(); toast('Connected');
    } catch { toast('That code doesn’t look right', true); }
  });
}

// --- wiring -------------------------------------------------------------------
function bind() {
  const root = $app();
  root.querySelector('[data-hub]').addEventListener('click', () => hubHandler && hubHandler());
  root.querySelector('[data-j-settings]')?.addEventListener('click', settingsSheet);
  root.querySelector('[data-j-add]')?.addEventListener('click', () => expenseSheet());
  root.querySelector('[data-j-settle]')?.addEventListener('click', settleSheet);
  root.querySelector('[data-j-recurring]')?.addEventListener('click', recurringSheet);
  root.querySelector('[data-j-history]')?.addEventListener('click', historySheet);
  root.querySelector('[data-j-sync]')?.addEventListener('click', syncSheet);
  root.querySelectorAll('#j-tab button').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.jTab; render(); }));
  root.querySelectorAll('[data-j-edit]').forEach((el) => el.addEventListener('click',
    () => expenseSheet(expenses.find((x) => x.id === el.dataset.jEdit))));
}
