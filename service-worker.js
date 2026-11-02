const CACHE_NAME = 'daymark-shell-v3';
const VENDOR_CACHE_NAME = 'daymark-vendor-v1';
const APP_ROOT = new URL('./', self.registration.scope);
const VENDOR_SCRIPTS = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/lucide@0.577.0/dist/umd/lucide.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.tailwindcss.com/3.4.17'
];

self.addEventListener('install', event => {
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_NAME).then(cache => cache.add(APP_ROOT.href)),
      caches.open(VENDOR_CACHE_NAME).then(async cache => {
        const results = await Promise.allSettled(VENDOR_SCRIPTS.map(async url => {
          const request = new Request(url, { mode: 'cors' });
          const response = await fetch(request);
          if (!response.ok) throw new Error(`Could not cache offline script: ${url}`);
          await cache.put(request, response);
        }));
        results.forEach(result => {
          if (result.status === 'rejected') console.error('Offline script cache failed:', result.reason);
        });
      })
    ])
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => (key.startsWith('daymark-shell-') && key !== CACHE_NAME) ||
          (key.startsWith('daymark-vendor-') && key !== VENDOR_CACHE_NAME))
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  const isVendorScript = request.destination === 'script' &&
    (url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'cdn.tailwindcss.com');
  if (request.method !== 'GET' || (url.origin !== self.location.origin && !isVendorScript)) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(isVendorScript ? VENDOR_CACHE_NAME : CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = isVendorScript
        ? await caches.match(request, { cacheName: VENDOR_CACHE_NAME })
        : await caches.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const appShell = await caches.match(APP_ROOT.href);
        if (appShell) return appShell;
      }
      throw error;
    }
  })());
});
