// grocery.js — a fast, shareable grocery list. Items auto-sort into aisles and
// can be shared to another phone the same way Move HQ shares its list. Not
// sensitive, so it uses plain (unencrypted) local storage for speed.
import { db, uid } from './db.js';
import { toast, openSheet, closeSheet } from './ui.js';
import { escapeHtml } from './util.js';

const AISLES = ['Produce', 'Dairy & Eggs', 'Meat & Seafood', 'Bakery', 'Pantry', 'Frozen', 'Beverages', 'Household', 'Personal care', 'Other'];
const AISLE_ICON = {
  'Produce': 'ti-apple', 'Dairy & Eggs': 'ti-egg', 'Meat & Seafood': 'ti-meat', 'Bakery': 'ti-bread',
  'Pantry': 'ti-jar', 'Frozen': 'ti-snowflake', 'Beverages': 'ti-bottle', 'Household': 'ti-spray',
  'Personal care': 'ti-wash', 'Other': 'ti-basket',
};
// Keyword → aisle guesses (first match wins).
const GUESS = [
  [/(milk|cheese|yogurt|yoghurt|butter|egg|cream|paneer)/, 'Dairy & Eggs'],
  [/(apple|banana|tomato|onion|potato|lettuce|spinach|carrot|garlic|ginger|pepper|lemon|lime|grape|berry|berries|fruit|veg|cilantro|avocado|cucumber|broccoli)/, 'Produce'],
  [/(chicken|beef|pork|fish|shrimp|prawn|mutton|lamb|bacon|sausage|meat|turkey|salmon)/, 'Meat & Seafood'],
  [/(bread|bagel|bun|roll|croissant|muffin|tortilla|naan)/, 'Bakery'],
  [/(rice|pasta|flour|sugar|oil|salt|spice|cereal|bean|lentil|dal|sauce|can|soup|noodle|masala|tea|coffee)/, 'Pantry'],
  [/(frozen|ice cream|icecream|pizza)/, 'Frozen'],
  [/(water|juice|soda|coke|beer|wine|drink|cola)/, 'Beverages'],
  [/(soap|detergent|paper towel|toilet|trash|cleaner|napkin|foil|dish|sponge|bag)/, 'Household'],
  [/(shampoo|toothpaste|toothbrush|razor|deodorant|lotion|floss|pad|tampon)/, 'Personal care'],
];

let items = [];
let hubHandler = null;
export function setGroceryHubHandler(fn) { hubHandler = fn; }

const $app = () => document.getElementById('app');

export async function mountGrocery() {
  await load();
  render();
}
async function load() { items = (await db.all('grocery')).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)); }
async function save(it) { it.updatedAt = Date.now(); await db.put('grocery', it); await load(); }

function guessAisle(name) {
  const s = name.toLowerCase();
  for (const [re, a] of GUESS) if (re.test(s)) return a;
  return 'Other';
}
function parseEntry(raw) {
  raw = raw.trim();
  let qty = '';
  const m = raw.match(/^(\d+\s*(?:x|X)?)\s+(.+)/);
  if (m) { qty = m[1].replace(/\s*[xX]$/, '').trim(); raw = m[2].trim(); }
  return { name: raw, qty };
}

async function addEntry(raw) {
  const { name, qty } = parseEntry(raw);
  if (!name) return;
  await save({ id: uid('g_'), order: (items.at(-1)?.order ?? 0) + 1, name, qty, aisle: guessAisle(name), price: '', checked: false });
}

// --- render -----------------------------------------------------------------
function render() {
  const remaining = items.filter((i) => !i.checked);
  const done = items.filter((i) => i.checked);
  const total = items.reduce((s, i) => s + (parseFloat(i.price) || 0), 0);

  // Group the remaining items by aisle, in aisle order.
  const groups = AISLES.map((a) => ({ aisle: a, list: remaining.filter((i) => i.aisle === a) })).filter((g) => g.list.length);

  $app().innerHTML = `<div class="view">
    <div class="app-header">
      <div class="title"><button class="header-btn" data-hub aria-label="All apps"><i class="ti ti-apps"></i></button>
        <h1 class="mod-title"><i class="ti ti-shopping-cart" style="color:var(--gold)"></i> Grocery</h1></div>
      <button class="header-btn" data-menu aria-label="More"><i class="ti ti-dots"></i></button>
    </div>

    <div class="groc-add">
      <input class="input" id="gc-new" placeholder="Add item — e.g. 2 Milk" autocomplete="off">
      <button class="mini-btn primary" id="gc-add" aria-label="Add"><i class="ti ti-plus"></i></button>
    </div>
    <div class="tiny muted spread" style="margin:8px 4px 12px">
      <span>${remaining.length} to buy${done.length ? ` · ${done.length} in cart` : ''}</span>
      ${total > 0 ? `<span>~ $${total.toFixed(2)}</span>` : ''}
    </div>

    ${items.length ? groups.map(groupHTML).join('') : emptyHTML()}
    ${done.length ? `<div class="section-title spread"><span>In cart · ${done.length}</span><button class="linkbtn" data-clear>Clear</button></div>
      <div class="groc-group">${done.map(itemHTML).join('')}</div>` : ''}
  </div>`;
  bind();
}

function groupHTML(g) {
  return `<div class="section-title"><i class="ti ${AISLE_ICON[g.aisle]}"></i> ${g.aisle}</div>
    <div class="groc-group">${g.list.map(itemHTML).join('')}</div>`;
}
function itemHTML(i) {
  return `<div class="groc-item ${i.checked ? 'checked' : ''}" data-edit="${i.id}">
    <button class="groc-check" data-toggle="${i.id}" aria-label="Toggle">${i.checked ? '<i class="ti ti-check"></i>' : ''}</button>
    <span class="groc-name">${escapeHtml(i.name)}${i.qty ? ` <span class="groc-qty">×${escapeHtml(i.qty)}</span>` : ''}</span>
    ${i.price ? `<span class="groc-price">$${escapeHtml(i.price)}</span>` : ''}
  </div>`;
}
function emptyHTML() {
  return `<div class="empty"><span class="em"><i class="ti ti-shopping-cart"></i></span>
    <div>List is empty</div><div class="tiny mt">Add items above — they sort into aisles automatically.</div></div>`;
}

function bind() {
  const r = $app();
  r.querySelector('[data-hub]').addEventListener('click', () => hubHandler && hubHandler());
  r.querySelector('[data-menu]').addEventListener('click', menuSheet);
  const input = r.querySelector('#gc-new');
  const add = async () => { const v = input.value; if (!v.trim()) return; await addEntry(v); render(); const n = document.getElementById('gc-new'); n.focus(); };
  r.querySelector('#gc-add').addEventListener('click', add);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  r.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const it = items.find((x) => x.id === b.dataset.toggle);
    if (it) { it.checked = !it.checked; await save(it); render(); }
  }));
  r.querySelectorAll('[data-edit]').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('[data-toggle]')) return;
    editSheet(items.find((x) => x.id === el.dataset.edit));
  }));
  r.querySelector('[data-clear]')?.addEventListener('click', clearChecked);
}

async function clearChecked() {
  const done = items.filter((i) => i.checked);
  if (!done.length) return;
  for (const i of done) await db.del('grocery', i.id);
  await load(); render(); toast(`Cleared ${done.length} item${done.length === 1 ? '' : 's'}`);
}

// --- edit item --------------------------------------------------------------
function editSheet(it) {
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Edit item</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <div class="field"><label>Item</label><input class="input" id="i-name" value="${escapeHtml(it.name)}"></div>
    <div class="btn-row">
      <div class="field" style="flex:1"><label>Quantity</label><input class="input" id="i-qty" value="${escapeHtml(it.qty || '')}" placeholder="e.g. 2"></div>
      <div class="field" style="flex:1"><label>Price <span class="muted tiny">(opt)</span></label><input class="input" id="i-price" inputmode="decimal" value="${escapeHtml(it.price || '')}" placeholder="0.00"></div>
    </div>
    <div class="field"><label>Aisle</label><select class="input" id="i-aisle">${AISLES.map((a) => `<option ${a === it.aisle ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
    <button class="btn primary" id="i-save"><i class="ti ti-device-floppy"></i> Save</button>
    <button class="btn danger mt" id="i-del"><i class="ti ti-trash"></i> Remove</button>
  `);
  sheet.querySelector('#i-save').addEventListener('click', async () => {
    it.name = sheet.querySelector('#i-name').value.trim() || it.name;
    it.qty = sheet.querySelector('#i-qty').value.trim();
    it.price = sheet.querySelector('#i-price').value.trim();
    it.aisle = sheet.querySelector('#i-aisle').value;
    await save(it); closeSheet(); render(); toast('Saved');
  });
  sheet.querySelector('#i-del').addEventListener('click', async () => {
    await db.del('grocery', it.id); await load(); closeSheet(); render(); toast('Removed');
  });
}

// --- menu: share / import / clear all ---------------------------------------
function menuSheet() {
  const s = openSheet(`
    <div class="sheet-title-row"><h2>Grocery list</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <button class="btn" id="m-share"><i class="ti ti-send"></i> Share list</button>
    <button class="btn mt" id="m-import"><i class="ti ti-download"></i> Import a list</button>
    <button class="btn danger mt" id="m-clear"><i class="ti ti-trash"></i> Clear whole list</button>
  `);
  s.querySelector('#m-share').addEventListener('click', () => { closeSheet(); shareSheet(); });
  s.querySelector('#m-import').addEventListener('click', () => { closeSheet(); importSheet(); });
  s.querySelector('#m-clear').addEventListener('click', () => {
    const s2 = openSheet(`<div class="center"><div style="font-size:30px"><i class="ti ti-trash"></i></div>
      <h2 style="margin:10px 0 6px">Clear the whole list?</h2><p class="muted tiny">Removes all ${items.length} items.</p></div>
      <button class="btn danger" id="c-yes">Clear all</button><button class="btn ghost mt" data-close>Cancel</button>`);
    s2.querySelector('#c-yes').addEventListener('click', async () => { await db.clear('grocery'); await load(); closeSheet(); render(); toast('List cleared'); });
  });
}

// --- share / import (same approach as Move HQ) ------------------------------
function b64encode(s) { return btoa(unescape(encodeURIComponent(s))); }
function b64decode(s) { return decodeURIComponent(escape(atob(s))); }
function downloadText(name, text) {
  const b = new Blob([text], { type: 'text/plain' });
  const u = URL.createObjectURL(b);
  const a = document.createElement('a');
  a.href = u; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
function parsePayload(raw) {
  let json;
  try { json = JSON.parse(raw); } catch { /* not raw */ }
  if (!json) { try { json = JSON.parse(b64decode(raw)); } catch { /* not base64 */ } }
  if (!json || json.app !== 'batvault-grocery' || !Array.isArray(json.items)) throw new Error('That doesn’t look like a grocery list');
  return json;
}

function shareSheet() {
  const json = JSON.stringify({ app: 'batvault-grocery', v: 1, exportedAt: new Date().toISOString(), items });
  const code = b64encode(json);
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Share list</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <p class="muted tiny">Send your ${items.length}-item list to another phone. There, open Grocery → menu → <b>Import</b>. It replaces the list on that phone.</p>
    <button class="btn primary mt" id="sh-share"><i class="ti ti-send"></i> Share…</button>
    <div class="btn-row">
      <button class="btn ghost" id="sh-copy"><i class="ti ti-copy"></i> Copy code</button>
      <button class="btn ghost" id="sh-file"><i class="ti ti-file-download"></i> Save file</button>
    </div>
    <div class="field mt"><label>Or copy this code manually</label>
      <div class="mono share-text" style="max-height:120px;overflow:auto">${escapeHtml(code)}</div></div>
  `);
  const copyCode = async () => { try { await navigator.clipboard.writeText(code); toast('Code copied — send it over'); } catch { toast('Copy failed', true); } };
  sheet.querySelector('#sh-copy').addEventListener('click', copyCode);
  sheet.querySelector('#sh-file').addEventListener('click', () => downloadText('grocery.json', json));
  sheet.querySelector('#sh-share').addEventListener('click', async () => {
    const file = new File([json], 'grocery.json', { type: 'application/json' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Grocery list' }); return; }
      if (navigator.share) { await navigator.share({ title: 'Grocery list', text: code }); return; }
    } catch { return; }
    copyCode();
  });
}

function importSheet() {
  const sheet = openSheet(`
    <div class="sheet-title-row"><h2>Import a list</h2><button class="close" data-close><i class="ti ti-x"></i></button></div>
    <p class="muted tiny">Paste a shared code, or choose a shared file. This <b>replaces</b> your current grocery list.</p>
    <div class="field mt"><label>Paste code</label><textarea class="input mono" id="im-code" rows="4" placeholder="Paste the code here…"></textarea></div>
    <div class="field"><label>…or choose a file</label><input class="input" type="file" id="im-file" accept=".json,.txt,application/json,text/plain"></div>
    <button class="btn primary" id="im-go"><i class="ti ti-arrow-bar-to-down"></i> Replace my list</button>
  `);
  let fileText = '';
  sheet.querySelector('#im-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) { try { fileText = await f.text(); } catch { toast('Could not read that file', true); } }
  });
  sheet.querySelector('#im-go').addEventListener('click', async () => {
    const raw = sheet.querySelector('#im-code').value.trim() || fileText.trim();
    if (!raw) return toast('Paste a code or choose a file', true);
    let payload;
    try { payload = parsePayload(raw); } catch (err) { return toast(err.message, true); }
    await db.clear('grocery');
    if (payload.items.length) await db.bulkPut('grocery', payload.items);
    await load(); closeSheet(); render(); toast(`Imported ${payload.items.length} item${payload.items.length === 1 ? '' : 's'}`);
  });
}
