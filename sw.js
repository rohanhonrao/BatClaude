// sw.js — offline cache. Bump CACHE when you change app files.
const CACHE = 'batvault-v2';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/util.js',
  './js/compute.js',
  './js/charts.js',
  './js/csv.js',
  './js/rates.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
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
