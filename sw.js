/* =========================================================
   Reel service worker - offline app shell
   Only same-origin files are cached; PeerJS, fonts and YouTube
   always go to the network (the app needs them live anyway).
   Bump VERSION whenever you ship changed app files, or the old
   shell keeps coming back from the cache.
   ========================================================= */
const VERSION = 'reel-shell-v5';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './boot.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

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
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // CDN / YouTube / WebRTC traffic passes straight through
  if (e.request.headers.has('range')) return; // media streaming: let <video> talk to the network directly

  // Page navigations: network first so updates land quickly,
  // cached shell as the offline fallback.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Same-origin assets: cache first, refresh in the background.
  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then(c => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
