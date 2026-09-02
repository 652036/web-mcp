const CACHE = 'forkcast-shell-v4';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './assets/icon.svg',
  './src/app.js',
  './src/data.js',
  './src/engine.js',
  './src/storage.js',
  './src/tools.js',
  './src/webmcp.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)));
  // Activate immediately, but do not claim already-open pages: a page keeps the
  // worker (and module set) it booted with until it navigates, so a deployment
  // never mixes old and new modules inside one session.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  );
});

function networkFirst(request, cacheKey = request) {
  return fetch(request)
    .then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(cacheKey, copy));
      }
      return response;
    })
    .catch(() => caches.match(cacheKey).then((cached) => cached ?? Response.error()));
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request, './index.html'));
    return;
  }

  // Same-origin scripts and styles are network-first so a redeploy reaches
  // returning visitors on their next load; the cache is only an offline fallback.
  event.respondWith(networkFirst(event.request));
});
