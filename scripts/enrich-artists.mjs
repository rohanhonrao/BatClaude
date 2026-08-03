// enrich-artists.mjs — attach a genre, a Wikipedia link and a short factual
// blurb to each artist, cached in data/artists.json so repeat runs are cheap.
//
// Sources, both free and keyless:
//   • Wikipedia REST summary  -> canonical link + one-sentence extract
//   • MusicBrainz             -> fallback descriptor ("American rock band") + tags
//
// Nothing here is generated or guessed: if neither source knows an artist we
// leave the fields off rather than inventing a bio.
import { readFile, writeFile } from 'node:fs/promises';

const UA = 'SanctumConcerts/1.0 (personal music listings app)';
const CACHE_PATH = 'data/artists.json';
const RECHECK_DAYS = 45;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Guards against grabbing the wrong Wikipedia page (e.g. "Muse" the magazine).
const MUSICY = /\b(band|singer|musician|rapper|duo|trio|group|dj|composer|songwriter|producer|orchestra|ensemble|guitarist|drummer|pianist|vocalist|record|music|hip hop|rock|pop|jazz|metal|punk|folk|electronic)\b/i;

const key = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

async function wikiSummary(title) {
  const data = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
  if (!data || data.type === 'disambiguation' || !data.extract) return null;
  const blob = `${data.description || ''} ${data.extract}`;
  if (!MUSICY.test(blob)) return null;               // probably a different subject
  return {
    wiki: data.content_urls?.desktop?.page || null,
    blurb: String(data.extract).split(/(?<=\.)\s/)[0].slice(0, 240),
    descriptor: data.description || null,
  };
}

async function wikiSearch(artist) {
  const q = encodeURIComponent(`${artist} musician OR band`);
  const data = await getJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&srlimit=3&format=json&origin=*`);
  for (const hit of data?.query?.search || []) {
    const got = await wikiSummary(hit.title);
    if (got) return got;
    await sleep(150);
  }
  return null;
}

async function musicbrainz(artist) {
  const q = encodeURIComponent(`artist:"${artist}"`);
  const data = await getJson(`https://musicbrainz.org/ws/2/artist?query=${q}&limit=1&fmt=json`);
  const a = data?.artists?.[0];
  if (!a || (a.score ?? 0) < 90) return null;
  const tags = (a.tags || []).sort((x, y) => (y.count || 0) - (x.count || 0)).map((t) => t.name);
  // Build a descriptor only from fields MusicBrainz actually returned.
  const bits = [a.country, a.type === 'Group' ? 'group' : a.type === 'Person' ? 'artist' : null].filter(Boolean);
  const descriptor = a.disambiguation || (bits.length ? bits.join(' ') : null);
  return { genres: tags.slice(0, 2), descriptor };
}

async function lookup(artist) {
  let out = { checkedAt: new Date().toISOString() };
  try {
    const w = (await wikiSummary(artist)) || (await wikiSearch(artist));
    if (w) { out.wiki = w.wiki; out.blurb = w.blurb; if (w.descriptor) out.descriptor = w.descriptor; }
  } catch { /* network hiccup — try MusicBrainz */ }
  await sleep(200);
  if (!out.blurb || !out.descriptor) {
    try {
      const mb = await musicbrainz(artist);
      if (mb) {
        if (mb.genres?.length) out.genres = mb.genres;
        if (!out.descriptor && mb.descriptor) out.descriptor = mb.descriptor;
      }
    } catch { /* leave the fields off */ }
    await sleep(1100); // MusicBrainz asks for <= 1 request/second
  }
  return out;
}

export async function enrich(events) {
  let cache = {};
  try { cache = JSON.parse(await readFile(CACHE_PATH, 'utf8')); } catch {}

  const artists = [...new Set(events.map((e) => e.artist))];
  const cutoff = Date.now() - RECHECK_DAYS * 86400000;
  let fetched = 0;

  for (const artist of artists) {
    const k = key(artist);
    const hit = cache[k];
    if (hit && Date.parse(hit.checkedAt || 0) > cutoff) continue;
    cache[k] = await lookup(artist);
    fetched++;
    if (fetched % 25 === 0) console.log(`  enriched ${fetched} new artists…`);
  }

  for (const ev of events) {
    const info = cache[key(ev.artist)];
    if (!info) continue;
    if (info.wiki) ev.wiki = info.wiki;
    if (info.blurb) ev.blurb = info.blurb;
    else if (info.descriptor) ev.blurb = info.descriptor[0].toUpperCase() + info.descriptor.slice(1);
    if (!ev.genre && info.genres?.length) ev.genre = info.genres[0];
  }

  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
  console.log(`Artist cache: ${Object.keys(cache).length} entries (${fetched} looked up this run).`);
  return events;
}
