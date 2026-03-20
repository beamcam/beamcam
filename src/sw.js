// Service Worker for BeamCam PWA
// Network-first strategy - always fetch latest version

const CACHE_NAME = 'beamcam-v1';

// Install event - activate immediately without caching
self.addEventListener('install', (event) => {
  console.log('[SW] Installing service worker (no precache)...');
  event.waitUntil(self.skipWaiting());
});

// Activate event - clean up all caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating service worker...');

  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            console.log('[SW] Deleting cache:', cacheName);
            return caches.delete(cacheName);
          })
        );
      })
      .then(() => {
        console.log('[SW] Activation complete - all caches cleared');
        return self.clients.claim();
      })
  );
});

// Fetch event - always network first, no caching
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip chrome extensions
  if (url.protocol === 'chrome-extension:') {
    return;
  }

  // Always fetch from network - no caching
  event.respondWith(
    fetch(request, {
      cache: 'no-store'
    }).catch((error) => {
      console.error('[SW] Fetch failed:', error);
      throw error;
    })
  );
});

// Handle messages from clients
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Log service worker version
console.log('[SW] Service Worker loaded - No caching strategy (network-first always)');
