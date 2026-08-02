// util.js — formatting, dates, settings, and seed data.
import { db, uid } from './db.js';

// --- Settings ---------------------------------------------------------------

const DEFAULT_SETTINGS = {
  currency: 'USD',
  locale: 'en-US',
  name: 'Wayne',
  onboarded: false,
};

let _settings = { ...DEFAULT_SETTINGS };

export async function loadSettings() {
  const rows = await db.all('settings');
  for (const r of rows) _settings[r.key] = r.value;
  return _settings;
}
export function getSetting(key) { return _settings[key]; }
export async function setSetting(key, value) {
  _settings[key] = value;
  await db.put('settings', { key, value });
}
export function settings() { return _settings; }

// --- Currency & numbers -----------------------------------------------------

const CURRENCY_META = {
  USD: { symbol: '$', locale: 'en-US', name: 'US Dollar' },
  INR: { symbol: '₹', locale: 'en-IN', name: 'Indian Rupee' },
  EUR: { symbol: '€', locale: 'en-IE', name: 'Euro' },
  GBP: { symbol: '£', locale: 'en-GB', name: 'British Pound' },
  JPY: { symbol: '¥', locale: 'ja-JP', name: 'Japanese Yen' },
  AUD: { symbol: 'A$', locale: 'en-AU', name: 'Australian Dollar' },
  CAD: { symbol: 'C$', locale: 'en-CA', name: 'Canadian Dollar' },
  AED: { symbol: 'د.إ', locale: 'ar-AE', name: 'UAE Dirham' },
  SGD: { symbol: 'S$', locale: 'en-SG', name: 'Singapore Dollar' },
};
export const CURRENCIES = Object.keys(CURRENCY_META);
export function currencyName(code) { return (CURRENCY_META[code] || {}).name || code; }
export function currencySymbolOf(code) { return (CURRENCY_META[code] || {}).symbol || code; }

// Format an amount in an explicit currency (independent of the app's setting).
export function fmtMoneyIn(n, code) {
  const meta = CURRENCY_META[code] || { locale: 'en-US' };
  try {
    return new Intl.NumberFormat(meta.locale, { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(n || 0);
  } catch {
    return (meta.symbol || '') + (n || 0).toFixed(2);
  }
}

export function currencySymbol() {
  return (CURRENCY_META[getSetting('currency')] || CURRENCY_META.INR).symbol;
}

export function fmtMoney(n, { sign = false, compact = false } = {}) {
  const cur = getSetting('currency') || 'INR';
  const meta = CURRENCY_META[cur] || CURRENCY_META.INR;
  const abs = Math.abs(n || 0);
  let str;
  try {
    str = new Intl.NumberFormat(meta.locale, {
      style: 'currency', currency: cur,
      notation: compact ? 'compact' : 'standard',
      maximumFractionDigits: compact ? 1 : 2,
      minimumFractionDigits: compact ? 0 : 2,
    }).format(abs);
  } catch {
    str = meta.symbol + abs.toFixed(2);
  }
  if (n < 0) return '-' + str;
  if (sign && n > 0) return '+' + str;
  return str;
}

export function parseAmount(str) {
  if (typeof str === 'number') return str;
  const n = parseFloat(String(str).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// --- Dates ------------------------------------------------------------------

export function todayISO() {
  const d = new Date();
  return isoDate(d);
}
export function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
export function monthKey(iso) { return (iso || todayISO()).slice(0, 7); } // YYYY-MM
export function thisMonth() { return monthKey(todayISO()); }

export function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(getSetting('locale') || 'en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function fmtDateShort(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(getSetting('locale') || 'en-IN', { day: 'numeric', month: 'short' });
}
export function monthLabel(mk) {
  const d = new Date(mk + '-01T00:00:00');
  return d.toLocaleDateString(getSetting('locale') || 'en-IN', { month: 'long', year: 'numeric' });
}
export function addMonths(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setMonth(d.getMonth() + n);
  return isoDate(d);
}
export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return isoDate(d);
}
export function relativeDay(iso) {
  const diff = Math.round((new Date(iso + 'T00:00:00') - new Date(todayISO() + 'T00:00:00')) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff <= 7) return `In ${diff} days`;
  if (diff < -1 && diff >= -7) return `${-diff} days ago`;
  return fmtDateShort(iso);
}

// --- Misc -------------------------------------------------------------------

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Render an icon that may be a Tabler name ("ti-wallet") or a legacy emoji
// left over from earlier versions — so existing data keeps rendering.
export function icon(name, fallback = 'ti-point') {
  const n = String(name || fallback);
  return /^ti-/.test(n) ? `<i class="ti ${escapeHtml(n)}"></i>` : escapeHtml(n);
}

// Curated set offered by the icon pickers.
export const ICON_CHOICES = [
  'ti-tools-kitchen-2', 'ti-shopping-cart', 'ti-shopping-bag', 'ti-car', 'ti-gas-station',
  'ti-home', 'ti-bolt', 'ti-droplet', 'ti-wifi', 'ti-device-mobile',
  'ti-movie', 'ti-music', 'ti-device-gamepad-2', 'ti-barbell', 'ti-pill',
  'ti-stethoscope', 'ti-plane', 'ti-bed', 'ti-book', 'ti-school',
  'ti-briefcase', 'ti-building-bank', 'ti-cash', 'ti-credit-card', 'ti-pig-money',
  'ti-chart-line', 'ti-gift', 'ti-heart', 'ti-paw', 'ti-baby-carriage',
  'ti-scissors', 'ti-shirt', 'ti-tools', 'ti-repeat', 'ti-receipt',
  'ti-coffee', 'ti-beer', 'ti-package', 'ti-dots', 'ti-star',
];

export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// --- Seed defaults ----------------------------------------------------------

export const DEFAULT_CATEGORIES = [
  { name: 'Salary', type: 'income', color: '#4ade80', icon: 'ti-briefcase' },
  { name: 'Business', type: 'income', color: '#34d399', icon: 'ti-chart-line' },
  { name: 'Interest', type: 'income', color: '#22d3ee', icon: 'ti-building-bank' },
  { name: 'Gifts', type: 'income', color: '#a78bfa', icon: 'ti-gift' },
  { name: 'Food & Dining', type: 'expense', color: '#f97316', icon: 'ti-tools-kitchen-2' },
  { name: 'Groceries', type: 'expense', color: '#84cc16', icon: 'ti-shopping-cart' },
  { name: 'Transport', type: 'expense', color: '#38bdf8', icon: 'ti-car' },
  { name: 'Shopping', type: 'expense', color: '#e879f9', icon: 'ti-shopping-bag' },
  { name: 'Bills & Utilities', type: 'expense', color: '#fbbf24', icon: 'ti-bolt' },
  { name: 'Rent', type: 'expense', color: '#f43f5e', icon: 'ti-home' },
  { name: 'Entertainment', type: 'expense', color: '#c084fc', icon: 'ti-movie' },
  { name: 'Health', type: 'expense', color: '#fb7185', icon: 'ti-pill' },
  { name: 'Travel', type: 'expense', color: '#2dd4bf', icon: 'ti-plane' },
  { name: 'Education', type: 'expense', color: '#60a5fa', icon: 'ti-book' },
  { name: 'Subscriptions', type: 'expense', color: '#f472b6', icon: 'ti-repeat' },
  { name: 'Other', type: 'expense', color: '#94a3b8', icon: 'ti-package' },
];

export const DEFAULT_ACCOUNTS = [
  { name: 'Cash', type: 'cash', balance: 0, icon: 'ti-cash' },
  { name: 'Bank Account', type: 'bank', balance: 0, icon: 'ti-building-bank' },
];

export async function seedIfEmpty() {
  const cats = await db.all('categories');
  if (cats.length === 0) {
    await db.bulkPut('categories', DEFAULT_CATEGORIES.map((c) => ({ id: uid('c_'), archived: false, ...c })));
  }
  const accts = await db.all('accounts');
  if (accts.length === 0) {
    await db.bulkPut('accounts', DEFAULT_ACCOUNTS.map((a) => ({ id: uid('a_'), archived: false, currency: getSetting('currency'), ...a })));
  }
}
