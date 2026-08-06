// projection.js — cash-flow projection engine.
//
// Model: actual logged transactions are the truth up to and including today.
// Everything AFTER today comes only from scheduled items the user has set up
// (no estimates, nothing invented). That keeps the projection factual and
// makes double-counting structurally impossible for the past.
//
// A scheduled item ("rule") looks like:
//   { id, name, type: 'income'|'expense'|'transfer', amount, accountId,
//     toAccountId?, categoryId, frequency, nextDate, endDate?, paused,
//     day2? (semimonthly second day) }

// --- date helpers (ES5-safe so they can be unit-tested outside a browser) ---

export function isoOf(d) {
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1);
  var day = String(d.getDate());
  if (m.length < 2) m = '0' + m;
  if (day.length < 2) day = '0' + day;
  return y + '-' + m + '-' + day;
}
// Parsed component-wise rather than via Date string parsing: avoids timezone
// shifts and engine differences (Safari, older engines) entirely.
export function parseISO(iso) {
  var p = String(iso).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

export function plusDays(iso, n) {
  var d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return isoOf(d);
}

// Add months while clamping to the end of shorter months:
// Jan 31 +1mo -> Feb 28/29, and the anchor day is preserved for later months.
export function plusMonthsClamped(iso, n, anchorDay) {
  var d = parseISO(iso);
  var day = anchorDay || d.getDate();
  var y = d.getFullYear();
  var m = d.getMonth() + n;
  var lastDay = new Date(y, m + 1, 0).getDate();
  return isoOf(new Date(y, m, Math.min(day, lastDay)));
}

// Day-of-month within a given month, where 31 means "last day".
function dayInMonth(year, monthIdx, day) {
  var lastDay = new Date(year, monthIdx + 1, 0).getDate();
  return isoOf(new Date(year, monthIdx, Math.min(day, lastDay)));
}

// --- schedule expansion -----------------------------------------------------

// Expand one rule into occurrence dates within [fromISO, toISO] (inclusive).
// Guards against runaway loops with a hard cap.
export function expandRule(rule, fromISO, toISO) {
  var out = [];
  if (!rule || rule.paused) return out;
  var start = rule.nextDate;
  if (!start) return out;
  var hardEnd = rule.endDate && rule.endDate < toISO ? rule.endDate : toISO;
  var freq = rule.frequency || 'monthly';
  var guard = 0;

  if (freq === 'once') {
    if (start >= fromISO && start <= hardEnd) out.push(start);
    return out;
  }

  if (freq === 'semimonthly') {
    // Two occurrences a month: the anchor day and `day2` (default 15 / last).
    var anchor = parseISO(start).getDate();
    var second = rule.day2 || (anchor <= 15 ? 31 : 15);
    var d0 = parseISO(fromISO < start ? start : fromISO);
    var y = d0.getFullYear(), mi = d0.getMonth();
    while (guard++ < 400) {
      var days = [anchor, second].sort(function (a, b) { return a - b; });
      for (var i = 0; i < days.length; i++) {
        var iso = dayInMonth(y, mi, days[i]);
        if (iso > hardEnd) return out;
        if (iso >= fromISO && iso >= start) out.push(iso);
      }
      mi++;
      if (mi > 11) { mi = 0; y++; }
      if (dayInMonth(y, mi, days[0]) > hardEnd) break;
    }
    return out;
  }

  var stepDays = { weekly: 7, biweekly: 14 }[freq];
  var stepMonths = { monthly: 1, quarterly: 3, yearly: 12 }[freq];
  if (!stepDays && !stepMonths) return out;

  var anchorDay = parseISO(start).getDate();
  var cur = start;
  var iter = 0;
  while (cur <= hardEnd && guard++ < 2000) {
    if (cur >= fromISO) out.push(cur);
    iter++;
    cur = stepDays ? plusDays(start, stepDays * iter)
                   : plusMonthsClamped(start, stepMonths * iter, anchorDay);
  }
  return out;
}

// --- balances ---------------------------------------------------------------

// Signed effect of a transaction on one account.
export function effectOn(t, accountId) {
  if (t.accountId === accountId) {
    if (t.type === 'income') return t.amount;
    if (t.type === 'expense') return -t.amount;
    if (t.type === 'transfer') return -t.amount;
  }
  if (t.type === 'transfer' && t.toAccountId === accountId) return t.amount;
  return 0;
}

// Signed effect of a scheduled rule occurrence on one account.
function ruleEffectOn(rule, accountId) {
  if (rule.accountId === accountId) {
    if (rule.type === 'income') return rule.amount;
    if (rule.type === 'expense') return -rule.amount;
    if (rule.type === 'transfer') return -rule.amount;
  }
  if (rule.type === 'transfer' && rule.toAccountId === accountId) return rule.amount;
  return 0;
}

// Balance of an account as of (and including) `asOfISO`.
export function balanceAsOf(account, transactions, asOfISO) {
  var bal = account.balance || 0; // opening balance
  for (var i = 0; i < transactions.length; i++) {
    var t = transactions[i];
    if (t.date > asOfISO) continue;
    bal += effectOn(t, account.id);
  }
  return bal;
}

// --- projection -------------------------------------------------------------

/**
 * Build a forward projection for one account (or a set of accounts combined).
 * accounts: array of account objects to include (1 = single view, N = combined)
 * Returns { start, events, points, lowest, endBalance, totals }
 */
export function project(opts) {
  var accounts = opts.accounts || [];
  var transactions = opts.transactions || [];
  var rules = opts.rules || [];
  var today = opts.today;
  var horizonDays = opts.horizonDays || 60;
  var endISO = plusDays(today, horizonDays);

  // Starting balance = sum of actual balances today.
  var start = 0;
  for (var a = 0; a < accounts.length; a++) start += balanceAsOf(accounts[a], transactions, today);

  // Already-posted occurrences, so a scheduled item that was logged early
  // is never counted twice.
  var posted = {};
  for (var i = 0; i < transactions.length; i++) {
    var t = transactions[i];
    if (t.recurringId && t.scheduledFor) posted[t.recurringId + '|' + t.scheduledFor] = true;
  }

  // Collect future events that affect any included account.
  var events = [];
  for (var r = 0; r < rules.length; r++) {
    var rule = rules[r];
    var delta = 0;
    for (var k = 0; k < accounts.length; k++) delta += ruleEffectOn(rule, accounts[k].id);
    if (delta === 0) continue; // irrelevant, or an internal transfer that nets out
    var dates = expandRule(rule, plusDays(today, 1), endISO);
    for (var d = 0; d < dates.length; d++) {
      if (posted[rule.id + '|' + dates[d]]) continue;
      events.push({
        date: dates[d], ruleId: rule.id, name: rule.name,
        type: rule.type, amount: rule.amount, delta: delta,
        categoryId: rule.categoryId, accountId: rule.accountId,
      });
    }
  }
  // Transactions already logged with a FUTURE date are known events too.
  // Without this they'd fall through the gap: excluded from today's balance,
  // and excluded from the schedule because they're marked as posted.
  for (var f = 0; f < transactions.length; f++) {
    var ft = transactions[f];
    if (ft.date <= today || ft.date > endISO) continue;
    var fd = 0;
    for (var fa = 0; fa < accounts.length; fa++) fd += effectOn(ft, accounts[fa].id);
    if (fd === 0) continue;
    events.push({
      date: ft.date, ruleId: ft.recurringId || null, txId: ft.id,
      name: ft.note || '', type: ft.type, amount: ft.amount, delta: fd,
      categoryId: ft.categoryId, accountId: ft.accountId, logged: true,
    });
  }

  events.sort(function (x, y) { return x.date < y.date ? -1 : x.date > y.date ? 1 : 0; });

  // Walk forward, tracking the running balance.
  var running = start;
  var lowest = { date: today, balance: start };
  var inflow = 0, outflow = 0;
  var points = [{ date: today, balance: start }];
  for (var e = 0; e < events.length; e++) {
    running += events[e].delta;
    events[e].balance = running;
    if (events[e].delta > 0) inflow += events[e].delta; else outflow += -events[e].delta;
    points.push({ date: events[e].date, balance: running });
    if (running < lowest.balance) lowest = { date: events[e].date, balance: running };
  }
  points.push({ date: endISO, balance: running });

  return {
    start: start, events: events, points: points, lowest: lowest,
    endBalance: running, endDate: endISO,
    totals: { inflow: inflow, outflow: outflow, net: inflow - outflow },
  };
}

/**
 * One continuous ledger: history, today, and the projected future sharing a
 * single running-balance column.
 *
 * The past is real transactions; the future is scheduled items (plus any
 * future-dated transactions). Both carry the balance *after* that row, so the
 * column reads straight through the present without a seam.
 */
export function ledger(opts) {
  var accounts = opts.accounts || [];
  var transactions = opts.transactions || [];
  var today = opts.today;
  var historyDays = opts.historyDays || 60;
  var fromISO = plusDays(today, -historyDays);

  // Everything before the window is folded into one opening figure, so the
  // running balance stays correct no matter how far back we're showing.
  var opening = 0;
  for (var a = 0; a < accounts.length; a++) {
    opening += balanceAsOf(accounts[a], transactions, plusDays(fromISO, -1));
  }

  var inWindow = [];
  var older = false;
  for (var i = 0; i < transactions.length; i++) {
    var t = transactions[i];
    if (t.date > today) continue;            // future-dated: handled by project()
    var delta = 0;
    for (var k = 0; k < accounts.length; k++) delta += effectOn(t, accounts[k].id);
    if (delta === 0) continue;               // internal transfer, or not ours
    // Only count history that actually belongs to the selected accounts,
    // otherwise another account's old activity offers "show earlier" for
    // rows that will never appear.
    if (t.date < fromISO) { older = true; continue; }
    inWindow.push({ t: t, delta: delta });
  }
  inWindow.sort(function (x, y) {
    if (x.t.date !== y.t.date) return x.t.date < y.t.date ? -1 : 1;
    return String(x.t.createdAt || '') < String(y.t.createdAt || '') ? -1 : 1;
  });

  var running = opening;
  var past = [];
  for (var p = 0; p < inWindow.length; p++) {
    running += inWindow[p].delta;
    past.push({
      kind: 'past',
      txId: inWindow[p].t.id,
      date: inWindow[p].t.date,
      note: inWindow[p].t.note || '',
      type: inWindow[p].t.type,
      categoryId: inWindow[p].t.categoryId,
      accountId: inWindow[p].t.accountId,
      toAccountId: inWindow[p].t.toAccountId,
      delta: inWindow[p].delta,
      balance: running,
    });
  }

  var proj = project({
    accounts: accounts, transactions: transactions, rules: opts.rules,
    today: today, horizonDays: opts.horizonDays || 60,
  });

  var future = [];
  for (var f = 0; f < proj.events.length; f++) {
    var e = proj.events[f];
    future.push({
      kind: 'future', ruleId: e.ruleId, txId: e.txId, logged: e.logged,
      date: e.date, note: e.name, type: e.type, categoryId: e.categoryId,
      accountId: e.accountId, delta: e.delta, balance: e.balance,
    });
  }

  return {
    opening: opening,
    fromISO: fromISO,
    past: past,
    future: future,
    todayBalance: proj.start,
    hasOlder: older,
    projection: proj,
  };
}

// Historical daily balance series for the trailing part of the chart.
export function historySeries(accounts, transactions, fromISO, toISO) {
  var pts = [];
  var cursor = fromISO;
  var guard = 0;
  while (cursor <= toISO && guard++ < 400) {
    var bal = 0;
    for (var a = 0; a < accounts.length; a++) bal += balanceAsOf(accounts[a], transactions, cursor);
    pts.push({ date: cursor, balance: bal });
    cursor = plusDays(cursor, Math.max(1, Math.round(guard === 1 ? 1 : 1)));
  }
  return pts;
}
