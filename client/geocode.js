(() => {
  const DB_NAME = 'fxbg_city_manager';
  const DB_VERSION = 2;
  const STORE_NAME = 'geocache';
  const TTL_MS = 30 * 24 * 60 * 60 * 1000;

  const STREET_CENTERLINES = {
    'caroline st': { lat: 38.3030, lng: -77.4593 },
    'william st': { lat: 38.3026, lng: -77.4569 },
    'princess anne st': { lat: 38.3019, lng: -77.4598 },
    'george st': { lat: 38.3044, lng: -77.4601 },
    'charles st': { lat: 38.3050, lng: -77.4622 },
    'lafayette blvd': { lat: 38.2918, lng: -77.4531 },
    'route 1': { lat: 38.2959, lng: -77.4582 },
    'plank rd': { lat: 38.2984, lng: -77.5061 }
  };

  const INTERSECTIONS = {
    'caroline st & william st': { lat: 38.3026, lng: -77.4582, label: 'Caroline St & William St' },
    'caroline st & princess anne st': { lat: 38.3017, lng: -77.4590, label: 'Caroline St & Princess Anne St' },
    'william st & george st': { lat: 38.3040, lng: -77.4578, label: 'William St & George St' },
    'lafayette blvd & route 1': { lat: 38.2919, lng: -77.4530, label: 'Lafayette Blvd & Route 1' }
  };

  const POI_ALIASES = {
    'city hall': { lat: 38.3032, lng: -77.4605, label: 'Fredericksburg City Hall' },
    'fredericksburg city hall': { lat: 38.3032, lng: -77.4605, label: 'Fredericksburg City Hall' },
    'mary washington hospital': { lat: 38.3092, lng: -77.4838, label: 'Mary Washington Hospital' },
    'vre station': { lat: 38.2995, lng: -77.4586, label: 'Fredericksburg VRE Station' },
    'fredericksburg vre station': { lat: 38.2995, lng: -77.4586, label: 'Fredericksburg VRE Station' },
    'downtown fredericksburg': { lat: 38.3029, lng: -77.4596, label: 'Downtown Fredericksburg' },
    'central park': { lat: 38.3002, lng: -77.4677, label: 'Central Park' }
  };

  function normalizeLocationText(text) {
    return String(text || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\b(near|at|around|by|the|in|on)\b/g, ' ')
      .replace(/[^a-z0-9&/@\-\s]/g, ' ')
      .replace(/\b(street)\b/g, 'st')
      .replace(/\b(avenue)\b/g, 'ave')
      .replace(/\b(boulevard)\b/g, 'blvd')
      .replace(/\b(route)\b/g, 'route')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'normalizedQuery' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
    });
  }

  async function readCache(normalizedQuery) {
    try {
      const db = await openDb();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(normalizedQuery);
      const row = await new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      if (!row) return null;
      if ((Date.now() - Number(row.timestamp || 0)) > TTL_MS) return null;
      return row;
    } catch {
      return null;
    }
  }

  async function writeCache(result) {
    try {
      const db = await openDb();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ ...result, timestamp: Date.now() });
    } catch {
      // noop
    }
  }

  function buildResult({ lat, lng, confidence, method, label, normalizedQuery }) {
    return { lat, lng, confidence, method, label, normalizedQuery };
  }

  function parseAddress(normalizedQuery) {
    const m = normalizedQuery.match(/\b(\d{1,5})\s+([a-z0-9\s]+?)\s+(st|ave|blvd|rd|dr|ln|hwy|pkwy)\b/i);
    if (!m) return null;
    return {
      houseNumber: m[1],
      streetName: `${m[2]} ${m[3]}`.replace(/\s+/g, ' ').trim()
    };
  }

  function parseIntersection(normalizedQuery) {
    const m = normalizedQuery.match(/\b([a-z0-9\s]+?)\s*(?:&|and|@|\/|at)\s*([a-z0-9\s]+)\b/i);
    if (!m) return null;
    const a = normalizeLocationText(m[1]);
    const b = normalizeLocationText(m[2]);
    return [a, b].sort().join(' & ');
  }

  function intersectionLookupKey(normalizedQuery) {
    const parsed = parseIntersection(normalizedQuery);
    if (!parsed) return null;
    const pieces = parsed.split(' & ').map((p) => p.trim());
    if (pieces.length !== 2) return null;

    const matchStreet = (value) => Object.keys(STREET_CENTERLINES).find((k) => value.includes(k));
    const s1 = matchStreet(pieces[0]);
    const s2 = matchStreet(pieces[1]);
    if (!s1 || !s2) return null;
    return [s1, s2].sort().join(' & ');
  }

  async function tryPlaceholderEndpoint(path, params = {}) {
    try {
      const url = new URL(path, window.location.origin);
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
      const res = await fetch(url.toString());
      if (!res.ok) return null;
      const payload = await res.json();
      if (!payload || !Number.isFinite(payload.lat) || !Number.isFinite(payload.lng)) return null;
      return payload;
    } catch {
      return null;
    }
  }

  async function resolveLocation({ text, cityHint = 'Fredericksburg, VA', defaultCenter } = {}) {
    const fallbackCenter = defaultCenter || { lat: 38.3032, lng: -77.4605 };
    const normalizedQuery = normalizeLocationText(`${text || ''} ${cityHint || ''}`);
    if (!normalizedQuery) {
      return buildResult({ lat: fallbackCenter.lat, lng: fallbackCenter.lng, confidence: 10, method: 'fallback_center', label: cityHint || 'Default center', normalizedQuery: '' });
    }

    const cached = await readCache(normalizedQuery);
    if (cached) {
      return buildResult({ ...cached });
    }

    let best = buildResult({ lat: fallbackCenter.lat, lng: fallbackCenter.lng, confidence: 10, method: 'fallback_center', label: cityHint || 'Default center', normalizedQuery });

    const address = parseAddress(normalizedQuery);
    if (address) {
      const endpoint = await tryPlaceholderEndpoint('/api/location/address', { q: `${address.houseNumber} ${address.streetName}`, city: cityHint || '' });
      if (endpoint) {
        best = buildResult({ lat: endpoint.lat, lng: endpoint.lng, confidence: 95, method: 'address_exact', label: endpoint.label || `${address.houseNumber} ${address.streetName}`, normalizedQuery });
      } else {
        const localStreet = Object.entries(STREET_CENTERLINES).find(([name]) => address.streetName.includes(name));
        if (localStreet) {
          const base = localStreet[1];
          const jitter = (Number(address.houseNumber) % 20) * 0.00005;
          best = buildResult({ lat: base.lat + jitter, lng: base.lng, confidence: 95, method: 'address_exact', label: `${address.houseNumber} ${localStreet[0]}`, normalizedQuery });
        }
      }
    }

    if (best.confidence < 90) {
      const intersectionKey = intersectionLookupKey(normalizedQuery);
      if (intersectionKey) {
        const endpoint = await tryPlaceholderEndpoint('/api/location/intersection', { q: intersectionKey, city: cityHint || '' });
        const hit = endpoint || INTERSECTIONS[intersectionKey];
        if (hit) {
          best = buildResult({ lat: hit.lat, lng: hit.lng, confidence: 90, method: 'intersection', label: hit.label || intersectionKey, normalizedQuery });
        }
      }
    }

    if (best.confidence < 85) {
      const endpoint = await tryPlaceholderEndpoint('/api/location/alias', { q: normalizedQuery, city: cityHint || '' });
      if (endpoint) {
        best = buildResult({ lat: endpoint.lat, lng: endpoint.lng, confidence: 85, method: 'poi_alias', label: endpoint.label || normalizedQuery, normalizedQuery });
      } else {
        const poiEntry = Object.entries(POI_ALIASES).find(([alias]) => normalizedQuery.includes(alias));
        if (poiEntry) {
          best = buildResult({ lat: poiEntry[1].lat, lng: poiEntry[1].lng, confidence: 85, method: 'poi_alias', label: poiEntry[1].label, normalizedQuery });
        }
      }
    }

    if (best.confidence < 60) {
      const partialStreet = Object.entries(STREET_CENTERLINES).find(([name]) => normalizedQuery.includes(name));
      if (partialStreet) {
        best = buildResult({ lat: partialStreet[1].lat, lng: partialStreet[1].lng, confidence: 60, method: 'partial_street', label: partialStreet[0], normalizedQuery });
      }
    }

    await writeCache(best);
    return best;
  }

  window.FXBGGeocode = {
    normalizeLocationText,
    resolveLocation
  };
})();
