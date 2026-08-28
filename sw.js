// sw.js — offline cache. Bump CACHE when you change app files.
const CACHE = 'sanctum-v36';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './css/tabler-icons.min.css',
  './css/fonts/tabler-icons.woff2',
  './fonts/inter-400.woff2',
  './fonts/inter-500.woff2',
  './fonts/inter-600.woff2',
  './fonts/inter-700.woff2',
  './fonts/cinzel-400.woff2',
  './fonts/cinzel-500.woff2',
  './fonts/grotesk-500.woff2',
  './fonts/grotesk-700.woff2',
  './js/shell.js',
  './js/app.js',
  './js/db.js',
  './js/util.js',
  './js/compute.js',
  './js/projection.js',
  './js/charts.js',
  './js/csv.js',
  './js/rates.js',
  './js/crypto.js',
  './js/shamir.js',
  './js/ui.js',
  './js/applock.js',
  './js/passwords.js',
  './js/vaultlock.js',
  './js/docs.js',
  './js/household.js',
  './js/sync.js',
  './js/concerts.js',
  './js/joint.js',
  './js/split.js',
  './data/concerts-la.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// GitHub Pages serves everything with `Cache-Control: max-age=600`, and
// cache.addAll() goes through the HTTP cache — so a new worker would happily
// re-cache the *stale* bytes it already had and then serve them cache-first
// forever. `cache: 'reload'` forces every asset to come from the network.
//
// Assets are also cached individually: with addAll a single failure rejects
// the whole install, the worker never activates, and the app is stuck on the
// previous version indefinitely.
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(ASSETS.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res && res.ok) await c.put(url, res);
      } catch { /* one missing asset must not block the update */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for app shell; network-first fallback to cache for everything else.
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  // Never intercept cross-origin requests (e.g. the exchange-rate API).
  if (new URL(request.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(request).then((cached) => {
      const fetched = fetch(request).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});

// Let the page activate a freshly installed worker (the "Refresh" button).
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
