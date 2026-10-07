const CACHE_NAME = 'qr-generator-offline-v5';
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './icon.svg'
];

// 1. Install: Pre-cache static shell and activate immediately
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      for (const url of PRECACHE_ASSETS) {
        try {
          await cache.add(url);
        } catch (e) {
          console.warn('Pre-cache skip:', url, e);
        }
      }
    })
  );
});

// 2. Activate: Clean up old versions and claim all open clients immediately
self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then(keys =>
        Promise.all(
          keys
            .filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
        )
      )
    ])
  );
});

// 3. Fetch: Cache-First with Dynamic Network Caching & Offline Fallback
self.addEventListener('fetch', event => {
  const request = event.request;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Only handle HTTP/HTTPS schemes
  if (!request.url.startsWith('http://') && !request.url.startsWith('https://')) return;

  event.respondWith(
    caches.match(request).then(cachedResponse => {
      // Background network fetch to keep cache up to date
      const networkFetch = fetch(request)
        .then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(request, copy);
            });
          }
          return networkResponse;
        })
        .catch(err => {
          // If offline and request is an HTML page navigation, return index.html
          if (request.mode === 'navigate') {
            return caches.match('./index.html') || caches.match('./');
          }
          // If already have cached response, don't throw
          if (cachedResponse) return cachedResponse;
          throw err;
        });

      // If cached response exists, return it immediately for instant offline load!
      // Otherwise wait for network fetch
      return cachedResponse || networkFetch;
    })
  );
});
