// sync.js — optional real-time sharing for a module's data.
//
// Design constraints this satisfies:
//   • No SDK. Firebase Realtime Database is reachable over plain REST, and its
//     `Accept: text/event-stream` endpoint pushes changes, so we get live sync
//     without a CDN script and the app stays fully offline-capable.
//   • End-to-end encrypted. Every record is AES-GCM encrypted with a key
//     derived from a shared passphrase before it leaves the device, so the
//     server only ever holds opaque blobs. It is a relay, not a custodian.
//   • Last-write-wins per record via `updatedAt`, with tombstones for deletes,
//     so two people editing different items never clobber each other.
//
// Honest limitation: records live under an unguessable room id with no user
// auth. Security rests on the encryption plus the secrecy of the pairing code
// — appropriate for a shared shopping list, NOT for the password vault.
import { db } from './db.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const KEY = 'syncConfig';

let cfg = null;         // { dbUrl, roomId, passphrase }
let cryptoKey = null;
let stream = null;
let onChange = null;
let applying = false;   // guards against echoing remote changes back

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

// --- config ------------------------------------------------------------------
export async function loadConfig() {
  const row = await db.get('settings', KEY);
  cfg = row ? row.value : null;
  cryptoKey = null;
  return cfg;
}
export function isConfigured() { return !!(cfg && cfg.dbUrl && cfg.roomId && cfg.passphrase); }
export function getConfig() { return cfg; }

export async function saveConfig(next) {
  cfg = next;
  cryptoKey = null;
  await db.put('settings', { key: KEY, value: next });
}
export async function clearConfig() {
  stop();
  cfg = null; cryptoKey = null;
  await db.del('settings', KEY);
}

// The old check was /^https:\/\/.+firebase/, which happily accepted the Firebase
// *console* URL (console.firebase.google.com/project/…) — the easiest possible
// mistake, since that is the page you are looking at when you go hunting for the
// URL. It created a connection that looked fine and silently never synced.
// Only a Realtime Database host will do.
export function validateDbUrl(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return { ok: false, msg: 'Paste your Realtime Database URL' };
  let u;
  try { u = new URL(s); } catch { return { ok: false, msg: 'That doesn’t look like a URL' }; }
  if (u.protocol !== 'https:') return { ok: false, msg: 'The database URL must start with https://' };
  if (u.hostname === 'console.firebase.google.com') {
    return { ok: false, msg: 'That’s the console page. The database URL is shown above the data tree.' };
  }
  if (!/\.firebaseio\.com$/i.test(u.hostname) && !/\.firebasedatabase\.app$/i.test(u.hostname)) {
    return { ok: false, msg: 'Not a Realtime Database URL — it should end in firebaseio.com' };
  }
  // A path means they copied a deep link rather than the database root.
  if (u.pathname && u.pathname !== '/') return { ok: false, msg: 'Paste just the database URL, with no path after it' };
  return { ok: true, url: u.origin };
}

// A single code carries everything the other phone needs, so only one person
// ever has to touch Firebase.
export function makePairingCode() {
  if (!isConfigured()) return '';
  return btoa(unescape(encodeURIComponent(JSON.stringify(cfg))));
}
export function parsePairingCode(code) {
  const o = JSON.parse(decodeURIComponent(escape(atob(String(code).trim()))));
  if (!o.dbUrl || !o.roomId || !o.passphrase) throw new Error('Incomplete code');
  o.dbUrl = String(o.dbUrl).replace(/\/+$/, '');
  return o;
}

export function newRoom(dbUrl) {
  return {
    dbUrl: String(dbUrl).trim().replace(/\/+$/, ''),
    roomId: b64(rand(18)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 22),
    passphrase: b64(rand(18)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 22),
  };
}

// --- crypto ------------------------------------------------------------------
async function key() {
  if (cryptoKey) return cryptoKey;
  const base = await crypto.subtle.importKey('raw', enc.encode(cfg.passphrase), 'PBKDF2', false, ['deriveKey']);
  cryptoKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('sanctum-sync:' + cfg.roomId), iterations: 120000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return cryptoKey;
}
async function seal(obj) {
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(ct) };
}
async function open(blob) {
  if (!blob || !blob.iv || !blob.ct) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, await key(), unb64(blob.ct));
    return JSON.parse(dec.decode(pt));
  } catch { return null; }   // wrong passphrase, or someone else's data
}

const url = (path) => `${cfg.dbUrl}/rooms/${cfg.roomId}${path}.json`;

// --- push --------------------------------------------------------------------
// `store` is the local IndexedDB store name; records keep their own ids.
export async function push(store, record) {
  if (!isConfigured() || applying) return;
  const stamped = { ...record, updatedAt: record.updatedAt || Date.now() };
  const body = { at: stamped.updatedAt, data: await seal(stamped) };
  try {
    await fetch(url(`/${store}/${encodeURIComponent(record.id)}`), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch { /* offline: the next full push reconciles */ }
}

export async function pushDelete(store, id) {
  if (!isConfigured() || applying) return;
  // A tombstone, not a removal — otherwise the other device would resurrect it.
  const body = { at: Date.now(), deleted: true };
  try {
    await fetch(url(`/${store}/${encodeURIComponent(id)}`), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch {}
}

export async function pushAll(stores) {
  if (!isConfigured()) return;
  for (const store of stores) {
    for (const rec of await db.all(store)) await push(store, rec);
  }
}

// --- merge -------------------------------------------------------------------
async function applyRecord(store, id, node) {
  if (!node) return false;
  const local = await db.get(store, id);
  const localAt = local?.updatedAt || 0;
  if ((node.at || 0) <= localAt) return false;      // ours is newer or equal
  applying = true;
  try {
    if (node.deleted) { if (local) await db.del(store, id); }
    else {
      const rec = await open(node.data);
      if (!rec) return false;
      await db.put(store, { ...rec, id });
    }
    return true;
  } finally { applying = false; }
}

async function applyTree(tree, stores) {
  let touched = false;
  for (const store of stores) {
    const branch = tree && tree[store];
    if (!branch) continue;
    for (const [id, node] of Object.entries(branch)) {
      if (await applyRecord(store, id, node)) touched = true;
    }
  }
  return touched;
}

// --- live stream --------------------------------------------------------------
export function start(stores, cb) {
  stop();
  if (!isConfigured()) return;
  onChange = cb;
  try {
    stream = new EventSource(url(''));
  } catch { stream = null; return; }

  const handle = async (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (!msg || msg.path === undefined) return;
    let touched = false;
    if (msg.path === '/') {
      touched = await applyTree(msg.data, stores);
    } else {
      // "/items/<id>" — a single record changed
      const [, store, id] = msg.path.split('/');
      if (store && id && stores.includes(store)) touched = await applyRecord(store, id, msg.data);
      else if (store && stores.includes(store) && msg.data) {
        touched = await applyTree({ [store]: msg.data }, stores);
      }
    }
    if (touched && onChange) onChange();
  };
  stream.addEventListener('put', handle);
  stream.addEventListener('patch', handle);
}

export function stop() {
  if (stream) { try { stream.close(); } catch {} stream = null; }
  onChange = null;
}

export function isLive() { return !!stream; }
