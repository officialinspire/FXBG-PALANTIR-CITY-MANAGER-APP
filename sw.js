const CACHE_VERSION = 'fxbg-v1';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const API_CACHE = `${CACHE_VERSION}-api`;
const API_CACHE_MAX_ENTRIES = 100;

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/index.js',
  '/styles.css',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/client/idb.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(PRECACHE_URLS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => ![SHELL_CACHE, API_CACHE].includes(key))
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) return;

  if (isShellRequest(url)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  if (isApiRequest(url)) {
    event.respondWith(staleWhileRevalidate(event.request));
  }
});

function isShellRequest(url) {
  return (
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/index.js' ||
    url.pathname === '/styles.css' ||
    url.pathname === '/favicon.svg' ||
    url.pathname === '/manifest.webmanifest' ||
    url.pathname === '/client/idb.js'
  );
}

function isApiRequest(url) {
  if (url.pathname === '/proxy') return false;
  if (!url.pathname.startsWith('/api/')) return false;
  return true;
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const network = await fetch(request);
  if (network.ok) {
    cache.put(request, network.clone());
  }
  return network;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then(async (response) => {
      if (response.ok) {
        await cache.put(request, response.clone());
        await trimCache(cache, API_CACHE_MAX_ENTRIES);
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    return cached;
  }

  const network = await networkPromise;
  if (network) return network;

  return new Response(JSON.stringify({ error: 'offline', message: 'No cached data available.' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;

  const dated = await Promise.all(keys.map(async (request) => {
    const response = await cache.match(request);
    const dateHeader = response?.headers?.get('date');
    const ts = dateHeader ? Date.parse(dateHeader) : 0;
    return { request, ts: Number.isFinite(ts) ? ts : 0 };
  }));

  dated.sort((a, b) => a.ts - b.ts);

  const deleteCount = dated.length - maxEntries;
  for (let i = 0; i < deleteCount; i += 1) {
    await cache.delete(dated[i].request);
  }
}

