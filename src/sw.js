// Service Worker for BeamCam PWA
// Smart caching: offline-first for static assets, network-first for dynamic content
// Excludes: /peerjs/*, WebSocket connections

const CACHE_NAME = 'beamcam-v4';
const STATIC_CACHE = 'beamcam-static-v4';

// Assets to precache for offline functionality
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/script.js',
  '/style.css',
  // CDN fallbacks cached on first load
];

// Install event - precache static assets
self.addEventListener('install', (event) => {
  console.log('[SW] Installing service worker with offline support...');

  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        console.log('[SW] Precaching static assets');
        // Don't fail installation if precache fails (network might be down)
        return cache.addAll(STATIC_ASSETS).catch((err) => {
          console.warn('[SW] Precache failed (continuing anyway):', err);
        });
      })
      .then(() => self.skipWaiting())
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating service worker...');

  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== STATIC_CACHE && name !== CACHE_NAME)
            .map((name) => {
              console.log('[SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        );
      })
      .then(() => {
        console.log('[SW] Activation complete');
        return self.clients.claim();
      })
  );
});

// Fetch event - smart routing strategy
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // EXCLUSIONS: Don't intercept these

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip chrome extensions
  if (url.protocol === 'chrome-extension:') {
    return;
  }

  // CRITICAL: Skip PeerJS signaling server paths
  if (url.pathname.startsWith('/peerjs')) {
    console.log('[SW] Bypassing cache for PeerJS:', url.pathname);
    return;
  }

  // CRITICAL: Skip WebSocket upgrade requests
  if (request.headers.get('upgrade') === 'websocket') {
    console.log('[SW] Bypassing cache for WebSocket');
    return;
  }

  // Skip TURN/STUN server requests (port 3478)
  if (url.port === '3478') {
    return;
  }

  // CACHING STRATEGIES

  // Strategy 1: Cache-first for static assets (HTML, CSS, JS, fonts, images)
  if (
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.woff2') ||
    url.pathname.endsWith('.woff') ||
    url.pathname.endsWith('.ttf') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.ico') ||
    url.pathname === '/'
  ) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          console.log('[SW] Cache hit:', url.pathname);
          // Return cached version, but update in background
          fetch(request).then((networkResponse) => {
            if (networkResponse.ok) {
              caches.open(STATIC_CACHE).then((cache) => {
                cache.put(request, networkResponse.clone());
              });
            }
          }).catch(() => {
            // Network failed, cached version is still served
          });
          return cachedResponse;
        }

        // Not in cache, fetch from network
        console.log('[SW] Cache miss, fetching:', url.pathname);
        return fetch(request).then((response) => {
          if (response.ok) {
            const responseToCache = response.clone();
            caches.open(STATIC_CACHE).then((cache) => {
              cache.put(request, responseToCache);
            });
          }
          return response;
        });
      })
    );
    return;
  }

  // Strategy 2: Network-first for CDN resources (with cache fallback)
  if (url.hostname.includes('unpkg.com') || url.hostname.includes('cdn')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const responseToCache = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseToCache);
            });
          }
          return response;
        })
        .catch(() => {
          // Network failed, try cache
          return caches.match(request).then((cachedResponse) => {
            if (cachedResponse) {
              console.log('[SW] CDN offline fallback:', url.href);
              return cachedResponse;
            }
            throw new Error('Network and cache failed');
          });
        })
    );
    return;
  }

  // Strategy 3: Network-only for everything else (API calls, dynamic content)
  // No caching, no interception
});

// Handle messages from clients
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

console.log('[SW] Service Worker loaded - Smart caching with offline support');
