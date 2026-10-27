'use strict';
/* Sheet Music viewer — offline service worker (no build step, no external deps).
 *
 * Strategy:
 * - App shell (index, styles, app code, manifest, probe) is cached at
 *   install. Shell files are network-first with a cache fallback, so code
 *   updates reach online visitors without a version bump.
 * - manifest.json is network-first with a cache fallback: the fresh piece
 *   list online, the last-known list offline.
 * - sheets/*.enc are cache-first; on a miss the worker fetches from the
 *   network and caches the response, so any page viewed online becomes
 *   available offline. The full-library download is driven by the page
 *   (app.js), which fetches every sheet URL through this worker.
 * - probe.enc is cache-first: PIN verification must work fully offline.
 */
const CACHE = 'sheet-vault-v1';
const SHELL = ['index.html', 'styles.css', 'app.js', 'manifest.json', 'probe.enc', './'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {}) // first visit while offline: shell fills in lazily
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isSheet(url) { return url.pathname.includes('/sheets/'); }
function isManifest(url) { return url.pathname.endsWith('/manifest.json'); }
function isProbe(url) { return url.pathname.endsWith('/probe.enc'); }
function isShell(url) { return /\/(index\.html|styles\.css|app\.js)?$/.test(url.pathname); }

function cachePut(req, res) {
  if (!res.ok) return;
  const copy = res.clone();
  caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (isSheet(url)) {
    // Cache-first: offline pages load instantly; new pages cache on first view.
    event.respondWith(
      caches.match(req, { ignoreSearch: true }).then(hit => {
        if (hit) return hit;
        return fetch(req).then(res => { cachePut(req, res); return res; });
      })
    );
    return;
  }
  if (isManifest(url)) {
    // Network-first: fresh list online, last-known list offline.
    event.respondWith(
      fetch(req).then(res => { cachePut(req, res); return res; })
        .catch(() => caches.match(req, { ignoreSearch: true }))
    );
    return;
  }
  if (isProbe(url)) {
    event.respondWith(
      caches.match(req, { ignoreSearch: true }).then(hit =>
        hit || fetch(req).then(res => { cachePut(req, res); return res; }))
    );
    return;
  }
  if (isShell(url)) {
    // Network-first so code updates propagate; cached copy serves offline.
    event.respondWith(
      fetch(req).then(res => { cachePut(req, res); return res; })
        .catch(() => caches.match(req, { ignoreSearch: true }))
    );
  }
});
