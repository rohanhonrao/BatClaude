// app.js — Sanctum finance module, router, and views.
import { db, uid, exportAll, importAll } from './db.js';
import {
  loadSettings, getSetting, setSetting, settings, seedIfEmpty,
  fmtMoney, parseAmount, todayISO, fmtDate, fmtDateShort, monthKey, thisMonth,
  monthLabel, addMonths, addDays, relativeDay, escapeHtml, currencySymbol,
  CURRENCIES, isoDate, fmtMoneyIn, currencyName, currencySymbolOf, icon as ico, ICON_CHOICES,
} from './util.js';
import * as C from './compute.js';
import * as Rates from './rates.js';
import * as charts from './charts.js';
import * as P from './projection.js';
import { csvToObjects, guessMapping, rowsToTransactions, transactionsToCSV } from './csv.js';

// --- Global state -----------------------------------------------------------
const S = {
  accounts: [], transactions: [], categories: [], budgets: [],
  recurring: [], goals: [], holdings: [],
  route: 'dashboard',
  month: thisMonth(),
  txFilter: 'all',
  txSearch: '',
  homeView: 'cashflow',   // 'cashflow' | 'expenses'
  cfAccount: 'all',       // 'all' or an account id
  cfHorizon: 60,          // days
};

// --- Account kinds ----------------------------------------------------------
// Derived so legacy accounts (which only had `type`) work with no migration.
const CASH_KINDS = ['checking', 'savings', 'cash'];
export function kindOf(a) {
  if (a.kind) return a.kind;
  const t = String(a.type || '').toLowerCase();
  if (t === 'savings') return 'savings';
  if (t === 'cash' || t === 'wallet') return 'cash';
  if (t === 'credit') return 'credit';
  return 'checking';
}
const KIND_ICON = { checking: 'ti-building-bank', savings: 'ti-pig-money', cash: 'ti-cash', credit: 'ti-credit-card' };
// Accounts that participate in cash flow (credit cards deliberately excluded for now).
function cashAccounts() {
  return S.accounts.filter((a) => !a.archived && CASH_KINDS.includes(kindOf(a)));
}
function cfSelection() {
  const list = cashAccounts();
  if (S.cfAccount === 'all') return list;
  const one = list.find((a) => a.id === S.cfAccount);
  return one ? [one] : list;
}

// Module lifecycle (managed by the shell)
let financeMounted = false;
let financeWired = false;
let onExitHub = null;
export function setHubHandler(fn) { onExitHub = fn; }

const $app = () => document.getElementById('app');

async function refresh() {
  const [accounts, transactions, categories, budgets, recurring, goals, holdings] = await Promise.all([
    db.all('accounts'), db.all('transactions'), db.all('categories'),
    db.all('budgets'), db.all('recurring'), db.all('goals'), db.all('holdings'),
  ]);
  Object.assign(S, { accounts, transactions, categories, budgets, recurring, goals, holdings });
}

// Lookups
const cat = (id) => S.categories.find((c) => c.id === id);
const acct = (id) => S.accounts.find((a) => a.id === id);
const catName = (id) => (cat(id) || {}).name || 'Uncategorized';
const catIcon = (id) => (cat(id) || {}).icon || 'ti-package';
const catColor = (id) => (cat(id) || {}).color || 'var(--faint)';

// --- Render -----------------------------------------------------------------
const VIEWS = {};
async function render() {
  const view = VIEWS[S.route] || VIEWS.dashboard;
  $app().innerHTML = view();
  setActiveNav();
  // Post-render hooks
  if (view.after) view.after();
}
function navigate(route) {
  S.route = route;
  window.scrollTo(0, 0);
  render();
}
function setActiveNav() {
  const map = { dashboard: 'dashboard', transactions: 'transactions', budgets: 'budgets' };
  const active = map[S.route] || 'more';
  document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.nav === active));
}

// --- Toast ------------------------------------------------------------------
let toastTimer;
function toast(msg, isErr = false) {
  let el = document.getElementById('toast');
  el.textContent = msg;
  el.className = isErr ? 'err show' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 2200);
}

// --- Sheet (bottom modal) ---------------------------------------------------
function openSheet(html) {
  closeSheet();
  const bd = document.createElement('div');
  bd.className = 'sheet-backdrop';
  bd.id = 'sheet-bd';
  bd.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="grabber"></div>${html}</div>`;
  bd.addEventListener('click', (e) => { if (e.target === bd) closeSheet(); });
  document.body.appendChild(bd);
  document.body.style.overflow = 'hidden';
  return bd.querySelector('.sheet');
}
function closeSheet() {
  const bd = document.getElementById('sheet-bd');
  if (bd) bd.remove();
  document.body.style.overflow = '';
}

// --- Small render helpers ---------------------------------------------------
function money(n, cls = '') {
  const c = n < 0 ? 'neg' : 'pos';
  return `<span class="amt ${c} ${cls}">${fmtMoney(n)}</span>`;
}
function monthNav(onLabel) {
  return `<div class="spread card" style="padding:10px 14px;">
    <button class="header-btn" data-month="-1">‹</button>
    <div class="center"><b>${escapeHtml(monthLabel(S.month))}</b>${onLabel ? `<div class="tiny muted">${onLabel}</div>` : ''}</div>
    <button class="header-btn" data-month="1" ${S.month >= thisMonth() ? 'style="opacity:.3"' : ''}>›</button>
  </div>`;
}
function txRow(t) {
  const isTransfer = t.type === 'transfer';
  const sign = t.type === 'income' ? 1 : -1;
  const icon = isTransfer ? ico('ti-arrows-exchange') : ico(catIcon(t.categoryId));
  const color = isTransfer ? 'var(--blue)' : catColor(t.categoryId);
  const title = isTransfer ? `${acct(t.accountId)?.name || '?'} → ${acct(t.toAccountId)?.name || '?'}`
    : (t.note || catName(t.categoryId));
  const sub = isTransfer ? 'Transfer' : `${catName(t.categoryId)} · ${acct(t.accountId)?.name || ''}`;
  const amtCls = t.type === 'income' ? 'pos' : t.type === 'transfer' ? 'muted' : 'neg';
  const amtStr = (t.type === 'income' ? '+' : t.type === 'expense' ? '-' : '') + fmtMoney(t.amount);
  const upcoming = t.date > todayISO();
  return `<div class="row tappable ${upcoming ? 'upcoming' : ''}" data-edit-tx="${t.id}">
    <div class="ic" style="background:${color}22;color:${color}">${icon}</div>
    <div class="main"><div class="t">${escapeHtml(title)}</div>
      <div class="s">${upcoming ? `<span class="pill up">Upcoming</span> ` : ''}${escapeHtml(sub)}</div></div>
    <div class="amt ${amtCls}">${amtStr}</div>
  </div>`;
}

function groupByDate(list) {
  const groups = {};
  for (const t of list) (groups[t.date] ||= []).push(t);
  return Object.keys(groups).sort((a, b) => b.localeCompare(a)).map((d) => ({ date: d, items: groups[d] }));
}

// ============================================================================
// VIEW: Dashboard
// ============================================================================
VIEWS.dashboard = function () {
  return `<div class="view">
    ${header('Welcome back, ' + (getSetting('name') || 'Wayne'))}
    <div class="seg" id="home-toggle">
      <button data-home-view="cashflow" class="${S.homeView === 'cashflow' ? 'active' : ''}"><i class="ti ti-wave-sine"></i> Cash flow</button>
      <button data-home-view="expenses" class="${S.homeView === 'expenses' ? 'active' : ''}"><i class="ti ti-chart-donut"></i> Expenses</button>
    </div>
    ${S.homeView === 'cashflow' ? cashflowBody() : expensesBody()}
  </div>`;
};

// --- Cash flow (forward-looking) -------------------------------------------
function cashflowBody() {
  const accts = cashAccounts();
  if (!accts.length) {
    return `${emptyState('ti-building-bank', 'No accounts yet', 'Add a checking or savings account to project your cash flow')}
      <button class="btn primary" data-add-account><i class="ti ti-plus"></i> Add account</button>`;
  }
  const sel = cfSelection();
  const today = todayISO();
  const proj = P.project({
    accounts: sel, transactions: S.transactions, rules: S.recurring,
    today, horizonDays: S.cfHorizon,
  });
  const buffer = sel.reduce((s, a) => s + (a.buffer || 0), 0);
  const belowBuffer = proj.lowest.balance < buffer && buffer > 0;
  const negative = proj.lowest.balance < 0;

  const chips = `<div class="chips mt">
    <button class="chip ${S.cfAccount === 'all' ? 'active' : ''}" data-cf-account="all">All</button>
    ${accts.map((a) => `<button class="chip ${S.cfAccount === a.id ? 'active' : ''}" data-cf-account="${a.id}">
      <i class="ti ${KIND_ICON[kindOf(a)] || 'ti-wallet'}"></i>${escapeHtml(a.name)}</button>`).join('')}
  </div>`;

  const horizons = `<div class="seg mt" id="cf-horizon">
    ${[30, 60, 90].map((d) => `<button data-cf-horizon="${d}" class="${S.cfHorizon === d ? 'active' : ''}">${d} days</button>`).join('')}
  </div>`;

  // Spendable vs reserves split (only meaningful on the combined view)
  let split = '';
  if (S.cfAccount === 'all') {
    const spendable = accts.filter((a) => kindOf(a) !== 'savings')
      .reduce((s, a) => s + P.balanceAsOf(a, S.transactions, today), 0);
    const reserves = accts.filter((a) => kindOf(a) === 'savings')
      .reduce((s, a) => s + P.balanceAsOf(a, S.transactions, today), 0);
    split = `<div class="hero-split">
      <div><span class="label">Spendable</span><b>${fmtMoney(spendable)}</b></div>
      <div><span class="label">Reserves</span><b>${fmtMoney(reserves)}</b></div>
    </div>`;
  }

  const ledger = proj.events.length
    ? proj.events.map((e) => `<div class="row ${e.logged || e.ruleId ? 'tappable' : ''}" ${
        e.logged && e.txId ? `data-edit-tx="${e.txId}"` : e.ruleId ? `data-edit-recurring="${e.ruleId}"` : ''}>
        <div class="cf-date">${escapeHtml(fmtDateShort(e.date))}</div>
        <div class="main"><div class="t">${escapeHtml(e.name || catName(e.categoryId))}</div>
          ${e.logged ? '<div class="s">logged</div>' : ''}</div>
        <div class="amt ${e.delta > 0 ? 'pos' : 'neg'}">${e.delta > 0 ? '+' : '−'}${fmtMoney(Math.abs(e.delta))}</div>
        <div class="cf-run ${e.balance < buffer ? 'warn' : ''}">${fmtMoney(e.balance, { compact: true })}</div>
      </div>`).join('')
    : `<div class="empty"><span class="em"><i class="ti ti-calendar"></i></span><div>Nothing scheduled</div>
        <div class="tiny mt">Add your rent, salary and bills to see the road ahead</div></div>`;

  return `${chips}
    <div class="hero mt">
      <div class="label">${sel.length === 1 ? escapeHtml(sel[0].name) : 'All cash accounts'} · today</div>
      <div class="amount">${fmtMoney(proj.start)}</div>
      ${split}
    </div>
    ${horizons}
    <div class="stat-row">
      <div class="stat"><div class="k">Lowest point</div>
        <div class="v ${negative || belowBuffer ? 'neg' : ''}">${fmtMoney(proj.lowest.balance)}</div>
        <div class="tiny muted">${proj.lowest.date === today ? 'today' : fmtDateShort(proj.lowest.date)}${belowBuffer ? ' · below buffer' : ''}</div></div>
      <div class="stat"><div class="k">In ${S.cfHorizon} days</div>
        <div class="v ${proj.totals.net >= 0 ? 'pos' : 'neg'}">${fmtMoney(proj.endBalance)}</div>
        <div class="tiny muted">${fmtMoney(proj.totals.net, { sign: true })} net</div></div>
    </div>
    ${negative ? `<div class="alert danger mt"><i class="ti ti-alert-triangle"></i> Projected to go negative on ${escapeHtml(fmtDate(proj.lowest.date))}.</div>`
      : belowBuffer ? `<div class="alert warn mt"><i class="ti ti-alert-triangle"></i> Dips below your ${fmtMoney(buffer)} buffer on ${escapeHtml(fmtDate(proj.lowest.date))}.</div>` : ''}
    <div class="card mt">${charts.projectionChart(proj.points, { buffer, lowest: proj.lowest })}
      <div class="tiny muted center">Projected from scheduled items only · dashed = future</div></div>
    <div class="section-title spread"><span>Upcoming</span><a data-nav-link="recurring">Manage ›</a></div>
    <div class="card">${ledger}</div>
    <button class="btn mt2" data-add-recurring><i class="ti ti-calendar-plus"></i> Add scheduled item</button>`;
}

// --- Expenses (backward-looking) -------------------------------------------
function expensesBody() {
  const flow = C.monthlyFlow(S.transactions, S.month);
  const byCat = C.spendByCategory(S.transactions, S.month).slice(0, 6);
  const budgets = C.budgetStatus(S.budgets, S.transactions, S.categories, S.month);
  // Backward-looking view: only what has actually happened.
  const recent = [...S.transactions]
    .filter((t) => monthKey(t.date) === S.month && t.type !== 'transfer' && t.date <= todayISO())
    .sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id)).slice(0, 6);

  const segs = byCat.map((r) => ({ label: catName(r.categoryId), value: r.total, color: catColor(r.categoryId) }));
  const legend = byCat.map((r) => `<div class="li"><span class="dot" style="background:${catColor(r.categoryId)}"></span>
    ${escapeHtml(catName(r.categoryId))}<span class="lv">${fmtMoney(r.total)}</span></div>`).join('');

  return `<div class="mt">${monthNav()}</div>
    <div class="stat-row">
      <div class="stat"><div class="k">↓ Income</div><div class="v pos">${fmtMoney(flow.income)}</div></div>
      <div class="stat"><div class="k">↑ Expenses</div><div class="v neg">${fmtMoney(flow.expense)}</div></div>
    </div>
    <div class="tiny muted center mt">Net this month:
      <b style="color:${flow.net >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtMoney(flow.net, { sign: true })}</b></div>

    ${segs.length ? `<div class="section-title">Spending by category</div>
    <div class="card"><div class="donut-wrap">
      ${charts.donut(segs, { centerLabel: fmtMoney(flow.expense, { compact: true }), centerSub: 'spent' })}
      <div class="legend">${legend}</div>
    </div></div>` : emptyState('ti-chart-donut', 'No spending this month', 'Tap + to log an expense')}

    ${budgets.length ? `<div class="section-title spread"><span>Budgets</span><a data-nav-link="budgets">All ›</a></div>
    <div class="card">${budgets.slice(0, 3).map(budgetRow).join('')}</div>` : ''}

    <div class="section-title spread"><span>Recent</span><a data-nav-link="transactions">All ›</a></div>
    <div class="card">${recent.length ? recent.map(txRow).join('') : emptyState('ti-receipt', 'No transactions yet', 'Tap + to add your first one')}</div>`;
}

// ============================================================================
// VIEW: Net worth (moved out of Home)
// ============================================================================
VIEWS.networth = function () {
  const nw = C.netWorth(S.accounts, S.transactions, S.holdings);
  const nwTrend = C.netWorthTrend(S.accounts, S.transactions, S.holdings, 6);
  const flowTrend = C.flowTrend(S.transactions, 6);
  return `<div class="view">
    ${subHeader('Net Worth')}
    <div class="hero">
      <div class="label">Net Worth</div>
      <div class="amount">${fmtMoney(nw.total)}</div>
      <div class="breakdown">
        <div>Liquid<b>${fmtMoney(nw.liquid)}</b></div>
        <div>Investments<b>${fmtMoney(nw.invest)}</b></div>
      </div>
    </div>
    <div class="section-title">Trend</div>
    <div class="card">${charts.lineChart(nwTrend)}</div>
    <div class="section-title">Income vs expenses</div>
    <div class="card">${charts.barsIncomeExpense(flowTrend)}</div>
    <button class="btn mt2" data-nav-link="accounts"><i class="ti ti-building-bank"></i> Accounts</button>
    <button class="btn mt" data-nav-link="investments"><i class="ti ti-chart-line"></i> Investments</button>
  </div>`;
};

function budgetRow(b) {
  return `<div class="mt" style="margin-bottom:14px" data-edit-budget="${b.id}">
    <div class="spread"><span>${ico(b.category.icon)} ${escapeHtml(b.category.name)}</span>
    <span class="tiny tabular ${b.over ? '' : 'muted'}" style="${b.over ? 'color:var(--red)' : ''}">${fmtMoney(b.used)} / ${fmtMoney(b.amount)}</span></div>
    <div class="bar ${b.over ? 'over' : ''}"><span style="width:${Math.round(b.pct * 100)}%"></span></div>
  </div>`;
}
const FREQ_LABEL = { once: 'one-off', weekly: 'weekly', biweekly: 'every 2 weeks',
  semimonthly: 'twice a month', monthly: 'monthly', quarterly: 'quarterly', yearly: 'yearly' };
function recurringRow(r) {
  const c = cat(r.categoryId);
  const isTransfer = r.type === 'transfer';
  const icon = isTransfer ? ico('ti-arrows-exchange') : ico(c?.icon, 'ti-calendar-repeat');
  const sub = `${relativeDay(r.nextDate)} · ${escapeHtml(FREQ_LABEL[r.frequency] || r.frequency)}${r.paused ? ' · paused' : ''}`;
  const sign = r.type === 'income' ? '+' : '−';
  return `<div class="row tappable ${r.paused ? 'dim' : ''}" data-edit-recurring="${r.id}">
    <div class="ic" style="background:var(--surface-2)">${icon}</div>
    <div class="main"><div class="t">${escapeHtml(r.name)}</div><div class="s">${sub}</div></div>
    <div class="amt ${r.type === 'income' ? 'pos' : isTransfer ? 'muted' : 'neg'}">${isTransfer ? '' : sign}${fmtMoney(r.amount)}</div>
  </div>`;
}

// ============================================================================
// VIEW: Transactions
// ============================================================================
VIEWS.transactions = function () {
  let list = S.transactions.filter((t) => monthKey(t.date) === S.month);
  if (S.txFilter !== 'all') list = list.filter((t) => t.type === S.txFilter);
  if (S.txSearch) {
    const q = S.txSearch.toLowerCase();
    list = list.filter((t) => (t.note || '').toLowerCase().includes(q) || catName(t.categoryId).toLowerCase().includes(q));
  }
  list.sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id));
  const flow = C.monthlyFlow(list.filter(() => true), null);
  // flow over the filtered list irrespective of month restriction already applied
  let income = 0, expense = 0;
  for (const t of list) { if (t.type === 'income') income += t.amount; else if (t.type === 'expense') expense += t.amount; }

  const groups = groupByDate(list);
  return `<div class="view">
    ${header('Transactions')}
    ${monthNav()}
    <div class="stat-row" style="margin-top:12px">
      <div class="stat"><div class="k">Income</div><div class="v pos tabular">${fmtMoney(income)}</div></div>
      <div class="stat"><div class="k">Expenses</div><div class="v neg tabular">${fmtMoney(expense)}</div></div>
    </div>
    <div class="mt"><input class="input" id="tx-search" placeholder="Search notes or categories…" value="${escapeHtml(S.txSearch)}"></div>
    <div class="seg mt" id="tx-filter">
      ${['all', 'expense', 'income', 'transfer'].map((f) => `<button data-f="${f}" class="${S.txFilter === f ? 'active' : ''}">${f[0].toUpperCase() + f.slice(1)}</button>`).join('')}
    </div>
    ${groups.length ? groups.map((g) => `
      <div class="section-title">${dateHeading(g.date)}</div>
      <div class="card">${g.items.map(txRow).join('')}</div>
    `).join('') : emptyState('ti-search', 'Nothing here', 'No transactions match this view')}
  </div>`;
};
VIEWS.transactions.after = function () {
  const s = document.getElementById('tx-search');
  if (s) s.addEventListener('input', (e) => { S.txSearch = e.target.value; rerenderBody(); });
};
function dateHeading(d) {
  const rel = relativeDay(d);
  return /Today|Yesterday|days|Tomorrow/.test(rel) ? `${rel} · ${fmtDateShort(d)}` : fmtDate(d);
}

// Re-render only the app body without losing scroll focus behaviour (used by search)
function rerenderBody() {
  const scroll = window.scrollY;
  render();
  window.scrollTo(0, scroll);
  const s = document.getElementById('tx-search');
  if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}

// ============================================================================
// VIEW: Budgets
// ============================================================================
VIEWS.budgets = function () {
  const statuses = C.budgetStatus(S.budgets, S.transactions, S.categories, S.month);
  const totalBudget = statuses.reduce((s, b) => s + b.amount, 0);
  const totalUsed = statuses.reduce((s, b) => s + b.used, 0);
  const pct = totalBudget > 0 ? Math.min(totalUsed / totalBudget, 1) : 0;
  const unbudgeted = S.categories.filter((c) => c.type === 'expense' && !c.archived && !S.budgets.find((b) => b.categoryId === c.id));

  return `<div class="view">
    ${header('Budgets')}
    ${monthNav()}
    <div class="card mt">
      <div class="spread"><span class="muted">Total budget</span><b class="tabular">${fmtMoney(totalUsed)} / ${fmtMoney(totalBudget)}</b></div>
      <div class="bar ${totalUsed > totalBudget && totalBudget > 0 ? 'over' : ''}"><span style="width:${Math.round(pct * 100)}%"></span></div>
      <div class="tiny muted mt">${totalBudget > 0 ? fmtMoney(Math.max(0, totalBudget - totalUsed)) + ' left this month' : 'Set budgets to track spending limits'}</div>
    </div>
    ${statuses.length ? `<div class="section-title">Category budgets</div>
    <div class="card">${statuses.map((b) => `<div data-edit-budget="${b.id}" class="tappable" style="padding:6px 4px">${budgetRow(b)}</div>`).join('')}</div>` : emptyState('ti-target-arrow', 'No budgets yet', 'Add a monthly limit for a category')}
    ${unbudgeted.length ? `<button class="btn mt2" data-add-budget>+ Add category budget</button>` : ''}
  </div>`;
};

// ============================================================================
// VIEW: More (menu)
// ============================================================================
VIEWS.more = function () {
  const nw = C.netWorth(S.accounts, S.transactions, S.holdings);
  const items = [
    ['networth', 'ti-diamond', 'Net Worth', fmtMoney(nw.total)],
    ['accounts', 'ti-building-bank', 'Accounts', `${S.accounts.filter(a=>!a.archived).length} · ${fmtMoney(nw.liquid)}`],
    ['investments', 'ti-chart-line', 'Investments', fmtMoney(nw.invest)],
    ['goals', 'ti-target-arrow', 'Goals', `${S.goals.length}`],
    ['recurring', 'ti-calendar-repeat', 'Scheduled items', `${S.recurring.length}`],
    ['converter', 'ti-arrows-exchange', 'Currency Converter', 'live'],
    ['categories', 'ti-tag', 'Categories', `${S.categories.filter(c=>!c.archived).length}`],
    ['import', 'ti-file-import', 'Import CSV', ''],
    ['settings', 'ti-settings', 'Settings & Backup', ''],
  ];
  return `<div class="view">
    ${header('More')}
    <div class="card">
      ${items.map(([r, ic, t, s]) => `<div class="row tappable" data-nav-link="${r}">
        <div class="ic" style="background:var(--surface-2)">${ico(ic)}</div>
        <div class="main"><div class="t">${t}</div></div>
        <div class="s muted tiny">${escapeHtml(s)}</div>
        <div class="muted" style="margin-left:8px">›</div>
      </div>`).join('')}
    </div>
    <div class="center muted tiny mt2">Sanctum · private · on this device</div>
  </div>`;
};

// ============================================================================
// VIEW: Accounts
// ============================================================================
VIEWS.accounts = function () {
  const active = S.accounts.filter((a) => !a.archived);
  const nw = C.netWorth(S.accounts, S.transactions, S.holdings);
  return `<div class="view">
    ${subHeader('Accounts')}
    <div class="hero"><div class="label">Liquid balance</div><div class="amount">${fmtMoney(nw.liquid)}</div></div>
    <div class="card mt">${active.length ? active.map((a) => {
      const bal = C.accountBalance(a, S.transactions);
      const k = kindOf(a);
      const low = a.buffer > 0 && bal < a.buffer;
      return `<div class="row tappable" data-edit-account="${a.id}">
        <div class="ic" style="background:var(--surface-2)">${ico(a.icon, 'ti-building-bank')}</div>
        <div class="main"><div class="t">${escapeHtml(a.name)}</div>
          <div class="s">${k}${a.buffer > 0 ? ` · buffer ${fmtMoney(a.buffer)}` : ''}</div></div>
        <span class="amt ${low ? 'neg' : 'pos'}">${fmtMoney(bal)}</span>
      </div>`;
    }).join('') : emptyState('ti-building-bank', 'No accounts', 'Add checking, savings or cash accounts')}</div>
    <button class="btn primary mt2" data-add-account><i class="ti ti-plus"></i> Add account</button>
    <div class="hint center mt">Set a low-balance buffer per account to get warned before you dip under it.</div>
  </div>`;
};

// ============================================================================
// VIEW: Investments
// ============================================================================
VIEWS.investments = function () {
  const total = S.holdings.reduce((s, h) => s + C.holdingValue(h), 0);
  return `<div class="view">
    ${subHeader('Investments')}
    <div class="hero"><div class="label">Portfolio value</div><div class="amount">${fmtMoney(total)}</div></div>
    <div class="card mt">${S.holdings.length ? S.holdings.map((h) => `
      <div class="row tappable" data-edit-holding="${h.id}">
        <div class="ic" style="background:var(--surface-2)">${ico(h.icon, 'ti-chart-line')}</div>
        <div class="main"><div class="t">${escapeHtml(h.name)}</div><div class="s">${h.quantity} × ${fmtMoney(h.price)}</div></div>
        ${money(C.holdingValue(h))}
      </div>`).join('') : emptyState('ti-chart-line', 'No holdings', 'Track stocks, funds, crypto, gold…')}</div>
    <button class="btn mt2" data-add-holding>+ Add holding</button>
  </div>`;
};

// ============================================================================
// VIEW: Goals
// ============================================================================
VIEWS.goals = function () {
  return `<div class="view">
    ${subHeader('Goals')}
    ${S.goals.length ? S.goals.map((g) => {
      const pct = g.target > 0 ? Math.min(g.saved / g.target, 1) : 0;
      return `<div class="card tappable" data-edit-goal="${g.id}">
        <div class="spread"><b>${escapeHtml(g.name)}</b><span class="pill ${pct >= 1 ? 'ok' : ''}">${Math.round(pct * 100)}%</span></div>
        <div class="bar mt"><span style="width:${Math.round(pct * 100)}%;background:${g.color || 'var(--gold)'}"></span></div>
        <div class="spread tiny muted mt"><span>${fmtMoney(g.saved)} saved</span><span>Goal ${fmtMoney(g.target)}</span></div>
        ${g.targetDate ? `<div class="tiny muted mt">Target: ${fmtDate(g.targetDate)}</div>` : ''}
      </div>`;
    }).join('') : emptyState('ti-target-arrow', 'No goals yet', 'Set a savings target to work toward')}
    <button class="btn mt2" data-add-goal>+ Add goal</button>
  </div>`;
};

// ============================================================================
// VIEW: Recurring
// ============================================================================
VIEWS.recurring = function () {
  const sorted = [...S.recurring].sort((a, b) => (a.nextDate || '').localeCompare(b.nextDate || ''));
  const repeating = sorted.filter((r) => r.frequency !== 'once');
  const oneOffs = sorted.filter((r) => r.frequency === 'once');
  const monthlyIn = repeating.filter((r) => r.type === 'income' && r.frequency === 'monthly').reduce((s, r) => s + r.amount, 0);
  const monthlyOut = repeating.filter((r) => r.type === 'expense' && r.frequency === 'monthly').reduce((s, r) => s + r.amount, 0);
  return `<div class="view">
    ${subHeader('Scheduled items')}
    <div class="hint">These drive your cash-flow projection. Nothing is estimated — only what you add here appears in the future.</div>
    ${repeating.length ? `<div class="stat-row">
      <div class="stat"><div class="k">Monthly in</div><div class="v pos">${fmtMoney(monthlyIn)}</div></div>
      <div class="stat"><div class="k">Monthly out</div><div class="v neg">${fmtMoney(monthlyOut)}</div></div>
    </div>` : ''}
    <div class="section-title">Repeating</div>
    <div class="card">${repeating.length ? repeating.map(recurringRow).join('')
      : emptyState('ti-calendar-repeat', 'Nothing repeating', 'Add rent, salary, subscriptions…')}</div>
    ${oneOffs.length ? `<div class="section-title">One-off</div>
    <div class="card">${oneOffs.map(recurringRow).join('')}</div>` : ''}
    <button class="btn primary mt2" data-add-recurring><i class="ti ti-plus"></i> Add scheduled item</button>
    <div class="hint center mt">Tap an item to edit, post it early, or delete it.</div>
  </div>`;
};

// ============================================================================
// VIEW: Categories
// ============================================================================
VIEWS.categories = function () {
  const render = (type) => S.categories.filter((c) => c.type === type && !c.archived).map((c) => `
    <div class="row tappable" data-edit-category="${c.id}">
      <div class="ic" style="background:${c.color}22;color:${c.color}">${ico(c.icon)}</div>
      <div class="main"><div class="t">${escapeHtml(c.name)}</div></div>
      <div class="muted">›</div>
    </div>`).join('');
  return `<div class="view">
    ${subHeader('Categories')}
    <div class="section-title">Expense</div><div class="card">${render('expense')}</div>
    <div class="section-title">Income</div><div class="card">${render('income')}</div>
    <button class="btn mt2" data-add-category>+ Add category</button>
  </div>`;
};

// ============================================================================
// VIEW: Import CSV
// ============================================================================
let importState = null;
VIEWS.import = function () {
  if (!importState) {
    return `<div class="view">
      ${subHeader('Import CSV')}
      <div class="card center">
        <div style="font-size:34px"><i class="ti ti-file-import"></i></div>
        <p class="muted">Import transactions from a bank statement or CSV export. Everything is parsed on your phone.</p>
        <label class="btn primary" style="display:inline-flex;width:auto;padding:12px 22px">Choose CSV file
          <input type="file" id="csv-file" accept=".csv,text/csv" hidden></label>
      </div>
      <div class="hint center mt">Supports Date, Description, and Amount (or Debit/Credit) columns.</div>
    </div>`;
  }
  const { headers, rows, map, drafts } = importState;
  const opt = (sel) => ['', ...headers].map((h) => `<option ${h === sel ? 'selected' : ''}>${escapeHtml(h)}</option>`).join('');
  return `<div class="view">
    ${subHeader('Import CSV')}
    <div class="card">
      <div class="tiny muted">${rows.length} rows found. Map your columns:</div>
      <div class="grid2 mt">
        <div class="field"><label>Date</label><select class="input" data-map="date">${opt(map.date)}</select></div>
        <div class="field"><label>Description</label><select class="input" data-map="description">${opt(map.description)}</select></div>
        <div class="field"><label>Amount</label><select class="input" data-map="amount">${opt(map.amount)}</select></div>
        <div class="field"><label>Debit (out)</label><select class="input" data-map="debit">${opt(map.debit)}</select></div>
        <div class="field"><label>Credit (in)</label><select class="input" data-map="credit">${opt(map.credit)}</select></div>
      </div>
      <div class="field"><label>Import into account</label>
        <select class="input" id="import-account">${S.accounts.filter(a=>!a.archived).map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}</select></div>
    </div>
    <div class="section-title">Preview (${drafts.length} valid)</div>
    <div class="card">${drafts.slice(0, 8).map((d) => `<div class="row">
      <div class="main"><div class="t">${escapeHtml(d.note || '(no description)')}</div><div class="s">${fmtDateShort(d.date)}</div></div>
      <div class="amt ${d.type === 'income' ? 'pos' : 'neg'}">${d.type === 'income' ? '+' : '-'}${fmtMoney(d.amount)}</div>
    </div>`).join('') || '<div class="muted tiny">No valid rows with current mapping.</div>'}
    ${drafts.length > 8 ? `<div class="tiny muted center mt">…and ${drafts.length - 8} more</div>` : ''}</div>
    <div class="btn-row">
      <button class="btn ghost" data-import-cancel>Cancel</button>
      <button class="btn primary" data-import-confirm ${drafts.length ? '' : 'disabled'}>Import ${drafts.length}</button>
    </div>
  </div>`;
};
VIEWS.import.after = function () {
  const f = document.getElementById('csv-file');
  if (f) f.addEventListener('change', onCSVFile);
  document.querySelectorAll('[data-map]').forEach((sel) => sel.addEventListener('change', () => {
    importState.map[sel.dataset.map] = sel.value;
    importState.drafts = rowsToTransactions(importState.rows, importState.map);
    render();
  }));
};
async function onCSVFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const { headers, rows } = csvToObjects(text);
  if (!headers.length) return toast('Could not read CSV', true);
  const map = guessMapping(headers);
  importState = { headers, rows, map, drafts: rowsToTransactions(rows, map) };
  render();
}

// ============================================================================
// VIEW: Currency Converter (live rates)
// ============================================================================
let convState = null;
VIEWS.converter = function () {
  if (!convState) {
    const base = getSetting('currency') || 'USD';
    convState = { amount: '1', from: base, to: base === 'USD' ? 'INR' : 'USD' };
  }
  const opts = (sel) => CURRENCIES.map((c) => `<option value="${c}" ${c === sel ? 'selected' : ''}>${c} · ${escapeHtml(currencyName(c))}</option>`).join('');
  return `<div class="view">
    ${subHeader('Currency Converter')}
    <div class="card">
      <div class="field"><label>Amount</label>
        <input class="input amount-input" id="cv-amount" inputmode="decimal" value="${escapeHtml(convState.amount)}"></div>
      <div class="field"><label>From</label><select class="input" id="cv-from">${opts(convState.from)}</select></div>
      <div class="center" style="margin:2px 0 8px"><button class="header-btn" id="cv-swap" title="Swap" style="width:44px">⇅</button></div>
      <div class="field" style="margin-bottom:2px"><label>To</label><select class="input" id="cv-to">${opts(convState.to)}</select></div>
    </div>
    <div class="hero mt center">
      <div class="label">Converted</div>
      <div class="amount" id="cv-result">…</div>
      <div class="tiny muted" id="cv-rate"></div>
    </div>
    <div class="spread mt">
      <span class="tiny muted" id="cv-status">Loading rates…</span>
      <button class="btn ghost" style="width:auto;padding:8px 14px" id="cv-refresh">↻ Refresh</button>
    </div>
    <div class="hint center mt2">Live mid-market rates, cached on your device for offline use. Only currency codes are sent online — never your data.</div>
  </div>`;
};
VIEWS.converter.after = async function () {
  const amount = document.getElementById('cv-amount');
  const from = document.getElementById('cv-from');
  const to = document.getElementById('cv-to');
  let cache = await Rates.getCached();

  const compute = () => {
    convState.amount = amount.value; convState.from = from.value; convState.to = to.value;
    const amt = parseAmount(amount.value);
    const resEl = document.getElementById('cv-result');
    const rateEl = document.getElementById('cv-rate');
    const out = Rates.convert(cache, amt, from.value, to.value);
    if (out == null) { resEl.textContent = '—'; rateEl.textContent = cache ? 'Rate unavailable' : ''; return; }
    resEl.textContent = fmtMoneyIn(out, to.value);
    const one = Rates.rateBetween(cache, from.value, to.value);
    rateEl.textContent = `1 ${from.value} = ${fmtMoneyIn(one, to.value)}`;
  };
  const setStatus = (msg) => {
    const el = document.getElementById('cv-status'); if (!el) return;
    if (msg) { el.textContent = msg; return; }
    if (!cache) { el.textContent = navigator.onLine ? 'No rates yet — tap Refresh' : 'Offline · no cached rates'; return; }
    const mins = Math.round((Date.now() - cache.fetchedAt) / 60000);
    const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
    el.textContent = `Rates updated ${ago}${navigator.onLine ? '' : ' · offline'}`;
  };

  compute(); setStatus();
  Rates.ensureFresh().then((c) => { if (c && c !== cache) { cache = c; compute(); setStatus(); } });

  [amount, from, to].forEach((el) => el.addEventListener('input', compute));
  document.getElementById('cv-swap').addEventListener('click', () => {
    const f = from.value; from.value = to.value; to.value = f; compute();
  });
  document.getElementById('cv-refresh').addEventListener('click', async () => {
    setStatus('Updating…');
    try { cache = await Rates.refreshRates(); compute(); setStatus(); toast('Rates updated'); }
    catch { setStatus(); toast('Could not fetch rates (offline?)', true); }
  });
};

// ============================================================================
// VIEW: Settings
// ============================================================================
VIEWS.settings = function () {
  const s = settings();
  return `<div class="view">
    ${subHeader('Settings & Backup')}
    <div class="card">
      <div class="field"><label>Your name</label><input class="input" id="set-name" value="${escapeHtml(s.name || '')}"></div>
      <div class="field"><label>Currency</label>
        <select class="input" id="set-currency">${CURRENCIES.map((c) => `<option ${c === s.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <button class="btn primary" id="save-settings">Save</button>
    </div>

    <div class="section-title">Backup & Restore</div>
    <div class="card">
      <p class="tiny muted">Your data lives only on this phone. Export regularly to keep a backup (save it to Google Drive, etc.).</p>
      <div class="btn-row"><button class="btn" data-export-json>⬇ Export backup</button>
      <label class="btn" style="cursor:pointer">⬆ Restore<input type="file" id="restore-file" accept=".json" hidden></label></div>
      <button class="btn mt" data-export-csv>Export transactions as CSV</button>
    </div>

    <div class="section-title">Danger zone</div>
    <div class="card"><button class="btn danger" data-wipe>Erase all data</button></div>
    <div class="center muted tiny mt2">Sanctum — built for ${escapeHtml(s.name || 'you')}</div>
  </div>`;
};
VIEWS.settings.after = function () {
  const rf = document.getElementById('restore-file');
  if (rf) rf.addEventListener('change', onRestoreFile);
};

// --- Headers ----------------------------------------------------------------
function header(title) {
  return `<div class="app-header">
    <div class="title">
      <button class="header-btn" data-hub aria-label="All apps"><i class="ti ti-apps"></i></button>
      <h1 class="mod-title">${escapeHtml(title)}</h1>
    </div>
    <button class="header-btn" data-nav-link="settings" aria-label="Settings"><i class="ti ti-settings"></i></button>
  </div>`;
}
function subHeader(title) {
  return `<div class="app-header">
    <div class="title"><button class="header-btn" data-back>‹</button><h1 style="font-size:19px">${escapeHtml(title)}</h1></div>
  </div>`;
}
// Icon picker — a grid of Tabler icons backed by a hidden input.
function iconPickerHTML(id, current) {
  const cur = current && /^ti-/.test(current) ? current : ICON_CHOICES[0];
  return `<input type="hidden" id="${id}" value="${cur}">
    <div class="icon-grid" data-picker="${id}">
      ${ICON_CHOICES.map((n) => `<button type="button" class="icon-opt ${n === cur ? 'active' : ''}" data-icon="${n}" aria-label="${n}"><i class="ti ${n}"></i></button>`).join('')}
    </div>`;
}
function wireIconPicker(sheet, id) {
  const grid = sheet.querySelector(`[data-picker="${id}"]`);
  if (!grid) return;
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('[data-icon]');
    if (!b) return;
    sheet.querySelector('#' + id).value = b.dataset.icon;
    grid.querySelectorAll('.icon-opt').forEach((x) => x.classList.toggle('active', x === b));
  });
}

function emptyState(em, title, sub) {
  return `<div class="empty"><span class="em">${ico(em)}</span><div>${escapeHtml(title)}</div>${sub ? `<div class="tiny mt">${escapeHtml(sub)}</div>` : ''}</div>`;
}

// ============================================================================
// Editors (sheets)
// ============================================================================
function txSheet(existing) {
  // Account preselection, best context first: the account you're viewing in
  // Cash flow -> the one you last used -> your first checking account -> first.
  const live = (id) => S.accounts.some((a) => a.id === id && !a.archived);
  const defaultAccount =
    (live(S.cfAccount) && S.cfAccount) ||
    (live(getSetting('lastAccountId')) && getSetting('lastAccountId')) ||
    S.accounts.find((a) => !a.archived && kindOf(a) === 'checking')?.id ||
    S.accounts.find((a) => !a.archived)?.id;
  const t = existing || { type: 'expense', amount: '', accountId: defaultAccount, categoryId: null, date: todayISO(), note: '' };
  const cats = (type) => S.categories.filter((c) => c.type === type && !c.archived);
  const accountOpts = (sel) => S.accounts.filter(a=>!a.archived).map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('');

  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>${existing ? 'Edit' : 'Add'} transaction</h2><button class="close" data-close>✕</button></div>
    <div class="seg type-seg" id="tx-type">
      ${['expense', 'income', 'transfer'].map((v) => `<button data-v="${v}" class="${t.type === v ? 'active' : ''}">${v[0].toUpperCase()+v.slice(1)}</button>`).join('')}
    </div>
    <input class="input amount-input mt" id="f-amount" inputmode="decimal" placeholder="${currencySymbol()}0" value="${t.amount || ''}">
    <div class="seg mt" id="tx-when">
      <button data-w="past" class="${t.date > todayISO() ? '' : 'active'}"><i class="ti ti-check"></i> Done</button>
      <button data-w="upcoming" class="${t.date > todayISO() ? 'active' : ''}"><i class="ti ti-clock"></i> Upcoming</button>
    </div>
    <div id="cat-wrap">
      <label class="tiny muted">Category</label>
      <div class="chips mt" id="f-cats"></div>
    </div>
    <div class="acct-row mt" id="acct-row">
      <div class="field" id="acct-wrap"><label>Account</label><select class="input" id="f-account">${accountOpts(t.accountId)}</select></div>
      <div class="field" id="toacct-wrap" style="display:none"><label>To account</label><select class="input" id="f-toaccount">${accountOpts(t.toAccountId)}</select></div>
    </div>
    <div class="field"><label id="f-date-label">Date</label><input class="input" type="date" id="f-date" value="${t.date}"></div>
    <div class="field" id="rep-wrap" style="display:none"><label>Repeats</label>
      <select class="input" id="f-repeat">
        <option value="once">Just once</option>
        <option value="weekly">Weekly</option>
        <option value="biweekly">Every 2 weeks</option>
        <option value="semimonthly">Twice a month</option>
        <option value="monthly">Monthly</option>
        <option value="quarterly">Quarterly</option>
        <option value="yearly">Yearly</option>
      </select>
      <div class="hint" id="rep-hint"></div>
    </div>
    <div class="field"><label>Note</label><input class="input" id="f-note" value="${escapeHtml(t.note || '')}" placeholder="Optional"></div>
    <button class="btn primary" id="f-save">${existing ? 'Save' : 'Add'} transaction</button>
    ${existing ? `<button class="btn danger mt" id="f-delete">Delete</button>` : ''}
  `);

  let state = { type: t.type, categoryId: t.categoryId };
  const renderCats = () => {
    const wrap = sheet.querySelector('#f-cats');
    const catWrap = sheet.querySelector('#cat-wrap');
    const toWrap = sheet.querySelector('#toacct-wrap');
    const acctRow = sheet.querySelector('#acct-row');
    if (state.type === 'transfer') {
      catWrap.style.display = 'none'; toWrap.style.display = '';
      acctRow.classList.add('transfer'); // two columns only when both are shown
      return;
    }
    catWrap.style.display = ''; toWrap.style.display = 'none';
    acctRow.classList.remove('transfer');
    const list = cats(state.type);
    if (!state.categoryId || !list.find((c) => c.id === state.categoryId)) state.categoryId = list[0]?.id;
    wrap.innerHTML = list.map((c) => `<button class="chip ${c.id === state.categoryId ? 'active' : ''}" data-cat="${c.id}">${ico(c.icon)} ${escapeHtml(c.name)}</button>`).join('');
    wrap.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => { state.categoryId = b.dataset.cat; renderCats(); }));
  };
  renderCats();

  sheet.querySelectorAll('#tx-type button').forEach((b) => b.addEventListener('click', () => {
    state.type = b.dataset.v;
    sheet.querySelectorAll('#tx-type button').forEach((x) => x.classList.toggle('active', x === b));
    renderCats();
  }));

  // --- when: already happened vs upcoming --------------------------------
  const dateEl = sheet.querySelector('#f-date');
  const repWrap = sheet.querySelector('#rep-wrap');
  const repSel = sheet.querySelector('#f-repeat');
  const tomorrow = addDays(todayISO(), 1);
  let when = t.date > todayISO() ? 'upcoming' : 'past';

  const syncWhen = () => {
    if (when === 'past') {
      dateEl.max = todayISO(); dateEl.removeAttribute('min');
      if (dateEl.value > todayISO()) dateEl.value = todayISO();
      sheet.querySelector('#f-date-label').textContent = 'Date';
      repWrap.style.display = 'none';
    } else {
      dateEl.min = tomorrow; dateEl.removeAttribute('max');
      if (!dateEl.value || dateEl.value <= todayISO()) dateEl.value = tomorrow;
      sheet.querySelector('#f-date-label').textContent = 'Due date';
      // Repeating only makes sense when creating something new.
      repWrap.style.display = existing ? 'none' : '';
    }
    const rep = repSel.value;
    sheet.querySelector('#rep-hint').textContent = rep === 'once'
      ? 'Shows in Cash flow, then becomes a normal transaction on that date.'
      : 'Saved as a scheduled item so it repeats in your projection.';
    sheet.querySelector('#f-save').textContent =
      existing ? 'Save transaction'
      : (when === 'upcoming' && rep !== 'once') ? 'Schedule it' : 'Add transaction';
  };
  sheet.querySelectorAll('#tx-when button').forEach((b) => b.addEventListener('click', () => {
    when = b.dataset.w;
    sheet.querySelectorAll('#tx-when button').forEach((x) => x.classList.toggle('active', x === b));
    syncWhen();
  }));
  repSel.addEventListener('change', syncWhen);
  syncWhen();

  sheet.querySelector('#f-save').addEventListener('click', async () => {
    const amount = parseAmount(sheet.querySelector('#f-amount').value);
    if (!amount || amount <= 0) return toast('Enter an amount', true);
    const date = sheet.querySelector('#f-date').value || todayISO();
    const note = sheet.querySelector('#f-note').value.trim();
    const accountId = sheet.querySelector('#f-account').value;
    const toAccountId = state.type === 'transfer' ? sheet.querySelector('#f-toaccount').value : null;
    if (state.type === 'transfer' && toAccountId === accountId) return toast('Pick two different accounts', true);

    const repeat = repSel.value;
    // Upcoming + repeating -> a scheduled item, so it recurs in the projection.
    if (!existing && when === 'upcoming' && repeat !== 'once') {
      const rule = {
        id: uid('r_'),
        name: note || (state.type === 'transfer' ? 'Transfer' : catName(state.categoryId)),
        type: state.type, amount, accountId,
        frequency: repeat, nextDate: date, endDate: '', paused: false,
      };
      if (state.type === 'transfer') rule.toAccountId = toAccountId;
      else rule.categoryId = state.categoryId;
      await db.put('recurring', rule);
      closeSheet(); await refresh(); render();
      return toast('Scheduled');
    }

    const rec = {
      id: existing?.id || uid('t_'),
      type: state.type, amount, accountId, date, note,
      createdAt: existing?.createdAt || Date.now(),
    };
    if (state.type === 'transfer') rec.toAccountId = toAccountId;
    else rec.categoryId = state.categoryId;
    // Preserve the link to a schedule if this row came from one.
    if (existing?.recurringId) { rec.recurringId = existing.recurringId; rec.scheduledFor = existing.scheduledFor; }
    setSetting('lastAccountId', accountId);
    await db.put('transactions', rec);
    closeSheet(); await refresh(); render();
    toast(existing ? 'Updated' : (date > todayISO() ? 'Added to upcoming' : 'Added'));
  });

  const del = sheet.querySelector('#f-delete');
  if (del) del.addEventListener('click', () => confirmDelete('transaction', async () => {
    await db.del('transactions', existing.id); closeSheet(); await refresh(); render(); toast('Deleted');
  }));
  setTimeout(() => sheet.querySelector('#f-amount').focus(), 100);
}

function accountSheet(existing) {
  const a = existing || { name: '', kind: 'checking', balance: 0, icon: 'ti-building-bank', buffer: 0 };
  const curKind = existing ? kindOf(existing) : 'checking';
  const KINDS = [['checking', 'Checking'], ['savings', 'Savings'], ['cash', 'Cash']];
  const curBal = existing ? P.balanceAsOf(existing, S.transactions, todayISO()) : 0;
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>${existing ? 'Edit' : 'Add'} account</h2><button class="close" data-close>✕</button></div>
    <div class="field"><label>Name</label><input class="input" id="a-name" value="${escapeHtml(a.name)}" placeholder="e.g. Chase Checking"></div>
    <div class="field"><label>Type</label>
      <div class="seg" id="a-kind">${KINDS.map(([k, l]) => `<button data-k="${k}" class="${k === curKind ? 'active' : ''}">${l}</button>`).join('')}</div></div>
    <div class="grid2">
      <div class="field"><label>Icon</label>${iconPickerHTML('a-icon', a.icon)}</div>
      <div class="field"><label>Low-balance buffer</label><input class="input" id="a-buffer" inputmode="decimal" value="${a.buffer || 0}"></div>
    </div>
    <div class="field"><label>Opening balance</label><input class="input" id="a-balance" inputmode="decimal" value="${a.balance || 0}"></div>
    ${existing ? `<div class="hint">Current balance is <b>${fmtMoney(curBal)}</b>. If that's wrong, reconcile it below — an adjustment entry is added so projections start from reality.</div>
      <button class="btn mt" id="a-reconcile"><i class="ti ti-scale"></i> Set current balance…</button>` : ''}
    <button class="btn primary mt" id="a-save">${existing ? 'Save' : 'Add'}</button>
    ${existing ? `<button class="btn danger mt" id="a-delete">Delete</button>` : ''}
  `);
  wireIconPicker(sheet, 'a-icon');
  let kind = curKind;
  sheet.querySelectorAll('#a-kind button').forEach((b) => b.addEventListener('click', () => {
    kind = b.dataset.k;
    sheet.querySelectorAll('#a-kind button').forEach((x) => x.classList.toggle('active', x === b));
  }));
  const rec = sheet.querySelector('#a-reconcile');
  if (rec) rec.addEventListener('click', () => reconcileSheet(existing, curBal));
  sheet.querySelector('#a-save').addEventListener('click', async () => {
    const name = sheet.querySelector('#a-name').value.trim();
    if (!name) return toast('Enter a name', true);
    await db.put('accounts', {
      id: existing?.id || uid('a_'), name,
      kind, type: kind,
      icon: sheet.querySelector('#a-icon').value || 'ti-building-bank',
      balance: parseAmount(sheet.querySelector('#a-balance').value),
      buffer: parseAmount(sheet.querySelector('#a-buffer').value),
      currency: getSetting('currency'), archived: existing?.archived || false,
    });
    closeSheet(); await refresh(); render(); toast('Saved');
  });
  const del = sheet.querySelector('#a-delete');
  if (del) del.addEventListener('click', () => {
    const hasTx = S.transactions.some((t) => t.accountId === existing.id || t.toAccountId === existing.id);
    confirmDelete(hasTx ? 'account (its transactions stay)' : 'account', async () => {
      await db.del('accounts', existing.id); closeSheet(); await refresh(); render(); toast('Deleted');
    });
  });
}

// Reconcile: tell the app what the account ACTUALLY holds right now, and it
// writes a balancing adjustment so projections start from the true number.
function reconcileSheet(account, currentBal) {
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Set current balance</h2><button class="close" data-close>✕</button></div>
    <div class="hint">App thinks <b>${escapeHtml(account.name)}</b> holds <b>${fmtMoney(currentBal)}</b>. Enter the real balance from your bank.</div>
    <div class="field mt"><label>Actual balance today</label>
      <input class="input amount-input" id="rc-bal" inputmode="decimal" value="${currentBal}"></div>
    <div id="rc-diff" class="tiny muted center"></div>
    <button class="btn primary mt" id="rc-go">Reconcile</button>
  `);
  const input = sheet.querySelector('#rc-bal');
  const diffEl = sheet.querySelector('#rc-diff');
  const show = () => {
    const d = parseAmount(input.value) - currentBal;
    diffEl.innerHTML = Math.abs(d) < 0.005 ? 'Already matches — nothing to adjust.'
      : `Adds a <b style="color:${d > 0 ? 'var(--green)' : 'var(--red)'}">${fmtMoney(d, { sign: true })}</b> adjustment.`;
  };
  input.addEventListener('input', show); show();
  sheet.querySelector('#rc-go').addEventListener('click', async () => {
    const diff = parseAmount(input.value) - currentBal;
    if (Math.abs(diff) < 0.005) { closeSheet(); return toast('Already up to date'); }
    const adjCat = S.categories.find((c) => c.type === (diff > 0 ? 'income' : 'expense') && /other|misc/i.test(c.name))
      || S.categories.find((c) => c.type === (diff > 0 ? 'income' : 'expense'));
    await db.put('transactions', {
      id: uid('t_'), type: diff > 0 ? 'income' : 'expense', amount: Math.abs(diff),
      accountId: account.id, categoryId: adjCat?.id, date: todayISO(),
      note: 'Balance adjustment', adjustment: true, createdAt: Date.now(),
    });
    closeSheet(); await refresh(); render(); toast('Balance reconciled');
  });
}

function holdingSheet(existing) {
  const h = existing || { name: '', quantity: 1, price: 0, icon: 'ti-chart-line' };
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>${existing ? 'Edit' : 'Add'} holding</h2><button class="close" data-close>✕</button></div>
    <div class="field"><label>Name</label><input class="input" id="h-name" value="${escapeHtml(h.name)}" placeholder="e.g. Nifty 50 Index Fund"></div>
    <div class="grid2">
      <div class="field"><label>Quantity / units</label><input class="input" id="h-qty" inputmode="decimal" value="${h.quantity}"></div>
      <div class="field"><label>Price per unit</label><input class="input" id="h-price" inputmode="decimal" value="${h.price}"></div>
    </div>
    <div class="field"><label>Icon</label>${iconPickerHTML('h-icon', h.icon)}</div>
    <button class="btn primary" id="h-save">${existing ? 'Save' : 'Add'}</button>
    ${existing ? `<button class="btn danger mt" id="h-delete">Delete</button>` : ''}
  `);
  wireIconPicker(sheet, 'h-icon');
  sheet.querySelector('#h-save').addEventListener('click', async () => {
    const name = sheet.querySelector('#h-name').value.trim();
    if (!name) return toast('Enter a name', true);
    await db.put('holdings', {
      id: existing?.id || uid('h_'), name,
      quantity: parseAmount(sheet.querySelector('#h-qty').value),
      price: parseAmount(sheet.querySelector('#h-price').value),
      icon: sheet.querySelector('#h-icon').value || 'ti-chart-line',
    });
    closeSheet(); await refresh(); render(); toast('Saved');
  });
  const del = sheet.querySelector('#h-delete');
  if (del) del.addEventListener('click', () => confirmDelete('holding', async () => {
    await db.del('holdings', existing.id); closeSheet(); await refresh(); render(); toast('Deleted');
  }));
}

function goalSheet(existing) {
  const g = existing || { name: '', target: 0, saved: 0, targetDate: '', color: 'var(--gold)' };
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>${existing ? 'Edit' : 'Add'} goal</h2><button class="close" data-close>✕</button></div>
    <div class="field"><label>Name</label><input class="input" id="g-name" value="${escapeHtml(g.name)}" placeholder="e.g. Emergency fund"></div>
    <div class="grid2">
      <div class="field"><label>Target amount</label><input class="input" id="g-target" inputmode="decimal" value="${g.target}"></div>
      <div class="field"><label>Saved so far</label><input class="input" id="g-saved" inputmode="decimal" value="${g.saved}"></div>
    </div>
    <div class="field"><label>Target date (optional)</label><input class="input" type="date" id="g-date" value="${g.targetDate || ''}"></div>
    <button class="btn primary" id="g-save">${existing ? 'Save' : 'Add'}</button>
    ${existing ? `<button class="btn danger mt" id="g-delete">Delete</button>` : ''}
  `);
  sheet.querySelector('#g-save').addEventListener('click', async () => {
    const name = sheet.querySelector('#g-name').value.trim();
    if (!name) return toast('Enter a name', true);
    await db.put('goals', {
      id: existing?.id || uid('g_'), name,
      target: parseAmount(sheet.querySelector('#g-target').value),
      saved: parseAmount(sheet.querySelector('#g-saved').value),
      targetDate: sheet.querySelector('#g-date').value, color: g.color || 'var(--gold)',
    });
    closeSheet(); await refresh(); render(); toast('Saved');
  });
  const del = sheet.querySelector('#g-delete');
  if (del) del.addEventListener('click', () => confirmDelete('goal', async () => {
    await db.del('goals', existing.id); closeSheet(); await refresh(); render(); toast('Deleted');
  }));
}

function recurringSheet(existing) {
  const r = existing || { name: '', type: 'expense', amount: 0, accountId: S.accounts[0]?.id, toAccountId: null, categoryId: null, frequency: 'monthly', nextDate: todayISO(), endDate: '', paused: false };
  const FREQS = [['once', 'One-off (no repeat)'], ['weekly', 'Weekly'], ['biweekly', 'Every 2 weeks'],
    ['semimonthly', 'Twice a month'], ['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['yearly', 'Yearly']];
  const acctOpts = (sel) => S.accounts.filter((a) => !a.archived)
    .map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('');
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>${existing ? 'Edit' : 'Add'} scheduled item</h2><button class="close" data-close>✕</button></div>
    <div class="field"><label>Name</label><input class="input" id="r-name" value="${escapeHtml(r.name)}" placeholder="e.g. Rent, Salary, Flight"></div>
    <div class="seg type-seg" id="r-type">
      ${['expense', 'income', 'transfer'].map((v) => `<button data-v="${v}" class="${r.type === v ? 'active' : ''}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}
    </div>
    <div class="grid2 mt">
      <div class="field"><label>Amount</label><input class="input" id="r-amount" inputmode="decimal" value="${r.amount}"></div>
      <div class="field"><label>Repeats</label><select class="input" id="r-freq">${FREQS.map(([f, l]) => `<option value="${f}" ${f === r.frequency ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <div class="field" id="r-cat-wrap"><label>Category</label><select class="input" id="r-cat"></select></div>
    <div class="field"><label id="r-acct-label">From account</label><select class="input" id="r-account">${acctOpts(r.accountId)}</select></div>
    <div class="field" id="r-to-wrap" style="display:none"><label>To account</label><select class="input" id="r-toaccount">${acctOpts(r.toAccountId)}</select></div>
    <div class="grid2">
      <div class="field"><label id="r-date-label">Next due date</label><input class="input" type="date" id="r-date" value="${r.nextDate}"></div>
      <div class="field" id="r-end-wrap"><label>Ends (optional)</label><input class="input" type="date" id="r-end" value="${r.endDate || ''}"></div>
    </div>
    ${existing ? `<button class="btn primary" id="r-post"><i class="ti ti-check"></i> Post now as transaction</button>` : ''}
    <button class="btn ${existing ? 'mt' : 'primary'}" id="r-save">${existing ? 'Save changes' : 'Add'}</button>
    ${existing ? `<button class="btn danger mt" id="r-delete">Delete</button>` : ''}
  `);
  let curType = r.type, curCat = r.categoryId;
  const syncType = () => {
    const isTransfer = curType === 'transfer';
    const isOnce = sheet.querySelector('#r-freq').value === 'once';
    sheet.querySelector('#r-cat-wrap').style.display = isTransfer ? 'none' : '';
    sheet.querySelector('#r-to-wrap').style.display = isTransfer ? '' : 'none';
    sheet.querySelector('#r-acct-label').textContent = isTransfer ? 'From account' : (curType === 'income' ? 'Into account' : 'From account');
    sheet.querySelector('#r-end-wrap').style.display = isOnce ? 'none' : '';
    sheet.querySelector('#r-date-label').textContent = isOnce ? 'Date' : 'Next due date';
  };
  sheet.querySelector('#r-freq').addEventListener('change', syncType);
  const fillCats = () => {
    const sel = sheet.querySelector('#r-cat');
    const list = S.categories.filter((c) => c.type === curType && !c.archived);
    if (!curCat || !list.find((c) => c.id === curCat)) curCat = list[0]?.id;
    sel.innerHTML = list.map((c) => `<option value="${c.id}" ${c.id === curCat ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
  };
  fillCats(); syncType();
  sheet.querySelector('#r-cat').addEventListener('change', (e) => { curCat = e.target.value; });
  sheet.querySelectorAll('#r-type button').forEach((b) => b.addEventListener('click', () => {
    curType = b.dataset.v; sheet.querySelectorAll('#r-type button').forEach((x) => x.classList.toggle('active', x === b));
    fillCats(); syncType();
  }));
  const collect = () => {
    const type = curType;
    const rec = {
      id: existing?.id || uid('r_'), name: sheet.querySelector('#r-name').value.trim(), type,
      amount: parseAmount(sheet.querySelector('#r-amount').value), frequency: sheet.querySelector('#r-freq').value,
      accountId: sheet.querySelector('#r-account').value,
      nextDate: sheet.querySelector('#r-date').value || todayISO(),
      endDate: sheet.querySelector('#r-end').value || '',
      paused: existing?.paused || false,
    };
    if (type === 'transfer') rec.toAccountId = sheet.querySelector('#r-toaccount').value;
    else rec.categoryId = sheet.querySelector('#r-cat').value;
    return rec;
  };
  sheet.querySelector('#r-save').addEventListener('click', async () => {
    const rec = collect();
    if (!rec.name) return toast('Enter a name', true);
    if (!rec.amount) return toast('Enter an amount', true);
    if (rec.type === 'transfer' && rec.toAccountId === rec.accountId) return toast('Pick two different accounts', true);
    await db.put('recurring', rec); closeSheet(); await refresh(); render(); toast('Saved');
  });
  const post = sheet.querySelector('#r-post');
  if (post) post.addEventListener('click', async () => {
    const rec = collect();
    const tx = {
      id: uid('t_'), type: rec.type, amount: rec.amount, accountId: rec.accountId,
      date: todayISO(), note: rec.name, createdAt: Date.now(),
      // Link back to the schedule so the projection never counts it twice.
      recurringId: rec.id, scheduledFor: rec.nextDate,
    };
    if (rec.type === 'transfer') tx.toAccountId = rec.toAccountId; else tx.categoryId = rec.categoryId;
    await db.put('transactions', tx);
    if (rec.frequency === 'once') {
      await db.del('recurring', rec.id);
      closeSheet(); await refresh(); render(); return toast('Posted');
    }
    // Advance to the next occurrence using the same expansion rules as the projection.
    const next = P.expandRule({ ...rec, endDate: '' }, P.plusDays(rec.nextDate, 1), P.plusDays(rec.nextDate, 400))[0];
    rec.nextDate = next || P.plusDays(rec.nextDate, 30);
    await db.put('recurring', rec);
    closeSheet(); await refresh(); render(); toast('Posted & rescheduled');
  });
  const del = sheet.querySelector('#r-delete');
  if (del) del.addEventListener('click', () => confirmDelete('scheduled item', async () => {
    await db.del('recurring', existing.id); closeSheet(); await refresh(); render(); toast('Deleted');
  }));
}

function categorySheet(existing) {
  const c = existing || { name: '', type: 'expense', color: '#f97316', icon: 'ti-package' };
  const palette = ['#f97316','#84cc16','#38bdf8','#e879f9','#fbbf24','#f43f5e','#c084fc','#fb7185','#2dd4bf','#60a5fa','#4ade80','#94a3b8'];
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>${existing ? 'Edit' : 'Add'} category</h2><button class="close" data-close>✕</button></div>
    <div class="grid2">
      <div class="field"><label>Name</label><input class="input" id="c-name" value="${escapeHtml(c.name)}"></div>
      <div class="field"><label>Icon</label>${iconPickerHTML('c-icon', c.icon)}</div>
    </div>
    <div class="field"><label>Type</label><div class="seg type-seg" id="c-type">
      ${['expense', 'income'].map((v) => `<button data-v="${v}" class="${c.type === v ? 'active' : ''}">${v[0].toUpperCase()+v.slice(1)}</button>`).join('')}</div></div>
    <div class="field"><label>Color</label><div class="chips" id="c-color">
      ${palette.map((p) => `<button class="chip" data-color="${p}" style="border-color:${p === c.color ? p : 'var(--line)'}"><span style="width:16px;height:16px;border-radius:5px;background:${p};display:inline-block"></span></button>`).join('')}</div></div>
    <button class="btn primary" id="c-save">${existing ? 'Save' : 'Add'}</button>
    ${existing ? `<button class="btn danger mt" id="c-delete">Delete</button>` : ''}
  `);
  wireIconPicker(sheet, 'c-icon');
  let curType = c.type, curColor = c.color;
  sheet.querySelectorAll('#c-type button').forEach((b) => b.addEventListener('click', () => {
    curType = b.dataset.v; sheet.querySelectorAll('#c-type button').forEach((x) => x.classList.toggle('active', x === b));
  }));
  sheet.querySelectorAll('#c-color button').forEach((b) => b.addEventListener('click', () => {
    curColor = b.dataset.color;
    sheet.querySelectorAll('#c-color button').forEach((x) => x.style.borderColor = x === b ? curColor : 'var(--line)');
  }));
  sheet.querySelector('#c-save').addEventListener('click', async () => {
    const name = sheet.querySelector('#c-name').value.trim();
    if (!name) return toast('Enter a name', true);
    await db.put('categories', {
      id: existing?.id || uid('c_'), name, type: curType, color: curColor,
      icon: sheet.querySelector('#c-icon').value || 'ti-package', archived: existing?.archived || false,
    });
    closeSheet(); await refresh(); render(); toast('Saved');
  });
  const del = sheet.querySelector('#c-delete');
  if (del) del.addEventListener('click', () => confirmDelete('category', async () => {
    // Soft-archive if used, else delete
    const used = S.transactions.some((t) => t.categoryId === existing.id);
    if (used) { existing.archived = true; await db.put('categories', existing); }
    else await db.del('categories', existing.id);
    closeSheet(); await refresh(); render(); toast(used ? 'Archived' : 'Deleted');
  }));
}

function budgetSheet(existing) {
  const expenseCats = S.categories.filter((c) => c.type === 'expense' && !c.archived);
  const available = existing ? expenseCats : expenseCats.filter((c) => !S.budgets.find((b) => b.categoryId === c.id));
  const b = existing || { categoryId: available[0]?.id, amount: 0 };
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>${existing ? 'Edit' : 'Add'} budget</h2><button class="close" data-close>✕</button></div>
    <div class="field"><label>Category</label><select class="input" id="b-cat" ${existing ? 'disabled' : ''}>
      ${available.map((c) => `<option value="${c.id}" ${c.id === b.categoryId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Monthly limit</label><input class="input amount-input" id="b-amount" inputmode="decimal" value="${b.amount || ''}" placeholder="${currencySymbol()}0"></div>
    <button class="btn primary" id="b-save">${existing ? 'Save' : 'Add'}</button>
    ${existing ? `<button class="btn danger mt" id="b-delete">Remove budget</button>` : ''}
  `);
  sheet.querySelector('#b-save').addEventListener('click', async () => {
    const amount = parseAmount(sheet.querySelector('#b-amount').value);
    if (!amount || amount <= 0) return toast('Enter a limit', true);
    await db.put('budgets', { id: existing?.id || uid('b_'), categoryId: sheet.querySelector('#b-cat').value, amount });
    closeSheet(); await refresh(); render(); toast('Saved');
  });
  const del = sheet.querySelector('#b-delete');
  if (del) del.addEventListener('click', async () => {
    await db.del('budgets', existing.id); closeSheet(); await refresh(); render(); toast('Removed');
  });
}

function confirmDelete(label, onYes) {
  const sheet = openSheet(`
    <div class="center" style="padding:10px 0 4px">
      <div style="font-size:32px">🗑️</div>
      <h2 style="margin:10px 0 6px">Delete ${escapeHtml(label)}?</h2>
      <p class="muted tiny">This can't be undone.</p>
    </div>
    <button class="btn danger" id="d-yes">Delete</button>
    <button class="btn ghost mt" data-close>Cancel</button>
  `);
  sheet.querySelector('#d-yes').addEventListener('click', onYes);
}

// ============================================================================
// Backup / restore / wipe
// ============================================================================
function downloadFile(name, content, type = 'application/json') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function doExportJSON() {
  const data = await exportAll();
  downloadFile(`sanctum-backup-${todayISO()}.json`, JSON.stringify(data, null, 2));
  toast('Backup downloaded');
}
async function doExportCSV() {
  const csv = transactionsToCSV(S.transactions, { categories: S.categories, accounts: S.accounts });
  downloadFile(`sanctum-transactions-${todayISO()}.csv`, csv, 'text/csv');
  toast('CSV downloaded');
}
async function onRestoreFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const sheet = openSheet(`
      <div class="center"><div style="font-size:32px">⬆️</div>
      <h2 style="margin:10px 0 6px">Restore backup?</h2>
      <p class="muted tiny">Exported ${payload.exportedAt ? new Date(payload.exportedAt).toLocaleString() : 'unknown'}. This replaces all current data.</p></div>
      <button class="btn primary" id="rs-yes">Replace everything</button>
      <button class="btn ghost mt" data-close>Cancel</button>`);
    sheet.querySelector('#rs-yes').addEventListener('click', async () => {
      await importAll(payload, { merge: false });
      closeSheet(); await refresh(); await loadSettings(); render(); toast('Restored');
    });
  } catch { toast('Invalid backup file', true); }
}

// ============================================================================
// Global event delegation
// ============================================================================
document.addEventListener('click', async (e) => {
  if (!financeMounted) return;
  const hb = e.target.closest('[data-hub]');
  if (hb) { financeMounted = false; document.getElementById('chrome').style.display = 'none'; closeSheet(); return onExitHub && onExitHub(); }
  const t = e.target.closest('[data-close]'); if (t) return closeSheet();
  const b = e.target.closest('[data-back]'); if (b) return navigate('more');
  const nl = e.target.closest('[data-nav-link]'); if (nl) return navigate(nl.dataset.navLink);

  const mn = e.target.closest('[data-month]');
  if (mn) { S.month = addMonths(S.month + '-01', parseInt(mn.dataset.month)).slice(0, 7); if (S.month > thisMonth()) S.month = thisMonth(); return render(); }

  const hv = e.target.closest('[data-home-view]');
  if (hv) { S.homeView = hv.dataset.homeView; setSetting('homeView', S.homeView); return render(); }
  const ca = e.target.closest('[data-cf-account]');
  if (ca) { S.cfAccount = ca.dataset.cfAccount; return render(); }
  const ch = e.target.closest('[data-cf-horizon]');
  if (ch) { S.cfHorizon = parseInt(ch.dataset.cfHorizon); setSetting('cfHorizon', S.cfHorizon); return render(); }

  const tf = e.target.closest('#tx-filter [data-f]');
  if (tf) { S.txFilter = tf.dataset.f; return render(); }

  // Edit handlers
  const map = [
    ['data-edit-tx', 'transactions', txSheet],
    ['data-edit-account', 'accounts', accountSheet],
    ['data-edit-holding', 'holdings', holdingSheet],
    ['data-edit-goal', 'goals', goalSheet],
    ['data-edit-recurring', 'recurring', recurringSheet],
    ['data-edit-category', 'categories', categorySheet],
    ['data-edit-budget', 'budgets', budgetSheet],
  ];
  for (const [attr, store, fn] of map) {
    const el = e.target.closest(`[${attr}]`);
    if (el) {
      const rec = S[store].find((r) => r.id === el.getAttribute(attr));
      if (!rec) return; // stale/missing id — never fall through to a blank "add" sheet
      return fn(rec);
    }
  }

  // Add handlers
  if (e.target.closest('[data-add-account]')) return accountSheet();
  if (e.target.closest('[data-add-holding]')) return holdingSheet();
  if (e.target.closest('[data-add-goal]')) return goalSheet();
  if (e.target.closest('[data-add-recurring]')) return recurringSheet();
  if (e.target.closest('[data-add-category]')) return categorySheet();
  if (e.target.closest('[data-add-budget]')) return budgetSheet();

  // Import
  if (e.target.closest('[data-import-cancel]')) { importState = null; return render(); }
  if (e.target.closest('[data-import-confirm]')) return confirmImport();

  // Settings
  if (e.target.closest('#save-settings')) return saveSettings();
  if (e.target.closest('[data-export-json]')) return doExportJSON();
  if (e.target.closest('[data-export-csv]')) return doExportCSV();
  if (e.target.closest('[data-wipe]')) return wipeData();
});

async function confirmImport() {
  const accountId = document.getElementById('import-account').value;
  const drafts = importState.drafts;
  const other = S.categories.find((c) => c.type === 'expense' && c.name === 'Other');
  const otherInc = S.categories.find((c) => c.type === 'income') || other;
  const recs = drafts.map((d) => ({
    id: uid('t_'), type: d.type, amount: d.amount, accountId,
    categoryId: d.type === 'income' ? otherInc?.id : other?.id,
    date: d.date, note: d.note, createdAt: Date.now(),
  }));
  await db.bulkPut('transactions', recs);
  importState = null; await refresh(); toast(`Imported ${recs.length}`); navigate('transactions');
}

async function saveSettings() {
  await setSetting('name', document.getElementById('set-name').value.trim() || 'Wayne');
  const cur = document.getElementById('set-currency').value;
  await setSetting('currency', cur);
  const meta = { INR: 'en-IN', USD: 'en-US', EUR: 'en-IE', GBP: 'en-GB', JPY: 'ja-JP', AUD: 'en-AU', CAD: 'en-CA', AED: 'ar-AE', SGD: 'en-SG' };
  await setSetting('locale', meta[cur] || 'en-IN');
  render(); toast('Settings saved');
}

function wipeData() {
  const sheet = openSheet(`
    <div class="center"><div style="font-size:32px">⚠️</div>
    <h2 style="margin:10px 0 6px">Erase everything?</h2>
    <p class="muted tiny">All accounts, transactions, budgets and settings on this device will be permanently deleted. Export a backup first!</p></div>
    <button class="btn danger" id="w-yes">Erase all data</button>
    <button class="btn ghost mt" data-close>Cancel</button>`);
  sheet.querySelector('#w-yes').addEventListener('click', async () => {
    for (const store of db.stores) await db.clear(store);
    closeSheet();
    await setSetting('onboarded', false);
    location.reload();
  });
}

// ============================================================================
// Onboarding
// ============================================================================
function onboarding() {
  $app().innerHTML = `<div class="view onboard">
    ${BAT_SVG(46, 'bat-lg')}
    <h1 class="brand">SANCTUM</h1>
    <p>A private, offline finance tracker. Every dollar, rupee, and holding stays on <b>your</b> phone — no accounts, no servers.</p>
    <div class="field" style="width:100%;max-width:320px;text-align:left;margin-top:10px">
      <label>What should I call you?</label>
      <input class="input" id="ob-name" value="${escapeHtml(getSetting('name') || '')}" placeholder="Your name">
    </div>
    <div class="field" style="width:100%;max-width:320px;text-align:left">
      <label>Currency</label>
      <select class="input" id="ob-currency">${CURRENCIES.map((c) => `<option ${c === getSetting('currency') ? 'selected' : ''}>${c}</option>`).join('')}</select>
    </div>
    <button class="btn primary" style="max-width:320px" id="ob-start">Enter the Batcave →</button>
    <div class="tiny muted">Tip: after this loads, tap ⋮ → “Add to Home screen”.</div>
  </div>`;
  document.getElementById('ob-start').addEventListener('click', async () => {
    const cur = document.getElementById('ob-currency').value;
    const meta = { INR: 'en-IN', USD: 'en-US', EUR: 'en-IE', GBP: 'en-GB', JPY: 'ja-JP', AUD: 'en-AU', CAD: 'en-CA', AED: 'ar-AE', SGD: 'en-SG' };
    await setSetting('name', document.getElementById('ob-name').value.trim() || 'Wayne');
    await setSetting('currency', cur);
    await setSetting('locale', meta[cur] || 'en-IN');
    await setSetting('onboarded', true);
    await seedIfEmpty();
    await refresh();
    document.getElementById('chrome').style.display = '';
    render();
  });
}

// ============================================================================
// Bat logo
// ============================================================================
// Snyder/Affleck-inspired elongated bat emblem — wide angular blade wings,
// sharp swept-up tips, a low sleek head, twin membrane points per wing.
// Sanctum mark — minimal pointed arch, shared with shell.js and the PNG icons.
const BAT_D = 'M6,43 L6,24 C6,13 12.5,6.5 20,2.5 C27.5,6.5 34,13 34,24 L34,43';
function BAT_SVG(height = 22, cls = 'mark') {
  const w = Math.round(height * 40 / 46);
  return `<svg class="${cls}" width="${w}" height="${height}" viewBox="0 0 40 46" fill="none" stroke="var(--accent)"
    stroke-width="3" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="${BAT_D}"/>
  </svg>`;
}

// ============================================================================
// Boot
// ============================================================================
// Entry point when the Finance module is opened from the hub.
export async function mountFinance() {
  financeMounted = true;
  await loadSettings();
  if (!getSetting('onboarded')) {
    document.getElementById('chrome').style.display = 'none';
    onboarding();
  } else {
    await seedIfEmpty();
    await refresh();
    // Restore last-used view preferences
    const hv = getSetting('homeView'); if (hv === 'cashflow' || hv === 'expenses') S.homeView = hv;
    const hz = getSetting('cfHorizon'); if (hz) S.cfHorizon = hz;
    S.route = 'dashboard';
    document.getElementById('chrome').style.display = '';
    render();
  }
  if (!financeWired) {
    document.querySelectorAll('.nav button').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.nav)));
    document.getElementById('fab').addEventListener('click', () => txSheet());
    financeWired = true;
  }
}
