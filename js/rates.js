// rates.js — live exchange rates for the built-in converter.
// Uses a free, no-key public API (fawazahmed0 currency-api via CDN). The only
// thing sent over the network is the base currency code — never your data.
// Rates are cached on-device so the converter still works offline.
import { db } from './db.js';

const BASE = 'usd'; // fetch everything relative to USD, derive cross-rates locally
const PRIMARY = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${BASE}.json`;
const FALLBACK = `https://latest.currency-api.pages.dev/v1/currencies/${BASE}.json`;
const MAX_AGE = 6 * 60 * 60 * 1000; // 6 hours

let mem = null;

export async function getCached() {
  if (mem) return mem;
  const row = await db.get('settings', 'ratesUSD');
  mem = row ? row.value : null;
  return mem;
}

export async function refreshRates() {
  let data;
  try {
    const r = await fetch(PRIMARY, { cache: 'no-store' });
    if (!r.ok) throw new Error('primary');
    data = await r.json();
  } catch {
    const r = await fetch(FALLBACK, { cache: 'no-store' });
    if (!r.ok) throw new Error('Could not fetch exchange rates');
    data = await r.json();
  }
  const rates = { ...(data[BASE] || {}) };
  rates[BASE] = 1;
  const value = { base: BASE, rates, date: data.date || null, fetchedAt: Date.now() };
  mem = value;
  await db.put('settings', { key: 'ratesUSD', value });
  return value;
}

// Return cached rates, refreshing in the background if stale and online.
export async function ensureFresh() {
  const c = await getCached();
  const stale = !c || (Date.now() - c.fetchedAt > MAX_AGE);
  if (stale && navigator.onLine) {
    try { return await refreshRates(); } catch { return c; }
  }
  return c;
}

// Cross-rate conversion using USD-based table. rates[x] = units of x per 1 USD.
export function convert(cache, amount, from, to) {
  if (!cache) return null;
  const rf = cache.rates[from.toLowerCase()];
  const rt = cache.rates[to.toLowerCase()];
  if (!rf || !rt) return null;
  return amount * (rt / rf);
}

export function rateBetween(cache, from, to) {
  return convert(cache, 1, from, to);
}
