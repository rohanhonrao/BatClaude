// vitrine.js — VITRINE: the perfume collection.
//
// A vitrine is the glass case a collection is kept in, which is what this is:
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
let status = 'all';       // 'all' | 'collected' | 'coveted'
let gender = 'all';       // 'all' | masculine | feminine | unisex
let search = '';
let hubHandler = null;
export function setVitrineHubHandler(fn) { hubHandler = fn; }

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

export async function mountVitrine() {
  await load();
  status = 'all'; gender = 'all'; search = '';
  render();
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
  if (status !== 'all') list = list.filter((p) => (p.status || 'coveted') === status);
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

  const body = shown.length
    ? houseNames.map((h) => `
        <div class="vt-group">
          <div class="vt-house"><span>${escapeHtml(h)}</span><span class="vt-n">${houses[h].length}</span></div>
          <div class="card">${houses[h].map(rowHTML).join('')}</div>
        </div>`).join('')
    : `<div class="empty"><span class="em"><i class="ti ti-perfume"></i></span>
        <div>${items.length ? 'Nothing matches' : 'The vitrine is empty'}</div>
        <div class="tiny mt">${items.length ? 'Try a different filter.' : 'Add the first bottle above.'}</div></div>`;

  $app().innerHTML = `<div class="view">
    <div class="app-header">
      <div class="title">
        <button class="header-btn" data-hub aria-label="All apps"><i class="ti ti-apps"></i></button>
        <h1 class="mod-title">Vitrine</h1>
      </div>
      <button class="header-btn" data-vt-decants aria-label="Decant sources"><i class="ti ti-flask"></i></button>
    </div>

    <div class="hero vt-hero">
      <div class="vt-counts">
        <div><b>${collected}</b><span class="label">Collected</span></div>
        <div><b>${coveted}</b><span class="label">Coveted</span></div>
      </div>
    </div>

    <div class="btn-row j-actions">
      <button class="btn primary" data-vt-add><i class="ti ti-plus"></i> Add perfume</button>
    </div>

    <div class="seg mt" id="vt-status">
      ${[['all', 'All'], ['collected', 'Collected'], ['coveted', 'Coveted']].map(([v, l]) =>
        `<button data-vt-status="${v}" class="${status === v ? 'active' : ''}">${l}</button>`).join('')}
    </div>

    <div class="hh-chips vt-genders mt">
      <button class="chip ${gender === 'all' ? 'active' : ''}" data-vt-gender="all">Any wear</button>
      ${GENDERS.map((g) => `<button class="chip ${gender === g.id ? 'active' : ''}" data-vt-gender="${g.id}">
        <i class="ti ${g.icon}"></i>${g.label}</button>`).join('')}
    </div>

    <div class="field mt"><input class="input" id="vt-search" placeholder="Search name, house or dupe…"
      value="${escapeHtml(search)}"></div>

    ${body}
  </div>`;
  bind();
}

function rowHTML(p) {
  const g = genderOf(p.gender);
  const best = bestPrice(p);
  const meta = [
    p.concentration ? escapeHtml(p.concentration) : '',
    `<i class="ti ${g.icon}"></i> ${g.label}`,
    p.kind === 'dupe'
      ? `<span class="vt-dupe ${p.dupeConfirmed ? 'ok' : ''}">${p.dupeConfirmed
          ? `dupe of ${escapeHtml(p.dupeConfirmed.of)}`
          : p.dupeOf ? `believed dupe of ${escapeHtml(p.dupeOf)}` : 'dupe'}</span>`
      : '',
  ].filter(Boolean).join(' · ');

  return `<div class="row tappable vt-row" data-vt-edit="${p.id}">
    <div class="ic"><i class="ti ti-perfume"></i></div>
    <div class="main">
      <div class="t">${escapeHtml(p.name || 'Untitled')}</div>
      <div class="s">${meta}</div>
    </div>
    <div class="vt-right">
      <span class="vt-status ${p.status === 'collected' ? 'have' : 'want'}">${
        p.status === 'collected' ? 'Collected' : 'Coveted'}</span>
      ${best ? `<div class="j-share">${fmtMoney(Number(best.price))}</div>` : ''}
    </div>
  </div>`;
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
        ? `<div class="alert ok"><i class="ti ti-rosette-discount-check"></i> Confirmed as a dupe of
            <b>${escapeHtml(p.dupeConfirmed.of)}</b>${p.dupeConfirmed.source ? ` — ${escapeHtml(p.dupeConfirmed.source)}` : ''}</div>`
        : `<div class="hint">Stored as <b>believed</b>. Sanctum has no dupe database, so it will not claim this is confirmed — see the note under Decant sources.</div>`}
    </div>

    <div class="field mt"><label>Notes</label><textarea class="input" id="v-notes" rows="2"
      placeholder="Optional — how it wears, longevity, where you tried it">${escapeHtml(p.notes || '')}</textarea></div>

    <div class="section-title spread"><span>Where to buy</span>
      <button class="mini-btn" data-v-addseller aria-label="Add seller"><i class="ti ti-plus"></i></button></div>
    ${best ? `<div class="vt-best"><i class="ti ti-tag"></i> Best recorded:
      <b>${fmtMoney(Number(best.price))}</b> at ${escapeHtml(best.name)}
      <span class="vt-auth ${authOf(best.authenticity).cls}">${authOf(best.authenticity).label}</span></div>` : ''}
    <div class="card">${(p.sellers || []).length
      ? p.sellers.map(sellerRowHTML).join('')
      : '<div class="tiny muted center" style="padding:14px">No sellers recorded yet.</div>'}</div>

    <button class="btn primary mt2" id="v-save">${existing ? 'Save' : 'Add to vitrine'}</button>
    ${existing ? '<button class="btn danger mt" id="v-del"><i class="ti ti-trash"></i> Remove from vitrine</button>' : ''}
  `);

  let kind = p.kind || 'original', gsel = p.gender || 'unisex', ssel = p.status || 'coveted';
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

  const collect = () => ({
    ...p,
    name: sheet.querySelector('#v-name').value.trim(),
    house: sheet.querySelector('#v-house').value.trim(),
    concentration: sheet.querySelector('#v-conc').value,
    kind, gender: gsel, status: ssel,
    dupeOf: kind === 'dupe' ? sheet.querySelector('#v-dupeof').value.trim() : '',
    dupeConfirmed: kind === 'dupe' ? p.dupeConfirmed : null,
    notes: sheet.querySelector('#v-notes').value.trim(),
  });

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

  sheet.querySelector('#v-save').addEventListener('click', async () => {
    const next = collect();
    if (!next.name) return toast('Give the perfume a name', true);
    await save(next);
    closeSheet(); render(); toast(existing ? 'Saved' : 'Added to the vitrine');
  });
  sheet.querySelector('#v-del')?.addEventListener('click', async () => {
    await db.del('perfumes', p.id); await load();
    closeSheet(); render(); toast('Removed');
  });
}

function sellerRowHTML(s) {
  const a = authOf(s.authenticity);
  return `<div class="row tappable" data-v-seller="${s.id}">
    <div class="ic"><i class="ti ti-${s.kind === 'decant' ? 'flask' : 'building-store'}"></i></div>
    <div class="main">
      <div class="t">${escapeHtml(s.name)}</div>
      <div class="s">${s.kind === 'decant' ? 'Decant' : 'Full bottle'}${s.size ? ` · ${escapeHtml(s.size)}` : ''}
        · <span class="vt-auth ${a.cls}">${a.label}</span></div>
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
          · <span class="vt-auth ${authOf(r.authenticity).cls}">${authOf(r.authenticity).label}</span></div></div>
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
  root.querySelector('[data-vt-decants]').addEventListener('click', decantsSheet);
  root.querySelector('[data-vt-add]').addEventListener('click', () => perfumeSheet());
  root.querySelectorAll('[data-vt-status]').forEach((b) => b.addEventListener('click', () => {
    status = b.dataset.vtStatus; render();
  }));
  root.querySelectorAll('[data-vt-gender]').forEach((b) => b.addEventListener('click', () => {
    gender = b.dataset.vtGender; render();
  }));
  root.querySelectorAll('[data-vt-edit]').forEach((el) => el.addEventListener('click',
    () => perfumeSheet(items.find((x) => x.id === el.dataset.vtEdit))));

  const s = root.querySelector('#vt-search');
  s.addEventListener('input', (e) => {
    search = e.target.value;
    const y = window.scrollY; render(); window.scrollTo(0, y);
    const n = document.getElementById('vt-search');
    if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
  });
}
