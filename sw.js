/* =========================================================
   Reel service worker - offline app shell
   Only same-origin app-shell files are cached. PeerJS and hls.js
   are vendored into ./vendor/, so they are part of the shell too.
   YouTube, fonts and media always go to the network.
   Bump VERSION whenever you ship changed app files, or the old
   shell keeps coming back from the cache.
   ========================================================= */
const VERSION = 'reel-shell-v18';
const SHELL = [
  './',
  './index.html',
  './styles.css?v=18',
  './app.js?v=18',
  './boot.js',
  './manifest.json',
  './vendor/peer.min.js',
  './vendor/hls.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

/* Paths that may be written to the cache. Query strings identify the shell
   version but are not part of the file name, so match on the path only. */
const SHELL_PATHS = new Set(SHELL.map(p => new URL(p, self.location.href).pathname));

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;

  // Never cache (or intercept) non-GET traffic: the Cache API only stores
  // GET responses, and a rejected put would surface as an unhandled error.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // CDN / YouTube / WebRTC traffic passes straight through
  if (req.headers.has('range')) return;       // media streaming: let <video> talk to the network directly

  // Page navigations: network first so updates land quickly,
  // cached shell as the offline fallback.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION)
              .then(c => c.put('./index.html', copy))
              .catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Only app-shell files are cached. Everything else same-origin is left
  // to the network so arbitrary responses never end up in the cache.
  if (!SHELL_PATHS.has(url.pathname)) return;

  // Same-origin assets: network first so updates apply right away,
  // falling back to cache when offline.
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION)
            .then(c => c.put(req, copy))
            .catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
