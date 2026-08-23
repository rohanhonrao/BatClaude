// db.js — Local, on-device data layer built on IndexedDB.
// Nothing here ever leaves the phone. No network, no accounts.

const DB_NAME = 'batvault';
const DB_VERSION = 5;

// Object stores and their keyPaths. All records use a string `id`.
const STORES = {
  accounts: 'id',
  transactions: 'id',
  categories: 'id',
  budgets: 'id',      // monthly budget per category: {id, categoryId, amount}
  recurring: 'id',
  goals: 'id',
  holdings: 'id',
  settings: 'key',    // key/value store for app settings
  vault: 'id',        // encrypted password entries: {id, blob:{iv,ct}, updatedAt}
  docs: 'id',         // Important Documents: {id, blob:{iv,ct}, updatedAt} — encrypted under a SEPARATE passcode vault (vaultlock.js), never the device key
  grocery: 'id',      // Household items: {id, listId, order, name, qty, priority, due, note, url, checked}
  lists: 'id',        // Household lists (usually a store): {id, name, icon, order}
};

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath });
          if (name === 'transactions') {
            store.createIndex('date', 'date');
            store.createIndex('accountId', 'accountId');
            store.createIndex('categoryId', 'categoryId');
          }
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(store, mode = 'readonly') {
  return openDB().then((db) => db.transaction(store, mode).objectStore(store));
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const db = {
  async all(store) {
    return reqToPromise((await tx(store)).getAll());
  },
  async get(store, key) {
    return reqToPromise((await tx(store)).get(key));
  },
  async put(store, value) {
    const s = await tx(store, 'readwrite');
    await reqToPromise(s.put(value));
    return value;
  },
  async bulkPut(store, values) {
    const s = await tx(store, 'readwrite');
    await Promise.all(values.map((v) => reqToPromise(s.put(v))));
    return values;
  },
  async del(store, key) {
    const s = await tx(store, 'readwrite');
    return reqToPromise(s.delete(key));
  },
  async clear(store) {
    const s = await tx(store, 'readwrite');
    return reqToPromise(s.clear());
  },
  stores: Object.keys(STORES),
};

// Simple id generator — time-ordered + random suffix, collision-safe enough
// for a single-user local app. (crypto.randomUUID isn't guaranteed on file://.)
let _counter = 0;
export function uid(prefix = '') {
  _counter = (_counter + 1) % 100000;
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  return `${prefix}${Date.now().toString(36)}${_counter.toString(36)}${rand}`;
}

// --- Backup / restore -------------------------------------------------------

export async function exportAll() {
  const out = { app: 'Sanctum', version: DB_VERSION, exportedAt: new Date().toISOString(), data: {} };
  for (const store of db.stores) {
    out.data[store] = await db.all(store);
  }
  return out;
}

export async function importAll(payload, { merge = false } = {}) {
  if (!payload || !payload.data) throw new Error('Invalid backup file.');
  for (const store of db.stores) {
    const rows = payload.data[store];
    if (!Array.isArray(rows)) continue;
    if (!merge) await db.clear(store);
    if (rows.length) await db.bulkPut(store, rows);
  }
}
