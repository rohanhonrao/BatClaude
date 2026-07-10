// compute.js — derived financial calculations from raw records.
import { monthKey, thisMonth } from './util.js';

// Signed effect of a transaction on a given account's balance.
function effectOn(t, accountId) {
  if (t.accountId === accountId) {
    if (t.type === 'income') return t.amount;
    if (t.type === 'expense') return -t.amount;
    if (t.type === 'transfer') return -t.amount; // money leaves source
  }
  if (t.type === 'transfer' && t.toAccountId === accountId) return t.amount; // arrives at dest
  return 0;
}

export function accountBalance(account, transactions) {
  let bal = account.balance || 0; // opening balance
  for (const t of transactions) bal += effectOn(t, account.id);
  return bal;
}

export function holdingValue(h) {
  return (h.quantity || 0) * (h.price || 0);
}

export function netWorth(accounts, transactions, holdings) {
  const liquid = accounts
    .filter((a) => !a.archived)
    .reduce((s, a) => s + accountBalance(a, transactions), 0);
  const invest = (holdings || []).reduce((s, h) => s + holdingValue(h), 0);
  return { total: liquid + invest, liquid, invest };
}

// Income/expense totals for a given YYYY-MM (or all-time if mk is null).
export function monthlyFlow(transactions, mk = thisMonth()) {
  let income = 0, expense = 0;
  for (const t of transactions) {
    if (t.type === 'transfer') continue;
    if (mk && monthKey(t.date) !== mk) continue;
    if (t.type === 'income') income += t.amount;
    else if (t.type === 'expense') expense += t.amount;
  }
  return { income, expense, net: income - expense };
}

// Spending grouped by category for a month. Returns [{categoryId, total}] desc.
export function spendByCategory(transactions, mk = thisMonth()) {
  const map = new Map();
  for (const t of transactions) {
    if (t.type !== 'expense') continue;
    if (mk && monthKey(t.date) !== mk) continue;
    map.set(t.categoryId, (map.get(t.categoryId) || 0) + t.amount);
  }
  return [...map.entries()]
    .map(([categoryId, total]) => ({ categoryId, total }))
    .sort((a, b) => b.total - a.total);
}

// Budget status per category for a month.
export function budgetStatus(budgets, transactions, categories, mk = thisMonth()) {
  const spent = new Map(spendByCategory(transactions, mk).map((r) => [r.categoryId, r.total]));
  return budgets
    .map((b) => {
      const cat = categories.find((c) => c.id === b.categoryId);
      const used = spent.get(b.categoryId) || 0;
      return {
        ...b,
        category: cat,
        used,
        remaining: b.amount - used,
        pct: b.amount > 0 ? Math.min(used / b.amount, 1) : 0,
        over: used > b.amount,
      };
    })
    .filter((b) => b.category)
    .sort((a, b) => b.pct - a.pct);
}

// Net-worth-ish trend: net cashflow per month over the last `months` months.
export function flowTrend(transactions, months = 6) {
  const now = new Date();
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const flow = monthlyFlow(transactions, mk);
    out.push({ mk, ...flow });
  }
  return out;
}

// Running liquid net worth at end of each of the last `months` months.
export function netWorthTrend(accounts, transactions, holdings, months = 6) {
  const openingLiquid = accounts.filter((a) => !a.archived).reduce((s, a) => s + (a.balance || 0), 0);
  const investNow = (holdings || []).reduce((s, h) => s + h.quantity * h.price, 0);
  const now = new Date();
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i + 1, 0); // last day of that month
    const cutoff = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let liquid = openingLiquid;
    for (const t of transactions) {
      if (t.date > cutoff) continue;
      if (t.type === 'income') liquid += t.amount;
      else if (t.type === 'expense') liquid -= t.amount;
      // transfers net to zero across accounts, ignore
    }
    out.push({ mk: cutoff.slice(0, 7), value: liquid + investNow });
  }
  return out;
}

// Upcoming recurring items within `days` (and any overdue ones).
export function upcomingRecurring(recurring, days = 14) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const limit = new Date(today); limit.setDate(limit.getDate() + days);
  return recurring
    .filter((r) => !r.paused)
    .map((r) => ({ ...r, due: new Date(r.nextDate + 'T00:00:00') }))
    .filter((r) => r.due <= limit)
    .sort((a, b) => a.due - b.due);
}
