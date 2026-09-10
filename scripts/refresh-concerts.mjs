// refresh-concerts.mjs — rebuild data/concerts-<city>.json from public listings.
//
// Runs on GitHub Actions (Node 20+, no dependencies). Server-side, so there is
// no CORS problem and no API key. We read schema.org JSON-LD that the listing
// pages already publish rather than scraping markup, which is far less brittle.
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { enrich } from './enrich-artists.mjs';

// A region can span several Songkick metro areas. New Jersey is not one metro:
// the New York metro covers NYC plus the Jersey Shore, while North Jersey
// (Jersey City, Hoboken, East Rutherford/MetLife, Holmdel/PNC) sits under the
// Jersey City metro. Verified by fetching both and reading the localities.
// Songkick also lists '34687-us-new-jersey', but it returns zero events —
// do not use it.
// Canonical slugs: '7644-us-new-york' 301-redirects to '…-nyc', and paying a
// redirect on every request is a wasted round trip against a host that is
// already counting them.
const REGIONS = {
  nynj: {
    name: 'New York & New Jersey',
    tz: 'America/New_York',
    metros: ['7644-us-new-york-nyc', '4690-us-jersey-city'],
  },
  la: { name: 'Los Angeles', tz: 'America/Los_Angeles', metros: ['17835-us-los-angeles-la'] },
  sf: { name: 'San Francisco', tz: 'America/Los_Angeles', metros: ['26330-us-san-francisco'] },
};

// Coverage runs to the end of the third month ahead: in September you get
// September plus October, November and December.
const MONTHS_AHEAD = 3;

// Songkick blocks the runner's datacentre IP after roughly five page requests
// and does not release it within several minutes — verified: retries at
// 21s/47s/90s/151s all returned 406, and the block carried into the next metro.
// The same pages fetched from a home connection return 200 all the way to page
// 15, so this is IP reputation, not depth, pacing or cookies.
//
// So one run cannot crawl four months of New York (~28 pages). Instead each run
// takes a slice and MERGES into what is already on disk, resuming from where
// the last run was cut off. Coverage builds over a few runs and then just stays
// fresh. This is why the file is never simply replaced.
const MAX_PAGES_PER_RUN = 12;
const UA = 'Mozilla/5.0 (compatible; SanctumConcerts/1.0; personal use)';

const regionId = process.argv[2] || 'nynj';
const region = REGIONS[regionId];
if (!region) {
  console.error(`Unknown region "${regionId}". Known: ${Object.keys(REGIONS).join(', ')}`);
  process.exit(1);
}

// The window is computed in the REGION's timezone, not the runner's UTC clock —
// otherwise a late run drops tonight's shows as "yesterday".
const localISO = (d) => d.toLocaleDateString('en-CA', { timeZone: region.tz });
const today = new Date();
const startISO = localISO(today);
// Last day of the month MONTHS_AHEAD out: day 0 of the following month.
const [ty, tm] = startISO.split('-').map(Number);
const endDate = new Date(Date.UTC(ty, tm - 1 + MONTHS_AHEAD + 1, 0));
const endISO = endDate.toISOString().slice(0, 10);

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

// Songkick throttles hard from a datacentre IP. Observed on GitHub Actions:
// four pages fetched 2.5s apart, then HTTP 406 on every attempt including
// retries at 4s/8s/12s, and the block persisted into the *next* metro. It is a
// cooldown, not a transient blip, so the backoff has to be on that scale.
const RETRY_WAITS = [20000, 45000, 90000, 150000];
const PAGE_DELAY = 7000;
const jitter = (ms) => ms + Math.floor(Math.random() * 2000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(metro, page) {
  const url = `https://www.songkick.com/metro-areas/${metro}${page > 1 ? `?page=${page}` : ''}`;
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_WAITS.length; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return res.text();
      lastErr = new Error(`HTTP ${res.status}`);
      // 406/429/5xx are throttling — wait it out rather than giving up.
      if (![406, 429, 500, 502, 503].includes(res.status)) break;
    } catch (e) { lastErr = e; }
    if (attempt === RETRY_WAITS.length) break;
    const wait = jitter(RETRY_WAITS[attempt]);
    console.log(`  page ${page} attempt ${attempt + 1} failed (${lastErr.message}); waiting ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
  throw lastErr || new Error('unknown fetch failure');
}

const evKey = (ev) => `${ev.date}|${slug(ev.artist)}|${slug(ev.venue)}`;

async function collect(regionId, previous) {
  const seen = new Map();
  let partial = false;

  // Start from everything already known that is still in the window. Past dates
  // fall away on their own; nothing else is discarded, because a run that gets
  // blocked at page 3 must not wipe out coverage earlier runs paid for.
  for (const ev of previous?.events || []) {
    if (ev.date >= startISO && ev.date <= endISO) seen.set(evKey(ev), ev);
  }
  const carried = seen.size;
  console.log(`Carried forward ${carried} events still in the window.`);

  const cursors = { ...(previous?.cursors || {}) };

  for (const metro of region.metros) {
    const before = seen.size;
    let emptyStreak = 0;
    let blockedAt = null;

    // Page 1 always, for freshness (new announcements land at the front), then
    // continue from wherever the previous run was cut off.
    const resumeAt = Math.max(2, cursors[metro] || 2);
    const plan = [1, ...Array.from({ length: MAX_PAGES_PER_RUN - 1 }, (_, i) => resumeAt + i)];
    console.log(`\n— metro ${metro} — pages ${plan[0]}, then ${plan[1]}…${plan[plan.length - 1]}`);

    for (const page of plan) {
      let html;
      try { html = await fetchPage(metro, page); }
      catch (e) {
        console.error(`page ${page}: ${e.message} — blocked; will resume here next run`);
        blockedAt = page;
        partial = true;
        break;
      }

      const inWindow = extractLdJson(html).map(toEvent).filter(Boolean).filter((e) => !isComedy(e));
      const total = extractLdJson(html).filter((n) => n['@type'] === 'MusicEvent').length;
      let added = 0;
      for (const ev of inWindow) {
        const key = evKey(ev);
        if (!seen.has(key)) { seen.set(key, ev); added++; }
      }
      console.log(`page ${page}: ${total} listed, ${inWindow.length} in window, ${added} new (region total ${seen.size})`);

      // `total === 0` means the metro has no more listings at all — that is the
      // end of this metro, not a throttle. Two in a row and we are done, so the
      // cursor resets and the next run starts over from the front for freshness.
      emptyStreak = total === 0 ? emptyStreak + 1 : 0;
      if (emptyStreak >= 2) { blockedAt = null; break; }
      await sleep(jitter(PAGE_DELAY));
    }

    // Resume next run where we stopped; reset to the front once exhausted.
    cursors[metro] = blockedAt || (emptyStreak >= 2 ? 1 : plan[plan.length - 1] + 1);
    console.log(`  metro ${metro}: +${seen.size - before} new, next run resumes at page ${cursors[metro]}`);
  }

  const events = [...seen.values()].sort((a, b) =>
    a.date.localeCompare(b.date) || a.artist.localeCompare(b.artist));

  // Stable, unique ids.
  const used = new Set();
  for (const ev of events) {
    const base = `${regionId}-${ev.date.slice(5, 7)}${ev.date.slice(8, 10)}-${slug(ev.artist)}`;
    let id = base, n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    ev.id = id;
  }
  return { events, partial, cursors };
}

const outPath = `data/concerts-${regionId}.json`;
let previous = null;
try { previous = JSON.parse(await readFile(outPath, 'utf8')); } catch {}

console.log(`Region ${regionId} (${region.name}); window ${startISO} → ${endISO}`);
const { events, partial, cursors } = await collect(regionId, previous);

if (events.length < 20) {
  console.error(`Only ${events.length} events found — refusing to write a likely-broken file.`);
  process.exit(1);
}

// Because runs merge rather than replace, the count can only fall when dates
// age out of the window — never because a crawl was throttled. Compare against
// the previous file's *in-window* count so the guard still means something.
const prevInWindow = (previous?.events || []).filter((e) => e.date >= startISO && e.date <= endISO).length;
if (prevInWindow && events.length < prevInWindow) {
  console.error(`Merged result (${events.length}) is smaller than the previous in-window count (${prevInWindow}). Refusing to write.`);
  process.exit(1);
}
if (partial) console.warn('Note: a metro was cut short by the source; the next run resumes from there.');

// Enrichment is a nice-to-have: blurbs and Wikipedia links. It must never be
// able to lose a good crawl — an ENOENT writing the cache once threw away a
// completed two-metro crawl and failed the whole run.
console.log('Enriching artists (Wikipedia + MusicBrainz, cached)…');
try {
  await enrich(events);
} catch (e) {
  console.warn(`Enrichment failed (${e.message}) — publishing listings without blurbs.`);
}

const payload = {
  city: region.name,
  cityId: regionId,
  coversFrom: startISO,
  coversTo: endISO,
  metros: region.metros,
  // Where the next run picks up per metro. Coverage is built across runs
  // because the source blocks the runner's IP after a handful of pages.
  cursors,
  reachesTo: events.length ? events[events.length - 1].date : startISO,
  generatedAt: new Date().toISOString(),
  sources: ['songkick.com (schema.org JSON-LD)'],
  note: 'Compiled automatically from public listings. Always confirm on the venue page before buying.',
  events,
};

// Ignore the timestamp when deciding whether anything actually changed, but do
// compare the full event objects so newly-added genres/links count as a change.
// The cursors MUST be part of this signature. Without them a run that found no
// new events would exit before writing, the cursor would never advance, and
// coverage would be stuck at page 5 forever.
const sig = (o) => JSON.stringify([o?.events || [], o?.cursors || {}]);
if (previous && sig(previous) === sig(payload)) {
  console.log('No listing changes and no cursor movement — leaving the file alone.');
  process.exit(0);
}

// Written compact, not pretty-printed. A four-month two-metro window is an
// order of magnitude more events than the old 28-day single-metro file, and
// indentation was roughly a third of the bytes — which the phone downloads.
// Nothing hand-edits this file, so the lost readability costs nothing.
await mkdir('data', { recursive: true });
await writeFile(outPath, JSON.stringify(payload) + '\n');
console.log(`Wrote ${outPath}: ${events.length} events, ${new Set(events.map((e) => e.venue)).size} venues.`);
