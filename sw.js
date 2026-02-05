const CACHE_VERSION = 'fxbg-v1';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const API_CACHE = `${CACHE_VERSION}-api`;
const TILE_CACHE = `${CACHE_VERSION}-tiles`;
const API_CACHE_MAX_ENTRIES = 100;
const TILE_CACHE_MAX_ENTRIES = 2000;

const tileRuntimeSettings = {
  enabled: true,
  activeProvider: 'carto'
};

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
        .filter((key) => ![SHELL_CACHE, API_CACHE, TILE_CACHE].includes(key))
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (event.data?.type === 'OFFLINE_TILE_SETTINGS') {
    tileRuntimeSettings.enabled = event.data.enabled !== false;
    tileRuntimeSettings.activeProvider = event.data.activeProvider === 'esri' ? 'esri' : 'carto';
    return;
  }

  if (event.data?.type === 'TILE_CACHE_STATS') {
    event.waitUntil((async () => {
      const cache = await caches.open(TILE_CACHE);
      const keys = await cache.keys();
      const count = keys.length;
      const approxMB = Number(((count * 60) / 1024).toFixed(1));
      event.source?.postMessage({ type: 'TILE_CACHE_STATS', count, approxMB });
    })());
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  if (isTileRequest(url)) {
    event.respondWith(handleTileRequest(event.request, url));
    return;
  }

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

function isTileRequest(url) {
  return isCartoTile(url) || isEsriTile(url);
}

function isCartoTile(url) {
  return /^(a|b|c|d)\.basemaps\.cartocdn\.com$/i.test(url.hostname)
    && /^\/dark_all\/\d+\/\d+\/\d+(@2x)?\.png$/i.test(url.pathname);
}

function isEsriTile(url) {
  return url.hostname === 'server.arcgisonline.com'
    && /^\/ArcGIS\/rest\/services\/Canvas\/World_Dark_Gray_(Base|Reference)\/MapServer\/tile\/\d+\/\d+\/\d+$/i.test(url.pathname);
}

function tileMatchesActiveProvider(url) {
  if (tileRuntimeSettings.activeProvider === 'esri') {
    return isEsriTile(url);
  }
  return isCartoTile(url);
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

async function handleTileRequest(request, url) {
  if (!tileRuntimeSettings.enabled || !tileMatchesActiveProvider(url)) {
    try {
      return await fetch(request);
    } catch {
      return createOfflineTileResponse();
    }
  }

  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);

  if (cached) {
    await cache.put(request, cached.clone());
    return cached;
  }

  try {
    const network = await fetch(request);
    if (network.ok) {
      await cache.put(request, network.clone());
      await trimTileCache(cache, TILE_CACHE_MAX_ENTRIES);
    }
    return network;
  } catch {
    return createOfflineTileResponse();
  }
}

async function trimTileCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const deleteCount = keys.length - maxEntries;
  for (let i = 0; i < deleteCount; i += 1) {
    await cache.delete(keys[i]);
  }
}

function createOfflineTileResponse() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" fill="#121a2f"/><g fill="#9db1d0" font-family="system-ui,sans-serif" text-anchor="middle"><text x="128" y="118" font-size="13">Offline tile</text><text x="128" y="138" font-size="12">not cached</text></g></svg>`;
  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-store'
    }
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
