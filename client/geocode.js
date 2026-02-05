(() => {
  const DB_NAME = 'fxbg_city_manager';
  const DB_VERSION = 4;
  const STORE_NAME = 'geocache';
  const GAZETTEER_STORE = 'gazetteer';
  const INTERSECTIONS_STORE = 'intersections';
  const PRECISION_PLACES_STORE = 'precision_places_pack';
  const DATASET_KEY = 'default';
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

  const FALLBACK_INTERSECTIONS = {
    'caroline st & william st': { lat: 38.3026, lng: -77.4582, label: 'Caroline St & William St' },
    'caroline st & princess anne st': { lat: 38.3017, lng: -77.4590, label: 'Caroline St & Princess Anne St' },
    'william st & george st': { lat: 38.3040, lng: -77.4578, label: 'William St & George St' },
    'lafayette blvd & route 1': { lat: 38.2919, lng: -77.4530, label: 'Lafayette Blvd & Route 1' }
  };

  const FALLBACK_POI_ALIASES = {
    'city hall': { lat: 38.3032, lng: -77.4605, label: 'Fredericksburg City Hall' },
    'fredericksburg city hall': { lat: 38.3032, lng: -77.4605, label: 'Fredericksburg City Hall' },
    'mary washington hospital': { lat: 38.3092, lng: -77.4838, label: 'Mary Washington Hospital' },
    'vre station': { lat: 38.2995, lng: -77.4586, label: 'Fredericksburg VRE Station' },
    'fredericksburg vre station': { lat: 38.2995, lng: -77.4586, label: 'Fredericksburg VRE Station' },
    'downtown fredericksburg': { lat: 38.3029, lng: -77.4596, label: 'Downtown Fredericksburg' },
    'central park': { lat: 38.3002, lng: -77.4677, label: 'Central Park' }
  };

  const localDatasets = {
    gazetteer: { version: 1, items: [] },
    intersections: { version: 1, items: [] },
    precisionPlaces: { version: 1, items: [] }
  };

  function normalizeLocationText(text) {
    return String(text || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\b(near|at|around|by|the|in|on)\b/g, ' ')
      .replace(/[^a-z0-9&/@\-\s]/g, ' ')
      .replace(/\b(street)\b/g, 'st')
      .replace(/\b(st\.)\b/g, 'st')
      .replace(/\b(avenue)\b/g, 'ave')
      .replace(/\b(ave\.)\b/g, 'ave')
      .replace(/\b(boulevard)\b/g, 'blvd')
      .replace(/\b(blvd\.)\b/g, 'blvd')
      .replace(/\b(road)\b/g, 'rd')
      .replace(/\b(rd\.)\b/g, 'rd')
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
        if (!db.objectStoreNames.contains(GAZETTEER_STORE)) {
          db.createObjectStore(GAZETTEER_STORE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(INTERSECTIONS_STORE)) {
          db.createObjectStore(INTERSECTIONS_STORE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(PRECISION_PLACES_STORE)) {
          db.createObjectStore(PRECISION_PLACES_STORE, { keyPath: 'key' });
        }
      };
    });
  }

  async function loadDatasetFromIDB(storeName) {
    try {
      const db = await openDb();
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(DATASET_KEY);
      const row = await new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      return row?.value || null;
    } catch {
      return null;
    }
  }

  async function saveDatasetToIDB(storeName, value) {
    try {
      const db = await openDb();
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put({ key: DATASET_KEY, value, timestamp: Date.now() });
    } catch {
      // noop
    }
  }

  async function fetchJsonWithTimeout(url, timeoutMs = 2500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function sanitizeDataset(payload) {
    const source = payload && payload.data && Array.isArray(payload.data.items) ? payload.data : payload;
    return {
      version: Number(source?.version) || 1,
      items: Array.isArray(source?.items) ? source.items : []
    };
  }

  async function warmDataset(kind, endpoint, storeName) {
    const remote = await fetchJsonWithTimeout(endpoint);
    if (remote) {
      const normalized = sanitizeDataset(remote);
      localDatasets[kind] = normalized;
      await saveDatasetToIDB(storeName, normalized);
      return;
    }
    const cached = await loadDatasetFromIDB(storeName);
    localDatasets[kind] = cached ? sanitizeDataset(cached) : { version: 1, items: [] };
  }

  async function hydrateGeoDatasets() {
    await Promise.all([
      warmDataset('gazetteer', '/api/geo/gazetteer', GAZETTEER_STORE),
      warmDataset('intersections', '/api/geo/intersections', INTERSECTIONS_STORE),
      warmDataset('precisionPlaces', '/api/places/downtown-centralpark', PRECISION_PLACES_STORE)
    ]);
  }

  async function getGazetteer() {
    if (!Array.isArray(localDatasets.gazetteer.items) || localDatasets.gazetteer.items.length === 0) {
      const cached = await loadDatasetFromIDB(GAZETTEER_STORE);
      if (cached) localDatasets.gazetteer = sanitizeDataset(cached);
    }
    return localDatasets.gazetteer;
  }

  async function getIntersections() {
    if (!Array.isArray(localDatasets.intersections.items) || localDatasets.intersections.items.length === 0) {
      const cached = await loadDatasetFromIDB(INTERSECTIONS_STORE);
      if (cached) localDatasets.intersections = sanitizeDataset(cached);
    }
    return localDatasets.intersections;
  }

  async function getPrecisionPlaces() {
    if (!Array.isArray(localDatasets.precisionPlaces.items) || localDatasets.precisionPlaces.items.length === 0) {
      const cached = await loadDatasetFromIDB(PRECISION_PLACES_STORE);
      if (cached) localDatasets.precisionPlaces = sanitizeDataset(cached);
    }
    return localDatasets.precisionPlaces;
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

  function intersectionItemKey(item) {
    const a = normalizeLocationText(item?.a || '');
    const b = normalizeLocationText(item?.b || '');
    if (!a || !b) return null;
    return [a, b].sort().join(' & ');
  }

  function findGazetteerHit(normalizedQuery, items) {
    for (const item of items || []) {
      if (!Number.isFinite(Number(item?.lat)) || !Number.isFinite(Number(item?.lng))) continue;
      const name = normalizeLocationText(item?.name || '');
      if (name && (normalizedQuery.includes(name) || name.includes(normalizedQuery))) {
        return { lat: Number(item.lat), lng: Number(item.lng), label: item.name || normalizedQuery };
      }
      const aliases = Array.isArray(item?.aliases) ? item.aliases : [];
      for (const alias of aliases) {
        const normAlias = normalizeLocationText(alias);
        if (!normAlias) continue;
        if (normalizedQuery.includes(normAlias) || normAlias.includes(normalizedQuery)) {
          return { lat: Number(item.lat), lng: Number(item.lng), label: item.name || alias || normalizedQuery };
        }
      }
    }
    return null;
  }

  function findIntersectionHit(key, items) {
    for (const item of items || []) {
      if (!Number.isFinite(Number(item?.lat)) || !Number.isFinite(Number(item?.lng))) continue;
      const itemKey = intersectionItemKey(item);
      if (itemKey && itemKey === key) {
        return {
          lat: Number(item.lat),
          lng: Number(item.lng),
          label: `${item.a} & ${item.b}`
        };
      }
    }
    return null;
  }

  function precisionIntersectionKey(item) {
    const explicit = parseIntersection(item?.name || '');
    if (explicit) return explicit;
    if (item?.a && item?.b) {
      return [normalizeLocationText(item.a), normalizeLocationText(item.b)].sort().join(' & ');
    }
    return null;
  }

  function findPrecisionPlacesHit(normalizedQuery, items) {
    const queryIntersection = parseIntersection(normalizedQuery);
    for (const item of items || []) {
      const values = [item?.name, item?.address, ...(Array.isArray(item?.aliases) ? item.aliases : [])]
        .map((v) => normalizeLocationText(v))
        .filter(Boolean);
      const matchedText = values.some((value) => normalizedQuery.includes(value) || value.includes(normalizedQuery));
      const matchedIntersection = queryIntersection && precisionIntersectionKey(item) === queryIntersection;
      if (!matchedText && !matchedIntersection) continue;
      if (!Number.isFinite(Number(item?.lat)) || !Number.isFinite(Number(item?.lng))) continue;
      return {
        lat: Number(item.lat),
        lng: Number(item.lng),
        label: item.name || item.address || normalizedQuery
      };
    }
    return null;
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

    const gazetteer = await getGazetteer();
    const intersections = await getIntersections();
    const precisionPlaces = await getPrecisionPlaces();
    let best = buildResult({ lat: fallbackCenter.lat, lng: fallbackCenter.lng, confidence: 10, method: 'fallback_center', label: cityHint || 'Default center', normalizedQuery });

    const precisionHit = findPrecisionPlacesHit(normalizedQuery, precisionPlaces.items);
    if (precisionHit) {
      best = buildResult({
        lat: precisionHit.lat,
        lng: precisionHit.lng,
        confidence: 99,
        method: 'precision_places_pack',
        label: precisionHit.label,
        normalizedQuery
      });
      await writeCache(best);
      return best;
    }

    const address = parseAddress(normalizedQuery);
    if (address) {
      const localStreet = Object.entries(STREET_CENTERLINES).find(([name]) => address.streetName.includes(name));
      if (localStreet) {
        const base = localStreet[1];
        const jitter = (Number(address.houseNumber) % 20) * 0.00005;
        best = buildResult({ lat: base.lat + jitter, lng: base.lng, confidence: 95, method: 'address_exact', label: `${address.houseNumber} ${localStreet[0]}`, normalizedQuery });
      }
    }

    if (best.confidence < 90) {
      const intersectionKey = intersectionLookupKey(normalizedQuery);
      if (intersectionKey) {
        const fromDataset = findIntersectionHit(intersectionKey, intersections.items);
        const hit = fromDataset || FALLBACK_INTERSECTIONS[intersectionKey];
        if (hit) {
          best = buildResult({ lat: hit.lat, lng: hit.lng, confidence: 90, method: 'intersection', label: hit.label || intersectionKey, normalizedQuery });
        }
      }
    }

    if (best.confidence < 85) {
      const hit = findGazetteerHit(normalizedQuery, gazetteer.items);
      if (hit) {
        best = buildResult({ lat: hit.lat, lng: hit.lng, confidence: 85, method: 'gazetteer', label: hit.label, normalizedQuery });
      } else {
        const poiEntry = Object.entries(FALLBACK_POI_ALIASES).find(([alias]) => normalizedQuery.includes(alias));
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

  hydrateGeoDatasets();

  window.FXBGGeocode = {
    normalizeLocationText,
    resolveLocation,
    getGazetteer,
    getIntersections,
    getPrecisionPlaces,
    addPlaceAnchor(input = {}) {
      const slug = String(input.name || 'new-anchor')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') || 'new-anchor';
      const snippet = {
        id: slug,
        name: input.name || 'New Anchor',
        type: input.type || 'poi',
        address: input.address || '',
        lat: Number.isFinite(Number(input.lat)) ? Number(input.lat) : null,
        lng: Number.isFinite(Number(input.lng)) ? Number(input.lng) : null,
        aliases: Array.isArray(input.aliases) ? input.aliases : [],
        tags: Array.isArray(input.tags) ? input.tags : []
      };
      console.log(JSON.stringify(snippet, null, 2));
      return snippet;
    }
  };
})();
