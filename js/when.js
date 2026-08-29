// when.js — turns "pay rent friday !!" into a title, a due date and a priority.
//
// Pure functions, no DOM, so it can be unit-tested (see ARCHITECTURE §10).
//
// The point is that typing a date should never require opening a date picker.
// Everything here is deliberately conservative: a phrase is only consumed if it
// is unambiguous, because silently eating part of someone's task title is worse
// than making them set the date by hand.

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_ABBR = ['sun', 'mon', 'tue', 'tues', 'wed', 'weds', 'thu', 'thur', 'thurs', 'fri', 'sat'];
const ABBR_TO_INDEX = {
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3,
  thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
};

export const iso = (d) => {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};
const fromISO = (s) => {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);            // local midnight; no timezone drift
};
export const addDaysISO = (s, n) => { const d = fromISO(s); d.setDate(d.getDate() + n); return iso(d); };

/** Add months, clamping to the end of a shorter month (Jan 31 + 1 = Feb 28/29). */
export function addMonthsISO(s, n) {
  const d = fromISO(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return iso(d);
}

/** The next occurrence of a weekday, strictly after today unless todayCounts. */
function nextWeekday(todayISO, target, { todayCounts = false, weeksAhead = 0 } = {}) {
  const d = fromISO(todayISO);
  let delta = (target - d.getDay() + 7) % 7;
  if (delta === 0 && !todayCounts) delta = 7;
  return addDaysISO(todayISO, delta + weeksAhead * 7);
}

// Ordered longest-first so "next friday" wins over "friday", and "every other
// week" over "every week". Each entry returns { due } and/or { repeat }.
function buildRules(todayISO) {
  const rules = [];
  const push = (re, fn) => rules.push({ re, fn });

  // --- repeats (checked first: "every friday" is a repeat, not a one-off) ---
  push(/\bevery\s+other\s+(day|week|month)\b/i, (m) => ({
    repeat: { unit: m[1].toLowerCase(), interval: 2 },
    due: m[1].toLowerCase() === 'day' ? addDaysISO(todayISO, 2)
      : m[1].toLowerCase() === 'week' ? addDaysISO(todayISO, 14) : addMonthsISO(todayISO, 2),
  }));
  push(new RegExp(`\\bevery\\s+(${DAYS.join('|')}|${DAY_ABBR.join('|')})s?\\b(?![\\w.\\-/@])`, 'i'), (m) => {
    const t = weekdayIndex(m[1]);
    return { repeat: { unit: 'week', interval: 1 }, due: nextWeekday(todayISO, t, { todayCounts: true }) };
  });
  push(/\b(every\s+day|daily)\b/i, () => ({ repeat: { unit: 'day', interval: 1 }, due: todayISO }));
  push(/\b(every\s+week|weekly)\b/i, () => ({ repeat: { unit: 'week', interval: 1 }, due: addDaysISO(todayISO, 7) }));
  push(/\b(every\s+month|monthly)\b/i, () => ({ repeat: { unit: 'month', interval: 1 }, due: addMonthsISO(todayISO, 1) }));
  push(/\b(every\s+year|yearly|annually)\b/i, () => ({ repeat: { unit: 'month', interval: 12 }, due: addMonthsISO(todayISO, 12) }));

  // --- one-off dates ---
  push(/\bday\s+after\s+tomorrow\b/i, () => ({ due: addDaysISO(todayISO, 2) }));
  push(/\b(tomorrow|tmrw|tmr)\b/i, () => ({ due: addDaysISO(todayISO, 1) }));
  push(/\b(today|tonight)\b/i, () => ({ due: todayISO }));
  push(/\bnext\s+week\b/i, () => ({ due: addDaysISO(todayISO, 7) }));
  push(/\bnext\s+month\b/i, () => ({ due: addMonthsISO(todayISO, 1) }));
  // A bare weekday is the one genuinely ambiguous token: "read Friday Night
  // Lights" and "monday.com subscription" are titles, not dates. So it is only
  // taken when introduced by on/by/due, or when it ends the line — and never
  // when glued to more word characters or punctuation like ".com".
  const DAY_ALT = `${DAYS.join('|')}|${DAY_ABBR.join('|')}`;
  const NOT_GLUED = '(?![\\w.\\-/@])';
  push(new RegExp(`\\bnext\\s+(${DAY_ALT})\\b${NOT_GLUED}`, 'i'),
    (m) => ({ due: nextWeekday(todayISO, weekdayIndex(m[1]), { weeksAhead: 1 }) }));
  push(new RegExp(`\\b(?:on|by|due)\\s+(${DAY_ALT})\\b${NOT_GLUED}`, 'i'),
    (m) => ({ due: nextWeekday(todayISO, weekdayIndex(m[1])) }));
  push(new RegExp(`\\b(${DAY_ALT})\\b${NOT_GLUED}\\s*$`, 'i'),
    (m) => ({ due: nextWeekday(todayISO, weekdayIndex(m[1])) }));
  push(/\bin\s+(\d{1,3})\s*(day|days|d)\b/i, (m) => ({ due: addDaysISO(todayISO, Number(m[1])) }));
  push(/\bin\s+(\d{1,2})\s*(week|weeks|w)\b/i, (m) => ({ due: addDaysISO(todayISO, Number(m[1]) * 7) }));
  push(/\bin\s+(\d{1,2})\s*(month|months|mo)\b/i, (m) => ({ due: addMonthsISO(todayISO, Number(m[1])) }));

  return rules;
}

function weekdayIndex(word) {
  const w = String(word).toLowerCase();
  const full = DAYS.indexOf(w);
  if (full !== -1) return full;
  return ABBR_TO_INDEX[w] ?? 1;
}

/**
 * Parse a quick-add line.
 *
 * Returns { title, due, repeat, priority }.
 *   due      — YYYY-MM-DD or null
 *   repeat   — { unit:'day'|'week'|'month', interval:number } or null
 *   priority — 2 for "!!", 1 for "!", else 0
 *
 * Only the FIRST date phrase is consumed; a second one is left in the title
 * rather than guessed at.
 */
export function parseWhen(text, todayISO) {
  let rest = String(text || '');
  let due = null;
  let repeat = null;

  // Priority markers, anywhere in the line.
  let priority = 0;
  const bang = rest.match(/(?:^|\s)(!{1,2})(?=\s|$)/);
  if (bang) {
    priority = bang[1].length === 2 ? 2 : 1;
    rest = rest.replace(bang[0], ' ');
  }

  for (const { re, fn } of buildRules(todayISO)) {
    const m = rest.match(re);
    if (!m) continue;
    const got = fn(m);
    // A repeat rule may also set the due date; a later date rule must not
    // overwrite a date the repeat already established.
    if (got.repeat && !repeat) repeat = got.repeat;
    if (got.due && !due) due = got.due;
    rest = rest.replace(m[0], ' ');
    if (due && repeat) break;
  }

  const title = rest.replace(/\s{2,}/g, ' ').trim().replace(/[\s,]+$/, '');
  return { title, due, repeat, priority };
}

/** Where a task belongs in the grouped list. Order matters; it drives the UI. */
export function bucketOf(todo, todayISO) {
  if (!todo.due) return 'someday';
  if (todo.due < todayISO) return 'overdue';
  if (todo.due === todayISO) return 'today';
  if (todo.due === addDaysISO(todayISO, 1)) return 'tomorrow';
  if (todo.due <= addDaysISO(todayISO, 7)) return 'week';
  return 'later';
}

/** Next due date for a repeating task once it is completed. */
export function nextDue(todo, todayISO) {
  if (!todo.repeat) return null;
  const { unit, interval = 1 } = todo.repeat;
  // Roll forward from the due date so a weekly task keeps its weekday, but
  // never land in the past — a task ignored for a month should come back
  // tomorrow, not fire a month of missed occurrences.
  let next = todo.due || todayISO;
  let guard = 0;
  do {
    next = unit === 'month' ? addMonthsISO(next, interval)
      : unit === 'week' ? addDaysISO(next, 7 * interval)
      : addDaysISO(next, interval);
  } while (next <= todayISO && guard++ < 400);
  return next;
}

export function repeatLabel(repeat) {
  if (!repeat) return '';
  const { unit, interval = 1 } = repeat;
  if (interval === 1) return { day: 'daily', week: 'weekly', month: 'monthly' }[unit] || '';
  if (unit === 'month' && interval === 12) return 'yearly';
  return `every ${interval} ${unit}s`;
}
