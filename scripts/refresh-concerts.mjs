// refresh-concerts.mjs — rebuild data/concerts-<city>.json from public listings.
//
// Runs on GitHub Actions (Node 20+, no dependencies). Server-side, so there is
// no CORS problem and no API key. We read schema.org JSON-LD that the listing
// pages already publish rather than scraping markup, which is far less brittle.
import { writeFile, readFile } from 'node:fs/promises';
import { enrich } from './enrich-artists.mjs';

const CITIES = {
  la: { name: 'Los Angeles', metro: '17835-us-los-angeles-la' },
  nyc: { name: 'New York', metro: '7644-us-new-york' },
  sf: { name: 'San Francisco', metro: '26330-us-san-francisco' },
};

const WINDOW_DAYS = 28;
const MAX_PAGES = 14;
const UA = 'Mozilla/5.0 (compatible; SanctumConcerts/1.0; personal use)';

// Window is computed in the CITY's timezone, not the runner's UTC clock —
// otherwise an evening run drops tonight's shows as "yesterday".
const TZ = 'America/Los_Angeles';
const localISO = (d) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const today = new Date();
const startISO = localISO(today);
const endISO = localISO(new Date(today.getTime() + WINDOW_DAYS * 86400000));

// Comedy shows are listed alongside music but aren't concerts.
const COMEDY_VENUE = /improv|comedy store|laugh factory|comedy club|the stand up/i;
const isComedy = (ev) => ev.genre === 'comedy' || COMEDY_VENUE.test(ev.venue);

const slug = (s) => String(s).toLowerCase().normalize('NFKD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '').slice(0, 22);

function extractLdJson(html) {
  const out = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      Array.isArray(parsed) ? out.push(...parsed) : out.push(parsed);
    } catch { /* skip malformed block */ }
  }
  return out;
}

function toEvent(node) {
  if (!node || node['@type'] !== 'MusicEvent' || !node.startDate) return null;
  const date = String(node.startDate).slice(0, 10);
  if (date < startISO || date > endISO) return null;

  const performers = [].concat(node.performer || []).filter(Boolean);
  const artist = performers[0]?.name || node.name;
  if (!artist) return null;
  const venue = node.location?.name || node.location?.address?.addressLocality;
  if (!venue) return null;

  const ev = {
    id: '',
    artist: String(artist).trim(),
    venue: String(venue).trim(),
    date,
    source: 'Songkick',
    url: String(node.url || '').split('?')[0],
  };
  const support = performers.slice(1).map((p) => p.name).filter(Boolean);
  if (support.length) ev.support = support.slice(0, 4);

  const locality = node.location?.address?.addressLocality;
  if (locality) ev.neighborhood = String(locality).replace(/\s*\(.*\)$/, '').trim();

  // Times are only present on some listings — never invent one.
  const t = String(node.startDate).match(/T(\d{2}:\d{2})/);
  if (t) ev.time = t[1];

  // Take genres from every performer on the bill, not just the headliner —
  // support acts often carry tags the headliner's entry is missing.
  const genres = [...new Set(performers.flatMap((p) => [].concat(p.genre || [])))]
    .map((g) => String(g).replace(/_/g, ' ').replace(/\band\b/g, '&').trim())
    .filter(Boolean);
  if (genres.length) {
    ev.genre = genres[0];
    if (genres.length > 1) ev.genres = genres.slice(0, 3);
  }

  return ev;
}

const HEADERS = {
  'User-Agent': UA,
  // Without a browser-shaped Accept header Songkick answers 406 Not Acceptable.
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchPage(metro, page) {
  const url = `https://www.songkick.com/metro-areas/${metro}${page > 1 ? `?page=${page}` : ''}`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return res.text();
      lastErr = new Error(`HTTP ${res.status}`);
      // 406/429/5xx are throttling — back off and try again rather than giving up.
      if (![406, 429, 500, 502, 503].includes(res.status)) break;
    } catch (e) { lastErr = e; }
    const wait = 4000 * attempt;
    console.log(`  page ${page} attempt ${attempt} failed (${lastErr.message}); retrying in ${wait / 1000}s`);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw lastErr || new Error('unknown fetch failure');
}

async function collect(cityId) {
  const city = CITIES[cityId];
  const seen = new Map();
  let partial = false;
  let emptyStreak = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    let html;
    try { html = await fetchPage(city.metro, page); }
    catch (e) {
      console.error(`page ${page}: ${e.message} — giving up on further pages`);
      partial = true;
      break;
    }

    const events = extractLdJson(html).map(toEvent).filter(Boolean).filter((e) => !isComedy(e));
    let added = 0;
    for (const ev of events) {
      const key = `${ev.date}|${slug(ev.artist)}|${slug(ev.venue)}`;
      if (!seen.has(key)) { seen.set(key, ev); added++; }
    }
    console.log(`page ${page}: ${events.length} in window, ${added} new (total ${seen.size})`);

    // Listings run chronologically; once a page adds nothing new twice over,
    // we're past the window.
    emptyStreak = added === 0 ? emptyStreak + 1 : 0;
    if (emptyStreak >= 2) break;
    await new Promise((r) => setTimeout(r, 2500)); // be a polite client
  }

  const events = [...seen.values()].sort((a, b) =>
    a.date.localeCompare(b.date) || a.artist.localeCompare(b.artist));

  // Stable, unique ids.
  const used = new Set();
  for (const ev of events) {
    const base = `${cityId}-${ev.date.slice(5, 7)}${ev.date.slice(8, 10)}-${slug(ev.artist)}`;
    let id = base, n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    ev.id = id;
  }
  return { city, events, partial };
}

const cityId = process.argv[2] || 'la';
const { city, events, partial } = await collect(cityId);

const outPath = `data/concerts-${cityId}.json`;
let previous = null;
try { previous = JSON.parse(await readFile(outPath, 'utf8')); } catch {}

if (events.length < 20) {
  console.error(`Only ${events.length} events found — refusing to overwrite with a likely-broken scrape.`);
  process.exit(1);
}

// A throttled crawl once cut 258 events down to 89 and happily saved it.
// Never let a partial result replace a healthy file.
const prevCount = previous?.events?.length || 0;
if (prevCount && events.length < prevCount * 0.6) {
  console.error(
    `Found only ${events.length} events but the existing file has ${prevCount}` +
    `${partial ? ' (the crawl was cut short by the source)' : ''}. ` +
    `Refusing to overwrite — re-run later.`);
  process.exit(1);
}
if (partial) console.warn('Note: the crawl ended early, so later dates may be thin.');

console.log('Enriching artists (Wikipedia + MusicBrainz, cached)…');
await enrich(events);

const payload = {
  city: city.name,
  cityId,
  generatedAt: new Date().toISOString(),
  windowDays: WINDOW_DAYS,
  sources: ['songkick.com (schema.org JSON-LD)'],
  note: 'Compiled automatically from public listings. Always confirm on the venue page before buying.',
  events,
};

// Ignore the timestamp when deciding whether anything actually changed, but do
// compare the full event objects so newly-added genres/links count as a change.
const sig = (o) => JSON.stringify(o?.events || []);
if (previous && sig(previous) === sig(payload)) {
  console.log('No listing changes — leaving the file alone.');
  process.exit(0);
}

await writeFile(outPath, JSON.stringify(payload, null, 2) + '\n');
console.log(`Wrote ${outPath}: ${events.length} events, ${new Set(events.map((e) => e.venue)).size} venues.`);
