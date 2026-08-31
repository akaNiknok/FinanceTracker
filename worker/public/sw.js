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
// The two Inter subsets are shell files now, not a Google Fonts round trip: that is
// what makes the app render in its own typeface offline instead of the fallback stack.
const SHELL = ['/', '/app.css', '/app.js', '/manifest.json',
               '/fonts/inter-latin.woff2', '/fonts/inter-latin-ext.woff2'];

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
  // Cross-origin (the Inter webfont) falls through to the browser, which already
  // has the system-font fallback in --font when it can't be fetched.
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname === '/api' || url.pathname === '/login') return;

  // ponytail: cache-first, refresh in the background. Ceiling — a deploy shows up on
  // the NEXT launch, since nothing here is version-keyed. The Refresh button clears
  // this cache, which is the escape hatch; if that ever stops being enough, stamp the
  // app version into asset URLs from release.js and drop ignoreSearch below.
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
    // ignoreSearch so a deep link (/?screen=budgets&tx=…) matches the cached "/".
    // Data Saver on: a cached hit is served and NOT revalidated. Every launch otherwise
    // spends six conditional requests to learn the shell did not change, and on a cell
    // connection the radio wake-up costs more than the 304s do. Refresh still clears
    // this cache, so a deploy is one tap away — the same escape hatch as above.
    if (hit && navigator.connection && navigator.connection.saveData) return hit;
    const fresh = fetch(e.request).then(function (res) {
      if (res.ok) caches.open(CACHE).then(function (c) { c.put(e.request, res.clone()); });
      return res;
    });
    if (hit) { fresh.catch(function () {}); return hit; }   // offline failure is expected here
    return fresh;
  }));
});
