// concerts.js — gigs near you.
//
// Data comes from `data/concerts-<city>.json`, compiled by a scheduled agent
// that sweeps Ticketmaster, DICE, Eventbrite, Songkick and venue calendars.
// Because the file is served from our own origin there's no CORS problem, no
// API key, and the last fetch is cached so the list still works offline.
import { db } from './db.js';
import { getSetting, setSetting, escapeHtml, todayISO, fmtDateShort, relativeDay } from './util.js';
import { toast, openSheet, closeSheet, pushNav } from './ui.js';

const CITIES = [
  { id: 'la', name: 'Los Angeles' },
  { id: 'nyc', name: 'New York' },
  { id: 'sf', name: 'San Francisco' },
];

let data = null;        // { city, generatedAt, events: [...] }
let artists = [];       // tracked artist names
let view = 'all';       // 'all' | 'forYou'
let search = '';
let loading = false;
let hubHandler = null;
export function setConcertsHubHandler(fn) { hubHandler = fn; }

const $app = () => document.getElementById('app');
const cityId = () => getSetting('concertCity') || 'la';
const cityName = () => (CITIES.find((c) => c.id === cityId()) || CITIES[0]).name;

export async function mountConcerts() {
  artists = getSetting('concertArtists') || [];
  view = 'all'; search = '';
  data = (await db.get('settings', 'concertsCache'))?.value?.[cityId()] || null;
  render();
  loadData();          // refresh in the background
}

async function loadData({ manual = false } = {}) {
  loading = true; render();
  try {
    const res = await fetch(`./data/concerts-${cityId()}.json?ts=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('no data file');
    const json = await res.json();
    data = json;
    const row = (await db.get('settings', 'concertsCache'))?.value || {};
    row[cityId()] = json;
    await db.put('settings', { key: 'concertsCache', value: row });
    if (manual) toast('Listings updated');
  } catch {
    if (manual) toast(data ? 'Offline — showing saved listings' : 'No listings yet for this city', true);
  } finally {
    loading = false; render();
  }
}

// --- matching ----------------------------------------------------------------
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function matchesTracked(ev) {
  if (!artists.length) return false;
  const hay = norm([ev.artist, ...(ev.support || [])].join(' '));
  return artists.some((a) => hay.includes(norm(a)));
}

function upcoming() {
  const today = todayISO();
  let list = (data?.events || []).filter((e) => e.date >= today);
  if (view === 'forYou') list = list.filter(matchesTracked);
  if (search) {
    const q = norm(search);
    list = list.filter((e) => norm([e.artist, e.venue, (e.support || []).join(' '), e.genre].join(' ')).includes(q));
  }
  return list.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
}

// --- render ------------------------------------------------------------------
function render() {
  const list = upcoming();
  const trackedCount = (data?.events || []).filter((e) => e.date >= todayISO() && matchesTracked(e)).length;
  const groups = {};
  for (const e of list) (groups[e.date] ||= []).push(e);
  const dates = Object.keys(groups).sort();

  $app().innerHTML = `<div class="view">
    <div class="app-header">
      <div class="title">
        <button class="header-btn" data-hub aria-label="All apps"><i class="ti ti-apps"></i></button>
        <h1 class="mod-title">Concerts</h1>
      </div>
      <button class="header-btn" id="c-artists" aria-label="My artists"><i class="ti ti-heart"></i></button>
    </div>

    <div class="spread" style="margin:0 2px 10px">
      <button class="chip active" id="c-city"><i class="ti ti-map-pin"></i> ${escapeHtml(cityName())}</button>
      <button class="chip" id="c-refresh">${loading ? '<i class="ti ti-loader"></i> Updating…' : '<i class="ti ti-refresh"></i> Refresh'}</button>
    </div>

    <div class="seg" id="c-view">
      <button data-v="all" class="${view === 'all' ? 'active' : ''}">All shows</button>
      <button data-v="forYou" class="${view === 'forYou' ? 'active' : ''}">For you${trackedCount ? ` · ${trackedCount}` : ''}</button>
    </div>

    <div class="field mt"><input class="input" id="c-search" placeholder="Search artist or venue…" value="${escapeHtml(search)}"></div>

    ${data ? `<div class="tiny muted spread" style="margin:-4px 4px 8px">
      <span>${list.length} show${list.length === 1 ? '' : 's'} · compiled ${freshness(data.generatedAt)}</span>
      <a href="https://github.com/rohanhonrao/BatClaude/actions/workflows/refresh-concerts.yml"
         target="_blank" rel="noopener">Rebuild ›</a></div>` : ''}

    ${dates.length ? dates.map((d) => `
      <div class="section-title">${escapeHtml(dayHeading(d))}</div>
      <div class="card">${groups[d].map(eventRow).join('')}</div>
    `).join('') : emptyBlock()}
  </div>`;

  bind();
}

function emptyBlock() {
  if (loading) return `<div class="empty"><span class="em"><i class="ti ti-loader"></i></span><div>Loading listings…</div></div>`;
  if (!data) return `<div class="empty"><span class="em"><i class="ti ti-music"></i></span>
    <div>No listings yet</div><div class="tiny mt">The scheduled agent hasn’t published ${escapeHtml(cityName())} yet. Pull Refresh to try again.</div></div>`;
  if (view === 'forYou') return `<div class="empty"><span class="em"><i class="ti ti-heart"></i></span>
    <div>None of your artists are playing</div><div class="tiny mt">Add more artists and we’ll flag them when they come to town.</div></div>`;
  return `<div class="empty"><span class="em"><i class="ti ti-search"></i></span><div>Nothing matches</div></div>`;
}

function eventRow(e) {
  const tracked = matchesTracked(e);
  return `<div class="row tappable" data-ev="${escapeHtml(e.id)}">
    <div class="ic"><i class="ti ti-${tracked ? 'heart-filled' : 'music'}"></i></div>
    <div class="main">
      <div class="t">${escapeHtml(e.artist)}${tracked ? ' <span class="pill up">Yours</span>' : ''}</div>
      <div class="s">${escapeHtml(e.venue)}${e.time ? ' · ' + escapeHtml(fmtTime(e.time)) : ''}${
        e.genre ? ' · ' + escapeHtml(e.genre) : ''}</div>
    </div>
    <div class="cf-run">${escapeHtml(e.price || '')}</div>
  </div>`;
}

function dayHeading(d) {
  const rel = relativeDay(d);
  return /Today|Tomorrow|In \d/.test(rel) ? `${rel} · ${fmtDateShort(d)}` : fmtDateShort(d);
}
function fmtTime(t) {
  const [h, m] = String(t).split(':').map(Number);
  if (isNaN(h)) return t;
  const ampm = h >= 12 ? 'pm' : 'am';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hh}:${String(m).padStart(2, '0')}${ampm}` : `${hh}${ampm}`;
}
function freshness(iso) {
  if (!iso) return 'unknown';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

// --- interactions ------------------------------------------------------------
function bind() {
  const root = $app();
  root.querySelector('[data-hub]').addEventListener('click', () => hubHandler && hubHandler());
  root.querySelector('#c-artists').addEventListener('click', artistsSheet);
  root.querySelector('#c-refresh').addEventListener('click', () => loadData({ manual: true }));
  root.querySelector('#c-city').addEventListener('click', citySheet);
  root.querySelectorAll('#c-view button').forEach((b) => b.addEventListener('click', () => { view = b.dataset.v; render(); }));
  const s = root.querySelector('#c-search');
  s.addEventListener('input', (e) => {
    search = e.target.value;
    const y = window.scrollY; render(); window.scrollTo(0, y);
    const n = document.getElementById('c-search');
    if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
  });
  root.querySelectorAll('[data-ev]').forEach((el) => el.addEventListener('click', () => {
    const ev = (data?.events || []).find((x) => String(x.id) === el.dataset.ev);
    if (ev) eventSheet(ev);
  }));
}

function eventSheet(e) {
  const tracked = matchesTracked(e);
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>${escapeHtml(e.artist)}</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    ${e.support?.length ? `<div class="tiny muted" style="margin:-8px 0 10px">with ${escapeHtml(e.support.join(', '))}</div>` : ''}
    ${(e.genres || (e.genre ? [e.genre] : [])).length ? `<div class="chips" style="margin-bottom:12px">
      ${(e.genres || [e.genre]).map((g) => `<span class="chip">${escapeHtml(g)}</span>`).join('')}</div>` : ''}
    ${e.blurb ? `<p class="blurb">${escapeHtml(e.blurb)}</p>` : ''}
    <div class="card">
      <div class="row" style="border:none"><div class="ic"><i class="ti ti-calendar"></i></div>
        <div class="main"><div class="t">${escapeHtml(fmtDateShort(e.date))}${e.time ? ' · ' + escapeHtml(fmtTime(e.time)) : ''}</div>
        <div class="s">${escapeHtml(relativeDay(e.date))}</div></div></div>
      <div class="row" style="border:none"><div class="ic"><i class="ti ti-building-arch"></i></div>
        <div class="main"><div class="t">${escapeHtml(e.venue)}</div>
        <div class="s">${escapeHtml(e.neighborhood || cityName())}</div></div></div>
      ${e.price ? `<div class="row" style="border:none"><div class="ic"><i class="ti ti-ticket"></i></div>
        <div class="main"><div class="t">${escapeHtml(e.price)}</div><div class="s">${escapeHtml(e.source || '')}</div></div></div>` : ''}
    </div>
    ${e.url ? `<a class="btn primary mt" href="${escapeHtml(e.url)}" target="_blank" rel="noopener"><i class="ti ti-external-link"></i> Tickets &amp; details</a>` : ''}
    ${e.wiki ? `<a class="btn mt" href="${escapeHtml(e.wiki)}" target="_blank" rel="noopener"><i class="ti ti-book"></i> Read about ${escapeHtml(e.artist)}</a>` : ''}
    <button class="btn mt" id="ev-track">
      <i class="ti ti-heart"></i> ${tracked ? 'Following this artist' : 'Follow ' + escapeHtml(e.artist)}</button>
    <div class="hint center mt2">Listings are compiled automatically — always confirm on the venue’s page.</div>
  `);
  sheet.querySelector('#ev-track').addEventListener('click', async () => {
    if (tracked) { closeSheet(); return toast('Already following'); }
    artists = [...artists, e.artist];
    await setSetting('concertArtists', artists);
    closeSheet(); render(); toast(`Following ${e.artist}`);
  });
}

function citySheet() {
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>City</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="card">${CITIES.map((c) => `<div class="row tappable" data-city="${c.id}">
      <div class="ic"><i class="ti ti-map-pin"></i></div>
      <div class="main"><div class="t">${escapeHtml(c.name)}</div></div>
      ${c.id === cityId() ? '<i class="ti ti-check" style="color:var(--accent)"></i>' : ''}
    </div>`).join('')}</div>
    <div class="hint center mt2">Listings are published per city by the scheduled agent.</div>
  `);
  sheet.querySelectorAll('[data-city]').forEach((el) => el.addEventListener('click', async () => {
    await setSetting('concertCity', el.dataset.city);
    closeSheet();
    data = (await db.get('settings', 'concertsCache'))?.value?.[cityId()] || null;
    render(); loadData();
  }));
}

function artistsSheet() {
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>My artists</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="field"><label>Add an artist</label>
      <div class="input-row"><input class="input" id="ar-name" placeholder="e.g. Fontaines D.C.">
      <button class="mini-btn" id="ar-add" aria-label="Add"><i class="ti ti-plus"></i></button></div></div>
    <div class="card" id="ar-list"></div>
    <div class="hint center mt2">We’ll flag their shows in “For you” whenever they play ${escapeHtml(cityName())}.</div>
  `);
  const paint = () => {
    const el = sheet.querySelector('#ar-list');
    el.innerHTML = artists.length ? artists.map((a, i) => `<div class="row">
      <div class="ic"><i class="ti ti-microphone-2"></i></div>
      <div class="main"><div class="t">${escapeHtml(a)}</div></div>
      <button class="mini-btn" data-rm="${i}" aria-label="Remove"><i class="ti ti-x"></i></button>
    </div>`).join('') : '<div class="tiny muted center" style="padding:14px">No artists yet.</div>';
    el.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async () => {
      artists = artists.filter((_, i) => i !== +b.dataset.rm);
      await setSetting('concertArtists', artists);
      paint(); render();
    }));
  };
  const add = async () => {
    const input = sheet.querySelector('#ar-name');
    const name = input.value.trim();
    if (!name) return;
    if (artists.some((a) => norm(a) === norm(name))) { input.value = ''; return toast('Already following'); }
    artists = [...artists, name];
    await setSetting('concertArtists', artists);
    input.value = ''; paint(); render();
  };
  sheet.querySelector('#ar-add').addEventListener('click', add);
  sheet.querySelector('#ar-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  paint();
}
