/**
 * sw.js — the offline shell. The whole reason the frontend left GAS: a service
 * worker cannot be registered inside the HtmlService sandbox iframe.
 *
 * Scope is the four files that make up the app. Data is deliberately NOT cached
 * here — the SPA already keeps version-gated payloads in localStorage (see
 * cachedCall), and a second, ungated HTTP cache in front of /api would serve
 * stale figures with no way to tell. /api and /login must reach the network so
 * gs() sees a real failure and can queue the write.
 */
const CACHE = 'ft-shell';
// No font files: the app uses the system font stack (DESIGN.md), so text renders
// offline with nothing cached for it.
const SHELL = ['/', '/app.css', '/app.js', '/manifest.json'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE)
    .then(function (c) { return c.addAll(SHELL); })
    .then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
                           .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  const url = new URL(e.request.url);
  // Cross-origin requests fall through to the browser untouched.
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname === '/api' || url.pathname === '/login') return;

  // Network-first with a short timeout, cache as the fallback. It was cache-first with a
  // background refresh, which put a deploy on the NEXT launch: every change took two
  // launches to show. Online, the Worker answers the conditional request with a 304, so
  // this costs the same requests the background refresh already made; only a slow or
  // dead network falls back to the cached copy (and still refreshes it for next time).
  // ignoreSearch so a deep link (/?screen=transactions&tx=…) matches the cached "/".
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
    // Data Saver on: a cached hit is served and NOT revalidated. On a cell connection the
    // radio wake-up costs more than the 304s do. Refresh clears this cache, so a deploy
    // is still one tap away.
    if (hit && navigator.connection && navigator.connection.saveData) return hit;
    const fresh = fetch(e.request).then(function (res) {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); }
      return res;
    });
    if (!hit) return fresh;
    fresh.catch(function () {});   // offline failure is expected here; the cache answers
    // ponytail: fixed 3 s budget before the cache wins; tune it if a slow network paints late.
    const late = new Promise(function (ok) { setTimeout(function () { ok(hit); }, 3000); });
    return Promise.race([fresh.catch(function () { return hit; }), late]);
  }));
});
