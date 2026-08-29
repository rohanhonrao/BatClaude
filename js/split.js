// split.js — the money maths for the Joint module. Pure functions, no DOM, so
// it can be unit-tested outside a browser (see ARCHITECTURE §10).
//
// Everything is computed in **integer cents**. Splitting dollars as floats
// accumulates drift: 1/3 of $10 three ways can silently fail to equal $10, and
// over months of rent that becomes a real disagreement. Shares are therefore
// derived so they always sum exactly to the amount charged.

export const CENTS = (dollars) => Math.round(Number(dollars || 0) * 100);
export const DOLLARS = (cents) => (cents || 0) / 100;

/**
 * Share of income for each person, from whichever basis is in use.
 * Returns a map personId -> fraction (sums to 1). Falls back to an even split
 * when nobody has entered an income yet, so the app is usable immediately.
 */
export function incomeRatios(people, basis) {
  const key = basis === 'gross' ? 'incomeGross' : 'incomeNet';
  const vals = people.map((p) => Math.max(0, Number(p[key]) || 0));
  const total = vals.reduce((a, b) => a + b, 0);
  const out = {};
  people.forEach((p, i) => { out[p.id] = total > 0 ? vals[i] / total : 1 / people.length; });
  return out;
}

/**
 * Split one expense into integer-cent shares per person.
 *
 * rule:
 *   'ratio'      — by income ratio
 *   'equal'      — evenly
 *   'payer'      — entirely the payer's own cost
 *   'other'      — entirely the other person's cost
 *   'custom'     — `customPct` is the PAYER's percentage (0-100)
 *
 * People are sorted by id first so both phones compute the identical
 * allocation; otherwise the rounding remainder could land on different people
 * and the two devices would disagree about the balance.
 */
export function shareOf(amountCents, { rule = 'ratio', customPct = 50, payerId }, people, ratios) {
  const ordered = [...people].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const shares = {};
  for (const p of ordered) shares[p.id] = 0;
  if (!ordered.length || !amountCents) return shares;

  if (rule === 'payer' || rule === 'other') {
    const other = ordered.find((p) => p.id !== payerId) || ordered[0];
    const target = rule === 'payer' ? (ordered.find((p) => p.id === payerId) || ordered[0]) : other;
    shares[target.id] = amountCents;
    return shares;
  }

  let weights;
  if (rule === 'equal') {
    weights = ordered.map(() => 1 / ordered.length);
  } else if (rule === 'custom' && ordered.length === 2) {
    const pct = Math.min(100, Math.max(0, Number(customPct) || 0)) / 100;
    weights = ordered.map((p) => (p.id === payerId ? pct : 1 - pct));
  } else {
    weights = ordered.map((p) => ratios[p.id] ?? 1 / ordered.length);
  }

  // Round all but the last, then give the last the remainder so the parts
  // always add up to exactly the amount.
  let running = 0;
  ordered.forEach((p, i) => {
    if (i === ordered.length - 1) shares[p.id] = amountCents - running;
    else { const s = Math.round(amountCents * weights[i]); shares[p.id] = s; running += s; }
  });
  return shares;
}

/**
 * The rule that actually applies to an expense: its own override, else its
 * category's default, else income ratio.
 *
 * This must be used everywhere a share is computed. Choosing "Category default"
 * in the expense form stores `rule: ''`, and an empty string is not `undefined`,
 * so `shareOf`'s default parameter never fires — the category's rule was being
 * skipped and everything fell through to income ratio. The form's live preview
 * resolved it correctly, so a category set to 50/50 previewed as 50/50 and then
 * settled by income.
 */
export function effectiveRule(expense, categories = []) {
  if (expense && expense.rule) return expense.rule;
  const c = categories.find((x) => x.id === (expense && expense.categoryId));
  return (c && c.rule) || 'ratio';
}

/**
 * Net position per person over a set of expenses and settlements.
 *
 * net > 0  -> this person has put in more than their share; they are owed.
 * net < 0  -> they owe.
 * With two people the nets are exact mirrors, so the UI shows one number.
 *
 * A settlement is money actually handed over: it reduces the payer's debt,
 * which is why it counts the same way a paid expense does.
 *
 * `categories` is needed to resolve each expense's effective rule — omit it and
 * every "Category default" expense silently falls back to income ratio.
 */
export function positions({ people, expenses, settlements = [], categories = [], basis = 'net' }) {
  const ratios = incomeRatios(people, basis);
  const net = {};
  const paid = {};
  const owedShare = {};
  for (const p of people) { net[p.id] = 0; paid[p.id] = 0; owedShare[p.id] = 0; }

  for (const e of expenses) {
    const amt = CENTS(e.amount);
    if (!amt || !e.payerId || net[e.payerId] === undefined) continue;
    const shares = shareOf(amt, { ...e, rule: effectiveRule(e, categories) }, people, ratios);
    paid[e.payerId] += amt;
    net[e.payerId] += amt;
    for (const [pid, s] of Object.entries(shares)) {
      if (net[pid] === undefined) continue;
      net[pid] -= s;
      owedShare[pid] += s;
    }
  }

  for (const s of settlements) {
    const amt = CENTS(s.amount);
    if (!amt) continue;
    if (net[s.fromId] !== undefined) net[s.fromId] += amt;
    if (net[s.toId] !== undefined) net[s.toId] -= amt;
  }

  return { ratios, net, paid, owedShare };
}

/**
 * The single sentence the app leads with: who owes whom, and how much.
 * Amounts under a cent are treated as settled to avoid "$0.00 owed" states.
 */
export function balanceBetween(people, net) {
  if (people.length !== 2) return { settled: true, amount: 0 };
  const [a, b] = [...people].sort((x, y) => String(x.id).localeCompare(String(y.id)));
  const diff = net[a.id] || 0;
  if (Math.abs(diff) < 1) return { settled: true, amount: 0 };
  return diff > 0
    ? { settled: false, amount: DOLLARS(diff), creditor: a, debtor: b }
    : { settled: false, amount: DOLLARS(-diff), creditor: b, debtor: a };
}

// --- weekly cycle ------------------------------------------------------------
// Weeks run Monday-Sunday, which matches how people talk about "this week"
// better than a Sunday start does.
export function weekStart(iso) {
  const p = String(iso).split('-');
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  const dow = (d.getDay() + 6) % 7;            // Mon = 0
  d.setDate(d.getDate() - dow);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
export function inWeek(iso, anchorISO) { return weekStart(iso) === weekStart(anchorISO); }

// --- monthly cycle -----------------------------------------------------------
export function monthKey(iso) { return String(iso).slice(0, 7); }        // YYYY-MM
export function inMonth(iso, key) { return monthKey(iso) === key; }

/** Step a YYYY-MM key by n months, without Date's timezone surprises. */
export function shiftMonth(key, n) {
  const [y, m] = String(key).split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const yy = Math.floor(total / 12);
  const mm = (total % 12) + 1;
  return `${yy}-${String(mm).padStart(2, '0')}`;
}

/**
 * What a month cost, broken down the two ways the question is usually asked:
 * fixed vs variable, and per person.
 *
 * Per person there are two different numbers and they are not interchangeable:
 *   share — what that person is responsible for under the split rules
 *   paid  — what they actually laid out
 * The gap between them is what settling up moves. Reporting only one of them
 * is what makes shared-expense apps feel wrong.
 *
 * Category `kind` drives fixed/variable; an expense whose category has been
 * deleted counts toward the totals as variable rather than vanishing.
 */
export function monthlySummary({ people, expenses, categories = [], basis = 'net', month }) {
  const ratios = incomeRatios(people, basis);
  const kindOf = (id) => (categories.find((c) => c.id === id)?.kind === 'fixed' ? 'fixed' : 'variable');
  const nameOf = (id) => categories.find((c) => c.id === id)?.name || 'Uncategorised';
  const iconOf = (id) => categories.find((c) => c.id === id)?.icon || 'ti-dots';

  const share = {}, paid = {};
  for (const p of people) { share[p.id] = 0; paid[p.id] = 0; }
  const byKind = { fixed: 0, variable: 0 };
  const byCategory = new Map();
  let total = 0;

  for (const e of expenses) {
    if (!inMonth(e.date, month)) continue;
    const amt = CENTS(e.amount);
    if (!amt || !e.payerId || paid[e.payerId] === undefined) continue;

    const kind = kindOf(e.categoryId);
    const shares = shareOf(amt, { ...e, rule: effectiveRule(e, categories) }, people, ratios);
    total += amt;
    byKind[kind] += amt;
    paid[e.payerId] += amt;

    const key = e.categoryId || '_none';
    if (!byCategory.has(key)) {
      const perPerson = {};
      for (const p of people) perPerson[p.id] = 0;
      byCategory.set(key, { id: key, name: nameOf(e.categoryId), icon: iconOf(e.categoryId),
        kind, total: 0, count: 0, perPerson });
    }
    const row = byCategory.get(key);
    row.total += amt; row.count += 1;

    for (const [pid, s] of Object.entries(shares)) {
      if (share[pid] === undefined) continue;
      share[pid] += s;
      row.perPerson[pid] += s;
    }
  }

  return {
    month, total, byKind, share, paid,
    categories: [...byCategory.values()].sort((a, b) =>
      (a.kind === b.kind ? b.total - a.total : a.kind === 'fixed' ? -1 : 1)),
  };
}

/** Every month that has at least one expense, newest first. */
export function monthsWithActivity(expenses) {
  const set = new Set(expenses.map((e) => monthKey(e.date)).filter((m) => /^\d{4}-\d{2}$/.test(m)));
  return [...set].sort().reverse();
}
