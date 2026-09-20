// alcove.js — ALCOVE: the perfume collection.
//
// An alcove is the recess a collection sits in, which is what this is:
// what you own, what you're after, and where a bottle can actually be bought
// without being a knockoff.
//
// Deliberately NOT synced — this is a personal collection, like Slate.
//
// Two honesty rules run through this module, both from CLAUDE.md rule 3:
//
//   1. A dupe claim is what YOU heard until something confirms it. It is stored
//      and shown as "believed", never as fact, because the app has no dupe
//      database to check it against (see ARCHITECTURE §8f).
//   2. Authenticity is never asserted by the app. It records the judgement you
//      made about a seller. Nothing here decides a seller is genuine on your
//      behalf — getting that wrong costs real money on a fake bottle.
//
// "Best price" is therefore computed only from prices you entered, and prefers
// sellers you marked verified: a cheaper price from a seller you distrust is
// not a better price.
import { db, uid } from './db.js';
import { escapeHtml, todayISO, fmtDateShort, fmtMoney, parseAmount } from './util.js';
import { toast, openSheet, closeSheet } from './ui.js';

const GENDERS = [
  { id: 'masculine', label: 'Masculine', icon: 'ti-gender-male' },
  { id: 'feminine',  label: 'Feminine',  icon: 'ti-gender-female' },
  { id: 'unisex',    label: 'Unisex',    icon: 'ti-gender-bigender' },
];
// The user asked for these to be titled classily; they are also unambiguous.
const STATUSES = [
  { id: 'collected', label: 'Collected', icon: 'ti-check' },
  { id: 'coveted',   label: 'Coveted',   icon: 'ti-heart' },
];
const CONCENTRATIONS = ['', 'Parfum', 'EDP', 'EDT', 'EDC', 'Extrait', 'Oil', 'Attar'];
const AUTHENTICITY = [
  { id: 'verified',   label: 'Verified',   cls: 'ok',   icon: 'ti-rosette-discount-check' },
  { id: 'unverified', label: 'Unchecked',  cls: 'mid',  icon: 'ti-help-circle' },
  { id: 'suspect',    label: 'Suspect',    cls: 'bad',  icon: 'ti-alert-triangle' },
];

let items = [];
let reference = null;      // data/perfumes.json as fetched — research, never the user's own record
let referenceLocal = null; // pasted research; kept apart so a refetch cannot erase it
let status = 'collected';  // 'collected' | 'coveted' — no combined view, by design
let gender = 'all';       // 'all' | masculine | feminine | unisex
let search = '';
let hubHandler = null;
export function setAlcoveHubHandler(fn) { hubHandler = fn; }

const $app = () => document.getElementById('app');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const genderOf = (g) => GENDERS.find((x) => x.id === g) || GENDERS[2];
const authOf = (a) => AUTHENTICITY.find((x) => x.id === a) || AUTHENTICITY[1];

async function load() {
  items = (await db.all('perfumes')).sort((a, b) =>
    String(a.house || '').localeCompare(String(b.house || '')) ||
    String(a.name || '').localeCompare(String(b.name || '')));
}
const save = async (p) => { p.updatedAt = Date.now(); await db.put('perfumes', p); await load(); };

// --- reference data -------------------------------------------------------------
// data/perfumes.json is filled on demand via the Research button (ARCHITECTURE §8f) and served
// same-origin, exactly like the concert listings. It is REFERENCE only: it never
// overwrites what the user recorded, and a dupe claim in it stays attributed to
// its source until the user chooses to accept it.
async function loadReference() {
  try {
    const res = await fetch('./data/perfumes.json?ts=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('no reference file');
    reference = await res.json();
    await db.put('settings', { key: 'alcoveReference', value: reference });
  } catch {
    reference = (await db.get('settings', 'alcoveReference'))?.value || null;   // offline
  }
}

/**
 * Match a bottle to the reference table by name, and by house when both have one.
 *
 * Locally imported entries win over the repo file. They have to be kept apart:
 * loadReference() overwrites the fetched copy every mount, so anything pasted in
 * would be silently lost if the two shared a slot.
 */
function referenceFor(p) {
  if (!p?.name) return null;
  const n = norm(p.name), h = norm(p.house);
  const hit = (list) => (list || []).find((r) =>
    norm(r.name) === n && (!h || !norm(r.house) || norm(r.house) === h));
  return hit(referenceLocal?.perfumes) || hit(reference?.perfumes) || null;
}

/**
 * The research request, written so it stands alone in a fresh session that has
 * none of this context. The rules are the module's rules — an invented field or
 * a guessed "authorised" costs real money on a counterfeit bottle.
 */
function researchPrompt(bottles) {
  const list = bottles.map((b) => `- ${b.name}${b.house ? ` (${b.house})` : ''}`).join('\n');
  return `Research ${bottles.length === 1 ? 'this perfume' : 'these perfumes'} for my collection app:

${list}

For each one, find:
- what it is commonly cited as a dupe of, if anything
- a 2-4 sentence summary of what reviewers say: how it smells, longevity and sillage, and the most common criticism
- a typical current price in USD (a low-high range is fine)
- retailers that sell it, and whether each is listed as an AUTHORISED retailer on the brand's own site

Rules that matter more than completeness:
1. Never invent a fact. If you cannot find something, leave the field out entirely. A missing field is correct; a guessed one is a bug.
2. A dupe claim is community consensus, not manufacturer fact. Include at least one source URL and set confidence to what the evidence supports: "commonly cited", "disputed", or "single source".
3. Set authorised to true ONLY if the brand's own website lists that retailer. Otherwise null. Never guess.
4. Summarise reviews in your own words; do not copy review text. Cite the sources.
5. Prices are a snapshot — set checkedAt to today.

Output as JSON in exactly this shape:
{"perfumes":[{"id":"","name":"","house":"","gender":"masculine|feminine|unisex","concentration":"","dupeOf":{"name":"","confidence":"","sources":[""]},"review":"","reviewSources":[""],"priceUSD":{"low":0,"high":0,"checkedAt":"YYYY-MM-DD"},"retailers":[{"name":"","url":"","authorised":true}],"checkedAt":"YYYY-MM-DD"}]}

Then do ONE of these:
- If you have access to the rohanhonrao/BatClaude repository, merge those entries into data/perfumes.json (match on name + house, replace existing entries, keep the other top-level fields, write compact JSON, validate it parses) and commit as "Alcove: refresh perfume reference".
- Otherwise just print the JSON in a single code block so I can paste it into the app.`;
}

export async function mountAlcove() {
  await load();
  reference = (await db.get('settings', 'alcoveReference'))?.value || null;
  referenceLocal = (await db.get('settings', 'alcoveReferenceLocal'))?.value || null;
  status = 'collected'; gender = 'all'; search = '';
  render();
  loadReference().then(render);         // refresh in the background
}

/** Merge pasted research into the local layer, replacing entries by name+house. */
async function importReference(json) {
  const incoming = (json?.perfumes || []).filter((r) => r && r.name);
  if (!incoming.length) throw new Error('no perfumes in that');
  const keep = (referenceLocal?.perfumes || []).filter((r) =>
    !incoming.some((i) => norm(i.name) === norm(r.name) && norm(i.house || '') === norm(r.house || '')));
  referenceLocal = { importedAt: new Date().toISOString(), perfumes: [...keep, ...incoming] };
  await db.put('settings', { key: 'alcoveReferenceLocal', value: referenceLocal });

  // Push the new findings into the bottles themselves, so the shelf shows wear
  // and dupe without the user ever typing them.
  for (const p of [...items]) {
    const r = referenceFor(p);
    if (r) await save(applyResearch(p, r));
  }
  return incoming.length;
}

// --- derived ------------------------------------------------------------------
/**
 * The cheapest price you recorded, preferring sellers you marked verified.
 * A cheaper price from a seller you distrust is not a better price, so suspect
 * sellers are never offered as the best and are excluded entirely.
 */
function bestPrice(p) {
  const priced = (p.sellers || []).filter((s) => Number(s.price) > 0 && s.authenticity !== 'suspect');
  if (!priced.length) return null;
  const verified = priced.filter((s) => s.authenticity === 'verified');
  const pool = verified.length ? verified : priced;
  return pool.reduce((best, s) => (Number(s.price) < Number(best.price) ? s : best));
}

function visible() {
  let list = items;
  list = list.filter((p) => (p.status || 'coveted') === status);
  if (gender !== 'all') list = list.filter((p) => (p.gender || 'unisex') === gender);
  if (search) {
    const q = norm(search);
    list = list.filter((p) => norm([p.name, p.house, p.dupeOf, p.notes].join(' ')).includes(q));
  }
  return list;
}

// --- render -------------------------------------------------------------------
function render() {
  const shown = visible();
  const collected = items.filter((p) => p.status === 'collected').length;
  const coveted = items.filter((p) => p.status === 'coveted').length;

  // Grouped by house — a collection reads by maison, not alphabetically overall.
  const houses = {};
  for (const p of shown) (houses[p.house || 'Unattributed'] ||= []).push(p);
  const houseNames = Object.keys(houses).sort((a, b) => a.localeCompare(b));

  // Shelves by maison: a collection reads by house, and a labelled shelf of
  // bottles looks like a collection in a way a list never does.
  const body = shown.length
    ? houseNames.map((h) => `
        <div class="al-group">
          <div class="al-house"><span>${escapeHtml(h)}</span><span class="al-n">${houses[h].length}</span></div>
          <div class="al-grid">${houses[h].map(tileHTML).join('')}</div>
        </div>`).join('')
    : `<div class="empty"><span class="em"><i class="ti ti-perfume"></i></span>
        <div>${items.length
          ? 'Nothing on this shelf'
          : status === 'collected' ? 'Nothing collected yet' : 'Nothing coveted yet'}</div>
        <div class="tiny mt">${items.length
          ? 'Try the other shelf, or clear the filter.'
          : 'Add a bottle above — name and house is all it needs.'}</div></div>`;

  $app().innerHTML = `<div class="view">
    <div class="app-header">
      <div class="title">
        <button class="header-btn" data-hub aria-label="All apps"><i class="ti ti-apps"></i></button>
        <h1 class="mod-title">Alcove</h1>
      </div>
      <div class="header-actions">
        <button class="header-btn primary-btn" data-al-add aria-label="Add a bottle"><i class="ti ti-plus"></i></button>
        <button class="header-btn" data-al-research aria-label="Research"><i class="ti ti-search"></i></button>
        <button class="header-btn" data-al-decants aria-label="Decant sources"><i class="ti ti-flask"></i></button>
      </div>
    </div>

    <div class="seg" id="al-status">
      ${STATUSES.map((s) =>
        `<button data-al-status="${s.id}" class="${status === s.id ? 'active' : ''}">
          <i class="ti ${s.icon}"></i> ${s.label}
          <span class="al-seg-n">${s.id === 'collected' ? collected : coveted}</span></button>`).join('')}
    </div>

    <div class="hh-chips al-genders mt">
      <button class="chip ${gender === 'all' ? 'active' : ''}" data-al-gender="all">Any wear</button>
      ${GENDERS.map((g) => `<button class="chip ${gender === g.id ? 'active' : ''}" data-al-gender="${g.id}">
        <i class="ti ${g.icon}"></i>${g.label}</button>`).join('')}
    </div>

    <div class="field mt"><input class="input" id="al-search" placeholder="Search name, house or dupe…"
      value="${escapeHtml(search)}"></div>

    ${body}
  </div>`;
  bind();
}

/**
 * A bottle's picture, in order of what is actually trustworthy:
 *   1. a photo the user added — theirs, on the device, works offline
 *   2. an image URL from research — remote, so it can 404 or be hotlink-blocked;
 *      it removes itself on error rather than leaving a broken frame
 *   3. a generated monogram — no network, never fails, looks deliberate
 */
function shotHTML(p) {
  const r = referenceFor(p);
  const mono = monogramHTML(p);
  if (p.photo) return `<div class="al-shot"><img src="${escapeHtml(p.photo)}" alt=""></div>`;
  if (r?.imageUrl) {
    return `<div class="al-shot">${mono}
      <img src="${escapeHtml(r.imageUrl)}" alt="" loading="lazy"
        onerror="this.remove()" style="position:absolute;inset:0"></div>`;
  }
  return `<div class="al-shot">${mono}</div>`;
}

// Stable per bottle: the same name always gives the same colour and initials,
// so a shelf of monograms looks composed rather than random.
function monogramHTML(p) {
  const text = `${p.name || ''} ${p.house || ''}`;
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const initials = (p.name || '?').split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join('');
  return `<div class="al-mono" style="background:linear-gradient(150deg,
    hsl(${hue} 18% 22%), hsl(${(hue + 40) % 360} 14% 12%))">${escapeHtml(initials)}</div>`;
}

function tileHTML(p) {
  const g = genderOf(p.gender);
  const best = bestPrice(p);
  const r = referenceFor(p);
  const dupeText = p.dupeConfirmed ? `dupe of ${p.dupeConfirmed.of}`
    : p.dupeOf ? `dupe of ${p.dupeOf}` : 'dupe';

  return `<button class="al-tile" data-al-edit="${p.id}">
    ${shotHTML(p)}
    ${p.photo ? '' : '<span class="al-tile-flag" aria-label="No photo yet"><i class="ti ti-camera"></i></span>'}
    <div class="al-tile-body">
      <div class="al-tile-name">${escapeHtml(p.name || 'Untitled')}</div>
      ${p.house ? `<div class="al-tile-house">${escapeHtml(p.house)}</div>` : ''}
      <div class="al-tile-badges">
        ${p.gender ? `<span class="al-badge">${escapeHtml(g.label)}</span>` : ''}
        ${p.kind === 'dupe'
          ? `<span class="al-badge dupe ${p.dupeConfirmed ? 'ok' : ''}">${escapeHtml(dupeText)}</span>` : ''}
        ${best ? `<span class="al-badge price">${fmtMoney(Number(best.price))}</span>`
          : r?.priceUSD?.low ? `<span class="al-badge price">${fmtMoney(Number(r.priceUSD.low))}</span>` : ''}
      </div>
    </div>
  </button>`;
}

// --- adding ---------------------------------------------------------------------
// Three fields, deliberately. Wear, dupe, notes and sellers are meant to arrive
// from research; asking the user to type them defeats the point.
//
// Nothing is defaulted here either — gender and kind stay undefined rather than
// guessing "unisex"/"original", so applyResearch() can tell "not known yet"
// apart from "the user chose this".
function addSheet() {
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Add a bottle</h2>
      <button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="field"><label>Name</label>
      <input class="input" id="a-name" placeholder="e.g. Khamrah" autocomplete="off"></div>
    <div class="field"><label>House</label>
      <input class="input" id="a-house" placeholder="e.g. Lattafa" autocomplete="off"></div>
    <div class="field"><label>Shelf</label><div class="seg" id="a-status">
      ${STATUSES.map((s) => `<button data-s="${s.id}" class="${s.id === status ? 'active' : ''}">
        <i class="ti ${s.icon}"></i> ${s.label}</button>`).join('')}</div></div>
    <div class="btn-row">
      <button class="btn" id="a-save">Add</button>
      <button class="btn primary" id="a-save-research"><i class="ti ti-search"></i> Add &amp; research</button>
    </div>
    <div class="hint mt">Wear, original-or-dupe, notes and where to buy all come from research.</div>
  `);

  let st = status;
  sheet.querySelectorAll('#a-status button').forEach((b) => b.addEventListener('click', () => {
    st = b.dataset.s;
    sheet.querySelectorAll('#a-status button').forEach((x) => x.classList.toggle('active', x === b));
  }));

  const commit = async () => {
    const name = sheet.querySelector('#a-name').value.trim();
    if (!name) { toast('Give the bottle a name', true); return null; }
    const house = sheet.querySelector('#a-house').value.trim();
    const rec = { id: uid('pf_'), name, house, status: st, sellers: [], createdAt: Date.now() };
    await save(applyResearch(rec, referenceFor(rec)));
    status = st;                       // land on the shelf it went to
    return rec;
  };
  sheet.querySelector('#a-save').addEventListener('click', async () => {
    if (!await commit()) return;
    closeSheet(); render(); toast('Added');
  });
  sheet.querySelector('#a-save-research').addEventListener('click', async () => {
    const rec = await commit();
    if (!rec) return;
    closeSheet(); render();
    handOff([{ name: rec.name, house: rec.house }]);
  });
  setTimeout(() => sheet.querySelector('#a-name').focus(), 100);
}

/**
 * Fill in the fields research is supposed to provide, remembering which ones it
 * set. A later refresh may update those; anything the user edited by hand is
 * left alone, which is why `fromResearch` exists rather than overwriting freely.
 */
function applyResearch(p, r) {
  if (!r) return p;
  const from = { ...(p.fromResearch || {}) };
  const take = (key, value) => {
    if (value === undefined || value === null || value === '') return;
    if (p[key] && !from[key]) return;          // user set it — leave it
    p[key] = value; from[key] = true;
  };
  take('gender', r.gender);
  take('concentration', r.concentration);
  if (r.dupeOf?.name && (!p.dupeOf || from.dupeOf)) {
    p.kind = 'dupe'; p.dupeOf = r.dupeOf.name;
    from.dupeOf = true; from.kind = true;
  }
  p.fromResearch = from;
  return p;
}

/**
 * Phone photos are several megabytes and the whole collection lives in
 * IndexedDB, so fifty of them would be a quarter of a gigabyte. Downscale to a
 * 640px long edge and re-encode as JPEG before storing.
 */
function readPhoto(file, maxEdge = 640) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('could not read that file'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("that doesn't look like an image"));
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.72));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

// --- the bottle ---------------------------------------------------------------
function perfumeSheet(existing) {
  const p = existing || {
    id: uid('pf_'), name: '', house: '', concentration: '', kind: 'original', dupeOf: '',
    dupeConfirmed: null, gender: 'unisex', status: 'coveted', notes: '', sellers: [],
    createdAt: Date.now(),
  };
  const best = bestPrice(p);

  const sheet = openSheet(`
    <div class="sheet-title-row">
      <h2>${existing ? escapeHtml(p.name || 'Perfume') : 'Add perfume'}</h2>
      <button class="close" data-close><i class="ti ti-x"></i></button></div>

    <div class="al-photo-row">
      <div class="al-photo-prev">${p.photo
        ? `<img src="${escapeHtml(p.photo)}" alt="">` : monogramHTML(p)}</div>
      <div class="al-photo-actions">
        <button class="btn" id="v-photo"><i class="ti ti-camera"></i> ${p.photo ? 'Replace' : 'Add photo'}</button>
        ${p.photo ? '<button class="chip" id="v-photo-x">Remove</button>' : ''}
      </div>
    </div>
    <input type="file" accept="image/*" id="v-photo-input" hidden>

    <div class="field"><label>Name</label><input class="input" id="v-name" value="${escapeHtml(p.name)}"
      placeholder="e.g. Khamrah"></div>
    <div class="grid2">
      <div class="field"><label>House</label><input class="input" id="v-house" value="${escapeHtml(p.house)}"
        placeholder="e.g. Lattafa"></div>
      <div class="field"><label>Concentration</label><select class="input" id="v-conc">
        ${CONCENTRATIONS.map((c) => `<option value="${c}" ${c === (p.concentration || '') ? 'selected' : ''}>${c || '—'}</option>`).join('')}
      </select></div>
    </div>

    <div class="field"><label>In the collection</label><div class="seg" id="v-status">
      ${STATUSES.map((s) => `<button data-s="${s.id}" class="${(p.status || 'coveted') === s.id ? 'active' : ''}">
        <i class="ti ${s.icon}"></i> ${s.label}</button>`).join('')}</div></div>

    <div class="field"><label>Wear</label><div class="seg" id="v-gender">
      ${GENDERS.map((g) => `<button data-g="${g.id}" class="${(p.gender || 'unisex') === g.id ? 'active' : ''}">${g.label}</button>`).join('')}</div></div>

    <div class="field"><label>Original or dupe</label><div class="seg" id="v-kind">
      <button data-k="original" class="${p.kind !== 'dupe' ? 'active' : ''}">Original</button>
      <button data-k="dupe" class="${p.kind === 'dupe' ? 'active' : ''}">Dupe</button></div></div>

    <div id="v-dupe-wrap" style="${p.kind === 'dupe' ? '' : 'display:none'}">
      <div class="field"><label>Believed to be a dupe of</label>
        <input class="input" id="v-dupeof" value="${escapeHtml(p.dupeOf || '')}" placeholder="e.g. Kilian Angels' Share"></div>
      ${p.dupeConfirmed
        ? `<div class="alert ok"><i class="ti ti-rosette-discount-check"></i>
            <span>Confirmed as a dupe of <b>${escapeHtml(p.dupeConfirmed.of)}</b>${
              p.dupeConfirmed.confidence ? ` — ${escapeHtml(p.dupeConfirmed.confidence)}` : ''}${
              p.dupeConfirmed.source
                ? ` · <a href="${escapeHtml(p.dupeConfirmed.source)}" target="_blank" rel="noopener">source</a>`
                : ''}</span></div>`
        : `<div class="hint">Stored as <b>believed</b> — your claim, not the app's. If the reference below agrees, you can accept it and the source is recorded with it.</div>`}
    </div>

    ${referenceCardHTML(p)}

    <div class="field mt"><label>Notes</label><textarea class="input" id="v-notes" rows="2"
      placeholder="Optional — how it wears, longevity, where you tried it">${escapeHtml(p.notes || '')}</textarea></div>

    <div class="section-title spread"><span>Where to buy</span>
      <button class="mini-btn" data-v-addseller aria-label="Add seller"><i class="ti ti-plus"></i></button></div>
    ${best ? `<div class="al-best"><i class="ti ti-tag"></i> Best recorded:
      <b>${fmtMoney(Number(best.price))}</b> at ${escapeHtml(best.name)}
      <span class="al-auth ${authOf(best.authenticity).cls}">${authOf(best.authenticity).label}</span></div>` : ''}
    <div class="card">${(p.sellers || []).length
      ? p.sellers.map(sellerRowHTML).join('')
      : '<div class="tiny muted center" style="padding:14px">No sellers recorded yet.</div>'}</div>

    <button class="btn primary mt2" id="v-save">${existing ? 'Save' : 'Add to the alcove'}</button>
    ${existing ? '<button class="btn danger mt" id="v-del"><i class="ti ti-trash"></i> Remove from the alcove</button>' : ''}
  `);

  // These start UNDEFINED rather than defaulted. The segments below show
  // 'original'/'unisex' as their resting state, but merely opening this sheet
  // must not stamp those onto the record — applyResearch() would then read them
  // as the user's own choice and refuse to fill the field in.
  let kind = p.kind, gsel = p.gender, ssel = p.status || 'coveted';
  const pick = (sel, set) => sheet.querySelectorAll(`${sel} button`).forEach((b) => b.addEventListener('click', () => {
    set(b);
    sheet.querySelectorAll(`${sel} button`).forEach((x) => x.classList.toggle('active', x === b));
  }));
  pick('#v-status', (b) => { ssel = b.dataset.s; });
  pick('#v-gender', (b) => { gsel = b.dataset.g; });
  pick('#v-kind', (b) => {
    kind = b.dataset.k;
    sheet.querySelector('#v-dupe-wrap').style.display = kind === 'dupe' ? '' : 'none';
  });

  const collect = () => {
    // Only an explicit "Original" clears the dupe fields. Testing `kind ===
    // 'dupe'` would wipe a research-filled dupeOf the moment the sheet was
    // opened and saved without touching that segment.
    const saidOriginal = kind === 'original';
    return {
      ...p,
      name: sheet.querySelector('#v-name').value.trim(),
      house: sheet.querySelector('#v-house').value.trim(),
      concentration: sheet.querySelector('#v-conc').value,
      kind, gender: gsel, status: ssel,
      dupeOf: saidOriginal ? '' : sheet.querySelector('#v-dupeof').value.trim(),
      dupeConfirmed: saidOriginal ? null : p.dupeConfirmed,
      notes: sheet.querySelector('#v-notes').value.trim(),
    };
  };

  // Adding a seller saves the bottle first, so a half-filled new perfume is not
  // lost behind the seller editor.
  sheet.querySelector('[data-v-addseller]').addEventListener('click', async () => {
    const draft = collect();
    if (!draft.name) return toast('Name the perfume first', true);
    await save(draft);
    sellerSheet(draft, null);
  });
  sheet.querySelectorAll('[data-v-seller]').forEach((el) => el.addEventListener('click', async () => {
    const draft = collect();
    if (draft.name) await save(draft);
    sellerSheet(draft, (draft.sellers || []).find((s) => s.id === el.dataset.vSeller));
  }));

  // Photos are stored on the record itself, downscaled first — see readPhoto().
  const reopen = async (rec) => {
    await save(rec);
    render();
    perfumeSheet(items.find((x) => x.id === p.id));   // in place; see §11 popstate
  };
  sheet.querySelector('#v-photo').addEventListener('click', () =>
    sheet.querySelector('#v-photo-input').click());
  sheet.querySelector('#v-photo-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const photo = await readPhoto(file);
      await reopen({ ...collect(), photo });
      toast('Photo added');
    } catch (err) {
      toast(err.message || 'Could not use that image', true);
    }
  });
  sheet.querySelector('#v-photo-x')?.addEventListener('click', async () => {
    await reopen({ ...collect(), photo: null });
    toast('Photo removed');
  });

  // Uses the fields as currently typed, so a name entered seconds ago is the one
  // researched rather than whatever was last saved.
  sheet.querySelector('[data-al-research-one]')?.addEventListener('click', () => handOff([{
    name: sheet.querySelector('#v-name').value.trim() || p.name,
    house: sheet.querySelector('#v-house').value.trim() || p.house,
  }]));

  // Accepting a reference dupe claim is the user's decision, and the source URL
  // is stored with it — so "confirmed" always means confirmed *by something*.
  sheet.querySelector('#v-ref-accept')?.addEventListener('click', async () => {
    const r = referenceFor(p);
    if (!r?.dupeOf) return;
    await save({
      ...collect(), kind: 'dupe', dupeOf: r.dupeOf.name,
      dupeConfirmed: {
        of: r.dupeOf.name,
        confidence: r.dupeOf.confidence || '',
        source: (r.dupeOf.sources || [])[0] || '',
        acceptedAt: todayISO(),
      },
    });
    closeSheet(); render(); toast('Recorded, with its source');
  });

  sheet.querySelector('#v-save').addEventListener('click', async () => {
    const next = collect();
    if (!next.name) return toast('Give the perfume a name', true);
    await save(next);
    closeSheet(); render(); toast(existing ? 'Saved' : 'Added to the alcove');
  });
  sheet.querySelector('#v-del')?.addEventListener('click', async () => {
    await db.del('perfumes', p.id); await load();
    closeSheet(); render(); toast('Removed');
  });
}

// Reference is rendered as a distinct card, never merged into the user's own
// fields: it is what research found, and the two must stay tellable apart.
function referenceCardHTML(p) {
  const r = referenceFor(p);
  if (!r) {
    if (!p.name) return '';
    return `<div class="hint mt"><i class="ti ti-search"></i> No reference entry for this bottle yet.</div>
      <button class="btn al-ref-cta" data-al-research-one="${p.id}">
        <i class="ti ti-search"></i> Research this bottle</button>`;
  }
  const days = r.checkedAt
    ? Math.round((Date.parse(todayISO()) - Date.parse(r.checkedAt)) / 86400000) : null;
  const stale = days !== null && days > 45;
  const price = r.priceUSD && (r.priceUSD.low || r.priceUSD.high)
    ? `${fmtMoney(Number(r.priceUSD.low || r.priceUSD.high))}${
        r.priceUSD.high && r.priceUSD.low && r.priceUSD.high !== r.priceUSD.low
          ? ` – ${fmtMoney(Number(r.priceUSD.high))}` : ''}` : null;

  return `<div class="al-ref">
    <div class="al-ref-head"><span><i class="ti ti-search"></i> Reference — from research</span>
      ${r.checkedAt ? `<span class="stale">${stale ? 'checked ' : ''}${escapeHtml(fmtDateShort(r.checkedAt))}</span>` : ''}</div>

    ${r.dupeOf ? `<div class="al-ref-row"><span class="lbl">Dupe of</span>
      <b>${escapeHtml(r.dupeOf.name)}</b>
      ${r.dupeOf.confidence ? `<span class="stale"> — ${escapeHtml(r.dupeOf.confidence)}</span>` : ''}
      ${(r.dupeOf.sources || []).slice(0, 1).map((u) =>
        ` <a href="${escapeHtml(u)}" target="_blank" rel="noopener">source</a>`).join('')}
      ${p.dupeConfirmed ? '' : '<button class="chip mini mt" id="v-ref-accept">Accept, with source</button>'}
    </div>` : ''}

    ${price ? `<div class="al-ref-row"><span class="lbl">Typically</span> <b>${price}</b>
      ${stale ? '<span class="stale"> — may be out of date</span>' : ''}</div>` : ''}

    ${(r.retailers || []).length ? `<div class="al-ref-row"><span class="lbl">Sold by</span>
      ${r.retailers.slice(0, 4).map((t) => `${escapeHtml(t.name)}${
        t.authorised === true ? ' <span class="al-auth ok">authorised</span>' : ''}`).join(', ')}</div>` : ''}

    ${r.review ? `<div class="al-ref-review">${escapeHtml(r.review)}</div>` : ''}
    ${(r.reviewSources || []).length
      ? `<div class="al-ref-row"><span class="stale">Summarised from ${r.reviewSources.length}
          source${r.reviewSources.length === 1 ? '' : 's'}</span></div>` : ''}
  </div>`;
}

function sellerRowHTML(s) {
  const a = authOf(s.authenticity);
  return `<div class="row tappable" data-v-seller="${s.id}">
    <div class="ic"><i class="ti ti-${s.kind === 'decant' ? 'flask' : 'building-store'}"></i></div>
    <div class="main">
      <div class="t">${escapeHtml(s.name)}</div>
      <div class="s">${s.kind === 'decant' ? 'Decant' : 'Full bottle'}${s.size ? ` · ${escapeHtml(s.size)}` : ''}
        · <span class="al-auth ${a.cls}">${a.label}</span></div>
    </div>
    <div class="amt">${Number(s.price) > 0 ? fmtMoney(Number(s.price)) : '—'}</div>
  </div>`;
}

// --- a seller -------------------------------------------------------------------
function sellerSheet(perfume, existing) {
  const s = existing || { id: uid('sl_'), name: '', kind: 'bottle', price: '', size: '',
    url: '', authenticity: 'unverified', note: '' };

  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>${existing ? 'Seller' : 'Add seller'}</h2>
      <button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="tiny muted">${escapeHtml(perfume.name)}</div>

    <div class="field mt"><label>Seller</label><input class="input" id="s-name" value="${escapeHtml(s.name)}"
      placeholder="Shop or site"></div>

    <div class="field"><label>Selling</label><div class="seg" id="s-kind">
      <button data-k="bottle" class="${s.kind !== 'decant' ? 'active' : ''}">Full bottle</button>
      <button data-k="decant" class="${s.kind === 'decant' ? 'active' : ''}">Decant</button></div></div>

    <div class="grid2">
      <div class="field"><label>Price</label><input class="input" id="s-price" inputmode="decimal"
        value="${s.price || ''}" placeholder="0.00"></div>
      <div class="field"><label>Size</label><input class="input" id="s-size" value="${escapeHtml(s.size || '')}"
        placeholder="e.g. 100ml / 5ml"></div>
    </div>

    <div class="field"><label>Authenticity — your judgement</label><div class="seg" id="s-auth">
      ${AUTHENTICITY.map((a) => `<button data-a="${a.id}" class="${(s.authenticity || 'unverified') === a.id ? 'active' : ''}">${a.label}</button>`).join('')}</div>
      <div class="hint mt">Sanctum cannot tell a genuine seller from a good fake, so it never guesses. This records what <b>you</b> established — a batch code check, a receipt, an authorised-retailer listing. Anything unchecked stays unchecked.</div></div>

    <div class="field"><label>Link</label><input class="input" id="s-url" value="${escapeHtml(s.url || '')}"
      placeholder="https://" inputmode="url"></div>
    <div class="field"><label>Note</label><input class="input" id="s-note" value="${escapeHtml(s.note || '')}"
      placeholder="Optional — batch code, how you checked"></div>

    <button class="btn primary mt" id="s-save">${existing ? 'Save seller' : 'Add seller'}</button>
    ${existing ? '<button class="btn danger mt" id="s-del"><i class="ti ti-trash"></i> Remove seller</button>' : ''}
  `);

  let kind = s.kind || 'bottle', auth = s.authenticity || 'unverified';
  const pick = (sel, set) => sheet.querySelectorAll(`${sel} button`).forEach((b) => b.addEventListener('click', () => {
    set(b);
    sheet.querySelectorAll(`${sel} button`).forEach((x) => x.classList.toggle('active', x === b));
  }));
  pick('#s-kind', (b) => { kind = b.dataset.k; });
  pick('#s-auth', (b) => { auth = b.dataset.a; });

  const back = async (sellers) => {
    const fresh = items.find((x) => x.id === perfume.id) || perfume;
    await save({ ...fresh, sellers });
    render();
    perfumeSheet(items.find((x) => x.id === perfume.id));   // in place; see §11 popstate
  };

  sheet.querySelector('#s-save').addEventListener('click', async () => {
    const name = sheet.querySelector('#s-name').value.trim();
    if (!name) return toast('Name the seller', true);
    const rec = { ...s, name, kind, authenticity: auth,
      price: parseAmount(sheet.querySelector('#s-price').value) || '',
      size: sheet.querySelector('#s-size').value.trim(),
      url: sheet.querySelector('#s-url').value.trim(),
      note: sheet.querySelector('#s-note').value.trim(),
      checkedAt: todayISO() };
    const fresh = items.find((x) => x.id === perfume.id) || perfume;
    const list = [...(fresh.sellers || [])];
    const i = list.findIndex((x) => x.id === rec.id);
    if (i >= 0) list[i] = rec; else list.push(rec);
    await back(list);
    toast(existing ? 'Seller saved' : 'Seller added');
  });
  sheet.querySelector('#s-del')?.addEventListener('click', async () => {
    const fresh = items.find((x) => x.id === perfume.id) || perfume;
    await back((fresh.sellers || []).filter((x) => x.id !== s.id));
    toast('Seller removed');
  });
}

// --- research hand-off ------------------------------------------------------------
// Alcove cannot do the lookup itself: it is a static page, and no key may ever
// ship in a public app. So it hands over a finished prompt instead.
// claude.ai/code/new is the documented way to start a session from the phone;
// there is NO documented prefill parameter, so this is deliberately copy-then-
// paste rather than a link pretending to carry the prompt with it.
async function handOff(bottles) {
  if (!bottles.length) return toast('Nothing to research', true);
  try {
    await navigator.clipboard.writeText(researchPrompt(bottles));
  } catch {
    return toast('Could not copy — open Research and copy it by hand', true);
  }
  toast(`Prompt copied for ${bottles.length} bottle${bottles.length === 1 ? '' : 's'} — paste it into Claude`);
  window.open('https://claude.ai/code/new', '_blank', 'noopener');
}

function researchSheet() {
  const missing = items.filter((p) => p.name && !referenceFor(p));
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2><i class="ti ti-search"></i> Research</h2>
      <button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="al-research-note">Alcove can't look things up itself — it's a static page on your phone, and no
      key may ship in a public app. So it hands Claude a finished prompt: copy, paste, done.</div>

    <div class="card mt"><div class="row">
      <div class="ic"><i class="ti ti-perfume"></i></div>
      <div class="main">
        <div class="t">${missing.length} bottle${missing.length === 1 ? '' : 's'} without reference</div>
        <div class="s">${missing.length
          ? escapeHtml(missing.slice(0, 3).map((p) => p.name).join(', ')) +
            (missing.length > 3 ? ` +${missing.length - 3} more` : '')
          : 'Everything in the alcove has reference data'}</div>
      </div>
    </div></div>

    ${missing.length ? `<button class="btn primary mt" id="al-copy-all">
      <i class="ti ti-copy"></i> Copy prompt &amp; open Claude</button>` : ''}

    <div class="section-title">Got results back?</div>
    <textarea class="input al-paste" id="al-paste" rows="4"
      placeholder="Paste the JSON block Claude gives you"></textarea>
    <button class="btn mt" id="al-import"><i class="ti ti-download"></i> Import results</button>
    <div class="hint mt">Imported entries live on this device and survive the next refresh. If your Claude
      session can reach the repo it commits instead, and then every device picks them up.</div>
  `);

  sheet.querySelector('#al-copy-all')?.addEventListener('click', () => handOff(missing));
  sheet.querySelector('#al-import').addEventListener('click', async () => {
    const raw = sheet.querySelector('#al-paste').value.trim();
    if (!raw) return toast('Paste the JSON first', true);
    try {
      // Claude answers in a fenced code block; accept it either way.
      const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      const n = await importReference(JSON.parse(cleaned));
      closeSheet(); render();
      toast(`Imported ${n} ${n === 1 ? 'entry' : 'entries'}`);
    } catch (e) {
      toast(`That didn't parse — ${e.message}`, true);
    }
  });
}

// --- decant sources ---------------------------------------------------------------
// Aggregated from the sellers you recorded, rather than from a built-in list:
// the app has no way to tell an honest decanter from a dishonest one, and
// listing shops as though it did would be exactly the mistake that costs money.
function decantsSheet() {
  const rows = [];
  for (const p of items) {
    for (const s of p.sellers || []) {
      if (s.kind === 'decant') rows.push({ ...s, perfume: p.name });
    }
  }
  rows.sort((a, b) => (a.authenticity === 'verified' ? -1 : 1) - (b.authenticity === 'verified' ? -1 : 1)
    || String(a.name).localeCompare(String(b.name)));

  openSheet(`
    <div class="sheet-title-row"><h2><i class="ti ti-flask"></i> Decant sources</h2>
      <button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="hint">Every seller you marked as selling decants, gathered in one place — sellers you verified first.</div>
    <div class="card mt">${rows.length ? rows.map((r) => `<div class="row">
      <div class="ic"><i class="ti ti-flask"></i></div>
      <div class="main"><div class="t">${escapeHtml(r.name)}</div>
        <div class="s">${escapeHtml(r.perfume)}${r.size ? ` · ${escapeHtml(r.size)}` : ''}
          · <span class="al-auth ${authOf(r.authenticity).cls}">${authOf(r.authenticity).label}</span></div></div>
      <div class="amt">${Number(r.price) > 0 ? fmtMoney(Number(r.price)) : '—'}</div>
    </div>`).join('') : '<div class="tiny muted center" style="padding:16px">No decant sellers recorded yet.</div>'}</div>
    <div class="hint mt"><b>Why there is no built-in list.</b> Sanctum has no way to check whether a shop sells
      genuine juice, and a list that looked authoritative would be worse than none — it is your money on a fake
      bottle. Record the ones you have actually vetted and they collect here.</div>
  `);
}

// --- wiring ---------------------------------------------------------------------
function bind() {
  const root = $app();
  root.querySelector('[data-hub]').addEventListener('click', () => hubHandler && hubHandler());
  root.querySelector('[data-al-research]').addEventListener('click', researchSheet);
  root.querySelector('[data-al-decants]').addEventListener('click', decantsSheet);
  root.querySelector('[data-al-add]').addEventListener('click', addSheet);
  root.querySelectorAll('[data-al-status]').forEach((b) => b.addEventListener('click', () => {
    status = b.dataset.alStatus; render();
  }));
  root.querySelectorAll('[data-al-gender]').forEach((b) => b.addEventListener('click', () => {
    gender = b.dataset.alGender; render();
  }));
  root.querySelectorAll('[data-al-edit]').forEach((el) => el.addEventListener('click',
    () => perfumeSheet(items.find((x) => x.id === el.dataset.alEdit))));

  const s = root.querySelector('#al-search');
  s.addEventListener('input', (e) => {
    search = e.target.value;
    const y = window.scrollY; render(); window.scrollTo(0, y);
    const n = document.getElementById('al-search');
    if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
  });
}
