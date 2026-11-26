/* Leon's Ledger service worker.
   Network-first: when online you always get the newest version; offline you get the last one. */
const CACHE = 'leons-ledger-1.3.0';
const FILES = ["./","./index.html","./styles.css?v=1.3.0","./web-api.js?v=1.3.0","./logic.js?v=1.3.0","./report.js?v=1.3.0","./app.js?v=1.3.0","./manifest.webmanifest","./icons/icon-192.png","./icons/icon-512.png"];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('leons-ledger-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html')))
  );
});
