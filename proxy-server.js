/**
 * CITY MANAGER — Single-command local server (CommonJS)
 * ✅ Serves static frontend (index.html, styles.css, index.js, assets)
 * ✅ Proxies ALL external requests via /proxy?url=...
 * ✅ Adds CORS headers (so browser never blocks)
 * ✅ Caches + dedupes requests to avoid upstream 429 rate limits
 *
 * Run:
 *   node proxy-server.js
 * Then open:
 *   http://localhost:8000
 */

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { Writable } = require("stream");
const crypto = require("crypto");
const dotenv = require("dotenv");
const repoEnvPath = path.join(__dirname, ".env");
const overrideEnvPath = process.env.ENV_PATH ? path.resolve(process.env.ENV_PATH) : null;
let loadedEnvPath = null;

function loadEnvFile(envPath) {
  if (!envPath) return false;
  if (!fs.existsSync(envPath)) return false;
  dotenv.config({ path: envPath });
  if (!loadedEnvPath) {
    loadedEnvPath = envPath;
  }
  return true;
}

if (overrideEnvPath) {
  loadEnvFile(overrideEnvPath);
}
loadEnvFile(repoEnvPath);
const { upstreamFetch } = require("./server/upstreamFetch");
const { createCache } = require("./server/cache");

// -----------------------------
// Environment & Logging Setup
// -----------------------------
const REQUIRED_ENV = [];

const DEFAULT_LOG_DIR = "logs";

function buildEnvStatus() {
  const keysPresent = {
    OPENUV_API_KEY: Boolean(OPENUV_API_KEY && String(OPENUV_API_KEY).trim()),
    WAQI_TOKEN: Boolean(WAQI_TOKEN && String(WAQI_TOKEN).trim())
  };

  const warnings = [];
  const placeholderPattern = /(your-|changeme|replace|example|placeholder)/i;

  [
    { name: "OPENUV_API_KEY", value: OPENUV_API_KEY },
    { name: "WAQI_TOKEN", value: WAQI_TOKEN }
  ].forEach(({ name, value }) => {
    const trimmed = String(value || "").trim();
    if (!trimmed) {
      warnings.push(`${name} is empty.`);
      return;
    }
    if (placeholderPattern.test(trimmed)) {
      warnings.push(`${name} looks like a placeholder value.`);
    }
  });

  return {
    ok: true,
    loadedEnvPath: loadedEnvPath || null,
    keysPresent,
    warnings
  };
}

function validateConfig() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    const message = `Missing required environment variables: ${missing.join(", ")}. Set them in .env or export them before starting.`;
    console.error(`[config] ${message}`);
    process.exit(1);
  }

  if (!process.env.LOG_DIR || !String(process.env.LOG_DIR).trim()) {
    process.env.LOG_DIR = DEFAULT_LOG_DIR;
    console.warn(`[config] LOG_DIR not set. Defaulting to \"${DEFAULT_LOG_DIR}\".`);
  }

  // PORT is optional, default to 8000
  const port = Number(process.env.PORT) || 8000;
  if (!Number.isFinite(port) || port <= 0) {
    console.error(`[config] Invalid PORT value. Using default 8000.`);
    return 8000;
  }
  return port;
}

const PORT = validateConfig();
let LOG_DIR = path.resolve(__dirname, process.env.LOG_DIR || DEFAULT_LOG_DIR);

function createNoopStream(name) {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
}

function ensureLogDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    return LOG_DIR;
  } catch (err) {
    const fallbackDir = path.join(os.tmpdir(), "fxbg-palantir-logs");
    console.warn(`[logs] Failed to ensure log directory \"${LOG_DIR}\": ${err.message}`);
    console.warn(`[logs] Falling back to temporary log directory: ${fallbackDir}`);

    try {
      fs.mkdirSync(fallbackDir, { recursive: true });
      LOG_DIR = fallbackDir;
      process.env.LOG_DIR = fallbackDir;
      return LOG_DIR;
    } catch (fallbackErr) {
      console.warn(`[logs] Failed to ensure fallback log directory \"${fallbackDir}\": ${fallbackErr.message}`);
      return null;
    }
  }
}

const resolvedLogDir = ensureLogDir();
const APP_LOG_PATH = resolvedLogDir ? path.join(resolvedLogDir, "app.log") : null;
const UPSTREAM_LOG_PATH = resolvedLogDir ? path.join(resolvedLogDir, "upstreams.log") : null;

function createSafeLogStream(logPath, label) {
  if (!logPath) {
    console.warn(`[logs] ${label} disabled (no writable log directory).`);
    return createNoopStream(label);
  }

  try {
    const stream = fs.createWriteStream(logPath, { flags: "a" });
    stream.on("error", (err) => {
      console.warn(`[logs] ${label} stream error (${logPath}): ${err.message}. Falling back to console-only logging.`);
    });
    return stream;
  } catch (err) {
    console.warn(`[logs] Failed to create ${label} stream (${logPath}): ${err.message}. Falling back to console-only logging.`);
    return createNoopStream(label);
  }
}

const appLogStream = createSafeLogStream(APP_LOG_PATH, "app log");
const upstreamLogStream = createSafeLogStream(UPSTREAM_LOG_PATH, "upstream log");

function writeLog(stream, payload) {
  const entry = {
    ts: new Date().toISOString(),
    ...payload
  };
  try {
    stream.write(`${JSON.stringify(entry)}${os.EOL}`);
  } catch (err) {
    console.warn("[logs] Failed to write log:", err.message);
  }
}

function logApp(payload) {
  writeLog(appLogStream, payload);
}

function logUpstream(payload) {
  writeLog(upstreamLogStream, payload);
}

function logOfflinePack(message, extra = {}) {
  logUpstream({
    level: "INFO",
    kind: "offline-pack",
    msg: `[offline-pack] ${message}`,
    ...extra
  });
}

const offlinePrefetchState = {
  running: false,
  currentKey: null,
  done: 0,
  total: 0,
  errors: [],
  startedAt: null,
  lastUpdatedAt: null
};

function redactUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const params = url.searchParams;
    const sensitiveKeys = ["token", "apikey", "api_key", "key", "access_token"];
    sensitiveKeys.forEach((key) => {
      if (params.has(key)) {
        params.set(key, "REDACTED");
      }
    });
    url.search = params.toString();
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function requestLogUrl(urlObj) {
  if (urlObj.pathname === "/proxy") {
    const target = urlObj.searchParams.get("url");
    return target ? redactUrl(target) : "/proxy";
  }
  return urlObj.pathname;
}

function matchStringField(block, fieldName) {
  const regex = new RegExp(`${fieldName}\\s*:\\s*"([^"]+)"`);
  const match = block.match(regex);
  return match ? match[1] : null;
}

function parseRssFeedEntry(entry) {
  const key = matchStringField(entry, "id") || matchStringField(entry, "key");
  const name = matchStringField(entry, "name");
  const url = matchStringField(entry, "url");
  const category = matchStringField(entry, "category");
  const enabledMatch = entry.match(/enabledByDefault\\s*:\\s*(true|false)/);
  const enabledByDefault = enabledMatch ? enabledMatch[1] === "true" : true;

  if (!url) return null;

  return {
    key: key || url,
    name: name || key || url,
    url,
    category: category || null,
    enabledByDefault
  };
}

function extractRssFeedRegistry(content) {
  const rssIndex = content.indexOf("rss: [");
  if (rssIndex === -1) return [];

  const arrayStart = content.indexOf("[", rssIndex);
  if (arrayStart === -1) return [];

  let depth = 0;
  let arrayEnd = -1;
  for (let i = arrayStart; i < content.length; i += 1) {
    const char = content[i];
    if (char === "[") depth += 1;
    if (char === "]") depth -= 1;
    if (depth === 0) {
      arrayEnd = i;
      break;
    }
  }

  if (arrayEnd === -1) return [];

  const rssBlock = content.slice(arrayStart + 1, arrayEnd);
  const feeds = [];
  const seen = new Set();
  let entryStart = -1;
  let braceDepth = 0;

  for (let i = 0; i < rssBlock.length; i += 1) {
    const char = rssBlock[i];
    if (char === "{") {
      if (braceDepth === 0) {
        entryStart = i;
      }
      braceDepth += 1;
    } else if (char === "}") {
      braceDepth -= 1;
      if (braceDepth === 0 && entryStart !== -1) {
        const entry = rssBlock.slice(entryStart, i + 1);
        const feed = parseRssFeedEntry(entry);
        if (feed && !seen.has(feed.url)) {
          feeds.push(feed);
          seen.add(feed.url);
        }
        entryStart = -1;
      }
    }
  }

  return feeds;
}

async function loadRssFeedRegistry() {
  const configPath = path.join(__dirname, "index.js");
  try {
    const content = await fsp.readFile(configPath, "utf8");
    return extractRssFeedRegistry(content);
  } catch (error) {
    console.warn(`[feeds] Failed to read RSS registry from index.js: ${error.message}`);
    return [];
  }
}

function toCacheMeta(cache, ttlMs) {
  if (!cache) return null;
  return {
    hit: Boolean(cache.hit),
    stale: Boolean(cache.stale),
    ageSec: Math.floor((cache.ageMs || 0) / 1000),
    ttlSec: Math.floor((ttlMs || 0) / 1000)
  };
}

function getClientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function logProxyOutcome({ url, status, cacheState, upstreamHost, elapsedMs, error }) {
  const safeUrl = redactUrl(url);
  logUpstream({
    level: "INFO",
    kind: "proxy",
    msg: "proxy_fetch",
    url: safeUrl,
    status,
    ms: elapsedMs,
    errorCode: error || undefined,
    cacheState,
    contentType: undefined,
    bytes: undefined
  });
}

function safeJsonParse(raw, fallback = null, context = "json") {
  if (raw === null || raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    logApp({
      level: "WARN",
      kind: "parse_failure",
      msg: `Failed to parse ${context}`,
      errorCode: err.message
    });
    return fallback;
  }
}

const PAYLOAD_LIMITS = {
  json: 2 * 1024 * 1024,
  text: 3 * 1024 * 1024,
  image: 5 * 1024 * 1024,
  binary: 5 * 1024 * 1024
};
const MAX_LAYER_BYTES = Number(process.env.MAX_LAYER_BYTES) || 25 * 1024 * 1024;
const MAX_OFFLINE_SNAPSHOT_FEATURES = Number(process.env.MAX_OFFLINE_SNAPSHOT_FEATURES) || 250000;
const MAX_OFFLINE_SNAPSHOT_MB = Number(process.env.MAX_OFFLINE_SNAPSHOT_MB) || 200;
const OFFLINE_PREFETCH_DELAY_MS = Number(process.env.OFFLINE_PREFETCH_DELAY_MS) || 500;
const OFFLINE_AOI_BOUNDS = {
  fxbg: [-77.55, 38.26, -77.41, 38.35],
  spotsy: [-77.72, 38.07, -77.32, 38.42]
};

class UpstreamError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function inferExpectedType(acceptHeader) {
  const accept = String(acceptHeader || "").toLowerCase();
  if (!accept || accept === "*/*") return null;
  if (accept.includes("application/json") || accept.includes("+json") || accept.includes("geojson")) {
    return "json";
  }
  if (accept.includes("text/html")) {
    return "html";
  }
  if (accept.includes("text/plain") || accept.includes("text/")) {
    return "text";
  }
  if (accept.includes("image/")) {
    return "image";
  }
  return null;
}

function resolvePayloadLimit(contentType, expectedType) {
  if (expectedType && PAYLOAD_LIMITS[expectedType]) return PAYLOAD_LIMITS[expectedType];
  const ct = String(contentType || "").toLowerCase();
  if (ct.startsWith("image/")) return PAYLOAD_LIMITS.image;
  if (ct.includes("json")) return PAYLOAD_LIMITS.json;
  if (ct.startsWith("text/") || ct.includes("xml")) return PAYLOAD_LIMITS.text;
  return PAYLOAD_LIMITS.binary;
}

function isLayerDownloadRequest(targetUrl, acceptHeader) {
  if (!targetUrl) return false;
  const accept = String(acceptHeader || "").toLowerCase();
  if (!accept.includes("geojson") && !accept.includes("application/json")) return false;
  try {
    const urlObj = new URL(targetUrl);
    const pathLower = urlObj.pathname.toLowerCase();
    const looksArcgis = pathLower.includes("/featureserver/") || pathLower.includes("/mapserver/");
    const looksQuery = pathLower.endsWith("/query") || urlObj.searchParams.has("geometry") || urlObj.searchParams.has("where");
    const format = String(urlObj.searchParams.get("f") || "").toLowerCase();
    const isGeoFormat = format.includes("geojson") || format.includes("json");
    return looksArcgis && (looksQuery || isGeoFormat);
  } catch {
    return false;
  }
}

const REPORTS_FILE = path.join(__dirname, "data", "reports.json");
const REPORT_UPLOAD_DIR = path.join(__dirname, "data", "uploads", "reports");
const REPORT_ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const REPORT_UPLOAD_LIMIT = 5 * 1024 * 1024;
const REPORT_FORM_LIMIT = REPORT_UPLOAD_LIMIT + (1 * 1024 * 1024);
const REPORT_NOTE_LIMIT = 2000;
const HUB_CLIENTS_FILE = path.join(__dirname, "data", "clients.json");
const HUB_CLIENTS_FLUSH_MS = 5 * 1000;
const HUB_CLIENTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const GEO_DATA_CACHE_TTL_MS = 60 * 1000;
const GAZETTEER_FILE = path.join(__dirname, "data", "gazetteer.json");
const INTERSECTIONS_FILE = path.join(__dirname, "data", "intersections.json");
const PLACES_FILE = path.join(__dirname, "data", "places.json");
const DOWNTOWN_CENTRAL_PARK_PLACES_FILE = path.join(__dirname, "data", "places-downtown-centralpark.json");
const DORMS_FILE = path.join(__dirname, "data", "dorms_fxbg.json");
const SCHOOLS_OVERRIDES_FILE = path.join(__dirname, "data", "schools_address_overrides.json");
const SCHOOLS_DATASET_FILE = path.join(__dirname, "data", "schools_fxbg.json");
const SPOTSY_STREETLIST_FILE = path.join(__dirname, "data", "streetlists", "spotsy_streets.json");
const SPOTSY_STREETLIST_SOURCE_URL = "https://www.spotsylvania.va.us/DocumentCenter/View/7321/Street-List-February-2026";
const GIS_CATALOG_FILE = path.join(__dirname, "data", "gis-catalog.json");
const CACHE_DIR = path.join(__dirname, "data", "cache");
const GIS_CACHE_DIR = path.join(CACHE_DIR, "gis");
const GIS_CACHE_INDEX_FILE = path.join(GIS_CACHE_DIR, "index.json");
const VA511_ICONS_CACHE_FILE = path.join(CACHE_DIR, "va511-icons-metadata.json");
const geoDataCache = new Map();
const va511IconsMemoryCache = { ts: 0, payload: null };
const VA511_ICONS_CACHE_TTL_MS = 5 * 60 * 1000;
const VA511_ICONS_SOURCE_URL = "https://files5.iteriscdn.com/WebApps/VA/SafeTravel/data/local/icons/metadata/icons.incident.geojsonp";

// VA511 Events + Cams endpoints (first-class server-side fetch with caching)
const VA511_EVENTS_SOURCE_URL = "https://511.vdot.virginia.gov/services/map/layers/map/events";
const VA511_CAMS_SOURCE_URL = "https://511.vdot.virginia.gov/services/map/layers/map/cams";
const VA511_EVENTS_CACHE_FILE = path.join(CACHE_DIR, "va511-events.json");
const VA511_CAMS_CACHE_FILE = path.join(CACHE_DIR, "va511-cams.json");
const VA511_EVENTS_CACHE_TTL_MS = 3 * 60 * 1000;   // 3 minutes fresh
const VA511_EVENTS_STALE_TTL_MS = 60 * 60 * 1000;   // 1 hour stale fallback
const VA511_CAMS_CACHE_TTL_MS = 5 * 60 * 1000;      // 5 minutes fresh
const VA511_CAMS_STALE_TTL_MS = 60 * 60 * 1000;     // 1 hour stale fallback
const va511EventsMemoryCache = { ts: 0, payload: null };
const va511CamsMemoryCache = { ts: 0, payload: null };

// FXBG I-95 corridor bounding box for status summary
const FXBG_I95_BBOX = { minLat: 38.15, maxLat: 38.55, minLon: -77.70, maxLon: -77.20 };

const CDC_SOURCE_URL = "https://data.cdc.gov/api/v3/views/psx4-wq38/query.json";
const CDC_BACKOFF_MS = 30 * 60 * 1000;
const cdcState = { backoffUntil: 0, lastReason: null, cache: null };
const hubClients = new Map();
let hubClientsFlushTimer = null;

function defaultGeoDataset() {
  return {
    version: 1,
    items: []
  };
}

function parseJsonpPayload(rawText, context = "jsonp") {
  const text = String(rawText || "").trim();
  if (!text) throw new Error(`${context}: empty response`);
  const match = text.match(/^[a-zA-Z_$][\w$]*\s*\(\s*([\s\S]+)\s*\)\s*;?\s*$/);
  const jsonText = match ? match[1] : text;
  return JSON.parse(jsonText);
}

async function readJsonFile(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function defaultGisCatalog() {
  return {
    version: 1,
    basemapEnhancers: [],
    toggleLayers: [],
    cityLayers: [],
    fredBusMode: [],
    environmentalTopo: [],
    spotsy: []
  };
}

async function readGisCatalog() {
  const catalog = await readJsonFile(GIS_CATALOG_FILE);
  if (!catalog) return defaultGisCatalog();
  return {
    ...defaultGisCatalog(),
    ...catalog
  };
}

function listGisCatalogEntries(catalog) {
  const groups = [
    "basemapEnhancers",
    "toggleLayers",
    "cityLayers",
    "fredBusMode",
    "environmentalTopo",
    "spotsy"
  ];
  const entries = [];
  for (const group of groups) {
    const items = Array.isArray(catalog[group]) ? catalog[group] : [];
    for (const item of items) {
      if (!item || !item.key) continue;
      entries.push({ ...item, category: group });
    }
  }
  return entries;
}

function findGisCatalogEntry(catalog, key) {
  if (!catalog || !key) return null;
  return listGisCatalogEntries(catalog).find((entry) => entry.key === key) || null;
}

function sanitizeGisKey(value) {
  const key = String(value || "").trim();
  if (!key || !/^[a-z0-9_-]+$/i.test(key)) return null;
  return key;
}

function detectGisFormat(contentType, buffer) {
  const ct = String(contentType || "").toLowerCase();
  const prefix = buffer?.slice(0, 64)?.toString("utf8")?.trimStart() || "";
  if (ct.includes("json") || prefix.startsWith("{")) {
    return "geojson";
  }
  if (buffer && buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    return "zip";
  }
  return "unknown";
}

function getGisCachePaths(key, format) {
  const base = path.join(GIS_CACHE_DIR, key);
  const ext = format === "geojson" ? ".json" : format === "zip" ? ".zip" : ".bin";
  return {
    rawPath: `${base}${ext}`,
    geojsonPath: `${base}.geojson`,
    metaPath: `${base}.meta.json`,
    savedAs: path.basename(`${base}${ext}`)
  };
}

async function readGisCacheMeta(key) {
  const metaPath = path.join(GIS_CACHE_DIR, `${key}.meta.json`);
  const meta = await readJsonFile(metaPath);
  if (!meta || !meta.savedAs) return null;
  const rawPath = path.join(GIS_CACHE_DIR, meta.savedAs);
  const hasRaw = fs.existsSync(rawPath);
  if (!hasRaw) return null;
  return { ...meta, rawPath, metaPath };
}

function defaultGisCacheIndex() {
  return { version: 1, items: {} };
}

async function readGisCacheIndex() {
  const index = await readJsonFile(GIS_CACHE_INDEX_FILE);
  if (!index || typeof index !== "object") {
    const initial = defaultGisCacheIndex();
    await writeGisCacheIndex(initial);
    return initial;
  }
  return {
    ...defaultGisCacheIndex(),
    ...index,
    items: typeof index.items === "object" && index.items ? index.items : {}
  };
}

async function writeGisCacheIndex(index) {
  await writeJsonFile(GIS_CACHE_INDEX_FILE, index);
}

async function updateGisCacheIndexItem(key, updater) {
  const index = await readGisCacheIndex();
  const current = index.items[key] || { key };
  const next = typeof updater === "function" ? updater(current) : { ...current, ...updater };
  index.items[key] = next;
  await writeGisCacheIndex(index);
  return next;
}

function offlineTierMatchesPack(entry, pack) {
  const tier = entry?.offline?.tier;
  if (!tier) return false;
  if (pack === "core") return tier === "core";
  if (pack === "field") return tier === "core" || tier === "optional" || tier === "field";
  return false;
}

function offlineAoiBounds(aoi) {
  if (!aoi) return null;
  return OFFLINE_AOI_BOUNDS[aoi] || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractItemId(url) {
  const text = String(url || "");
  if (!text) return null;
  const patterns = [
    /\/content\/items\/([a-f0-9]{32})\/data/i,
    /\/datasets\/([a-f0-9]{32})(?:[/?#]|$)/i,
    /#\/geohub\/datasets\/([a-f0-9]{32})(?:[/?#]|$)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].toLowerCase();
  }
  return null;
}

function portalBaseForUrl(url) {
  const text = String(url || "");
  if (text.includes("gis.spotsylvania.va.us")) {
    return "https://gis.spotsylvania.va.us/portal";
  }
  return "https://www.arcgis.com";
}

async function fetchPortalItem(portalBase, itemId) {
  if (!portalBase || !itemId) return null;
  const itemUrl = `${portalBase.replace(/\/$/, "")}/sharing/rest/content/items/${itemId}?f=pjson`;
  const urlCheck = checkUrlAllowed(itemUrl);
  if (!urlCheck.allowed) {
    return { ok: false, error: "blocked_url", reason: urlCheck.reason };
  }

  const upstream = await upstreamFetch(itemUrl, {
    expectedType: "json",
    timeoutMs: 15000,
    upstreamName: `gis-resolve-${itemId}`,
    route: "/api/gis/resolve"
  });

  if (!upstream.ok) {
    return {
      ok: false,
      error: upstream.error || "upstream_failed",
      status: upstream.status || 0
    };
  }

  return { ok: true, data: upstream.json || null };
}

async function fetchPortalRelatedItems(portalBase, itemId, relationshipType, direction) {
  if (!portalBase || !itemId || !relationshipType || !direction) return null;
  const relatedUrl = `${portalBase.replace(/\/$/, "")}/sharing/rest/content/items/${itemId}/relatedItems?relationshipType=${encodeURIComponent(relationshipType)}&direction=${encodeURIComponent(direction)}&f=pjson`;
  const urlCheck = checkUrlAllowed(relatedUrl);
  if (!urlCheck.allowed) {
    return { ok: false, error: "blocked_url", reason: urlCheck.reason };
  }

  const upstream = await upstreamFetch(relatedUrl, {
    expectedType: "json",
    timeoutMs: 15000,
    upstreamName: `gis-related-${itemId}`,
    route: "/api/gis/resolve"
  });

  if (!upstream.ok) {
    return {
      ok: false,
      error: upstream.error || "upstream_failed",
      status: upstream.status || 0
    };
  }

  return { ok: true, data: upstream.json || null };
}

async function resolveArcgis(entry) {
  const url = entry?.url || "";
  const itemId = extractItemId(url);
  if (!itemId) {
    return { ok: false, error: "missing_item_id" };
  }

  const portalBase = portalBaseForUrl(url);
  const itemResult = await fetchPortalItem(portalBase, itemId);
  if (!itemResult?.ok) {
    return { ok: false, error: itemResult?.error || "item_fetch_failed", reason: itemResult?.reason, status: itemResult?.status };
  }

  const item = itemResult.data || {};
  const serviceUrl = item.url || null;
  let relatedItemId = null;
  let relatedServiceUrl = null;
  let layerUrl = null;

  if (!serviceUrl) {
    const relationshipTypes = ["Service2Data", "Data2Service"];
    const directions = ["forward", "reverse"];
    for (const relationshipType of relationshipTypes) {
      for (const direction of directions) {
        const relatedResult = await fetchPortalRelatedItems(portalBase, itemId, relationshipType, direction);
        const relatedItems = relatedResult?.data?.relatedItems || [];
        const candidate = relatedItems.find((rel) => rel?.type?.toLowerCase().includes("feature")) || relatedItems[0];
        if (candidate?.id) {
          relatedItemId = candidate.id.toLowerCase();
          const relatedItem = await fetchPortalItem(portalBase, relatedItemId);
          if (relatedItem?.ok) {
            relatedServiceUrl = relatedItem.data?.url || null;
          }
        }
        if (relatedServiceUrl) break;
      }
      if (relatedServiceUrl) break;
    }
  }

  const finalServiceUrl = serviceUrl || relatedServiceUrl;
  if (finalServiceUrl) {
    if (/\/(feature|map)server\/\d+$/i.test(finalServiceUrl)) {
      layerUrl = finalServiceUrl;
    } else if (/\/featureserver\/?$/i.test(finalServiceUrl)) {
      layerUrl = `${finalServiceUrl.replace(/\/$/, "")}/0`;
    } else if (/\/mapserver\/?$/i.test(finalServiceUrl)) {
      layerUrl = `${finalServiceUrl.replace(/\/$/, "")}/0`;
    } else {
      layerUrl = finalServiceUrl;
    }
  }

  return {
    ok: true,
    itemId,
    portalBase,
    title: item.title || null,
    type: item.type || null,
    serviceUrl: finalServiceUrl,
    layerUrl,
    relatedItemId
  };
}

function buildGisCacheSource(entry, resolution) {
  return {
    url: entry?.url || null,
    layerUrl: resolution?.layerUrl || entry?.layerUrl || entry?.offline?.layerUrl || null,
    portalBase: resolution?.portalBase || entry?.portalBase || null,
    itemId: resolution?.itemId || entry?.itemId || extractItemId(entry?.url || "") || null
  };
}

const DEFAULT_OFFLINE_PACK_BUDGET_MB = {
  core: 500,
  field: 4000
};

function getOfflinePackBudgetMB(catalog, pack) {
  const budget = catalog?.offlinePacks?.[pack]?.storageBudgetMB;
  if (Number.isFinite(budget)) return budget;
  if (pack && Object.prototype.hasOwnProperty.call(DEFAULT_OFFLINE_PACK_BUDGET_MB, pack)) {
    return DEFAULT_OFFLINE_PACK_BUDGET_MB[pack];
  }
  return null;
}

function getOfflinePackBudgetBytes(catalog, pack) {
  const budgetMB = getOfflinePackBudgetMB(catalog, pack);
  if (!Number.isFinite(budgetMB)) return null;
  return budgetMB * 1024 * 1024;
}

function getOfflinePackUsageBytes(catalog, pack, index) {
  if (!pack) return null;
  const entries = listGisCatalogEntries(catalog);
  const entryMap = new Map(entries.map((entry) => [entry.key, entry]));
  const items = Object.values(index.items || {}).filter((item) => item?.cached);
  return items.reduce((acc, item) => {
    const entry = entryMap.get(item.key);
    if (!offlineTierMatchesPack(entry, pack)) return acc;
    return acc + (item.bytes || 0);
  }, 0);
}

async function resolveGisLayerUrl(key, entry) {
  const cachedPath = path.join(GIS_CACHE_DIR, `${key}.resolved.json`);
  const cached = await readJsonFile(cachedPath);
  if (cached?.ok && cached.layerUrl) {
    return cached;
  }
  const resolution = await resolveArcgis(entry);
  if (resolution?.ok) {
    await writeJsonFile(cachedPath, resolution);
  }
  return resolution;
}

async function isGisCacheItemValid(key, item) {
  if (!item?.cached) return false;
  if (item.format === "arcgis_snapshot") {
    return fs.existsSync(path.join(GIS_CACHE_DIR, `${key}.geojson`));
  }
  const meta = await readGisCacheMeta(key);
  return Boolean(meta);
}

async function touchGisCacheIndexItem(key, entry) {
  const now = Date.now();
  return updateGisCacheIndexItem(key, (current) => ({
    ...current,
    key,
    name: current.name || entry?.name || null,
    lastUsedAt: now
  }));
}

async function syncGisCacheIndexFromMeta(key, entry, cachedMeta) {
  if (!cachedMeta) return null;
  const cachedAt = cachedMeta.fetchedAt ? Date.parse(cachedMeta.fetchedAt) : null;
  const now = Date.now();
  return updateGisCacheIndexItem(key, (current) => ({
    ...current,
    key,
    name: entry?.name || current.name || null,
    cached: true,
    cachedAt: Number.isFinite(cachedAt) ? cachedAt : current.cachedAt || now,
    bytes: cachedMeta.bytes || current.bytes || 0,
    format: cachedMeta.format || current.format || "unknown",
    source: current.source || buildGisCacheSource(entry, null),
    etag: current.etag || null,
    lastModified: current.lastModified || null,
    lastUsedAt: now
  }));
}

async function getDirectorySizeBytes(dirPath) {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += await getDirectorySizeBytes(fullPath);
      } else if (entry.isFile()) {
        const stats = await fsp.stat(fullPath);
        total += stats.size;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

function buildArcgisQueryUrl(layerUrl, params) {
  const base = layerUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/query`);
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    url.searchParams.set(key, String(value));
  });
  return url.toString();
}

async function fetchArcgisFeatureCount(layerUrl, bbox) {
  const url = buildArcgisQueryUrl(layerUrl, {
    f: "json",
    where: "1=1",
    geometry: bbox.join(","),
    geometryType: "esriGeometryEnvelope",
    spatialRel: "esriSpatialRelIntersects",
    inSR: 4326,
    outSR: 4326,
    returnCountOnly: "true"
  });

  const result = await upstreamFetch(url, {
    expectedType: "json",
    timeoutMs: 20000,
    upstreamName: "gis-offline-count",
    route: "/api/gis/offline/prefetch"
  });

  if (!result.ok || !result.json) {
    return { ok: false, error: result.error || "count_failed", status: result.status || 0 };
  }

  const count = Number(result.json.count);
  if (!Number.isFinite(count)) {
    return { ok: false, error: "invalid_count" };
  }

  return { ok: true, count };
}

async function fetchArcgisGeojsonPage(layerUrl, bbox, offset, pageSize) {
  const url = buildArcgisQueryUrl(layerUrl, {
    f: "geojson",
    where: "1=1",
    geometry: bbox.join(","),
    geometryType: "esriGeometryEnvelope",
    spatialRel: "esriSpatialRelIntersects",
    inSR: 4326,
    outSR: 4326,
    outFields: "*",
    resultOffset: offset,
    resultRecordCount: pageSize,
    returnGeometry: "true"
  });

  const result = await upstreamFetch(url, {
    expectedType: "json",
    timeoutMs: 25000,
    maxBytes: MAX_LAYER_BYTES,
    upstreamName: "gis-offline-page",
    route: "/api/gis/offline/prefetch"
  });

  if (!result.ok || !result.json) {
    return { ok: false, error: result.error || "page_failed", status: result.status || 0 };
  }

  return { ok: true, data: result.json };
}

async function cacheGisDownloadResult(key, entry, buffer, contentType, fetchedAt) {
  const format = detectGisFormat(contentType, buffer);
  const cachePaths = getGisCachePaths(key, format);

  await fsp.mkdir(GIS_CACHE_DIR, { recursive: true });
  await fsp.writeFile(cachePaths.rawPath, buffer);

  let normalizedGeojsonPath = null;
  if (format === "geojson") {
    try {
      const parsed = JSON.parse(buffer.toString("utf8"));
      const normalized = JSON.stringify(parsed, null, 2);
      await fsp.writeFile(cachePaths.geojsonPath, normalized, "utf8");
      normalizedGeojsonPath = cachePaths.geojsonPath;
    } catch (err) {
      logApp({
        level: "WARN",
        kind: "gis_normalize",
        msg: "Failed to normalize GIS payload",
        errorCode: err.message,
        key
      });
    }
  }

  const meta = {
    key,
    bytes: buffer.length,
    contentType: contentType || null,
    savedAs: cachePaths.savedAs,
    fetchedAt,
    format
  };
  await writeJsonFile(cachePaths.metaPath, meta);

  const now = Date.now();
  const source = buildGisCacheSource(entry, null);
  await updateGisCacheIndexItem(key, (current) => ({
    ...current,
    key,
    name: entry?.name || current.name || null,
    cached: true,
    cachedAt: now,
    bytes: meta.bytes,
    format: meta.format,
    source,
    etag: current.etag || null,
    lastModified: current.lastModified || null,
    lastUsedAt: now
  }));

  return { meta, normalized: Boolean(normalizedGeojsonPath) };
}

async function downloadGisFileEntry(key, entry) {
  const urlCheck = checkUrlAllowed(entry.url);
  if (!urlCheck.allowed) {
    return { ok: false, error: "blocked_url", reason: urlCheck.reason };
  }

  const upstream = await upstreamFetch(entry.url, {
    includeBodyBuffer: true,
    maxBytes: MAX_LAYER_BYTES,
    timeoutMs: 20000,
    upstreamName: `gis-${key}`,
    route: "/api/gis/offline/prefetch"
  });

  if (!upstream.ok || !upstream.bodyBuffer) {
    return { ok: false, error: upstream.error || "upstream_failed", status: upstream.status || 0 };
  }

  const cached = await cacheGisDownloadResult(key, entry, upstream.bodyBuffer, upstream.contentType, upstream.fetchedAt);
  return { ok: true, cached };
}

async function downloadGisArcgisSnapshot(key, entry) {
  const bounds = offlineAoiBounds(entry?.offline?.aoi);
  if (!bounds) {
    return { ok: false, error: "missing_aoi_bounds" };
  }

  const resolution = await resolveGisLayerUrl(key, entry);
  if (!resolution?.ok || !resolution.layerUrl) {
    return { ok: false, error: resolution?.error || "missing_layer_url" };
  }

  const countResult = await fetchArcgisFeatureCount(resolution.layerUrl, bounds);
  if (!countResult.ok) {
    return { ok: false, error: countResult.error || "count_failed" };
  }

  if (countResult.count > MAX_OFFLINE_SNAPSHOT_FEATURES) {
    await updateGisCacheIndexItem(key, (current) => ({
      ...current,
      key,
      name: entry?.name || current.name || null,
      cached: false,
      bytes: 0,
      format: "arcgis_snapshot",
      source: buildGisCacheSource(entry, resolution),
      etag: current.etag || null,
      lastModified: current.lastModified || null,
      lastUsedAt: current.lastUsedAt || null,
      error: "too_large_for_pack"
    }));
    return { ok: false, error: "too_large_for_pack" };
  }

  const pageSize = Number(process.env.OFFLINE_SNAPSHOT_PAGE_SIZE) || 2000;
  const snapshotPath = path.join(GIS_CACHE_DIR, `${key}.geojson`);
  await fsp.mkdir(GIS_CACHE_DIR, { recursive: true });

  const stream = fs.createWriteStream(snapshotPath, { encoding: "utf8" });
  let totalFeatures = 0;
  let totalBytes = 0;
  let first = true;
  const prefix = "{\"type\":\"FeatureCollection\",\"features\":[";
  stream.write(prefix);
  totalBytes += Buffer.byteLength(prefix);

  try {
    for (let offset = 0; ; offset += pageSize) {
      const page = await fetchArcgisGeojsonPage(resolution.layerUrl, bounds, offset, pageSize);
      if (!page.ok) {
        throw new Error(page.error || "page_failed");
      }

      const features = Array.isArray(page.data?.features) ? page.data.features : [];
      if (features.length === 0) break;

      for (const feature of features) {
        if (totalFeatures >= MAX_OFFLINE_SNAPSHOT_FEATURES) {
          throw new Error("too_large_for_pack");
        }
        const chunk = JSON.stringify(feature);
        const prefixChunk = first ? "" : ",";
        const chunkBytes = Buffer.byteLength(prefixChunk) + Buffer.byteLength(chunk);
        totalBytes += chunkBytes;
        if (totalBytes > MAX_OFFLINE_SNAPSHOT_MB * 1024 * 1024) {
          throw new Error("too_large_for_pack");
        }
        stream.write(prefixChunk + chunk);
        first = false;
        totalFeatures += 1;
      }

      if (features.length < pageSize) break;
    }
  } catch (err) {
    await new Promise((resolve) => stream.end(resolve));
    await fsp.rm(snapshotPath, { force: true });
    const errorCode = err.message === "too_large_for_pack" ? "too_large_for_pack" : "snapshot_failed";
    await updateGisCacheIndexItem(key, (current) => ({
      ...current,
      key,
      name: entry?.name || current.name || null,
      cached: false,
      bytes: 0,
      format: "arcgis_snapshot",
      source: buildGisCacheSource(entry, resolution),
      etag: current.etag || null,
      lastModified: current.lastModified || null,
      lastUsedAt: current.lastUsedAt || null,
      error: errorCode
    }));
    return { ok: false, error: errorCode };
  }

  const suffix = "]}";
  stream.write(suffix);
  totalBytes += Buffer.byteLength(suffix);
  await new Promise((resolve) => stream.end(resolve));

  const stats = await fsp.stat(snapshotPath);
  const now = Date.now();
  await updateGisCacheIndexItem(key, (current) => ({
    ...current,
    key,
    name: entry?.name || current.name || null,
    cached: true,
    cachedAt: now,
    bytes: stats.size,
    format: "arcgis_snapshot",
    source: buildGisCacheSource(entry, resolution),
    etag: current.etag || null,
    lastModified: current.lastModified || null,
    lastUsedAt: now
  }));

  return { ok: true, bytes: stats.size, features: totalFeatures };
}

function buildOfflineQueue(catalog, { pack, keys } = {}) {
  const entries = listGisCatalogEntries(catalog);
  let filtered = entries.filter((entry) => entry?.offline);
  if (Array.isArray(keys) && keys.length > 0) {
    const keySet = new Set(keys);
    filtered = filtered.filter((entry) => keySet.has(entry.key));
  } else if (pack) {
    filtered = filtered.filter((entry) => offlineTierMatchesPack(entry, pack));
  }
  filtered.sort((a, b) => {
    const aPriority = Number.isFinite(a?.offline?.priority) ? a.offline.priority : 999;
    const bPriority = Number.isFinite(b?.offline?.priority) ? b.offline.priority : 999;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return String(a.key).localeCompare(String(b.key));
  });
  return filtered;
}

async function removeGisCacheFiles(key, item) {
  const meta = await readGisCacheMeta(key);
  if (meta?.rawPath) {
    await fsp.rm(meta.rawPath, { force: true });
  }
  if (meta?.metaPath) {
    await fsp.rm(meta.metaPath, { force: true });
  }
  const geojsonPath = path.join(GIS_CACHE_DIR, `${key}.geojson`);
  await fsp.rm(geojsonPath, { force: true });
}

async function evictOfflineCache({ targetBytes, pack, catalog }) {
  const index = await readGisCacheIndex();
  const entries = listGisCatalogEntries(catalog);
  const entryMap = new Map(entries.map((entry) => [entry.key, entry]));
  const items = Object.values(index.items || {}).filter((item) => item?.cached);
  let filtered = items;

  if (pack) {
    filtered = items.filter((item) => {
      const entry = entryMap.get(item.key);
      return offlineTierMatchesPack(entry, pack);
    });
  }

  const target = Number.isFinite(targetBytes) ? targetBytes : null;
  let totalBytes = filtered.reduce((acc, item) => acc + (item.bytes || 0), 0);
  if (target !== null && totalBytes <= target) {
    return { evicted: 0, remainingBytes: totalBytes };
  }

  filtered.sort((a, b) => {
    const aUsed = Number.isFinite(a.lastUsedAt) ? a.lastUsedAt : a.cachedAt || 0;
    const bUsed = Number.isFinite(b.lastUsedAt) ? b.lastUsedAt : b.cachedAt || 0;
    return aUsed - bUsed;
  });

  let evicted = 0;
  for (const item of filtered) {
    if (target !== null && totalBytes <= target) break;
    await removeGisCacheFiles(item.key, item);
    totalBytes -= item.bytes || 0;
    evicted += 1;
    await updateGisCacheIndexItem(item.key, (current) => ({
      ...current,
      key: item.key,
      cached: false,
      bytes: 0,
      cachedAt: null,
      lastUsedAt: null
    }));
  }

  return { evicted, remainingBytes: totalBytes };
}

async function summarizeOfflineStatus(catalog) {
  const index = await readGisCacheIndex();
  const entries = listGisCatalogEntries(catalog);
  const entryMap = new Map(entries.map((entry) => [entry.key, entry]));
  const items = Object.values(index.items || {});
  const cachedItems = items.filter((item) => item?.cached);
  const totalBytes = cachedItems.reduce((acc, item) => acc + (item.bytes || 0), 0);
  const byTier = {};

  for (const item of cachedItems) {
    const tier = entryMap.get(item.key)?.offline?.tier || "unknown";
    if (!byTier[tier]) {
      byTier[tier] = { count: 0, bytes: 0 };
    }
    byTier[tier].count += 1;
    byTier[tier].bytes += item.bytes || 0;
  }

  const budgets = {
    core: getOfflinePackBudgetMB(catalog, "core"),
    field: getOfflinePackBudgetMB(catalog, "field")
  };

  return {
    cacheBytes: totalBytes,
    cacheCount: cachedItems.length,
    byTier,
    budgets,
    lastErrors: offlinePrefetchState.errors.slice(-10)
  };
}

async function runOfflinePrefetch(entries, { force = false, pack = null, catalog = null } = {}) {
  offlinePrefetchState.running = true;
  offlinePrefetchState.currentKey = null;
  offlinePrefetchState.done = 0;
  offlinePrefetchState.total = entries.length;
  offlinePrefetchState.errors = [];
  offlinePrefetchState.startedAt = Date.now();
  offlinePrefetchState.lastUpdatedAt = Date.now();

  logOfflinePack(`prefetch_start total=${entries.length}`);

  const budgetBytes = catalog && pack ? getOfflinePackBudgetBytes(catalog, pack) : null;
  let usageBytes = 0;
  if (budgetBytes !== null) {
    const index = await readGisCacheIndex();
    usageBytes = getOfflinePackUsageBytes(catalog, pack, index) || 0;
    if (usageBytes >= budgetBytes) {
      const message = "budget_exceeded: Evict offline packs or increase storageBudgetMB.";
      offlinePrefetchState.errors.push({ key: "pack", error: message });
      logOfflinePack(`prefetch_stop reason=${message}`);
      offlinePrefetchState.running = false;
      offlinePrefetchState.currentKey = null;
      offlinePrefetchState.lastUpdatedAt = Date.now();
      return;
    }
  }

  for (const entry of entries) {
    offlinePrefetchState.currentKey = entry.key;
    offlinePrefetchState.lastUpdatedAt = Date.now();
    try {
      const index = await readGisCacheIndex();
      const cachedItem = index.items[entry.key];
      const cachedBytes = cachedItem?.bytes || 0;
      if (budgetBytes !== null) {
        usageBytes = getOfflinePackUsageBytes(catalog, pack, index) || usageBytes;
        const estMB = Number.isFinite(entry?.offline?.estSizeMB) ? entry.offline.estSizeMB : null;
        const estBytes = Number.isFinite(estMB) ? estMB * 1024 * 1024 : null;
        const projectedBytes = estBytes !== null ? Math.max(0, usageBytes - cachedBytes) + estBytes : null;
        if (projectedBytes !== null && projectedBytes > budgetBytes) {
          const message = "budget_exceeded: Evict offline packs or increase storageBudgetMB.";
          offlinePrefetchState.errors.push({ key: entry.key, error: message });
          logOfflinePack(`prefetch_stop key=${entry.key} reason=${message}`);
          break;
        }
      }
      if (!force && cachedItem && await isGisCacheItemValid(entry.key, cachedItem)) {
        await touchGisCacheIndexItem(entry.key, entry);
        logOfflinePack(`prefetch_skip_cached key=${entry.key}`);
      } else {
        let result = null;
        if (entry.offline?.downloadMode === "serviceQuery") {
          result = await downloadGisArcgisSnapshot(entry.key, entry);
        } else {
          result = await downloadGisFileEntry(entry.key, entry);
        }

        if (!result?.ok) {
          const errorCode = result?.error || "download_failed";
          offlinePrefetchState.errors.push({ key: entry.key, error: errorCode });
          logOfflinePack(`prefetch_error key=${entry.key} error=${errorCode}`);
        } else {
          const newBytes = result?.bytes || result?.cached?.meta?.bytes || cachedBytes;
          if (budgetBytes !== null) {
            usageBytes = Math.max(0, usageBytes - cachedBytes + (newBytes || 0));
            if (usageBytes > budgetBytes) {
              const message = "budget_exceeded: Evict offline packs or increase storageBudgetMB.";
              await removeGisCacheFiles(entry.key, cachedItem);
              await updateGisCacheIndexItem(entry.key, (current) => ({
                ...current,
                key: entry.key,
                cached: false,
                bytes: 0,
                cachedAt: null,
                lastUsedAt: null
              }));
              offlinePrefetchState.errors.push({ key: entry.key, error: message });
              logOfflinePack(`prefetch_stop key=${entry.key} reason=${message}`);
              break;
            }
          }
          logOfflinePack(`prefetch_ok key=${entry.key}`);
        }
      }
    } catch (err) {
      const message = err?.message || "prefetch_failed";
      offlinePrefetchState.errors.push({ key: entry.key, error: message });
      logOfflinePack(`prefetch_error key=${entry.key} error=${message}`);
    }
    offlinePrefetchState.done += 1;
    offlinePrefetchState.lastUpdatedAt = Date.now();
    if (OFFLINE_PREFETCH_DELAY_MS > 0) {
      await sleep(OFFLINE_PREFETCH_DELAY_MS);
    }
  }

  offlinePrefetchState.running = false;
  offlinePrefetchState.currentKey = null;
  offlinePrefetchState.lastUpdatedAt = Date.now();
  logOfflinePack(`prefetch_done total=${offlinePrefetchState.total} done=${offlinePrefetchState.done}`);
}

async function fetchVa511IconsMetadata() {
  const now = Date.now();
  if (va511IconsMemoryCache.payload && (now - va511IconsMemoryCache.ts) < VA511_ICONS_CACHE_TTL_MS) {
    return { ok: true, data: va511IconsMemoryCache.payload.data, sourceUrl: VA511_ICONS_SOURCE_URL, fetchedAt: va511IconsMemoryCache.payload.fetchedAt, cached: true };
  }

  try {
    const result = await upstreamFetch(VA511_ICONS_SOURCE_URL, {
      expectedType: "json",
      allowJsonp: true,
      timeoutMs: 15000,
      headers: {
        "Accept": "application/javascript,text/javascript,text/plain,application/json,*/*",
        "Referer": "https://511.vdot.virginia.gov/",
        "Origin": "https://511.vdot.virginia.gov",
        "User-Agent": "FXBG-PALANTIR-CityManager/1.0"
      },
      upstreamName: "va511-icons-metadata",
      route: "/api/va511/icons-metadata"
    });
    if (!result.ok || !result.json) {
      throw new Error(result.error || `HTTP ${result.status}`);
    }
    const payload = { ok: true, data: result.json, sourceUrl: VA511_ICONS_SOURCE_URL, fetchedAt: new Date().toISOString() };
    va511IconsMemoryCache.ts = now;
    va511IconsMemoryCache.payload = payload;
    await writeJsonFile(VA511_ICONS_CACHE_FILE, payload);
    return { ...payload, cached: false };
  } catch (err) {
    const diskCached = await readJsonFile(VA511_ICONS_CACHE_FILE);
    if (diskCached?.ok && diskCached?.data) {
      va511IconsMemoryCache.ts = now;
      va511IconsMemoryCache.payload = diskCached;
      return {
        ok: false,
        degraded: true,
        reason: err.message,
        cached: true,
        sourceUrl: VA511_ICONS_SOURCE_URL,
        fetchedAt: diskCached.fetchedAt || null,
        data: diskCached.data
      };
    }
    return {
      ok: false,
      degraded: true,
      reason: err.message,
      cached: false,
      sourceUrl: VA511_ICONS_SOURCE_URL,
      fetchedAt: null,
      data: null
    };
  }
}

// ---------------------------------------------------------------------------
// VA511 Events (server-side fetch with memory + disk cache + stale fallback)
// ---------------------------------------------------------------------------
const VA511_UPSTREAM_HEADERS = {
  "Accept": "application/json,*/*",
  "Referer": "https://511.vdot.virginia.gov/",
  "Origin": "https://511.vdot.virginia.gov",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
};

async function fetchVa511Layer(sourceUrl, memCache, ttlMs, staleTtlMs, diskCacheFile, layerName) {
  const now = Date.now();
  // 1. Fresh memory cache?
  if (memCache.payload && (now - memCache.ts) < ttlMs) {
    return { ok: true, data: memCache.payload.data, sourceUrl, fetchedAt: memCache.payload.fetchedAt, cached: true, degraded: false };
  }

  // 2. Try upstream
  try {
    const result = await upstreamFetch(sourceUrl, {
      expectedType: "json",
      timeoutMs: 15000,
      headers: VA511_UPSTREAM_HEADERS,
      upstreamName: `va511-${layerName}`,
      route: `/api/va511/${layerName}`
    });

    if (!result.ok || !result.json) {
      throw new Error(result.error || `upstream returned status ${result.status}`);
    }

    const payload = { ok: true, data: result.json, sourceUrl, fetchedAt: result.fetchedAt };
    memCache.ts = now;
    memCache.payload = payload;
    await writeJsonFile(diskCacheFile, payload);
    return { ...payload, cached: false, degraded: false };
  } catch (err) {
    // 3. Stale memory cache within stale window?
    if (memCache.payload && (now - memCache.ts) < staleTtlMs) {
      return { ok: true, data: memCache.payload.data, sourceUrl, fetchedAt: memCache.payload.fetchedAt, cached: true, degraded: true, reason: err.message };
    }

    // 4. Disk cache fallback
    const diskCached = await readJsonFile(diskCacheFile);
    if (diskCached?.ok && diskCached?.data) {
      memCache.ts = now;
      memCache.payload = diskCached;
      return { ok: true, data: diskCached.data, sourceUrl, fetchedAt: diskCached.fetchedAt || null, cached: true, degraded: true, reason: err.message };
    }

    // 5. Total failure
    return { ok: false, data: null, sourceUrl, fetchedAt: null, cached: false, degraded: true, error: err.message };
  }
}

async function fetchVa511Events() {
  return fetchVa511Layer(VA511_EVENTS_SOURCE_URL, va511EventsMemoryCache, VA511_EVENTS_CACHE_TTL_MS, VA511_EVENTS_STALE_TTL_MS, VA511_EVENTS_CACHE_FILE, "events");
}

async function fetchVa511Cams() {
  return fetchVa511Layer(VA511_CAMS_SOURCE_URL, va511CamsMemoryCache, VA511_CAMS_CACHE_TTL_MS, VA511_CAMS_STALE_TTL_MS, VA511_CAMS_CACHE_FILE, "cams");
}

// ---------------------------------------------------------------------------
// VA511 Status Summary (computed from events)
// ---------------------------------------------------------------------------
function computeVa511Status(eventsPayload) {
  if (!eventsPayload || !eventsPayload.ok || !eventsPayload.data) {
    if (eventsPayload?.degraded && eventsPayload?.data) {
      // degraded but have cached data — still compute
    } else {
      return {
        ok: false,
        totalEvents: 0,
        i95ApproxCount: 0,
        byCategory: {},
        fetchedAt: eventsPayload?.fetchedAt || null,
        degraded: eventsPayload?.degraded || true,
        cached: eventsPayload?.cached || false,
        error: eventsPayload?.error || "no events data"
      };
    }
  }

  const data = eventsPayload.data;
  // VA511 events can be a FeatureCollection or an array
  const items = Array.isArray(data) ? data : (data?.features || data?.items || []);
  const totalEvents = items.length;

  const byCategory = { incident: 0, crash: 0, congestion: 0, closure: 0, construction: 0, other: 0 };
  let i95ApproxCount = 0;

  for (const item of items) {
    // Support both GeoJSON features and flat objects
    const props = item.properties || item;
    const geom = item.geometry || null;
    let lat = null, lon = null;

    if (geom && geom.coordinates) {
      [lon, lat] = geom.coordinates;
    } else {
      lat = parseFloat(props.latitude || props.lat || props.y || 0);
      lon = parseFloat(props.longitude || props.lon || props.lng || props.x || 0);
    }

    // Categorize
    const combined = `${props.title || ""} ${props.event || ""} ${props.description || ""} ${props.incident_type || ""} ${props.road || ""}`.toLowerCase();
    if (/crash|collision|accident|wreck/.test(combined)) byCategory.crash++;
    else if (/closed|closure|blocked|detour/.test(combined)) byCategory.closure++;
    else if (/congestion|slow|delay|queue/.test(combined)) byCategory.congestion++;
    else if (/construction|work\s*zone|lane\s*closure|paving/.test(combined)) byCategory.construction++;
    else if (/incident/.test(combined)) byCategory.incident++;
    else byCategory.other++;

    // I-95 corridor count
    if (isFinite(lat) && isFinite(lon)) {
      const isI95 = /\bi\-?95\b|\binterstate\s*95\b/.test(combined);
      if (isI95 && lat >= FXBG_I95_BBOX.minLat && lat <= FXBG_I95_BBOX.maxLat && lon >= FXBG_I95_BBOX.minLon && lon <= FXBG_I95_BBOX.maxLon) {
        i95ApproxCount++;
      }
    }
  }

  return {
    ok: true,
    totalEvents,
    i95ApproxCount,
    byCategory,
    fetchedAt: eventsPayload.fetchedAt,
    degraded: Boolean(eventsPayload.degraded),
    cached: Boolean(eventsPayload.cached)
  };
}

async function readOrInitGeoDataset(filePath, context) {
  const now = Date.now();
  const cached = geoDataCache.get(filePath);
  if (cached && (now - cached.ts) <= GEO_DATA_CACHE_TTL_MS) {
    return cached.value;
  }

  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });

  try {
    await fsp.access(filePath, fs.constants.F_OK);
  } catch {
    const emptyPayload = defaultGeoDataset();
    await fsp.writeFile(filePath, JSON.stringify(emptyPayload, null, 2), "utf8");
  }

  let raw = "";
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    logApp({
      level: "WARN",
      kind: "geo_dataset_read_failed",
      msg: `Failed reading ${context}`,
      errorCode: err.message
    });
    const fallback = defaultGeoDataset();
    geoDataCache.set(filePath, { value: fallback, ts: now });
    return fallback;
  }

  const parsed = safeJsonParse(raw, defaultGeoDataset(), context);
  const normalized = {
    version: Number(parsed?.version) || 1,
    items: Array.isArray(parsed?.items) ? parsed.items : []
  };

  geoDataCache.set(filePath, { value: normalized, ts: now });
  return normalized;
}

async function ensureReportsFile() {
  const dir = path.dirname(REPORTS_FILE);
  await fsp.mkdir(dir, { recursive: true });
  try {
    await fsp.access(REPORTS_FILE);
  } catch {
    await fsp.writeFile(REPORTS_FILE, "[]", "utf8");
  }
}

async function readReports() {
  await ensureReportsFile();
  const raw = await fsp.readFile(REPORTS_FILE, "utf8");
  const parsed = safeJsonParse(raw, [], "reports");
  return Array.isArray(parsed) ? parsed : [];
}

async function writeReports(items) {
  await ensureReportsFile();
  const tmp = `${REPORTS_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(items, null, 2), "utf8");
  await fsp.rename(tmp, REPORTS_FILE);
}

function sanitizeDeviceId(raw) {
  const input = String(raw || "").trim();
  if (!input) return "";
  return input.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 64);
}

function sanitizeUserAgent(raw) {
  const input = String(raw || "").trim();
  if (!input) return "unknown";
  return input.slice(0, 160);
}

function scheduleHubClientsFlush() {
  if (hubClientsFlushTimer) return;
  hubClientsFlushTimer = setTimeout(async () => {
    hubClientsFlushTimer = null;
    try {
      const payload = {
        updatedAt: new Date().toISOString(),
        clients: Array.from(hubClients.values())
      };
      await fsp.mkdir(path.dirname(HUB_CLIENTS_FILE), { recursive: true });
      const tmp = `${HUB_CLIENTS_FILE}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
      await fsp.rename(tmp, HUB_CLIENTS_FILE);
    } catch (err) {
      logApp({
        level: "WARN",
        kind: "hub_clients_persist_failed",
        msg: "Failed to persist hub clients",
        errorCode: err.message
      });
    }
  }, HUB_CLIENTS_FLUSH_MS);
}

async function loadHubClients() {
  try {
    const raw = await fsp.readFile(HUB_CLIENTS_FILE, "utf8");
    const parsed = safeJsonParse(raw, null, "hub clients");
    const clients = Array.isArray(parsed) ? parsed : parsed?.clients;
    if (!Array.isArray(clients)) return;
    for (const item of clients) {
      const deviceId = sanitizeDeviceId(item?.deviceId);
      if (!deviceId) continue;
      const lastSeen = Number(item?.lastSeen);
      if (!Number.isFinite(lastSeen)) continue;
      hubClients.set(deviceId, {
        deviceId,
        lastSeen,
        userAgent: sanitizeUserAgent(item?.userAgent)
      });
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      logApp({
        level: "WARN",
        kind: "hub_clients_load_failed",
        msg: "Failed to load hub clients",
        errorCode: err.message
      });
    }
  }
}

function touchHubClient({ deviceId, userAgent }) {
  const safeDeviceId = sanitizeDeviceId(deviceId);
  if (!safeDeviceId) return null;
  const now = Date.now();

  // prune stale entries to avoid unbounded growth
  for (const [id, entry] of hubClients.entries()) {
    if (now - Number(entry.lastSeen || 0) > HUB_CLIENTS_MAX_AGE_MS) {
      hubClients.delete(id);
    }
  }

  const current = hubClients.get(safeDeviceId) || { deviceId: safeDeviceId };
  const next = {
    ...current,
    deviceId: safeDeviceId,
    lastSeen: now,
    userAgent: sanitizeUserAgent(userAgent)
  };
  hubClients.set(safeDeviceId, next);
  scheduleHubClientsFlush();
  return next;
}

function parseMultipart(buffer, boundary) {
  const delimiter = `--${boundary}`;
  const body = buffer.toString("latin1");
  const parts = body.split(delimiter).slice(1, -1);
  const fields = {};
  let file = null;

  for (const part of parts) {
    const cleaned = part.replace(/^\r\n/, "");
    const [rawHeaders, rawBody] = cleaned.split("\r\n\r\n");
    if (!rawHeaders || rawBody === undefined) continue;
    const headers = rawHeaders.split("\r\n").reduce((acc, line) => {
      const [key, ...rest] = line.split(":");
      acc[key.toLowerCase()] = rest.join(":").trim();
      return acc;
    }, {});
    const disposition = headers["content-disposition"] || "";
    const nameMatch = disposition.match(/name="([^"]+)"/i);
    const fileMatch = disposition.match(/filename="([^"]*)"/i);
    const name = nameMatch ? nameMatch[1] : null;
    const bodyContent = rawBody.replace(/\r\n$/, "");
    if (!name) continue;

    if (fileMatch && fileMatch[1]) {
      const mime = headers["content-type"] || "application/octet-stream";
      file = {
        field: name,
        filename: fileMatch[1],
        mime,
        buffer: Buffer.from(bodyContent, "latin1")
      };
    } else {
      fields[name] = Buffer.from(bodyContent, "latin1").toString("utf8");
    }
  }

  return { fields, file };
}

async function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > limit) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks, received)));
    req.on("error", reject);
  });
}

function filterReports(items, { since, sinceDays, bbox } = {}) {
  let cutoff = null;
  if (since) {
    const ts = Date.parse(since);
    if (!Number.isNaN(ts)) cutoff = ts;
  }
  if (sinceDays) {
    const days = Number(sinceDays);
    if (Number.isFinite(days)) {
      const sinceTs = Date.now() - days * 86400000;
      cutoff = cutoff ? Math.max(cutoff, sinceTs) : sinceTs;
    }
  }
  let bounds = null;
  if (bbox) {
    const parts = bbox.split(",").map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      bounds = {
        minLng: parts[0],
        minLat: parts[1],
        maxLng: parts[2],
        maxLat: parts[3]
      };
    }
  }

  return items.filter((item) => {
    if (cutoff) {
      const ts = Date.parse(item.ts);
      if (Number.isNaN(ts) || ts < cutoff) return false;
    }
    if (bounds) {
      if (item.lng < bounds.minLng || item.lng > bounds.maxLng) return false;
      if (item.lat < bounds.minLat || item.lat > bounds.maxLat) return false;
    }
    return true;
  }).sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
}

function toCsvValue(value) {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function isJsonContentType(contentType) {
  const ct = String(contentType || "").toLowerCase();
  return ct.includes("application/json") || ct.includes("+json");
}

function isHtmlContentType(contentType) {
  const ct = String(contentType || "").toLowerCase();
  return ct.includes("text/html") || ct.includes("text/plain");
}

function validateContentType(expectedType, contentType, bodyBuffer) {
  if (!expectedType) return { ok: true };
  const ct = String(contentType || "").toLowerCase();
  if (expectedType === "json") {
    if (isJsonContentType(ct)) return { ok: true };
    if (bodyBuffer && bodyBuffer.length > 0) {
      try {
        JSON.parse(bodyBuffer.toString("utf8"));
        return { ok: true };
      } catch {
        return { ok: false, errorCode: "unexpected_content_type" };
      }
    }
    return { ok: false, errorCode: "empty_body" };
  }
  if (expectedType === "html") {
    return isHtmlContentType(ct) ? { ok: true } : { ok: false, errorCode: "unexpected_content_type" };
  }
  if (expectedType === "image") {
    return ct.startsWith("image/") ? { ok: true } : { ok: false, errorCode: "unexpected_content_type" };
  }
  if (expectedType === "jsonp") {
    const ok = ct.includes("text/javascript") || ct.includes("application/javascript") || ct.includes("text/plain") || isJsonContentType(ct);
    return ok ? { ok: true } : { ok: false, errorCode: "unexpected_content_type" };
  }
  if (expectedType === "text") {
    const ok = ct.startsWith("text/") || ct.includes("xml") || ct.includes("application/javascript") || ct.includes("text/javascript");
    return ok ? { ok: true } : { ok: false, errorCode: "unexpected_content_type" };
  }
  return { ok: true };
}

async function readResponseBodyWithLimit(response, limitBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && limitBytes && contentLength > limitBytes) {
    throw new UpstreamError("payload_too_large", `Payload exceeds ${limitBytes} bytes`);
  }

  if (!response.body || !response.body.getReader) {
    return Buffer.from(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (limitBytes && received > limitBytes) {
        await reader.cancel();
        throw new UpstreamError("payload_too_large", `Payload exceeds ${limitBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  }

  return Buffer.concat(chunks, received);
}

// PDF parsing (for crime reports)
let pdfParse = null;
try {
  pdfParse = require("pdf-parse");
} catch (e) {
  console.warn("[Crime Reports] pdf-parse not installed. Run 'npm install' to enable PDF parsing.");
}

function normalizeSpotsyStreetEntry(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const headerPatterns = [
    /^street list/i,
    /spotsylvania county/i,
    /document center/i,
    /department of/i,
    /^page\s+\d+/i,
    /page\s+\d+\s+of\s+\d+/i,
    /february\s+\d{4}/i,
    /updated\s+\d{4}/i
  ];
  if (headerPatterns.some((pattern) => pattern.test(lower))) return null;
  if (!/[a-z]/i.test(text)) return null;
  return text;
}

function parseSpotsyStreetListText(rawText) {
  const lines = String(rawText || "").split(/\r?\n/);
  const streets = [];
  const seen = new Set();

  for (const line of lines) {
    const parts = String(line || "")
      .split(/\s{2,}/g)
      .map((part) => part.trim())
      .filter(Boolean);

    for (const part of parts.length ? parts : [line]) {
      const cleaned = normalizeSpotsyStreetEntry(part);
      if (!cleaned) continue;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      streets.push(cleaned);
    }
  }

  return streets;
}

// Support environment aliases for API keys
const OPENUV_API_KEY = process.env.OPENUV_API_KEY || process.env.OPENUV_KEY || "";
const WAQI_TOKEN = process.env.WAQI_TOKEN || process.env.WAQI_API_KEY || process.env.AQICN_TOKEN || "";

// Boot log: .env provenance (safe - no secrets)
(function logEnvProvenance() {
  const envPathToLog = loadedEnvPath || repoEnvPath;
  if (envPathToLog && fs.existsSync(envPathToLog)) {
    try {
      const stats = fs.statSync(envPathToLog);
      const content = fs.readFileSync(envPathToLog);
      const sha256 = crypto.createHash("sha256").update(content).digest("hex").slice(0, 8);
      console.log(`[env] .env=${envPathToLog} mtime=${stats.mtime.toISOString()} size=${stats.size} sha256=${sha256}...`);
    } catch (e) {
      console.log(`[env] .env=${envPathToLog} (could not stat: ${e.message})`);
    }
  } else {
    console.log("[env] .env not found");
  }
  // Log key lengths only (no secrets)
  console.log(`[env] OPENUV_API_KEY: ${OPENUV_API_KEY ? `present (${OPENUV_API_KEY.length} chars)` : "missing"}`);
  console.log(`[env] WAQI_TOKEN: ${WAQI_TOKEN ? `present (${WAQI_TOKEN.length} chars)` : "missing"}`);
})();

// Warn about optional API keys at startup
if (!OPENUV_API_KEY) {
  console.warn("[config] OPENUV_API_KEY (or OPENUV_KEY) not set; OpenUV endpoints disabled.");
}
if (!WAQI_TOKEN) {
  console.warn("[config] WAQI_TOKEN (or WAQI_API_KEY/AQICN_TOKEN) not set; WAQI endpoints disabled.");
}

const HOST = process.env.BIND || "0.0.0.0";
const PUBLIC_DIR = __dirname;

// Simple mime map
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".zip": "application/zip",
  ".bin": "application/octet-stream",
};

/**
 * Security: Allowlist of permitted upstream domains
 * Prevents open relay / SSRF attacks by restricting proxy targets
 */
const ALLOWED_UPSTREAM_DOMAINS = [
  // Weather
  'api.weather.gov',
  'weather.gov',
  'openuv.io',
  'api.openuv.io',

  // Traffic & Incidents
  '511virginia.org',
  'www.511virginia.org',
  '511.vdot.virginia.gov',
  'virginiaroads.org',
  'www.virginiaroads.org',
  'iteriscdn.com',
  'files4.iteriscdn.com',
  'files5.iteriscdn.com',

  // VDOT Traffic Cameras - New camera snapshot domain (2025+)
  // VA511 migrated camera snapshots to vdotcameras.com (snapshot.vdotcameras.com, media-sfs8.vdotcameras.com, etc.)
  'vdotcameras.com',

  // Virginia Crash Data
  'data.virginia.gov',
  'services1.arcgis.com',
  'services.arcgis.com',
  'gis.virginiadot.org',
  'utility.arcgis.com',
  'arcgis.com', // ArcGIS services (various subdomains)

  // Virginia Gov RSS Feeds
  'fredericksburgva.gov',
  'www.fredericksburgva.gov',
  'spotsylvania.va.us',
  'www.spotsylvania.va.us',
  'staffordcountyva.gov',
  'www.staffordcountyva.gov',
  'staffordschools.net',
  'www.staffordschools.net',
  'co.caroline.va.us',
  'warrentonva.gov',
  'www.warrentonva.gov',

  // Local News
  'potomaclocal.com',
  'www.potomaclocal.com',
  'fredericksburgfreepress.com',
  'www.fredericksburgfreepress.com',

  // Health Data
  'data.cdc.gov',
  'cdc.gov',

  // Air Quality
  'api.waqi.info',
  'waqi.info',

  // Geocoding
  'nominatim.openstreetmap.org',

  // External Cameras
  'wetmet.net',
  'api.wetmet.net',
  'app.oxblue.com',
  'oxblue.com',
  'hsm.hopto.me',
  'webcamgalore.com',
  'www.webcamgalore.com',
  'images.webcamgalore.com',

  // Map Tiles
  'cartodb-basemaps-a.global.ssl.fastly.net',
  'cartodb-basemaps-b.global.ssl.fastly.net',
  'cartodb-basemaps-c.global.ssl.fastly.net',
  'cartodb-basemaps-d.global.ssl.fastly.net',
  'global.ssl.fastly.net',

  // GIS / Map Services
  'maps.fredericksburgva.gov',
  'p5v98VHDX9Atv3l7.maps.arcgis.com', // VDOT ArcGIS subdomain
  'data-fredericksburg.opendata.arcgis.com',
  'gis.spotsylvania.va.us',

  // Testing/Dev (remove in production if needed)
  'httpbin.org',
  'www.httpbin.org',
];

function normalizeHost(host) {
  return String(host || "").trim().toLowerCase().replace(/^www\./, "");
}

const NORMALIZED_ALLOWED_HOSTS = new Set(ALLOWED_UPSTREAM_DOMAINS.map(normalizeHost));

function isAllowedHost(host) {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  for (const allowed of NORMALIZED_ALLOWED_HOSTS) {
    if (normalized === allowed) return true;
    if (normalized.endsWith(`.${allowed}`) && normalized.length > allowed.length + 1) return true;
  }
  return false;
}

function runAllowlistSanityCheck() {
  const cases = [
    ["www.staffordschools.net", true],
    ["staffordschools.net", true],
    ["files5.iteriscdn.com", true],
    ["eviliteriscdn.com", false],
    ["localhost", false]
  ];
  const failed = cases.filter(([host, expected]) => isAllowedHost(host) !== expected);
  if (failed.length === 0) {
    console.log("[allowlist] sanity check passed");
    return true;
  }
  console.error("[allowlist] sanity check failed", failed);
  return false;
}

const REQUIRED_UPSTREAMS = [
  {
    name: "VA511 Cameras API",
    url: "https://511.vdot.virginia.gov/services/map/layers/map/cams",
    expect: ["application/json"],
    required: true
  },
  {
    name: "VA511 Traffic Events API",
    url: "https://511.vdot.virginia.gov/services/map/layers/map/events",
    expect: ["application/json"],
    required: true
  },
  {
    name: "NWS Points API",
    url: "https://api.weather.gov/points/38.3032,-77.4605",
    expect: ["application/json"],
    required: true
  },
  {
    name: "Fredericksburg Crime Reports Page",
    url: "https://www.fredericksburgva.gov/1426/Crime-Reports",
    expect: ["text/html"],
    required: false
  },
  {
    name: "Snapshot Camera CDN",
    url: "https://snapshot.vdotcameras.com",
    expect: ["image/"],
    required: false
  }
];

const UPSTREAM_CACHE_TTLS = {
  // Crime incidents: 30m TTL, stale window 24h
  crimeIncidents: { ttlMs: 30 * 60 * 1000, staleTtlMs: 24 * 60 * 60 * 1000 },
  // Cameras/VDOT feeds: 5-15m TTL, 1h stale window (conservative defaults)
  va511Cameras: { ttlMs: 5 * 60 * 1000, staleTtlMs: 60 * 60 * 1000 },
  va511Events: { ttlMs: 10 * 60 * 1000, staleTtlMs: 60 * 60 * 1000 },
  nwsPoints: { ttlMs: 15 * 60 * 1000, staleTtlMs: 60 * 60 * 1000 },
  diagnostics: { ttlMs: 30 * 1000, staleTtlMs: 2 * 60 * 1000 },
  waqi: { ttlMs: 5 * 60 * 1000, staleTtlMs: 2 * 60 * 1000 }
};

const DIAG_TIMEOUT_MS = 8000;
const DIAG_CONCURRENCY = 3;
const upstreamLastSuccess = new Map();
const upstreamStatus = new Map();
const upstreamCache = createCache();
const upstreamTestRateLimit = new Map();
const UPSTREAM_TEST_RATE_LIMIT_MS = 10_000;

function updateUpstreamStatus(name, { ok, status, elapsedMs, cacheHit = false, stale = false, message } = {}) {
  if (!name) return;
  const existing = upstreamStatus.get(name) || {};
  const nowIso = new Date().toISOString();
  const next = {
    name,
    lastAttemptAt: nowIso,
    lastOkAt: ok ? nowIso : existing.lastOkAt || null,
    lastOk: typeof ok === "boolean" ? ok : existing.lastOk ?? null,
    lastStatus: status ?? existing.lastStatus ?? null,
    lastElapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : existing.lastElapsedMs ?? null,
    cacheHit: Boolean(cacheHit),
    stale: Boolean(stale),
    message: message || (!ok ? existing.message : null) || null
  };
  upstreamStatus.set(name, next);
}

/**
 * Private IP ranges to block (RFC 1918 + loopback + link-local)
 */
const PRIVATE_IP_PATTERNS = [
  /^127\./,           // 127.0.0.0/8 (loopback)
  /^10\./,            // 10.0.0.0/8 (private)
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,  // 172.16.0.0/12 (private)
  /^192\.168\./,      // 192.168.0.0/16 (private)
  /^169\.254\./,      // 169.254.0.0/16 (link-local)
  /^::1$/,            // IPv6 loopback
  /^fe80:/i,          // IPv6 link-local
  /^fc00:/i,          // IPv6 unique local
  /^fd00:/i,          // IPv6 unique local
];

/**
 * Blocked hostnames (case-insensitive)
 */
const BLOCKED_HOSTNAMES = [
  'localhost',
  '0.0.0.0',
  '127.0.0.1',
  '::1',
];

/**
 * Check if target URL is allowed by security policy
 * Returns { allowed: boolean, reason?: string }
 */
function checkUrlAllowed(targetUrl) {
  try {
    const url = new URL(targetUrl);
    const hostname = url.hostname.toLowerCase();
    const normalizedHostname = normalizeHost(hostname);

    // 1. Block non-http(s) protocols
    if (!['http:', 'https:'].includes(url.protocol)) {
      return {
        allowed: false,
        reason: `Protocol '${url.protocol}' not allowed (only http/https permitted)`
      };
    }

    // 2. Block localhost and special hostnames
    if (BLOCKED_HOSTNAMES.includes(hostname)) {
      return {
        allowed: false,
        reason: `Hostname '${hostname}' is blocked (localhost/loopback not permitted)`
      };
    }

    // 3. Block private IP ranges
    for (const pattern of PRIVATE_IP_PATTERNS) {
      if (pattern.test(hostname)) {
        return {
          allowed: false,
          reason: `IP address '${hostname}' is in private/reserved range`
        };
      }
    }

    // 4. Check allowlist (match hostname or parent domain)
    // Round 3: Fixed domain boundary check to prevent matches like 'evilarcgis.com' matching 'arcgis.com'
    const isAllowed = isAllowedHost(normalizedHostname);

    if (!isAllowed) {
      return {
        allowed: false,
        host: normalizedHostname,
        reason: `Domain '${normalizedHostname}' not in allowlist (see DEV_NOTES.md for permitted domains)`
      };
    }

    // All checks passed
    return { allowed: true, host: normalizedHostname };

  } catch (err) {
    return {
      allowed: false,
      reason: `Invalid URL: ${err.message}`
    };
  }
}

function isProxyRecursionTarget(targetUrl, req) {
  try {
    const parsed = new URL(targetUrl);
    const host = parsed.hostname.toLowerCase();
    const localHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
    if (localHosts.has(host)) return true;

    const forwardedHost = String(req.headers['x-forwarded-host'] || '').trim();
    const hostHeader = String(forwardedHost || req.headers.host || '').trim();
    if (!hostHeader) return false;

    const hostWithoutPort = normalizeHost(hostHeader.split(':')[0] || '');
    const requestPort = hostHeader.includes(':') ? hostHeader.split(':').pop() : String(PORT);
    const targetPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');

    return normalizeHost(host) === hostWithoutPort && String(targetPort) === String(requestPort);
  } catch {
    return false;
  }
}

function send(res, status, body, headers = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Cache-TTL-MS, X-Timeout-MS, X-Access-Token, X-Api-Key, X-Requested-With, Accept",
    "Content-Length": buffer.length,
    ...headers,
  });
  res.end(buffer);
}

// -------- Proxy cache + rate limits --------

/**
 * CacheManager - Bounded, leak-safe wrapper around Map-based cache
 * Features:
 * - Max entries cap (LRU eviction)
 * - Approximate memory cap (soft limit)
 * - TTL-based expiration with periodic cleanup
 * - No external dependencies
 */
class CacheManager {
  constructor(opts = {}) {
    this.maxEntries = opts.maxEntries || 500;
    this.maxBytes = opts.maxBytes || 50 * 1024 * 1024; // 50MB soft limit
    this.cleanupIntervalMs = opts.cleanupIntervalMs || 60 * 1000; // 60s

    this.cache = new Map(); // key -> { ts, ttlMs, status, headers, body:Buffer, accessTs }
    this.currentBytes = 0;

    // Start periodic cleanup timer
    this.cleanupTimer = setInterval(() => this._cleanup(), this.cleanupIntervalMs);

    // Ensure cleanup happens on process exit
    if (typeof process !== 'undefined') {
      process.once('beforeExit', () => this.destroy());
    }
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Update access timestamp for LRU
    entry.accessTs = Date.now();
    return entry;
  }

  set(key, entry) {
    // Estimate size (approximate)
    const bodySize = entry.body ? entry.body.length : 0;
    const metaSize = 500; // Rough estimate for headers + metadata
    const entrySize = bodySize + metaSize;

    // Remove old entry size if updating
    const oldEntry = this.cache.get(key);
    if (oldEntry) {
      const oldSize = (oldEntry.body?.length || 0) + 500;
      this.currentBytes = Math.max(0, this.currentBytes - oldSize);
    }

    // Add access timestamp for LRU
    entry.accessTs = Date.now();

    this.cache.set(key, entry);
    this.currentBytes += entrySize;

    // Enforce limits
    this._enforceLimits();
  }

  has(key) {
    return this.cache.has(key);
  }

  delete(key) {
    const entry = this.cache.get(key);
    if (entry) {
      const size = (entry.body?.length || 0) + 500;
      this.currentBytes = Math.max(0, this.currentBytes - size);
    }
    return this.cache.delete(key);
  }

  size() {
    return this.cache.size;
  }

  stats() {
    return {
      entries: this.cache.size,
      bytes: this.currentBytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes
    };
  }

  _cleanup() {
    const now = Date.now();
    let removed = 0;
    let survivedPastMaxTTL = 0;
    const MAX_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours - absolute max for any entry

    for (const [key, entry] of this.cache.entries()) {
      const age = now - entry.ts;

      // Warn if entry survived past its expected TTL significantly
      if (age > entry.ttlMs * 2 && entry.ttlMs > 0) {
        survivedPastMaxTTL++;
      }

      // Remove if expired or absurdly old (safety check)
      if (age > entry.ttlMs || age > MAX_TTL_MS) {
        const size = (entry.body?.length || 0) + 500;
        this.currentBytes = Math.max(0, this.currentBytes - size);
        this.cache.delete(key);
        removed++;
      }
    }

    if (survivedPastMaxTTL > 0) {
      console.warn(`[CacheManager] WARNING: ${survivedPastMaxTTL} entries survived past 2x their TTL (possible cleanup lag)`);
    }

    if (removed > 0) {
      console.log(`[CacheManager] Cleaned up ${removed} expired entries (${this.cache.size} remaining)`);
    }
  }

  _enforceLimits() {
    // Check entry count limit
    if (this.cache.size <= this.maxEntries && this.currentBytes <= this.maxBytes) {
      return; // Within limits
    }

    // WARN if approaching or exceeding hard limits
    const entryOverage = this.cache.size - this.maxEntries;
    const byteOverage = this.currentBytes - this.maxBytes;

    if (entryOverage > this.maxEntries * 0.1) {
      console.warn(`[CacheManager] WARNING: Cache size significantly exceeds limit (${this.cache.size} > ${this.maxEntries}, overage: ${entryOverage})`);
    }

    if (byteOverage > this.maxBytes * 0.1) {
      console.warn(`[CacheManager] WARNING: Cache bytes significantly exceed limit (${this.currentBytes} > ${this.maxBytes}, overage: ${Math.round(byteOverage / 1024 / 1024)} MB)`);
    }

    // Evict oldest accessed entries until within limits
    const entries = Array.from(this.cache.entries())
      .sort((a, b) => (a[1].accessTs || 0) - (b[1].accessTs || 0)); // Oldest first

    let evicted = 0;
    for (const [key, entry] of entries) {
      if (this.cache.size <= this.maxEntries && this.currentBytes <= this.maxBytes) {
        break;
      }

      const size = (entry.body?.length || 0) + 500;
      this.currentBytes = Math.max(0, this.currentBytes - size);
      this.cache.delete(key);
      evicted++;
    }

    if (evicted > 0) {
      console.log(`[CacheManager] Evicted ${evicted} entries (size: ${this.cache.size}, bytes: ${this.currentBytes})`);
    }
  }

  destroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

// Initialize cache manager
const cacheManager = new CacheManager({
  maxEntries: Number(process.env.CACHE_MAX_ENTRIES) || 500,
  maxBytes: Number(process.env.CACHE_MAX_BYTES) || 50 * 1024 * 1024,
  cleanupIntervalMs: 60 * 1000
});

// Legacy Map references (for backwards compatibility)
const cache = cacheManager; // Now uses CacheManager API
const inflight = new Map(); // key -> Promise<cacheEntry>
const hostLast = new Map(); // host -> ts
const hostBackoff = new Map(); // host -> { consecutiveErrors, backoffMs }
let activeFetches = 0;
const MAX_CONCURRENT = 3;
const MIN_INTERVAL_PER_HOST_MS = 600; // spacing per host to reduce 429 bursts
const DEFAULT_TIMEOUT_MS = 30000; // 30 second default timeout
const MAX_BACKOFF_ENTRIES = 200; // Cap hostBackoff map size to prevent unbounded growth

function nowMs() { return Date.now(); }
function cacheKey(url, accept) { return `${accept || ""}::${url}`; }

/**
 * Prune hostBackoff map if it grows too large
 * Removes entries with lowest error counts (least problematic hosts)
 */
function pruneHostBackoff() {
  if (hostBackoff.size <= MAX_BACKOFF_ENTRIES) return;

  // Sort by consecutive errors (ascending) and remove lowest-error entries
  const entries = Array.from(hostBackoff.entries())
    .sort((a, b) => a[1].consecutiveErrors - b[1].consecutiveErrors);

  const toRemove = hostBackoff.size - MAX_BACKOFF_ENTRIES;
  for (let i = 0; i < toRemove; i++) {
    hostBackoff.delete(entries[i][0]);
  }

  console.log(`[proxy] Pruned ${toRemove} entries from hostBackoff map (${hostBackoff.size} remaining)`);
}

/**
 * TTL Configuration Map (centralized policy)
 * Supports environment variable overrides via CACHE_TTL_<CATEGORY>=<ms>
 */
const TTL_CONFIG = {
  // By category/type
  weather: Number(process.env.CACHE_TTL_WEATHER) || 60 * 1000,           // 1 min
  traffic: Number(process.env.CACHE_TTL_TRAFFIC) || 90 * 1000,           // 1.5 min
  crashes: Number(process.env.CACHE_TTL_CRASHES) || 90 * 1000,           // 1.5 min
  rss: Number(process.env.CACHE_TTL_RSS) || 20 * 60 * 1000,             // 20 min
  cameras: Number(process.env.CACHE_TTL_CAMERAS) || 120 * 1000,          // 2 min
  uv: Number(process.env.CACHE_TTL_UV) || 30 * 60 * 1000,               // 30 min
  health: Number(process.env.CACHE_TTL_HEALTH) || 6 * 60 * 60 * 1000,   // 6 hours
  geocode: Number(process.env.CACHE_TTL_GEOCODE) || 7 * 24 * 60 * 60 * 1000, // 7 days
  default: Number(process.env.CACHE_TTL_DEFAULT) || 60 * 1000,           // 1 min

  // By hostname patterns
  hostPatterns: [
    { pattern: /api\.weather\.gov/i, ttl: 'weather' },
    { pattern: /511virginia\.org|511\.vdot\.virginia\.gov/i, ttl: 'traffic' },
    { pattern: /arcgis\.com|virginiaroads\.org/i, ttl: 'crashes' },
    { pattern: /data\.virginia\.gov/i, ttl: 'crashes' },
    { pattern: /api\.openuv\.io|openuv/i, ttl: 'uv' },
    { pattern: /data\.cdc\.gov|cdc\.gov/i, ttl: 'health' },
    { pattern: /nominatim\.openstreetmap\.org/i, ttl: 'geocode' },
  ],

  // By path patterns
  pathPatterns: [
    { pattern: /\.rss$|\/rss\/|\/feed\//i, ttl: 'rss' },
    { pattern: /\.(jpg|jpeg|png|webp|gif)($|\?)/i, ttl: 'cameras' },
  ]
};

const RSS_HEADER_HOSTS = [
  "fredericksburgva.gov",
  "spotsylvania.va.us",
  "staffordcountyva.gov",
  "staffordschools.net"
];

const RSS_ACCEPT_HEADER = "application/rss+xml, application/atom+xml, application/xml, text/xml, */*";
const RSS_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function shouldApplyRssHeaderShim(targetUrl, acceptHeader) {
  let host = "";
  let path = "";
  try {
    const url = new URL(targetUrl);
    host = url.hostname;
    path = url.pathname || "";
  } catch {
    return false;
  }

  const hostMatch = RSS_HEADER_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  if (!hostMatch) return false;

  const accept = String(acceptHeader || "").toLowerCase();
  const rssAccept = accept.includes("rss+xml") || accept.includes("atom+xml") || accept.includes("application/xml") || accept.includes("text/xml");
  const rssUrl = /RSSFeed\.aspx/i.test(targetUrl) || /\.(rss|xml)(\?|$)/i.test(path);
  return rssAccept || rssUrl;
}

function buildRssHeaderShim(targetUrl) {
  const url = new URL(targetUrl);
  const origin = `https://${url.hostname}`;
  return {
    "User-Agent": RSS_USER_AGENT,
    "Accept": RSS_ACCEPT_HEADER,
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": `${origin}/`,
    "Origin": origin
  };
}

function parseTtl(reqUrl, reqHeaders) {
  // 1. Check for explicit client hint header
  const hinted = Number(reqHeaders["x-cache-ttl-ms"] || 0);
  if (Number.isFinite(hinted) && hinted > 0) {
    return Math.min(hinted, 10 * 60 * 1000); // Cap at 10 minutes
  }

  try {
    const u = new URL(reqUrl);
    const h = u.hostname;
    const p = u.pathname.toLowerCase();

    // 2. Check hostname patterns
    for (const { pattern, ttl } of TTL_CONFIG.hostPatterns) {
      if (pattern.test(h)) {
        const category = typeof ttl === 'string' ? ttl : 'default';
        return TTL_CONFIG[category] || TTL_CONFIG.default;
      }
    }

    // 3. Check path patterns
    for (const { pattern, ttl } of TTL_CONFIG.pathPatterns) {
      if (pattern.test(p)) {
        const category = typeof ttl === 'string' ? ttl : 'default';
        return TTL_CONFIG[category] || TTL_CONFIG.default;
      }
    }
  } catch {}

  // 4. Default fallback
  return TTL_CONFIG.default;
}

/**
 * QQMS - Quality + Quantity Measurement System
 * Computes metadata about cached responses for observability
 * Returns scores and signals as HTTP headers (non-breaking)
 */
class QQMS {
  constructor() {
    this.errorCounts = new Map(); // url -> { count, windowStart }
    this.errorWindowMs = 5 * 60 * 1000; // 5-minute rolling window
  }

  recordError(url) {
    const now = Date.now();
    const existing = this.errorCounts.get(url);

    if (!existing || (now - existing.windowStart) > this.errorWindowMs) {
      this.errorCounts.set(url, { count: 1, windowStart: now });
    } else {
      existing.count++;
    }

    // Cleanup old entries periodically
    if (Math.random() < 0.01) { // 1% chance on each call
      for (const [key, val] of this.errorCounts.entries()) {
        if ((now - val.windowStart) > this.errorWindowMs) {
          this.errorCounts.delete(key);
        }
      }
    }
  }

  getErrorCount(url) {
    const now = Date.now();
    const existing = this.errorCounts.get(url);
    if (!existing || (now - existing.windowStart) > this.errorWindowMs) {
      return 0;
    }
    return existing.count;
  }

  /**
   * Compute quality signals for a cache entry
   */
  computeQuality(url, entry, wasStale = false) {
    const now = Date.now();
    const age = now - entry.ts;
    const freshnessRatio = Math.max(0, Math.min(1, 1 - (age / entry.ttlMs)));

    const errorCount = this.getErrorCount(url);
    const errorPenalty = Math.min(errorCount * 0.1, 0.5); // Max 50% penalty

    // Quality score (0-100)
    let quality = 100;
    quality *= freshnessRatio; // Decay with age
    quality *= (1 - errorPenalty); // Reduce if errors occurred
    quality *= wasStale ? 0.7 : 1.0; // Stale responses get 70% quality

    return {
      score: Math.round(quality),
      freshness: Math.round(freshnessRatio * 100),
      isStale: wasStale,
      age: age,
      errorCount: errorCount,
      statusReliable: entry.status === 200
    };
  }

  /**
   * Compute quantity signals for response body
   */
  computeQuantity(body, contentType = '') {
    const bytes = body?.length || 0;

    let itemCount = 0;
    let dataStructure = 'unknown';

    // Attempt to parse and count items
    if (contentType.includes('json') && bytes > 0 && bytes < 10 * 1024 * 1024) {
      const parsed = safeJsonParse(body.toString('utf8'), null, "qqms quantity");
      if (parsed) {
        dataStructure = 'json';

        if (Array.isArray(parsed)) {
          itemCount = parsed.length;
        } else if (parsed?.features && Array.isArray(parsed.features)) {
          itemCount = parsed.features.length;
          dataStructure = 'geojson';
        } else if (parsed?.items && Array.isArray(parsed.items)) {
          itemCount = parsed.items.length;
        } else if (typeof parsed === 'object') {
          itemCount = Object.keys(parsed).length;
        }
      }
    } else if (contentType.includes('xml') || contentType.includes('rss') || contentType.includes('atom')) {
      dataStructure = 'xml/rss';
      const text = body.toString('utf8', 0, Math.min(bytes, 500000));
      const itemMatches = text.match(/<item\b|<entry\b/gi);
      itemCount = itemMatches?.length || 0;
    } else if (contentType.includes('image')) {
      dataStructure = 'image';
      itemCount = 1;
    }

    return {
      bytes: bytes,
      items: itemCount,
      dataStructure: dataStructure,
      isEmpty: bytes === 0
    };
  }

  /**
   * Generate QQMS headers for HTTP response
   */
  generateHeaders(url, entry, wasStale = false) {
    const quality = this.computeQuality(url, entry, wasStale);
    const quantity = this.computeQuantity(entry.body, entry.headers?.['Content-Type']);

    // Combined score (quality weighted 70%, quantity presence weighted 30%)
    const quantityScore = quantity.isEmpty ? 0 : Math.min(100, 50 + Math.log10(quantity.items + 1) * 20);
    const combined = Math.round(quality.score * 0.7 + quantityScore * 0.3);

    return {
      'X-QQMS-Score': String(combined),
      'X-QQMS-Quality': String(quality.score),
      'X-QQMS-Freshness': String(quality.freshness),
      'X-QQMS-Stale': wasStale ? '1' : '0',
      'X-QQMS-Age-Ms': String(quality.age),
      'X-QQMS-Items': String(quantity.items),
      'X-QQMS-Bytes': String(quantity.bytes),
      'X-QQMS-Structure': quantity.dataStructure,
    };
  }
}

const qqms = new QQMS();

/**
 * Record successful fetch for host (reset backoff)
 */
function recordHostSuccess(host) {
  hostBackoff.delete(host);
}

/**
 * Record failed fetch for host (escalate backoff)
 */
function recordHostError(host) {
  const existing = hostBackoff.get(host) || { consecutiveErrors: 0, backoffMs: MIN_INTERVAL_PER_HOST_MS };
  const newErrors = existing.consecutiveErrors + 1;
  // Exponential backoff: 600ms -> 1200ms -> 2400ms -> 4800ms -> max 10s
  const newBackoff = Math.min(MIN_INTERVAL_PER_HOST_MS * Math.pow(2, newErrors), 10000);
  hostBackoff.set(host, { consecutiveErrors: newErrors, backoffMs: newBackoff });

  console.log(`[proxy] Host ${host} backoff: ${newErrors} errors, ${newBackoff}ms delay`);

  // Prune map if it grows too large (safety cap)
  pruneHostBackoff();
}

async function waitForSlot(host) {
  while (activeFetches >= MAX_CONCURRENT) {
    await new Promise((r) => setTimeout(r, 40));
  }

  const last = hostLast.get(host) || 0;
  const backoffInfo = hostBackoff.get(host);
  const minInterval = backoffInfo?.backoffMs || MIN_INTERVAL_PER_HOST_MS;

  const delta = nowMs() - last;
  if (delta < minInterval) {
    await new Promise((r) => setTimeout(r, minInterval - delta));
  }
}

/**
 * Generate short random request ID for tracing
 * Format: 8 alphanumeric characters (e.g., "a3f9b2c1")
 */
function generateRequestId() {
  return Math.random().toString(36).substring(2, 10);
}

function buildProxyErrorEntry({
  status = 502,
  errorCode,
  upstreamHost,
  message,
  elapsedMs,
  requestId
}) {
  const body = Buffer.from(JSON.stringify({
    ok: false,
    error: errorCode || "upstream_error",
    upstream: upstreamHost || "unknown",
    status,
    message: message || "Upstream error"
  }));
  return {
    ts: nowMs(),
    ttlMs: 5000,
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Proxy-Error": errorCode || "upstream_error",
      "X-Proxy-Upstream-Host": upstreamHost || "unknown",
      "X-Proxy-Cache-State": "miss",
      "X-Proxy-Elapsed-MS": String(elapsedMs || 0),
      "X-Proxy-Request-ID": requestId || generateRequestId()
    },
    body
  };
}

function expectedTypeFromExpectList(expectList = []) {
  const list = expectList.map(entry => String(entry).toLowerCase());
  if (list.some(entry => entry.includes("json"))) return "json";
  if (list.some(entry => entry.includes("text/html") || entry.includes("text/plain"))) return "html";
  if (list.some(entry => entry.includes("image/"))) return "image";
  return null;
}

async function fetchUpstreamWithLimits(url, { expectedType = null, timeoutMs = DIAG_TIMEOUT_MS, name = "Upstream Diagnostics", route } = {}) {
  const start = Date.now();
  const result = await runUpstreamFetch(name, url, {
    route,
    expectedType,
    timeoutMs,
    headers: {
      "User-Agent": "FXBG-PALANTIR-CityManager/1.0 (diagnostics)"
    }
  });

  if (!result.ok) {
    const errorCode = result.error || (result.status ? `http_${result.status}` : "fetch_failed");
    throw new UpstreamError(errorCode, result.error || "Upstream fetch failed");
  }

  return {
    ok: result.ok,
    status: result.status,
    contentType: result.contentType,
    bytes: result.bytes || 0,
    ms: Date.now() - start
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

async function validateRequiredUpstreams() {
  const failures = [];
  for (const upstream of REQUIRED_UPSTREAMS) {
    const expectedType = expectedTypeFromExpectList(upstream.expect);
    let success = false;
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await fetchUpstreamWithLimits(upstream.url, {
          expectedType,
          timeoutMs: DIAG_TIMEOUT_MS,
          name: upstream.name,
          route: "startup-validation"
        });
        if (result.status === 200) {
          success = true;
          upstreamLastSuccess.set(upstream.name, new Date().toISOString());
          logApp({
            level: "INFO",
            kind: "upstream_validation",
            msg: "Required upstream ok",
            url: redactUrl(upstream.url),
            status: result.status,
            ms: result.ms,
            contentType: result.contentType,
            bytes: result.bytes
          });
          break;
        }
        lastError = new UpstreamError(`http_${result.status}`, `HTTP ${result.status}`);
      } catch (err) {
        lastError = err;
      }
    }

    if (!success) {
      const errorCode = lastError?.code || "unreachable";
      logApp({
        level: upstream.required ? "ERROR" : "WARN",
        kind: "upstream_validation",
        msg: "Required upstream failed",
        url: redactUrl(upstream.url),
        errorCode
      });
      if (upstream.required) {
        failures.push(`${upstream.name} (${errorCode})`);
      }
    }
  }

  if (failures.length > 0) {
    // Graceful degradation: warn but don't exit
    // Server should still start even if upstreams are temporarily unavailable
    console.warn(`[startup] Required upstreams unavailable (will retry on demand): ${failures.join(", ")}`);
    console.warn("[startup] Server will start anyway - some features may be degraded until upstreams recover.");
  }
}

async function proxyFetch(targetUrl, reqHeaders) {
  const accept = String(reqHeaders["accept"] || "");
  const expectedType = inferExpectedType(accept);
  const key = cacheKey(targetUrl, accept);
  const requestId = generateRequestId();
  const startTime = Date.now();

  const cached = cache.get(key);
  const isFresh = cached && (nowMs() - cached.ts) < cached.ttlMs;
  if (isFresh) {
    // Add QQMS headers to fresh cache hit
    const qqmsHeaders = qqms.generateHeaders(targetUrl, cached, false);
    const elapsed = Date.now() - startTime;
    let upstreamHost = '';
    try { upstreamHost = new URL(targetUrl).hostname; } catch {}

    logProxyOutcome({
      url: targetUrl,
      status: cached.status,
      cacheState: "hit",
      upstreamHost,
      elapsedMs: elapsed
    });

    return {
      ...cached,
      headers: {
        ...cached.headers,
        ...qqmsHeaders,
        'X-Proxy-Request-ID': requestId,
        'X-Proxy-Upstream-Host': upstreamHost,
        'X-Proxy-Cache-State': 'hit',
        'X-Proxy-Elapsed-MS': String(elapsed)
      }
    };
  }
  const staleCandidate = cached || null;

  if (inflight.has(key)) return inflight.get(key);

  const ttlMs = parseTtl(targetUrl, reqHeaders);

  const prom = (async () => {
    let u;
    try { u = new URL(targetUrl); } catch { throw new Error("Invalid URL"); }

    const upstreamHost = u.hostname;

    // Auto-upgrade Iteris CDN from http to https
    let finalUrl = targetUrl;
    if ((upstreamHost === 'files4.iteriscdn.com' || upstreamHost === 'files5.iteriscdn.com') &&
        u.protocol === 'http:') {
      finalUrl = targetUrl.replace('http://', 'https://');
      console.log(`[proxy] Auto-upgrading Iteris CDN to HTTPS: ${upstreamHost}`);
    }

    await waitForSlot(u.hostname);
    activeFetches++;
    hostLast.set(u.hostname, nowMs());

    try {
      // Node 18+ has global fetch
      let upstream;
      try {
      // Build headers with better User-Agent and optional Referer for specific sites
      const upstreamHeaders = {
        // Disable gzip/deflate so we can cache raw bytes uniformly
        "Accept-Encoding": "identity",
        "Accept-Language": "en-US,en;q=0.9",
        // Use realistic browser User-Agent to avoid blocking
        "User-Agent": reqHeaders["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        // Allow callers to hint a specific Accept header via the incoming request; fallback to */*
        "Accept": accept || "*/*",
      };

      // Forward important custom headers from the client
      // This is critical for APIs that require authentication headers (OpenUV, etc.)
      const headersToForward = [
        "x-access-token",      // OpenUV API authentication
        "x-api-key",           // Generic API key header
        "authorization",       // Standard auth header
        "x-requested-with",    // AJAX indicator
      ];

      for (const headerName of headersToForward) {
        if (reqHeaders[headerName]) {
          upstreamHeaders[headerName] = reqHeaders[headerName];
        }
      }

      // VA511 camera snapshot fix: Override Referer/Origin for VA511 hosts to prevent 403
      // VA511 enforces anti-hotlinking and rejects requests with localhost referer
      // Include iteriscdn.com which hosts VA511 GeoJSON data (incidents, cameras, etc.)
      const targetHost = new URL(targetUrl).hostname;
      const isVa511Host = targetHost.includes("511virginia.org") ||
                          targetHost.includes("511.vdot.virginia.gov") ||
                          targetHost.includes("iteriscdn.com");

      if (isVa511Host) {
        // Force approved VA511 referrer/origin (overrides client's localhost referer)
        upstreamHeaders["Referer"] = "https://511.vdot.virginia.gov/";
        upstreamHeaders["Origin"] = "https://511.vdot.virginia.gov";
      } else {
        // For non-VA511 hosts, use existing referer logic
        // Add Referer if provided by client
        if (reqHeaders["referer"]) {
          upstreamHeaders["Referer"] = reqHeaders["referer"];
        } else {
          // Set appropriate referer based on target URL
          try {
            if (targetHost.includes("fredericksburgva.gov") || targetHost.includes("spotsylvania.va.us")) {
              upstreamHeaders["Referer"] = `https://${targetHost}/`;
            } else if (targetHost.includes("openuv.io") || targetHost.includes("data.cdc.gov")) {
              // Set referer for health/UV APIs to look more legitimate
              upstreamHeaders["Referer"] = `https://${targetHost}/`;
            }
          } catch {}
        }
      }

      if (shouldApplyRssHeaderShim(targetUrl, accept)) {
        Object.assign(upstreamHeaders, buildRssHeaderShim(targetUrl));
      }

      // Add timeout support via AbortController
      const timeoutMs = Number(reqHeaders["x-timeout-ms"]) || DEFAULT_TIMEOUT_MS;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        upstream = await fetch(finalUrl, {
          method: "GET",
          redirect: "follow",
          headers: upstreamHeaders,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
      } finally {
        clearTimeout(timeoutId);
      }
      } catch (e) {
        console.error(`[proxy] Fetch error for ${targetUrl}:`, e.message || String(e));
        recordHostError(u.hostname);
        qqms.recordError(targetUrl);
        if (staleCandidate) {
          console.log(`[proxy] Using stale cache for ${targetUrl} (fetch error: ${e.message || 'unknown'})`);
          const qqmsHeaders = qqms.generateHeaders(targetUrl, staleCandidate, true);
          const elapsed = Date.now() - startTime;
          logProxyOutcome({
            url: targetUrl,
            status: 200,
            cacheState: "stale",
            upstreamHost,
            elapsedMs: elapsed,
            error: e.message || "fetch_error"
          });
          return {
            ...staleCandidate,
            headers: {
              ...staleCandidate.headers,
              "X-Proxy-Stale": "1",
              "X-Proxy-Cache-Used": "stale",
              "X-Proxy-Error": "fetch_failed",
              'X-Proxy-Request-ID': requestId,
              'X-Proxy-Upstream-Host': upstreamHost,
              'X-Proxy-Cache-State': 'stale',
              'X-Proxy-Elapsed-MS': String(elapsed),
              ...qqmsHeaders
            },
            ts: staleCandidate.ts,
            ttlMs: staleCandidate.ttlMs,
            status: 200,
          };
        }
        throw e;
      }

      // For 403 Forbidden, 429 rate limit, 502 Bad Gateway, or server errors, return stale cache if available
      if (staleCandidate && (upstream.status === 403 || upstream.status === 429 || upstream.status === 502 || upstream.status >= 500 || upstream.status === 404)) {
        console.log(`[proxy] Using stale cache for ${targetUrl} (upstream ${upstream.status})`);

        // Enhanced debug output for 403 responses (anti-hotlinking detection)
        if (upstream.status === 403) {
          const upstreamContentType = upstream.headers.get("content-type") || "unknown";
          const bodyPreview = await upstream.text().catch(() => "");
          const preview = bodyPreview.slice(0, 100);
          console.warn(`[proxy] 403 FORBIDDEN DEBUG:`);
          console.warn(`  Host: ${upstreamHost}`);
          console.warn(`  Content-Type: ${upstreamContentType}`);
          console.warn(`  Body preview: ${preview}`);
        }

        recordHostError(u.hostname);
        qqms.recordError(targetUrl);
        const qqmsHeaders = qqms.generateHeaders(targetUrl, staleCandidate, true);
        const elapsed = Date.now() - startTime;
        logProxyOutcome({
          url: targetUrl,
          status: 200,
          cacheState: "stale",
          upstreamHost,
          elapsedMs: elapsed,
          error: `upstream_${upstream.status}`
        });
        return {
          ...staleCandidate,
          headers: {
            ...staleCandidate.headers,
            "X-Proxy-Stale": "1",
            "X-Proxy-Upstream-Status": String(upstream.status),
            "X-Proxy-Cache-Used": "stale",
            'X-Proxy-Request-ID': requestId,
            'X-Proxy-Upstream-Host': upstreamHost,
            'X-Proxy-Cache-State': 'stale',
            'X-Proxy-Elapsed-MS': String(elapsed),
            ...qqmsHeaders
          },
          status: 200,
        };
      }

      // Success - reset backoff
      if (upstream.status === 200) {
        recordHostSuccess(u.hostname);
      }

      // Enhanced debug logging for non-200 responses
      if (upstream.status !== 200) {
        const upstreamContentType = upstream.headers.get("content-type") || "unknown";
        console.warn(`[proxy] ${upstreamHost} returned HTTP ${upstream.status} (Content-Type: ${upstreamContentType})`);

        // For 403s without stale cache, log additional debug info
        if (upstream.status === 403) {
          const bodyPreview = Buffer.from(await upstream.clone().arrayBuffer()).toString('utf8', 0, 100);
          console.warn(`[proxy] 403 FORBIDDEN DEBUG:`);
          console.warn(`  Host: ${upstreamHost}`);
          console.warn(`  URL: ${targetUrl}`);
          console.warn(`  Body preview: ${bodyPreview}`);
        }
      }

      // If we get 404 and have no stale cache, return the error
      if (upstream.status === 404) {
        recordHostError(u.hostname);
        qqms.recordError(targetUrl);
        const elapsed = Date.now() - startTime;
        const errorBody = Buffer.from(JSON.stringify({
          ok: false,
          error: "Not Found",
          upstream: upstreamHost,
          status: 404,
          message: "The requested resource was not found. Check the URL and try again."
        }));
        const entry404 = {
          ts: nowMs(),
          ttlMs: 5000, // Cache 404s for 5 seconds to avoid hammering
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "X-Proxy-Error": "upstream_404",
            'X-Proxy-Request-ID': requestId,
            'X-Proxy-Upstream-Host': upstreamHost,
            'X-Proxy-Cache-State': 'miss',
            'X-Proxy-Elapsed-MS': String(elapsed)
          },
          body: errorBody
        };
        const qqmsHeaders = qqms.generateHeaders(targetUrl, entry404, false);
        entry404.headers = { ...entry404.headers, ...qqmsHeaders };
        logProxyOutcome({
          url: targetUrl,
          status: 404,
          cacheState: "miss",
          upstreamHost,
          elapsedMs: elapsed,
          error: "upstream_404"
        });
        return entry404;
      }

      const contentType = upstream.headers.get("content-type") || "application/octet-stream";
      let buf;
      try {
        const limitBytes = resolvePayloadLimit(contentType, expectedType);
        const isLayerDownload = isLayerDownloadRequest(finalUrl, accept);
        const effectiveLimit = isLayerDownload ? Math.min(limitBytes, MAX_LAYER_BYTES) : limitBytes;
        if (isLayerDownload) {
          const contentLength = Number(upstream.headers.get("content-length"));
          if (Number.isFinite(contentLength) && contentLength > MAX_LAYER_BYTES) {
            const maxMb = Math.round(MAX_LAYER_BYTES / (1024 * 1024));
            throw new UpstreamError("payload_too_large", `Layer payload exceeds ${maxMb}MB limit`);
          }
        }
        buf = await readResponseBodyWithLimit(upstream, effectiveLimit);
      } catch (err) {
        if (err instanceof UpstreamError && err.code === "payload_too_large") {
          logApp({
            level: "WARN",
            kind: "payload_violation",
            msg: "Proxy payload limit exceeded",
            url: redactUrl(targetUrl),
            contentType,
            errorCode: err.code
          });
          const elapsed = Date.now() - startTime;
          const errorEntry = buildProxyErrorEntry({
            status: 413,
            errorCode: err.code,
            upstreamHost,
            message: err.message,
            elapsedMs: elapsed,
            requestId
          });
          const qqmsHeaders = qqms.generateHeaders(targetUrl, errorEntry, false);
          errorEntry.headers = { ...errorEntry.headers, ...qqmsHeaders };
          logProxyOutcome({
            url: targetUrl,
            status: 413,
            cacheState: "miss",
            upstreamHost,
            elapsedMs: elapsed,
            error: err.code
          });
          return errorEntry;
        }
        throw err;
      }

      const validation = validateContentType(expectedType, contentType, buf);
      if (!validation.ok) {
        logApp({
          level: "WARN",
          kind: "parse_failure",
          msg: "Proxy content type mismatch",
          url: redactUrl(targetUrl),
          contentType,
          errorCode: validation.errorCode
        });
        const elapsed = Date.now() - startTime;
        const errorEntry = buildProxyErrorEntry({
          status: 502,
          errorCode: validation.errorCode,
          upstreamHost,
          message: `Unexpected content type: ${contentType || "unknown"}`,
          elapsedMs: elapsed,
          requestId
        });
        const qqmsHeaders = qqms.generateHeaders(targetUrl, errorEntry, false);
        errorEntry.headers = { ...errorEntry.headers, ...qqmsHeaders };
        logProxyOutcome({
          url: targetUrl,
          status: 502,
          cacheState: "miss",
          upstreamHost,
          elapsedMs: elapsed,
          error: validation.errorCode
        });
        return errorEntry;
      }

      // Log empty responses for debugging
      if (buf.length === 0) {
        console.warn(`[proxy] WARNING: ${targetUrl} returned empty response (0 bytes)`);
        console.warn(`[proxy]   Content-Type: ${contentType}`);
        console.warn(`[proxy]   Accept: ${accept}`);
      }

      // Validate response content for JSON/XML endpoints
      // Detect HTML responses when JSON/XML is expected to catch proxy errors
      const isTextContent = contentType.includes("text/") || contentType.includes("json") || contentType.includes("xml");
      if (isTextContent && buf.length > 0 && buf.length < 500000) { // Only check reasonable-sized text responses
        const preview = buf.toString('utf8', 0, Math.min(500, buf.length));
        const looksLikeHtml = /^\s*<!DOCTYPE html/i.test(preview) || /^\s*<html/i.test(preview);

        // Check if caller expected JSON/XML based on Accept header or content-type
        const expectsStructuredData = contentType.includes("json") || contentType.includes("xml") ||
                                       accept.includes("json") || accept.includes("xml") ||
                                       accept.includes("geojson") || accept.includes("rss") || accept.includes("atom");

        if (looksLikeHtml && expectsStructuredData) {
          console.warn(`[proxy] WARNING: ${targetUrl} returned HTML when structured data expected (Accept: ${accept})`);
          console.warn(`[proxy]   Preview: ${preview.slice(0, 200)}`);
          // Return stale cache if available for HTML error pages
          if (staleCandidate) {
            console.log(`[proxy] Using stale cache instead of HTML error page`);
            recordHostError(u.hostname);
            qqms.recordError(targetUrl);
            const qqmsHeaders = qqms.generateHeaders(targetUrl, staleCandidate, true);
            const elapsed = Date.now() - startTime;
            logProxyOutcome({
              url: targetUrl,
              status: 200,
              cacheState: "stale",
              upstreamHost,
              elapsedMs: elapsed,
              error: "html_instead_of_data"
            });
            return {
              ...staleCandidate,
              headers: {
                ...staleCandidate.headers,
                "X-Proxy-Stale": "1",
                "X-Proxy-Error": "html_instead_of_data",
                "X-Proxy-Cache-Used": "stale",
                "X-Proxy-Upstream-Status": String(upstream.status),
                'X-Proxy-Request-ID': requestId,
                'X-Proxy-Upstream-Host': upstreamHost,
                'X-Proxy-Cache-State': 'stale',
                'X-Proxy-Elapsed-MS': String(elapsed),
                ...qqmsHeaders
              },
              status: 200,
            };
          } else {
            // No stale cache available - return structured error JSON instead of HTML
            console.error(`[proxy] No stale cache available, returning error JSON for HTML response`);
            recordHostError(u.hostname);
            qqms.recordError(targetUrl);
            const elapsed = Date.now() - startTime;
            const errorBody = Buffer.from(JSON.stringify({
              ok: false,
              error: "html_instead_of_data",
              upstream: upstreamHost,
              status: upstream.status,
              message: "Upstream returned HTML when structured data (JSON/XML) was expected. This usually indicates a block page, error page, or misconfigured endpoint.",
              hint: "Check if the API endpoint requires authentication or has changed URLs."
            }));
            const errorEntry = {
              ts: nowMs(),
              ttlMs: 5000, // Cache error for 5 seconds to avoid hammering
              status: 502,
              headers: {
                "Content-Type": "application/json",
                "X-Proxy-Error": "html_instead_of_data",
                "X-Proxy-Upstream-Status": String(upstream.status),
                'X-Proxy-Request-ID': requestId,
                'X-Proxy-Upstream-Host': upstreamHost,
                'X-Proxy-Cache-State': 'miss',
                'X-Proxy-Elapsed-MS': String(elapsed)
              },
              body: errorBody
            };
            const qqmsHeaders = qqms.generateHeaders(targetUrl, errorEntry, false);
            errorEntry.headers = { ...errorEntry.headers, ...qqmsHeaders };
            logProxyOutcome({
              url: targetUrl,
              status: 502,
              cacheState: "miss",
              upstreamHost,
              elapsedMs: elapsed,
              error: "html_instead_of_data"
            });
            return errorEntry;
          }
        }
      }

      const elapsed = Date.now() - startTime;
      const entry = {
        ts: nowMs(),
        ttlMs: upstream.status === 429 ? Math.min(ttlMs, 15_000) : ttlMs,
        status: upstream.status,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "no-store",
          "X-Proxy-Cache-TTL": String(ttlMs),
          "X-Proxy-Upstream-Status": String(upstream.status),
          "X-Proxy-Cache-Fresh": "1",
          'X-Proxy-Request-ID': requestId,
          'X-Proxy-Upstream-Host': upstreamHost,
          'X-Proxy-Cache-State': 'fresh',
          'X-Proxy-Elapsed-MS': String(elapsed)
        },
        body: buf,
      };

      // Add QQMS headers to fresh upstream response
      const qqmsHeaders = qqms.generateHeaders(targetUrl, entry, false);
      entry.headers = { ...entry.headers, ...qqmsHeaders };

      cache.set(key, entry);
      logProxyOutcome({
        url: targetUrl,
        status: upstream.status,
        cacheState: "fresh",
        upstreamHost,
        elapsedMs: elapsed
      });
      return entry;
    } finally {
      activeFetches = Math.max(0, activeFetches - 1);
      inflight.delete(key);
    }
  })();

  inflight.set(key, prom);
  return prom;
}

// -------- static --------
function serveStatic(req, res) {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  let reqPath = urlObj.pathname;
  if (reqPath === "/") reqPath = "/index.html";

  const safe = path.normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(PUBLIC_DIR, safe);

  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden");
  if (!fs.existsSync(filePath)) return send(res, 404, "Not found");

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  fs.createReadStream(filePath).pipe(res);
}

// Track server start time for uptime
const SERVER_START_TIME = Date.now();

// =============================================================================
// CRIME REPORTS - Real PDF Scraping Implementation
// =============================================================================

const FXBG_CRIME_REPORTS_URL = "https://www.fredericksburgva.gov/1426/Crime-Reports";
const FXBG_DOCUMENT_CENTER_BASE = "https://www.fredericksburgva.gov/DocumentCenter/View/";

// Crime reports refresh state (for throttling and status)
const crimeReportsState = {
  lastRefreshAttempt: null,
  lastRefreshOk: false,
  lastRefreshMessage: null,
  lastUpdated: null,
  pdfCount: 0,
  incidentsCount: 0,
  lastResult: null,
  lastResultTimestamp: 0
};
const CRIME_REFRESH_THROTTLE_MS = 10000; // 10 second throttle

// Geocode cache for RSS + crime report locations
const geocodeCache = new Map();
const geocodeInflight = new Map();
const GEOCODE_CACHE_FILE = path.join(__dirname, "data", "geocode-cache.json");
const GEOCODE_CACHE_VERSION = 1;
const GEOCODE_SAVE_DEBOUNCE_MS = 1500;
let geocodeSaveTimer = null;
let lastUpstreamFetchTs = 0;
let geocodeUpstreamQueue = Promise.resolve();

const GEOCODE_AOI = {
  minLat: 38.15,
  maxLat: 38.40,
  minLon: -77.70,
  maxLon: -77.30
};

const GENERIC_LOCATION_WORDS = new Set([
  "downtown", "vicinity", "area", "region", "nearby", "neighborhood",
  "district", "zone", "city", "town", "county", "center"
]);

const GEO_STREET_TOKENS = [
  "st", "street", "ave", "avenue", "rd", "road", "blvd", "boulevard",
  "dr", "drive", "ct", "court", "ln", "lane", "pkwy", "parkway",
  "hwy", "highway", "route", "rt", "pl", "place", "ter", "terrace",
  "way", "cir", "circle"
];

const LOCAL_JURISDICTIONS = new Set([
  "fredericksburg",
  "stafford",
  "spotsylvania",
  "caroline",
  "king george",
  "orange",
  "culpeper",
  "regional"
]);

function hasStateInQuery(value) {
  const q = String(value || "");
  return /\b(va|virginia)\b/i.test(q);
}

function ensureVirginiaQuery(query, jurisdiction) {
  const j = String(jurisdiction || "").toLowerCase();
  if (!LOCAL_JURISDICTIONS.has(j)) return query;
  if (hasStateInQuery(query)) return query;
  return `${query}, Virginia`;
}

function normalizeKeyPart(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s&/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKey(query, jurisdiction) {
  const q = normalizeKeyPart(query);
  const j = normalizeKeyPart(jurisdiction);
  return `${q}||${j}`;
}

function isWithinAoi(lat, lon) {
  return lat >= GEOCODE_AOI.minLat &&
    lat <= GEOCODE_AOI.maxLat &&
    lon >= GEOCODE_AOI.minLon &&
    lon <= GEOCODE_AOI.maxLon;
}

function inferLowConfidence(query) {
  const normalized = normalizeKeyPart(query);
  if (!normalized) return true;
  const tokens = normalized.split(" ");
  const hasNumber = tokens.some(token => /\d/.test(token));
  const hasStreetToken = tokens.some(token => GEO_STREET_TOKENS.includes(token));
  const hasNonGeneric = tokens.some(token => !GENERIC_LOCATION_WORDS.has(token));
  return !hasNumber && !hasStreetToken && !hasNonGeneric;
}

function scheduleGeocodeSave() {
  if (geocodeSaveTimer) clearTimeout(geocodeSaveTimer);
  geocodeSaveTimer = setTimeout(() => {
    saveGeocodeCache().catch((err) => {
      console.warn("[Geocode] Failed to save cache:", err.message);
    });
  }, GEOCODE_SAVE_DEBOUNCE_MS);
}

// Load geocode cache on startup
async function loadGeocodeCache() {
  try {
    const data = await fsp.readFile(GEOCODE_CACHE_FILE, "utf8");
    const parsed = safeJsonParse(data, null, "geocode cache");
    if (parsed && typeof parsed === "object") {
      const items = parsed.items && typeof parsed.items === "object" ? parsed.items : parsed;
      for (const [key, value] of Object.entries(items || {})) {
        if (!value || typeof value !== "object") continue;
        if (!Number.isFinite(value.lat) || !Number.isFinite(value.lon)) continue;
        geocodeCache.set(key, {
          lat: Number(value.lat),
          lon: Number(value.lon),
          ts: Number.isFinite(value.ts) ? value.ts : Date.now(),
          source: value.source === "cache" ? "cache" : "nominatim"
        });
      }
      console.log(`[Geocode] Loaded ${geocodeCache.size} cached locations`);
    }
  } catch (e) {
    // Cache file doesn't exist yet
  }
}

// Save geocode cache
async function saveGeocodeCache() {
  const dataDir = path.dirname(GEOCODE_CACHE_FILE);
  await fsp.mkdir(dataDir, { recursive: true });
  const obj = {
    version: GEOCODE_CACHE_VERSION,
    updatedAt: new Date().toISOString(),
    items: Object.fromEntries(geocodeCache)
  };
  await fsp.writeFile(GEOCODE_CACHE_FILE, JSON.stringify(obj, null, 2), "utf8");
}

async function runUpstreamFetch(name, url, options = {}) {
  const result = await upstreamFetch(url, {
    upstreamName: name,
    route: options.route,
    expectedType: options.expectedType,
    allowJsonp: options.allowJsonp,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    headers: options.headers,
    accept: options.accept,
    method: options.method,
    includeBodyText: options.includeBodyText,
    includeBodyBuffer: options.includeBodyBuffer,
    cacheState: options.cacheState || "miss",
    logger: logUpstream
  });

  updateUpstreamStatus(name, {
    ok: result.ok,
    status: result.status,
    elapsedMs: result.elapsedMs,
    cacheHit: options.cacheState === "hit",
    stale: options.cacheState === "stale",
    message: result.error || (result.warnings ? result.warnings.join("; ") : null)
  });

  return result;
}

function scoreGeocodeResult(result) {
  const lat = Number(result.lat);
  const lon = Number(result.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { score: -Infinity, lat, lon, insideAoi: false };
  }

  const insideAoi = isWithinAoi(lat, lon);
  const importance = Number(result.importance) || 0;
  const classWeight = {
    place: 3,
    highway: 2.5,
    amenity: 2.5,
    boundary: 2,
    building: 1.5,
    tourism: 1.5,
    leisure: 1.2,
    shop: 1.0,
    railway: 1.0,
    landuse: 0.6
  }[result.class] || 0;
  const typeWeight = {
    city: 2,
    town: 2,
    village: 1.5,
    hamlet: 1.2,
    road: 1.2,
    residential: 1.0,
    primary: 1.0,
    secondary: 0.9,
    tertiary: 0.8,
    house: 0.6,
    neighbourhood: 0.5
  }[result.type] || 0;

  const score = (insideAoi ? 5 : 0) + (importance * 2) + classWeight + typeWeight;
  return { score, lat, lon, insideAoi };
}

async function scheduleGeocodeUpstreamFetch(fn) {
  const run = geocodeUpstreamQueue.then(async () => {
    const now = Date.now();
    const waitMs = Math.max(0, lastUpstreamFetchTs + 1000 - now);
    if (waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    lastUpstreamFetchTs = Date.now();
    return fn();
  });
  geocodeUpstreamQueue = run.catch(() => {});
  return run;
}

async function fetchNominatimResults(query) {
  const params = new URLSearchParams({
    format: "json",
    q: query,
    limit: "5",
    countrycodes: "us",
    viewbox: `${GEOCODE_AOI.minLon},${GEOCODE_AOI.maxLat},${GEOCODE_AOI.maxLon},${GEOCODE_AOI.minLat}`,
    bounded: "0"
  });
  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;

  return scheduleGeocodeUpstreamFetch(async () => {
    const response = await runUpstreamFetch("Nominatim Geocode", url, {
      accept: "application/json",
      headers: {
        "User-Agent": "FXBG-PALANTIR-CityManager/1.0 (server-geocode)"
      },
      timeoutMs: 15000,
      expectedType: "json",
      maxBytes: PAYLOAD_LIMITS.json
    });

    if (response.status !== 200 || !response.ok) {
      throw new UpstreamError(response.status || 500, response.error || "nominatim_failed");
    }

    const results = Array.isArray(response.json)
      ? response.json
      : safeJsonParse(response.bodyText || "[]", [], "geocode response");
    return Array.isArray(results) ? results : [];
  });
}

function selectBestGeocodeResult(results) {
  if (!Array.isArray(results) || results.length === 0) return null;

  const scored = results.map((result) => {
    const scoredResult = scoreGeocodeResult(result);
    return {
      result,
      ...scoredResult
    };
  }).filter(entry => Number.isFinite(entry.score));

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}

async function geocodeWithCache(query, jurisdiction) {
  const key = normalizeKey(query, jurisdiction);
  const cached = geocodeCache.get(key);
  if (cached) {
    return { ...cached, key, source: "cache" };
  }

  if (geocodeInflight.has(key)) {
    return geocodeInflight.get(key);
  }

  const inflightPromise = (async () => {
    const results = await fetchNominatimResults(query);
    const best = selectBestGeocodeResult(results);
    if (!best) return null;
    const entry = {
      lat: best.lat,
      lon: best.lon,
      ts: Date.now(),
      source: "nominatim"
    };
    geocodeCache.set(key, entry);
    scheduleGeocodeSave();
    return { ...entry, key, aoi: best.insideAoi ? "inside" : "outside" };
  })();

  geocodeInflight.set(key, inflightPromise);
  try {
    const result = await inflightPromise;
    return result;
  } finally {
    geocodeInflight.delete(key);
  }
}

// Fetch crime reports page and extract PDF links
// Implements multiple strategies with cache-busting for robust extraction
async function fetchCrimeReportPdfLinks() {
  console.log("[Crime Reports] Fetching crime reports page...");

  let responseStatus = null;
  let responseContentType = null;
  let bodyLength = 0;
  let bodySnippet = "";

  const debug = {
    strategy1Count: 0,
    strategy2Count: 0,
    strategy3Count: 0,
    strategy3Attempted: false,
    strategy3Error: null
  };

  // Helper to extract DocumentCenter links from HTML
  function extractDocCenterLinks(html) {
    // Strategy 1: Relative /DocumentCenter/View/<id> links
    const relativeRegex = /\/DocumentCenter\/View\/(\d+)(?:\/[^"'<>\s]*)?/gi;
    const relativeMatches = [...html.matchAll(relativeRegex)];

    // Strategy 2: Absolute https://...fredericksburgva.gov/DocumentCenter/View/<id> links
    const absoluteRegex = /https?:\/\/(?:www\.)?fredericksburgva\.gov\/DocumentCenter\/View\/(\d+)(?:\/[^"'<>\s]*)?/gi;
    const absoluteMatches = [...html.matchAll(absoluteRegex)];

    const pdfLinks = [];
    const seenIds = new Set();

    // Process relative matches first
    for (const match of relativeMatches) {
      const docId = match[1];
      if (seenIds.has(docId)) continue;
      seenIds.add(docId);
      pdfLinks.push({
        id: docId,
        url: `https://www.fredericksburgva.gov/DocumentCenter/View/${docId}`,
        path: match[0],
        strategy: "directHtml"
      });
    }
    debug.strategy1Count = pdfLinks.length;

    // Process absolute matches (may add new IDs not found via relative)
    for (const match of absoluteMatches) {
      const docId = match[1];
      if (seenIds.has(docId)) continue;
      seenIds.add(docId);
      const normalizedUrl = match[0].replace(/^http:/, "https:").replace(/^https:\/\/fredericksburgva\.gov/, "https://www.fredericksburgva.gov");
      pdfLinks.push({
        id: docId,
        url: normalizedUrl,
        path: match[0],
        strategy: "absoluteLinks"
      });
    }
    debug.strategy2Count = pdfLinks.length - debug.strategy1Count;

    return { links: pdfLinks, seenIds };
  }

  try {
    // Add cache-busting query param
    const cacheBustedUrl = `${FXBG_CRIME_REPORTS_URL}?_ts=${Date.now()}`;

    const cachePolicy = UPSTREAM_CACHE_TTLS.crimeIncidents;
    const cacheKey = "crime-reports-page";
    const pageFetch = await upstreamCache.wrap(
      cacheKey,
      cachePolicy.ttlMs,
      async () => {
        const result = await runUpstreamFetch("Fredericksburg Crime Reports Page", cacheBustedUrl, {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          timeoutMs: 30000,
          expectedType: "html",
          maxBytes: PAYLOAD_LIMITS.text,
          includeBodyText: true,
          headers: {
            "Cache-Control": "no-cache",
            "Pragma": "no-cache"
          }
        });
        if (!result.ok || result.status !== 200) {
          throw new Error(`HTTP ${result.status || 0}`);
        }
        return result;
      },
      { staleTtlMs: cachePolicy.staleTtlMs }
    );

    if (pageFetch.cache?.hit) {
      updateUpstreamStatus("Fredericksburg Crime Reports Page", {
        ok: true,
        status: pageFetch.value?.status,
        elapsedMs: pageFetch.value?.elapsedMs,
        cacheHit: true,
        stale: pageFetch.cache.stale,
        message: pageFetch.warning || null
      });
    }

    const response = pageFetch.value;
    const cacheWarning = pageFetch.warning || null;
    responseStatus = response.status;
    responseContentType = response.contentType;

    const html = response.bodyText || "";
    bodyLength = html.length;
    bodySnippet = html.substring(0, 300);

    // Extract links using strategies 1 & 2
    const { links: pdfLinks, seenIds } = extractDocCenterLinks(html);

    // Strategy 3 (fallback): Try to find dynamic content endpoint if no links found
    if (pdfLinks.length === 0) {
      debug.strategy3Attempted = true;

      // Look for CivicPlus/Granicus Content/Load endpoint indicators
      const contentLoadMatch = html.match(/\/Content\/Load[^"'\s]*/i) ||
                               html.match(/data-load-url="([^"]+)"/i);

      if (contentLoadMatch) {
        try {
          const contentLoadUrl = contentLoadMatch[1] || contentLoadMatch[0];
          const fullContentUrl = contentLoadUrl.startsWith("http")
            ? contentLoadUrl
            : `https://www.fredericksburgva.gov${contentLoadUrl.startsWith("/") ? "" : "/"}${contentLoadUrl}`;

          console.log(`[Crime Reports] Attempting Strategy 3: Content/Load at ${fullContentUrl}`);

          const contentResponse = await runUpstreamFetch("Fredericksburg Crime Reports ContentLoad", fullContentUrl, {
            accept: "text/html,*/*",
            timeoutMs: 15000,
            expectedType: "html",
            maxBytes: PAYLOAD_LIMITS.text,
            includeBodyText: true,
            headers: {
              "Cache-Control": "no-cache",
              "X-Requested-With": "XMLHttpRequest"
            }
          });

          if (contentResponse.status === 200 && contentResponse.ok) {
            const contentHtml = contentResponse.bodyText || "";
            const contentResult = extractDocCenterLinks(contentHtml);

            for (const link of contentResult.links) {
              if (!seenIds.has(link.id)) {
                seenIds.add(link.id);
                link.strategy = "contentLoad";
                pdfLinks.push(link);
              }
            }
            debug.strategy3Count = contentResult.links.length;
          }
        } catch (contentErr) {
          debug.strategy3Error = contentErr.message;
          console.warn("[Crime Reports] Strategy 3 (Content/Load) failed:", contentErr.message);
        }
      }
    }

    // Determine primary strategy used
    let strategyUsed = "none";
    if (debug.strategy1Count > 0) strategyUsed = "directHtml";
    else if (debug.strategy2Count > 0) strategyUsed = "absoluteLinks";
    else if (debug.strategy3Count > 0) strategyUsed = "contentLoad";

    console.log(`[Crime Reports] Found ${pdfLinks.length} DocumentCenter links (strategy: ${strategyUsed}, s1=${debug.strategy1Count}, s2=${debug.strategy2Count}, s3=${debug.strategy3Count})`);

    // Return with metadata for response
    return {
      links: pdfLinks,
      strategyUsed: strategyUsed,
      debug: debug,
      warning: cacheWarning,
      diagnostics: pdfLinks.length === 0 ? {
        status: responseStatus,
        contentType: responseContentType,
        bodyLength: bodyLength,
        bodySnippet: bodySnippet
      } : null
    };
  } catch (e) {
    console.error("[Crime Reports] Failed to fetch crime reports page:", e.message);
    logApp({
      level: "ERROR",
      kind: "crime_reports_fetch_failed",
      msg: "Crime reports page fetch failed",
      errorCode: e.code || e.message
    });
    return {
      links: [],
      strategyUsed: "none",
      debug: debug,
      diagnostics: {
        status: responseStatus,
        contentType: responseContentType,
        bodyLength: bodyLength,
        bodySnippet: bodySnippet,
        error: e.message
      }
    };
  }
}

// Download and parse a PDF
async function downloadAndParsePdf(pdfUrl) {
  if (!pdfParse) {
    console.warn("[Crime Reports] pdf-parse not available, skipping PDF download");
    return null;
  }

  try {
    console.log(`[Crime Reports] Downloading PDF: ${pdfUrl}`);
    const response = await runUpstreamFetch("Crime Reports PDF", pdfUrl, {
      accept: "application/pdf",
      timeoutMs: 60000,
      expectedType: "pdf",
      maxBytes: PAYLOAD_LIMITS.binary,
      includeBodyBuffer: true
    });

    if (response.status !== 200 || !response.ok) {
      console.warn(`[Crime Reports] PDF download failed: HTTP ${response.status || 0}`);
      return null;
    }

    // Check if we got a PDF (content-type or magic bytes)
    const contentType = response.contentType || "";
    const bodyBuffer = response.bodyBuffer || Buffer.alloc(0);
    const isHtml = contentType.includes("text/html") || bodyBuffer.slice(0, 15).toString().includes("<!DOCTYPE");

    if (isHtml) {
      console.warn(`[Crime Reports] Got HTML instead of PDF for: ${pdfUrl}`);
      return null;
    }

    // Parse PDF
    const data = await pdfParse(bodyBuffer);
    return {
      text: data.text,
      numPages: data.numpages,
      info: data.info
    };
  } catch (e) {
    console.error(`[Crime Reports] Failed to parse PDF ${pdfUrl}:`, e.message);
    logApp({
      level: "WARN",
      kind: "parse_failure",
      msg: "Crime report PDF parse failed",
      url: redactUrl(pdfUrl),
      errorCode: e.code || e.message
    });
    return null;
  }
}

// Parse incidents from PDF text
function parseIncidentsFromPdfText(text, sourcePdfUrl) {
  const incidents = [];

  // Common patterns in FXBG crime reports:
  // - Date patterns: MM/DD/YYYY, MM-DD-YYYY
  // - Location patterns: block of Street, Street at Street, 100 block of Street
  // - Offense types: Larceny, Theft, Assault, Burglary, etc.

  const lines = text.split(/\n+/).map(l => l.trim()).filter(l => l.length > 0);

  // Try to find incident blocks
  // FXBG reports typically have format: Date | Offense | Location | Description

  let currentIncident = null;
  const datePattern = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/;
  const offensePatterns = [
    { pattern: /\blarceny\b/i, type: "Larceny", category: "theft" },
    { pattern: /\blarceny from (?:motor )?vehicle\b/i, type: "Larceny from Vehicle", category: "larceny_from_vehicle" },
    { pattern: /\btheft\b/i, type: "Theft", category: "theft" },
    { pattern: /\bmotor vehicle theft\b/i, type: "Motor Vehicle Theft", category: "vehicle_theft" },
    { pattern: /\bstolen vehicle\b/i, type: "Motor Vehicle Theft", category: "vehicle_theft" },
    { pattern: /\bburglary\b/i, type: "Burglary", category: "burglary" },
    { pattern: /\bbreaking\s*(and|&)\s*entering\b/i, type: "Burglary", category: "burglary" },
    { pattern: /\brobbery\b/i, type: "Robbery", category: "robbery" },
    { pattern: /\bassault\b/i, type: "Assault", category: "assault" },
    { pattern: /\bbattery\b/i, type: "Assault", category: "assault" },
    { pattern: /\bshots?\s*fired\b/i, type: "Shots Fired", category: "shots_fired" },
    { pattern: /\bgunshot\b/i, type: "Shots Fired", category: "shots_fired" },
    { pattern: /\bdrug\b/i, type: "Drug Violation", category: "drugs" },
    { pattern: /\bnarcotics?\b/i, type: "Drug Violation", category: "drugs" },
    { pattern: /\bfraud\b/i, type: "Fraud", category: "fraud" },
    { pattern: /\bforgery\b/i, type: "Fraud", category: "fraud" },
    { pattern: /\bvandalism\b/i, type: "Vandalism", category: "vandalism" },
    { pattern: /\bdestruction of property\b/i, type: "Vandalism", category: "vandalism" },
    { pattern: /\btrespass\b/i, type: "Trespassing", category: "trespass" },
    { pattern: /\bmissing person\b/i, type: "Missing Person", category: "missing_person" },
    { pattern: /\bweapon\b/i, type: "Weapons Offense", category: "weapon" },
    { pattern: /\bsex(?:ual)?\s*(?:assault|offense)\b/i, type: "Sex Offense", category: "sex_offense" },
    { pattern: /\bdisorderly\b/i, type: "Disorderly Conduct", category: "default" },
    { pattern: /\bdomestic\b/i, type: "Domestic Disturbance", category: "assault" }
  ];

  // Location patterns
  const locationPattern = /\b(\d+\s+block\s+(?:of\s+)?[A-Za-z\s]+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ct|Court|Pl|Place|Pkwy|Parkway|Hwy|Highway|Way|Ln|Lane)\.?)\b/i;
  const intersectionPattern = /\b([A-Za-z\s]+(?:St|Ave|Blvd|Rd|Dr)\.?\s+(?:at|and|&|\@)\s+[A-Za-z\s]+(?:St|Ave|Blvd|Rd|Dr)\.?)\b/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for date
    const dateMatch = line.match(datePattern);
    if (dateMatch) {
      // Save previous incident if exists
      if (currentIncident && currentIncident.offenseType) {
        incidents.push(currentIncident);
      }

      // Parse date
      let dateStr = dateMatch[1];
      let incidentDate;
      try {
        // Handle various date formats
        const parts = dateStr.split(/[\/\-]/);
        if (parts.length === 3) {
          let [month, day, year] = parts;
          if (year.length === 2) {
            year = (parseInt(year) > 50 ? "19" : "20") + year;
          }
          incidentDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        }
      } catch (e) {
        incidentDate = new Date();
      }

      currentIncident = {
        id: `crime-${Date.now()}-${incidents.length}`,
        incidentDateISO: incidentDate ? incidentDate.toISOString() : new Date().toISOString(),
        reportedDate: incidentDate ? incidentDate.toISOString() : new Date().toISOString(),
        offenseType: null,
        offenseCategory: "default",
        locationRaw: null,
        description: line,
        sourcePdfUrl: sourcePdfUrl,
        latitude: null,
        longitude: null
      };
    }

    if (currentIncident) {
      // Check for offense type
      if (!currentIncident.offenseType) {
        for (const { pattern, type, category } of offensePatterns) {
          if (pattern.test(line)) {
            currentIncident.offenseType = type;
            currentIncident.offenseCategory = category;
            break;
          }
        }
      }

      // Check for location
      if (!currentIncident.locationRaw) {
        const locMatch = line.match(locationPattern) || line.match(intersectionPattern);
        if (locMatch) {
          currentIncident.locationRaw = locMatch[1].trim();
        }
      }

      // Build description
      if (line !== currentIncident.description) {
        currentIncident.description += " " + line;
      }
    }
  }

  // Don't forget the last incident
  if (currentIncident && currentIncident.offenseType) {
    incidents.push(currentIncident);
  }

  // Clean up descriptions
  for (const inc of incidents) {
    inc.description = inc.description
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500); // Limit length
  }

  return incidents;
}

// Geocode a location string to lat/lon
async function geocodeLocation(locationRaw, retryCount = 0) {
  if (!locationRaw) return null;

  const searchQuery = `${locationRaw}, Fredericksburg, Virginia, USA`;

  try {
    const geocoded = await geocodeWithCache(searchQuery, "crime-reports");
    if (geocoded && Number.isFinite(geocoded.lat) && Number.isFinite(geocoded.lon)) {
      return {
        lat: geocoded.lat,
        lon: geocoded.lon,
        displayName: locationRaw
      };
    }

    // Fallback: use approximate Fredericksburg center with offset
    return {
      lat: 38.3032 + (Math.random() - 0.5) * 0.02,
      lon: -77.4605 + (Math.random() - 0.5) * 0.02,
      displayName: locationRaw + " (approximate)"
    };
  } catch (e) {
    if (retryCount < 1) {
      return geocodeLocation(locationRaw, retryCount + 1);
    }
    console.warn(`[Geocode] Failed for "${locationRaw}":`, e.message);
    return null;
  }
}

// Main function to refresh crime reports
async function refreshCrimeReports(months = 6) {
  console.log(`[Crime Reports] Starting refresh for last ${months} months...`);

  const allIncidents = [];
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - months);

  // Update state: refresh attempt started
  crimeReportsState.lastRefreshAttempt = new Date().toISOString();

  try {
    // Load geocode cache
    await loadGeocodeCache();

    // Fetch PDF links (returns { links, strategyUsed, debug, diagnostics })
    const fetchResult = await fetchCrimeReportPdfLinks();
    const pdfLinks = fetchResult.links;
    const strategyUsed = fetchResult.strategyUsed || "none";
    const fetchWarning = fetchResult.warning || null;

    if (pdfLinks.length === 0) {
      console.warn("[Crime Reports] No PDF links found");
      const result = {
        success: false,
        count: 0,
        pdfCount: 0,
        message: "No crime report PDFs found on source page",
        strategyUsed: strategyUsed,
        debug: fetchResult.debug,
        warning: fetchWarning || undefined
      };
      // Include diagnostics if available
      if (fetchResult.diagnostics) {
        result.diagnostics = fetchResult.diagnostics;
      }
      // Update state
      crimeReportsState.lastRefreshOk = false;
      crimeReportsState.lastRefreshMessage = result.message;
      return result;
    }

    // Process up to 10 most recent PDFs (to avoid overwhelming the server)
    const pdfsToProcess = pdfLinks.slice(0, 10);
    const sampleUrls = pdfLinks.slice(0, 3).map(p => p.url);

    for (const pdf of pdfsToProcess) {
      try {
        const parsed = await downloadAndParsePdf(pdf.url);
        if (parsed && parsed.text) {
          const incidents = parseIncidentsFromPdfText(parsed.text, pdf.url);
          console.log(`[Crime Reports] Extracted ${incidents.length} incidents from PDF ${pdf.id}`);
          allIncidents.push(...incidents);
        }
      } catch (e) {
        console.error(`[Crime Reports] Error processing PDF ${pdf.id}:`, e.message);
      }

      // Small delay between PDFs
      await new Promise(r => setTimeout(r, 500));
    }

    // Geocode incidents (with rate limiting)
    console.log(`[Crime Reports] Geocoding ${allIncidents.length} incidents...`);
    let geocoded = 0;
    for (const incident of allIncidents) {
      if (incident.locationRaw && !incident.latitude) {
        const geo = await geocodeLocation(incident.locationRaw);
        if (geo) {
          incident.latitude = geo.lat;
          incident.longitude = geo.lon;
          geocoded++;
        }
      }
    }
    console.log(`[Crime Reports] Geocoded ${geocoded} locations`);

    // Save geocode cache
    await saveGeocodeCache();

    // Filter by date and deduplicate
    const filtered = allIncidents.filter(inc => {
      const incDate = new Date(inc.incidentDateISO);
      return incDate >= cutoffDate;
    });

    // Deduplicate by description similarity
    const deduped = [];
    const seenDescriptions = new Set();
    for (const inc of filtered) {
      const descKey = inc.description.toLowerCase().slice(0, 100);
      if (!seenDescriptions.has(descKey)) {
        seenDescriptions.add(descKey);
        deduped.push(inc);
      }
    }

    // Sort by date (newest first)
    deduped.sort((a, b) => new Date(b.incidentDateISO) - new Date(a.incidentDateISO));

    // Save to file
    const dataDir = path.join(__dirname, "data", "fxbg-crime-reports");
    await fsp.mkdir(dataDir, { recursive: true });

    const outputData = {
      lastUpdated: new Date().toISOString(),
      sourceUrl: FXBG_CRIME_REPORTS_URL,
      pdfCount: pdfsToProcess.length,
      incidentCount: deduped.length,
      incidents: deduped
    };

    await fsp.writeFile(
      path.join(dataDir, "incidents.json"),
      JSON.stringify(outputData, null, 2),
      "utf8"
    );

    console.log(`[Crime Reports] Saved ${deduped.length} incidents to file`);

    // Update state on success
    crimeReportsState.lastRefreshOk = true;
    crimeReportsState.lastRefreshMessage = `Successfully refreshed ${deduped.length} crime incidents from ${pdfsToProcess.length} PDFs`;
    crimeReportsState.lastUpdated = outputData.lastUpdated;
    crimeReportsState.pdfCount = pdfsToProcess.length;
    crimeReportsState.incidentsCount = deduped.length;

    return {
      success: true,
      count: deduped.length,
      pdfCount: pdfsToProcess.length,
      geocoded: geocoded,
      sample: sampleUrls,
      strategyUsed: strategyUsed,
      debug: fetchResult.debug,
      message: crimeReportsState.lastRefreshMessage,
      warning: fetchWarning || undefined
    };

  } catch (e) {
    console.error("[Crime Reports] Refresh failed:", e.message);
    // Update state on error
    crimeReportsState.lastRefreshOk = false;
    crimeReportsState.lastRefreshMessage = e.message;
    return { success: false, count: 0, message: e.message, strategyUsed: "none" };
  }
}

// Initialize geocode cache on module load
loadGeocodeCache().catch(() => {});

// =============================================================================

/**
 * Generate sample crime incidents for testing
 * Used as fallback when PDF scraping is not available
 */
function generateSampleIncidents(months) {
  const offenseTypes = [
    { type: "Larceny from Vehicle", category: "larceny_from_vehicle" },
    { type: "Theft", category: "theft" },
    { type: "Motor Vehicle Theft", category: "vehicle_theft" },
    { type: "Burglary", category: "burglary" },
    { type: "Robbery", category: "robbery" },
    { type: "Assault", category: "assault" },
    { type: "Shots Fired", category: "shots_fired" },
    { type: "Drug Violation", category: "drugs" },
    { type: "Fraud", category: "fraud" },
    { type: "Vandalism", category: "vandalism" }
  ];

  const locations = [
    { name: "William St", lat: 38.3032, lon: -77.4605 },
    { name: "Lafayette Blvd", lat: 38.2995, lon: -77.4620 },
    { name: "Carl D Silver Pkwy", lat: 38.3200, lon: -77.5100 },
    { name: "Jefferson Davis Hwy", lat: 38.2850, lon: -77.4800 },
    { name: "Plank Rd", lat: 38.3050, lon: -77.5150 },
    { name: "Dixon St", lat: 38.3050, lon: -77.4650 },
    { name: "Princess Anne St", lat: 38.3015, lon: -77.4590 },
    { name: "Westwood Shopping Center", lat: 38.3180, lon: -77.5080 }
  ];

  const incidents = [];
  const now = Date.now();

  // Generate incidents spread over the requested months
  const totalDays = months * 30;
  const incidentCount = Math.min(50, months * 8); // ~8 incidents per month, max 50

  for (let i = 0; i < incidentCount; i++) {
    const daysAgo = Math.floor(Math.random() * totalDays);
    const incidentDate = new Date(now - daysAgo * 24 * 60 * 60 * 1000);

    const offense = offenseTypes[Math.floor(Math.random() * offenseTypes.length)];
    const location = locations[Math.floor(Math.random() * locations.length)];

    // Add slight randomness to location
    const latOffset = (Math.random() - 0.5) * 0.01;
    const lonOffset = (Math.random() - 0.5) * 0.01;

    incidents.push({
      id: `crime-${Date.now()}-${i}`,
      offenseType: offense.type,
      offenseCategory: offense.category,
      locationRaw: location.name,
      description: `${offense.type} reported at ${location.name}`,
      incidentDateISO: incidentDate.toISOString(),
      latitude: location.lat + latOffset,
      longitude: location.lon + lonOffset,
      reportedDate: incidentDate.toISOString()
    });
  }

  return incidents.sort((a, b) => new Date(b.incidentDateISO) - new Date(a.incidentDateISO));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 204, "");

    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const requestStart = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - requestStart;
      const contentLength = Number(res.getHeader("Content-Length"));
      logApp({
        level: "INFO",
        kind: "request",
        msg: "request_complete",
        route: urlObj.pathname,
        method: req.method,
        status: res.statusCode,
        url: requestLogUrl(urlObj),
        ms: duration,
        bytes: Number.isFinite(contentLength) ? contentLength : undefined
      });
    });

    if (urlObj.pathname.startsWith("/uploads/reports/")) {
      const filename = path.basename(urlObj.pathname);
      const filePath = path.join(REPORT_UPLOAD_DIR, filename);
      if (!filePath.startsWith(REPORT_UPLOAD_DIR)) {
        return send(res, 403, "Forbidden");
      }
      if (!fs.existsSync(filePath)) {
        return send(res, 404, "Not found");
      }
      const ext = path.extname(filePath).toLowerCase();
      const type = MIME[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // Health check endpoint (legacy, kept for backward compatibility)
    if (urlObj.pathname === "/health") {
      const uptimeMs = Date.now() - SERVER_START_TIME;
      const cacheStats = cacheManager.stats();
      const health = {
        status: "ok",
        uptimeMs: uptimeMs,
        uptime: {
          ms: uptimeMs,
          human: `${Math.floor(uptimeMs / 1000 / 60)} minutes`
        },
        cache: {
          entries: cacheStats.entries,
          maxEntries: cacheStats.maxEntries,
          bytesUsed: cacheStats.bytes,
          maxBytes: cacheStats.maxBytes,
          utilizationPct: Math.round((cacheStats.bytes / cacheStats.maxBytes) * 100)
        },
        connections: {
          activeFetches: activeFetches,
          maxConcurrent: MAX_CONCURRENT,
          inflightRequests: inflight.size
        },
        hostBackoffs: hostBackoff.size
      };
      return send(res, 200, JSON.stringify(health, null, 2), { "Content-Type": "application/json" });
    }

    if (urlObj.pathname === "/api/env/status" && req.method === "GET") {
      const payload = buildEnvStatus();
      return send(res, 200, JSON.stringify(payload, null, 2), { "Content-Type": "application/json" });
    }

    // Enhanced health endpoint with full diagnostics
    if (urlObj.pathname === "/api/health") {
      const uptimeMs = Date.now() - SERVER_START_TIME;
      const uptimeSec = Math.floor(uptimeMs / 1000);
      const cacheStats = cacheManager.stats();

      // Load crime reports status from file
      let crimeStatus = {
        lastRefreshAttempt: crimeReportsState.lastRefreshAttempt,
        lastRefreshOk: crimeReportsState.lastRefreshOk,
        lastUpdated: crimeReportsState.lastUpdated,
        pdfCount: crimeReportsState.pdfCount,
        incidentsCount: crimeReportsState.incidentsCount,
        isStale: true
      };

      try {
        const incidentsFile = path.join(__dirname, "data", "fxbg-crime-reports", "incidents.json");
        const data = await fsp.readFile(incidentsFile, "utf8");
        const parsed = safeJsonParse(data, null, "crime health check");
        if (parsed && !Array.isArray(parsed)) {
          crimeStatus.lastUpdated = parsed.lastUpdated || crimeStatus.lastUpdated;
          crimeStatus.pdfCount = parsed.pdfCount || crimeStatus.pdfCount;
          crimeStatus.incidentsCount = parsed.incidentCount || (parsed.incidents ? parsed.incidents.length : 0);
        }
      } catch (e) {
        // File doesn't exist
      }

      // Compute staleness
      if (crimeStatus.lastUpdated) {
        crimeStatus.isStale = Date.now() - new Date(crimeStatus.lastUpdated).getTime() > 7 * 24 * 60 * 60 * 1000;
      }

      // Read package.json version
      let version = "1.0.0";
      try {
        const pkgPath = path.join(__dirname, "package.json");
        const pkgData = await fsp.readFile(pkgPath, "utf8");
        const pkg = safeJsonParse(pkgData, {}, "package.json health");
        version = pkg.version || version;
      } catch (e) {}

      const upstreams = REQUIRED_UPSTREAMS.map((upstream) => {
        const state = upstreamStatus.get(upstream.name) || {};
        return {
          name: upstream.name,
          ok: state.lastOk === true,
          lastOkAt: state.lastOkAt || null,
          lastAttemptAt: state.lastAttemptAt || null,
          lastStatus: state.lastStatus || null,
          lastElapsedMs: state.lastElapsedMs || null,
          cacheHit: Boolean(state.cacheHit),
          stale: Boolean(state.stale),
          message: state.message || null,
          required: upstream.required
        };
      });

      const degraded = upstreams.some((upstream) => {
        if (!upstream.required) return false;
        if (upstream.ok && !upstream.stale) return false;
        if (upstream.cacheHit && !upstream.stale) return false;
        return true;
      });

      const crimeCachePolicy = UPSTREAM_CACHE_TTLS.crimeIncidents;
      const crimeAgeMs = crimeStatus.lastUpdated ? Date.now() - new Date(crimeStatus.lastUpdated).getTime() : null;
      const crimeCacheMeta = {
        hit: Boolean(crimeStatus.lastUpdated),
        stale: crimeAgeMs !== null ? crimeAgeMs > crimeCachePolicy.ttlMs : true,
        ageSec: crimeAgeMs !== null ? Math.floor(crimeAgeMs / 1000) : null,
        ttlSec: Math.floor(crimeCachePolicy.ttlMs / 1000)
      };

      const health = {
        ok: true,
        status: "ok",
        time: new Date().toISOString(),
        uptimeSec: uptimeSec,
        env: process.env.NODE_ENV || "development",
        version: version,
        logDir: LOG_DIR,
        optionalKeys: {
          OPENUV_API_KEY: !!OPENUV_API_KEY,
          WAQI_TOKEN: !!WAQI_TOKEN
        },
        degraded,
        upstreams,
        crimeReports: {
          ...crimeStatus,
          cache: crimeCacheMeta
        }
      };

      return send(res, 200, JSON.stringify(health, null, 2), { "Content-Type": "application/json" });
    }

    if (urlObj.pathname === "/api/feeds/registry") {
      const feeds = await loadRssFeedRegistry();
      const payload = {
        ok: true,
        feeds
      };
      return send(res, 200, JSON.stringify(payload), { "Content-Type": "application/json" });
    }

    if (urlObj.pathname === "/api/health/offline-readiness") {
      const serverTime = new Date().toISOString();
      const hasLogsDir = Boolean(resolvedLogDir && fs.existsSync(resolvedLogDir));
      const cacheDirExists = fs.existsSync(CACHE_DIR);
      const diskCacheBytes = cacheDirExists ? await getDirectorySizeBytes(CACHE_DIR) : 0;
      const hasSchoolsDataset = fs.existsSync(SCHOOLS_DATASET_FILE);
      const hasStreetlists = {
        spotsy: fs.existsSync(SPOTSY_STREETLIST_FILE)
      };
      const canServeStatic = fs.existsSync(path.join(PUBLIC_DIR, "index.html"));

      const degradedUpstreams = REQUIRED_UPSTREAMS.filter((upstream) => upstream.required).filter((upstream) => {
        const state = upstreamStatus.get(upstream.name) || {};
        if (state.lastOk === true && !state.stale) return false;
        if (state.cacheHit && !state.stale) return false;
        return true;
      }).map((upstream) => upstream.name);

      const lastUpstreamSuccessAt = REQUIRED_UPSTREAMS.reduce((acc, upstream) => {
        acc[upstream.name] = upstreamLastSuccess.get(upstream.name) || null;
        return acc;
      }, {});

      const payload = {
        ok: true,
        serverTime,
        hasLogsDir,
        cacheDir: CACHE_DIR,
        diskCacheBytes,
        hasSchoolsDataset,
        hasStreetlists,
        canServeStatic,
        canServeTiles: false,
        degradedUpstreams,
        lastUpstreamSuccessAt
      };

      return send(res, 200, JSON.stringify(payload, null, 2), { "Content-Type": "application/json" });
    }

    if (urlObj.pathname === "/api/gis/catalog" && req.method === "GET") {
      const catalog = await readGisCatalog();
      return send(res, 200, JSON.stringify(catalog, null, 2), { "Content-Type": "application/json" });
    }

    if (urlObj.pathname === "/api/gis/resolve" && req.method === "GET") {
      const rawKey = urlObj.searchParams.get("key");
      const key = sanitizeGisKey(rawKey);
      if (!key) {
        return send(res, 400, JSON.stringify({ ok: false, error: "invalid_key" }), { "Content-Type": "application/json" });
      }

      const catalog = await readGisCatalog();
      const entry = findGisCatalogEntry(catalog, key);
      if (!entry) {
        return send(res, 404, JSON.stringify({ ok: false, error: "unknown_key" }), { "Content-Type": "application/json" });
      }

      const resolvedPath = path.join(GIS_CACHE_DIR, `${key}.resolved.json`);
      const cachedResolution = await readJsonFile(resolvedPath);
      if (cachedResolution) {
        return send(res, 200, JSON.stringify(cachedResolution, null, 2), { "Content-Type": "application/json" });
      }

      const resolution = await resolveArcgis(entry);
      await writeJsonFile(resolvedPath, resolution);
      return send(res, 200, JSON.stringify(resolution, null, 2), { "Content-Type": "application/json" });
    }

    if (urlObj.pathname === "/api/gis/fetch" && req.method === "GET") {
      const rawKey = urlObj.searchParams.get("key");
      const key = sanitizeGisKey(rawKey);
      if (!key) {
        return send(res, 400, JSON.stringify({ ok: false, error: "invalid_key" }), { "Content-Type": "application/json" });
      }

      const catalog = await readGisCatalog();
      const entry = findGisCatalogEntry(catalog, key);
      if (!entry) {
        return send(res, 404, JSON.stringify({ ok: false, error: "unknown_key" }), { "Content-Type": "application/json" });
      }

      const cachedMeta = await readGisCacheMeta(key);
      if (cachedMeta) {
        await syncGisCacheIndexFromMeta(key, entry, cachedMeta);
        return send(res, 200, JSON.stringify({
          ok: true,
          key,
          cached: true,
          bytes: cachedMeta.bytes,
          contentType: cachedMeta.contentType || null,
          savedAs: cachedMeta.savedAs,
          fetchedAt: cachedMeta.fetchedAt,
          format: cachedMeta.format || "unknown"
        }, null, 2), { "Content-Type": "application/json" });
      }

      const urlCheck = checkUrlAllowed(entry.url);
      if (!urlCheck.allowed) {
        return send(res, 400, JSON.stringify({ ok: false, error: "blocked_url", reason: urlCheck.reason }, null, 2), { "Content-Type": "application/json" });
      }

      const upstream = await upstreamFetch(entry.url, {
        includeBodyBuffer: true,
        maxBytes: MAX_LAYER_BYTES,
        timeoutMs: 20000,
        upstreamName: `gis-${key}`,
        route: "/api/gis/fetch"
      });

      if (!upstream.ok || !upstream.bodyBuffer) {
        return send(res, 502, JSON.stringify({
          ok: false,
          error: upstream.error || "upstream_failed",
          status: upstream.status || 0
        }, null, 2), { "Content-Type": "application/json" });
      }

      const cached = await cacheGisDownloadResult(key, entry, upstream.bodyBuffer, upstream.contentType, upstream.fetchedAt);
      const meta = cached.meta;

      return send(res, 200, JSON.stringify({
        ok: true,
        key,
        cached: false,
        bytes: meta.bytes,
        contentType: meta.contentType,
        savedAs: meta.savedAs,
        fetchedAt: meta.fetchedAt,
        format: meta.format,
        normalized: cached.normalized
      }, null, 2), { "Content-Type": "application/json" });
    }

    if (urlObj.pathname === "/api/gis/data" && req.method === "GET") {
      const rawKey = urlObj.searchParams.get("key");
      const key = sanitizeGisKey(rawKey);
      if (!key) {
        return send(res, 400, JSON.stringify({ ok: false, error: "invalid_key" }), { "Content-Type": "application/json" });
      }

      const geojsonPath = path.join(GIS_CACHE_DIR, `${key}.geojson`);
      if (fs.existsSync(geojsonPath)) {
        const payload = await fsp.readFile(geojsonPath);
        const catalog = await readGisCatalog();
        const entry = findGisCatalogEntry(catalog, key);
        const cachedMeta = await readGisCacheMeta(key);
        if (cachedMeta) {
          await syncGisCacheIndexFromMeta(key, entry, cachedMeta);
        } else {
          const stats = await fsp.stat(geojsonPath);
          const now = Date.now();
          await updateGisCacheIndexItem(key, (current) => ({
            ...current,
            key,
            name: entry?.name || current.name || null,
            cached: true,
            cachedAt: current.cachedAt || now,
            bytes: stats.size,
            format: current.format || "arcgis_snapshot",
            source: current.source || buildGisCacheSource(entry, null),
            etag: current.etag || null,
            lastModified: current.lastModified || null,
            lastUsedAt: now
          }));
        }
        return send(res, 200, payload, { "Content-Type": MIME[".geojson"] });
      }

      const cachedMeta = await readGisCacheMeta(key);
      if (cachedMeta) {
        const ext = path.extname(cachedMeta.rawPath).toLowerCase();
        const type = MIME[ext] || "application/octet-stream";
        const payload = await fsp.readFile(cachedMeta.rawPath);
        const catalog = await readGisCatalog();
        const entry = findGisCatalogEntry(catalog, key);
        await touchGisCacheIndexItem(key, entry);
        return send(res, 200, payload, { "Content-Type": type });
      }

      return send(res, 404, JSON.stringify({ ok: false, error: "not_cached_yet" }), { "Content-Type": "application/json" });
    }

    if (urlObj.pathname === "/api/gis/offline/status" && req.method === "GET") {
      const catalog = await readGisCatalog();
      const summary = await summarizeOfflineStatus(catalog);
      return send(res, 200, JSON.stringify({ ok: true, ...summary }, null, 2), { "Content-Type": "application/json" });
    }

    if (urlObj.pathname === "/api/gis/offline/prefetch" && req.method === "POST") {
      try {
        const body = await readBody(req, PAYLOAD_LIMITS.json);
        const payload = safeJsonParse(body.toString("utf8"), {}, "offline prefetch");
        const pack = payload.pack ? String(payload.pack) : null;
        const force = Boolean(payload.force);
        const keys = Array.isArray(payload.keys) ? payload.keys.map((key) => sanitizeGisKey(key)).filter(Boolean) : null;

        if (!pack && (!keys || keys.length === 0)) {
          return send(res, 400, JSON.stringify({ ok: false, error: "missing_pack_or_keys" }), { "Content-Type": "application/json" });
        }
        if (pack && pack !== "core" && pack !== "field") {
          return send(res, 400, JSON.stringify({ ok: false, error: "invalid_pack" }), { "Content-Type": "application/json" });
        }
        if (offlinePrefetchState.running) {
          return send(res, 409, JSON.stringify({ ok: false, error: "job_running" }, null, 2), { "Content-Type": "application/json" });
        }

        const catalog = await readGisCatalog();
        const entries = buildOfflineQueue(catalog, { pack, keys });
        const budgetBytes = pack ? getOfflinePackBudgetBytes(catalog, pack) : null;

        if (entries.length === 0) {
          return send(res, 200, JSON.stringify({ ok: true, started: false, queued: 0 }, null, 2), { "Content-Type": "application/json" });
        }

        if (budgetBytes !== null) {
          const index = await readGisCacheIndex();
          const usageBytes = getOfflinePackUsageBytes(catalog, pack, index) || 0;
          if (usageBytes >= budgetBytes) {
            return send(res, 409, JSON.stringify({
              ok: false,
              error: "budget_exceeded",
              message: "Offline pack is over budget. Evict cached items or increase storageBudgetMB."
            }, null, 2), { "Content-Type": "application/json" });
          }
          const estimatedBytes = entries.reduce((acc, entry) => {
            const estMB = Number.isFinite(entry?.offline?.estSizeMB) ? entry.offline.estSizeMB : null;
            if (!Number.isFinite(estMB)) return acc;
            return acc + (estMB * 1024 * 1024);
          }, 0);
          if (estimatedBytes > 0 && (usageBytes + estimatedBytes) > budgetBytes) {
            return send(res, 409, JSON.stringify({
              ok: false,
              error: "budget_exceeded",
              message: "Offline pack would exceed budget. Evict cached items or increase storageBudgetMB."
            }, null, 2), { "Content-Type": "application/json" });
          }
        }

        setImmediate(() => runOfflinePrefetch(entries, { force, pack, catalog }));
        return send(res, 200, JSON.stringify({ ok: true, started: true, queued: entries.length }, null, 2), { "Content-Type": "application/json" });
      } catch (err) {
        return send(res, 400, JSON.stringify({ ok: false, error: "invalid_payload", message: err.message }, null, 2), { "Content-Type": "application/json" });
      }
    }

    if (urlObj.pathname === "/api/gis/offline/progress" && req.method === "GET") {
      return send(res, 200, JSON.stringify({ ok: true, ...offlinePrefetchState }, null, 2), { "Content-Type": "application/json" });
    }

    if (urlObj.pathname === "/api/gis/offline/evict" && req.method === "POST") {
      try {
        const body = await readBody(req, PAYLOAD_LIMITS.json);
        const payload = safeJsonParse(body.toString("utf8"), {}, "offline evict");
        const pack = payload.pack ? String(payload.pack) : null;
        const targetMB = payload.targetMB !== undefined ? Number(payload.targetMB) : null;

        if (!pack && !Number.isFinite(targetMB)) {
          return send(res, 400, JSON.stringify({ ok: false, error: "missing_target" }, null, 2), { "Content-Type": "application/json" });
        }

        const catalog = await readGisCatalog();
        let targetBytes = null;
        if (Number.isFinite(targetMB)) {
          targetBytes = targetMB * 1024 * 1024;
        } else if (pack) {
          const budgetMB = getOfflinePackBudgetMB(catalog, pack);
          if (!Number.isFinite(budgetMB)) {
            return send(res, 400, JSON.stringify({ ok: false, error: "missing_budget" }, null, 2), { "Content-Type": "application/json" });
          }
          targetBytes = budgetMB * 1024 * 1024;
        }

        const result = await evictOfflineCache({ targetBytes, pack, catalog });
        return send(res, 200, JSON.stringify({ ok: true, ...result }, null, 2), { "Content-Type": "application/json" });
      } catch (err) {
        return send(res, 400, JSON.stringify({ ok: false, error: "invalid_payload", message: err.message }, null, 2), { "Content-Type": "application/json" });
      }
    }

    if (urlObj.pathname === "/api/gis/offline/refresh" && req.method === "POST") {
      try {
        const body = await readBody(req, PAYLOAD_LIMITS.json);
        const payload = safeJsonParse(body.toString("utf8"), {}, "offline refresh");
        const key = sanitizeGisKey(payload.key);
        const force = Boolean(payload.force);

        if (!key) {
          return send(res, 400, JSON.stringify({ ok: false, error: "invalid_key" }, null, 2), { "Content-Type": "application/json" });
        }

        const catalog = await readGisCatalog();
        const entry = findGisCatalogEntry(catalog, key);
        if (!entry) {
          return send(res, 404, JSON.stringify({ ok: false, error: "unknown_key" }, null, 2), { "Content-Type": "application/json" });
        }

        const refreshDays = entry.offline?.refreshDays;
        if (!force && !Number.isFinite(refreshDays)) {
          return send(res, 400, JSON.stringify({ ok: false, error: "refresh_not_allowed" }, null, 2), { "Content-Type": "application/json" });
        }

        const index = await readGisCacheIndex();
        const cachedAt = index.items?.[key]?.cachedAt;
        if (!force && Number.isFinite(refreshDays) && Number.isFinite(cachedAt)) {
          const ageMs = Date.now() - cachedAt;
          if (ageMs < refreshDays * 86400000) {
            return send(res, 200, JSON.stringify({ ok: true, refreshed: false, reason: "not_due" }, null, 2), { "Content-Type": "application/json" });
          }
        }

        let result = null;
        if (entry.offline?.downloadMode === "serviceQuery") {
          result = await downloadGisArcgisSnapshot(key, entry);
        } else {
          result = await downloadGisFileEntry(key, entry);
        }

        if (!result?.ok) {
          return send(res, 502, JSON.stringify({ ok: false, error: result?.error || "refresh_failed" }, null, 2), { "Content-Type": "application/json" });
        }

        return send(res, 200, JSON.stringify({ ok: true, refreshed: true }, null, 2), { "Content-Type": "application/json" });
      } catch (err) {
        return send(res, 400, JSON.stringify({ ok: false, error: "invalid_payload", message: err.message }, null, 2), { "Content-Type": "application/json" });
      }
    }

    if (urlObj.pathname === "/api/spotsy/streets/refresh" && req.method === "GET") {
      if (!pdfParse) {
        return send(res, 500, JSON.stringify({ ok: false, error: "pdf_parse_unavailable" }), { "Content-Type": "application/json" });
      }

      try {
        const upstream = await runUpstreamFetch("Spotsy Street List PDF", SPOTSY_STREETLIST_SOURCE_URL, {
          expectedType: "pdf",
          includeBodyBuffer: true,
          timeoutMs: 20000,
          maxBytes: MAX_LAYER_BYTES,
          accept: "application/pdf",
          route: "/api/spotsy/streets/refresh"
        });

        if (!upstream.ok || !upstream.bodyBuffer) {
          return send(res, 502, JSON.stringify({
            ok: false,
            error: upstream.error || "upstream_failed",
            status: upstream.status || 0
          }, null, 2), { "Content-Type": "application/json" });
        }

        const parsed = await pdfParse(upstream.bodyBuffer);
        const streets = parseSpotsyStreetListText(parsed.text);
        const fetchedAt = new Date().toISOString();
        const payload = {
          ok: true,
          count: streets.length,
          streets,
          sourceUrl: SPOTSY_STREETLIST_SOURCE_URL,
          fetchedAt,
          savedAs: path.basename(SPOTSY_STREETLIST_FILE)
        };
        await writeJsonFile(SPOTSY_STREETLIST_FILE, payload);

        return send(res, 200, JSON.stringify({
          ok: true,
          count: streets.length,
          savedAs: payload.savedAs,
          fetchedAt
        }, null, 2), { "Content-Type": "application/json" });
      } catch (err) {
        return send(res, 500, JSON.stringify({
          ok: false,
          error: "streetlist_refresh_failed",
          message: err.message
        }, null, 2), { "Content-Type": "application/json" });
      }
    }

    if (urlObj.pathname === "/api/spotsy/streets" && req.method === "GET") {
      const payload = await readJsonFile(SPOTSY_STREETLIST_FILE);
      if (!payload) {
        return send(res, 404, JSON.stringify({ ok: false, error: "not_found" }, null, 2), { "Content-Type": "application/json" });
      }
      return send(res, 200, JSON.stringify(payload, null, 2), { "Content-Type": "application/json" });
    }


    if (urlObj.pathname === "/api/geo/gazetteer" && req.method === "GET") {
      const payload = await readOrInitGeoDataset(GAZETTEER_FILE, "gazetteer");
      return send(res, 200, JSON.stringify(payload, null, 2), { "Content-Type": "application/json" });
    }

    if (urlObj.pathname === "/api/geo/intersections" && req.method === "GET") {
      const payload = await readOrInitGeoDataset(INTERSECTIONS_FILE, "intersections");
      return send(res, 200, JSON.stringify(payload, null, 2), { "Content-Type": "application/json" });
    }

    if (urlObj.pathname === "/api/places" && req.method === "GET") {
      const payload = await readOrInitGeoDataset(PLACES_FILE, "places");
      return send(res, 200, JSON.stringify(payload, null, 2), { "Content-Type": "application/json" });
    }

    if (urlObj.pathname === "/api/places/downtown-centralpark" && req.method === "GET") {
      const payload = await readOrInitGeoDataset(DOWNTOWN_CENTRAL_PARK_PLACES_FILE, "places_downtown_centralpark");
      return send(res, 200, JSON.stringify({ ok: true, data: payload }, null, 2), { "Content-Type": "application/json" });
    }

    if (urlObj.pathname === "/api/geo/dorms" && req.method === "GET") {
      const payload = await readOrInitGeoDataset(DORMS_FILE, "dorms");
      return send(res, 200, JSON.stringify(payload, null, 2), { "Content-Type": "application/json" });
    }

    if (urlObj.pathname === "/api/geo/schools-overrides" && req.method === "GET") {
      const payload = await readOrInitGeoDataset(SCHOOLS_OVERRIDES_FILE, "schools_overrides");
      return send(res, 200, JSON.stringify(payload, null, 2), { "Content-Type": "application/json" });
    }

    if (urlObj.pathname === "/api/va511/icons-metadata" && req.method === "GET") {
      const payload = await fetchVa511IconsMetadata();
      return send(res, payload.ok ? 200 : 200, JSON.stringify(payload, null, 2), { "Content-Type": "application/json" });
    }

    // --- VA511 Events (server-side cached) ---
    if (urlObj.pathname === "/api/va511/events" && req.method === "GET") {
      const payload = await fetchVa511Events();
      return send(res, payload.ok ? 200 : 502, JSON.stringify(payload, null, 2), { "Content-Type": "application/json" });
    }

    // --- VA511 Cameras (server-side cached) ---
    if (urlObj.pathname === "/api/va511/cams" && req.method === "GET") {
      const payload = await fetchVa511Cams();
      return send(res, payload.ok ? 200 : 502, JSON.stringify(payload, null, 2), { "Content-Type": "application/json" });
    }

    // --- VA511 Status Summary (computed from events, for UI indicator) ---
    if (urlObj.pathname === "/api/va511/status" && req.method === "GET") {
      const eventsPayload = await fetchVa511Events();
      const status = computeVa511Status(eventsPayload);
      return send(res, status.ok ? 200 : 502, JSON.stringify(status, null, 2), { "Content-Type": "application/json" });
    }

    if (urlObj.pathname === "/api/cdc/wonder" && req.method === "GET") {
      const token = String(process.env.CDC_APP_TOKEN || "").trim();
      if (!token) {
        return send(res, 200, JSON.stringify({ ok: false, disabled: true, reason: "CDC_APP_TOKEN not configured" }, null, 2), { "Content-Type": "application/json" });
      }

      if (Date.now() < cdcState.backoffUntil) {
        return send(res, 200, JSON.stringify({
          ok: false,
          degraded: true,
          reason: cdcState.lastReason || "CDC backoff active",
          backoffUntil: new Date(cdcState.backoffUntil).toISOString(),
          cached: Boolean(cdcState.cache),
          data: cdcState.cache
        }, null, 2), { "Content-Type": "application/json" });
      }

      try {
        const upstream = await upstreamFetch(CDC_SOURCE_URL, {
          expectedType: "json",
          timeoutMs: 15000,
          headers: {
            "Accept": "application/json",
            "X-App-Token": token,
            "User-Agent": "FXBG-PALANTIR-CityManager/1.0"
          },
          upstreamName: "cdc-wonder",
          route: "/api/cdc/wonder"
        });

        if (!upstream.ok || !upstream.json) {
          if (upstream.status === 403 || upstream.status === 429) {
            cdcState.backoffUntil = Date.now() + CDC_BACKOFF_MS;
            cdcState.lastReason = `HTTP ${upstream.status}`;
          }
          throw new Error(upstream.error || `HTTP ${upstream.status}`);
        }

        const data = upstream.json;
        cdcState.cache = data;
        cdcState.backoffUntil = 0;
        cdcState.lastReason = null;
        return send(res, 200, JSON.stringify({ ok: true, data, fetchedAt: new Date().toISOString() }, null, 2), { "Content-Type": "application/json" });
      } catch (err) {
        return send(res, 200, JSON.stringify({
          ok: false,
          degraded: true,
          reason: err.message,
          cached: Boolean(cdcState.cache),
          data: cdcState.cache
        }, null, 2), { "Content-Type": "application/json" });
      }
    }

    if (urlObj.pathname === "/api/location/address" || urlObj.pathname === "/api/location/intersection" || urlObj.pathname === "/api/location/alias") {
      if (req.method !== "GET") {
        return send(res, 405, JSON.stringify({ ok: false, error: "method_not_allowed" }), { "Content-Type": "application/json" });
      }
      return send(res, 404, JSON.stringify({
        ok: false,
        error: "not_implemented",
        message: "Module 6 dataset endpoint placeholder"
      }, null, 2), { "Content-Type": "application/json" });
    }

    if (urlObj.pathname === "/api/geocode/stats") {
      const response = {
        ok: true,
        cacheSize: geocodeCache.size,
        inflightCount: geocodeInflight.size,
        lastUpstreamFetchTs: lastUpstreamFetchTs || null
      };
      return send(res, 200, JSON.stringify(response, null, 2), { "Content-Type": "application/json" });
    }

    if (urlObj.pathname === "/api/geocode") {
      if (req.method !== "GET") {
        return send(res, 405, JSON.stringify({ ok: false, error: "method_not_allowed" }), { "Content-Type": "application/json" });
      }

      const rawQ = String(urlObj.searchParams.get("q") || "").trim();
      const j = String(urlObj.searchParams.get("j") || "").trim();
      const q = ensureVirginiaQuery(rawQ, j);
      const normalizedQ = normalizeKeyPart(q);

      if (q.length < 3 || q.length > 160 || normalizedQ.length < 3) {
        return send(res, 400, JSON.stringify({ ok: false, error: "invalid_query" }), { "Content-Type": "application/json" });
      }

      const lowConfidence = inferLowConfidence(q);

      try {
        const result = await geocodeWithCache(q, j);
        if (!result) {
          return send(res, 200, JSON.stringify({ ok: false, error: "no_results" }, null, 2), { "Content-Type": "application/json" });
        }

        const lat = Number(result.lat);
        const lon = Number(result.lon);
        const aoi = result.aoi || (isWithinAoi(lat, lon) ? "inside" : "outside");

        return send(res, 200, JSON.stringify({
          ok: true,
          lat,
          lon,
          source: result.source === "cache" ? "cache" : "nominatim",
          key: result.key || normalizeKey(q, j),
          q,
          j,
          aoi,
          confidence: lowConfidence ? "low" : "normal"
        }, null, 2), { "Content-Type": "application/json" });
      } catch (err) {
        const status = err instanceof UpstreamError ? 502 : 500;
        return send(res, status, JSON.stringify({
          ok: false,
          error: err instanceof UpstreamError ? "upstream_failed" : "geocode_failed"
        }, null, 2), { "Content-Type": "application/json" });
      }
    }

    if (urlObj.pathname === "/api/reports" && req.method === "GET") {
      const items = await readReports();
      const filtered = filterReports(items, {
        since: urlObj.searchParams.get("since"),
        sinceDays: urlObj.searchParams.get("sinceDays"),
        bbox: urlObj.searchParams.get("bbox")
      });
      return send(res, 200, JSON.stringify({ ok: true, count: filtered.length, items: filtered }, null, 2), {
        "Content-Type": "application/json"
      });
    }

    if (urlObj.pathname === "/api/reports" && req.method === "POST") {
      try {
        const contentType = String(req.headers["content-type"] || "");
        let fields = {};
        let upload = null;

        if (contentType.includes("multipart/form-data")) {
          const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
          if (!boundaryMatch) {
            return send(res, 400, JSON.stringify({ ok: false, error: "invalid_multipart" }), { "Content-Type": "application/json" });
          }
          const boundary = boundaryMatch[1].replace(/^"|"$/g, "");
          const body = await readBody(req, REPORT_FORM_LIMIT);
          const parsed = parseMultipart(body, boundary);
          fields = parsed.fields || {};
          upload = parsed.file || null;
        } else {
          const body = await readBody(req, PAYLOAD_LIMITS.json);
          fields = safeJsonParse(body.toString("utf8"), {}, "reports payload");
        }

        const lat = Number(fields.lat);
        const lng = Number(fields.lng);
        const accuracy = fields.accuracy !== undefined ? Number(fields.accuracy) : undefined;
        const severity = Number(fields.severity);
        const type = String(fields.type || "Other");
        const note = String(fields.note || "");

        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          return send(res, 400, JSON.stringify({ ok: false, error: "invalid_coordinates" }), { "Content-Type": "application/json" });
        }
        if (!Number.isFinite(severity) || severity < 1 || severity > 5) {
          return send(res, 400, JSON.stringify({ ok: false, error: "invalid_severity" }), { "Content-Type": "application/json" });
        }
        if (note.length > REPORT_NOTE_LIMIT) {
          return send(res, 400, JSON.stringify({ ok: false, error: "note_too_long" }), { "Content-Type": "application/json" });
        }

        const id = crypto.randomUUID();
        let photo = null;

        if (upload && upload.buffer && upload.buffer.length) {
          if (!REPORT_ALLOWED_MIME.has(upload.mime)) {
            return send(res, 400, JSON.stringify({ ok: false, error: "invalid_photo_type" }), { "Content-Type": "application/json" });
          }
          if (upload.buffer.length > REPORT_UPLOAD_LIMIT) {
            return send(res, 400, JSON.stringify({ ok: false, error: "photo_too_large" }), { "Content-Type": "application/json" });
          }
          await fsp.mkdir(REPORT_UPLOAD_DIR, { recursive: true });
          const ext = upload.mime === "image/jpeg" ? "jpg" : upload.mime === "image/png" ? "png" : "webp";
          const filename = `${id}.${ext}`;
          const filePath = path.join(REPORT_UPLOAD_DIR, filename);
          await fsp.writeFile(filePath, upload.buffer);
          photo = {
            filename,
            mime: upload.mime,
            size: upload.buffer.length,
            path: filePath,
            url: `/uploads/reports/${filename}`
          };
        }

        const item = {
          id,
          ts: new Date().toISOString(),
          lat,
          lng,
          accuracy: Number.isFinite(accuracy) ? accuracy : undefined,
          type,
          severity,
          note,
          photo,
          userAgent: req.headers["user-agent"] || undefined,
          deviceLabel: fields.deviceLabel || undefined
        };

        const items = await readReports();
        items.push(item);
        await writeReports(items);

        return send(res, 200, JSON.stringify({ ok: true, item }, null, 2), { "Content-Type": "application/json" });
      } catch (err) {
        const status = err.message === "payload_too_large" ? 413 : 500;
        return send(res, status, JSON.stringify({ ok: false, error: "report_save_failed" }), { "Content-Type": "application/json" });
      }
    }

    if (urlObj.pathname === "/api/reports/export.csv") {
      const items = await readReports();
      const headers = ["id", "ts", "lat", "lng", "accuracy", "type", "severity", "note", "photoUrl"];
      const rows = items.map((item) => [
        item.id,
        item.ts,
        item.lat,
        item.lng,
        item.accuracy || "",
        item.type,
        item.severity,
        item.note,
        item.photo?.url || ""
      ]);
      const csv = [headers.map(toCsvValue).join(","), ...rows.map(row => row.map(toCsvValue).join(","))].join("\n");
      return send(res, 200, csv, { "Content-Type": "text/csv; charset=utf-8" });
    }

    if (urlObj.pathname === "/api/reports/export.geojson") {
      const items = await readReports();
      const features = items.map((item) => ({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [item.lng, item.lat]
        },
        properties: {
          id: item.id,
          ts: item.ts,
          accuracy: item.accuracy,
          type: item.type,
          severity: item.severity,
          note: item.note,
          photoUrl: item.photo?.url || null
        }
      }));
      const geojson = { type: "FeatureCollection", features };
      return send(res, 200, JSON.stringify(geojson, null, 2), { "Content-Type": "application/geo+json" });
    }

    // Upstream health endpoint - compact report of key upstreams
    if (urlObj.pathname === "/api/health/upstreams") {
      const upstreams = [];

      for (const upstream of REQUIRED_UPSTREAMS) {
        const lastSuccess = upstreamLastSuccess.get(upstream.name) || null;
        upstreams.push({
          name: upstream.name,
          url: upstream.url,
          required: upstream.required,
          lastSuccess: lastSuccess,
          usingCached: lastSuccess !== null
        });
      }

      const response = {
        ok: true,
        timestamp: new Date().toISOString(),
        upstreams: upstreams,
        optionalServices: {
          openuv: OPENUV_API_KEY ? "enabled" : "disabled (missing key)",
          waqi: WAQI_TOKEN ? "enabled" : "disabled (missing token)"
        }
      };

      return send(res, 200, JSON.stringify(response, null, 2), { "Content-Type": "application/json" });
    }

    // Upstream test endpoint - safe connectivity check
    if (urlObj.pathname === "/api/health/test-upstreams") {
      const clientKey = getClientKey(req);
      const now = Date.now();
      const lastRun = upstreamTestRateLimit.get(clientKey) || 0;
      if (now - lastRun < UPSTREAM_TEST_RATE_LIMIT_MS) {
        const retryAfterSec = Math.ceil((UPSTREAM_TEST_RATE_LIMIT_MS - (now - lastRun)) / 1000);
        const response = {
          ok: false,
          error: "rate_limited",
          message: "Upstream tests are limited to once per 10 seconds per client.",
          retryAfterSec
        };
        return send(res, 200, JSON.stringify(response, null, 2), { "Content-Type": "application/json" });
      }
      upstreamTestRateLimit.set(clientKey, now);

      const quick = urlObj.searchParams.get("quick") !== "0";
      const cachePolicy = UPSTREAM_CACHE_TTLS.diagnostics;
      const cacheKey = quick ? "test-upstreams-quick" : "test-upstreams-full";

      const cacheResult = await upstreamCache.wrap(
        cacheKey,
        cachePolicy.ttlMs,
        async () => {
          const results = await mapWithConcurrency(REQUIRED_UPSTREAMS, DIAG_CONCURRENCY, async (upstream) => {
            const expectedType = expectedTypeFromExpectList(upstream.expect);
            const method = expectedType === "image" ? "HEAD" : "GET";
            const maxBytes = expectedType === "image" ? 0 : quick ? 64 * 1024 : 256 * 1024;

            const result = await runUpstreamFetch(upstream.name, upstream.url, {
              route: "test-upstreams",
              expectedType,
              timeoutMs: quick ? 5000 : 8000,
              method,
              maxBytes,
              includeBodyText: expectedType === "html" || expectedType === "text"
            });

            const status = result.status || 0;
            const connectionOk = status > 0;
            const httpOk = status >= 200 && status < 400;
            const contentTypeOk = result.error !== "unexpected_content_type";
            const parseOk = result.error !== "invalid_json" && contentTypeOk;
            const ok = connectionOk && httpOk && contentTypeOk && parseOk;

            let recommendation = "Upstream healthy.";
            if (!connectionOk) {
              recommendation = "Check DNS/connectivity; rely on cached data.";
            } else if (status === 403 || status === 429) {
              recommendation = "Upstream blocking or rate-limiting; use cached data.";
            } else if (status >= 500) {
              recommendation = "Upstream server error; use cached data.";
            } else if (!contentTypeOk || !parseOk) {
              recommendation = "Upstream returned unexpected data; use cached data.";
            }

            return {
              name: upstream.name,
              url: upstream.url,
              ok,
              dnsOk: connectionOk,
              httpStatus: status,
              elapsedMs: result.elapsedMs,
              contentType: result.contentType || null,
              contentTypeOk,
              parseOk,
              notes: result.error || (!httpOk && status ? `http_${status}` : null),
              recommendation
            };
          });

          const okCount = results.filter(r => r.ok).length;
          return {
            ok: okCount === results.length,
            summary: `${okCount}/${results.length} upstreams healthy`,
            timestamp: new Date().toISOString(),
            quick,
            upstreams: results
          };
        },
        { staleTtlMs: cachePolicy.staleTtlMs }
      );

      const response = {
        ...cacheResult.value,
        cache: toCacheMeta(cacheResult.cache, cachePolicy.ttlMs),
        warning: cacheResult.warning || undefined
      };

      return send(res, 200, JSON.stringify(response, null, 2), { "Content-Type": "application/json" });
    }

    // OpenUV API proxy (server-side key injection)
    if (urlObj.pathname === "/api/openuv") {
      const lat = Number(urlObj.searchParams.get("lat"));
      const lon = Number(urlObj.searchParams.get("lng") || urlObj.searchParams.get("lon"));

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return send(res, 400, JSON.stringify({ ok: false, error: "invalid_coordinates" }), { "Content-Type": "application/json" });
      }

      if (!OPENUV_API_KEY) {
        return send(res, 503, JSON.stringify({
          ok: false,
          error: "missing_env",
          message: "Missing OPENUV_API_KEY (or OPENUV_KEY) in .env"
        }), { "Content-Type": "application/json" });
      }

      const targetUrl = `https://api.openuv.io/api/v1/uv?lat=${lat}&lng=${lon}`;
      const entry = await proxyFetch(targetUrl, {
        accept: "application/json",
        "x-access-token": OPENUV_API_KEY
      });
      return send(res, entry.status || 200, entry.body, entry.headers);
    }

    // Air Quality API proxy (WAQI token server-side)
    if (urlObj.pathname === "/api/waqi") {
      const lat = Number(urlObj.searchParams.get("lat"));
      const lon = Number(urlObj.searchParams.get("lon"));
      const cachePolicy = UPSTREAM_CACHE_TTLS.waqi;
      const errorCacheTtlMs = 30 * 1000;

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return send(res, 400, JSON.stringify({
          ok: false,
          provider: "waqi",
          aqi: null,
          city: null,
          ts: Date.now(),
          error: "invalid_coordinates"
        }), { "Content-Type": "application/json" });
      }

      const cacheKey = `waqi:${lat}:${lon}`;
      const cached = upstreamCache.get(cacheKey);
      if (cached.hit && !cached.stale) {
        const payload = cached.value;
        const status = payload?.ok ? 200 : 503;
        return send(res, status, JSON.stringify(payload), { "Content-Type": "application/json" });
      }

      if (!WAQI_TOKEN) {
        const payload = {
          ok: false,
          provider: "waqi",
          aqi: null,
          city: null,
          ts: Date.now(),
          error: "WAQI_TOKEN missing"
        };
        upstreamCache.set(cacheKey, payload, errorCacheTtlMs);
        return send(res, 503, JSON.stringify(payload), { "Content-Type": "application/json" });
      }

      const targetUrl = `https://api.waqi.info/feed/geo:${lat};${lon}/?token=${WAQI_TOKEN}`;
      let payload = null;
      let statusCode = 200;
      try {
        const entry = await proxyFetch(targetUrl, { accept: "application/json" });
        const bodyText = entry.body ? entry.body.toString("utf8") : "";
        const data = bodyText ? JSON.parse(bodyText) : null;

        if (entry.status && entry.status >= 200 && entry.status < 300 && data?.status === "ok") {
          const rawAqi = data?.data?.aqi;
          const parsedAqi = typeof rawAqi === "number" ? rawAqi : Number.isFinite(Number(rawAqi)) ? Number(rawAqi) : null;
          const city = data?.data?.city?.name || data?.data?.city || null;
          payload = {
            ok: true,
            provider: "waqi",
            aqi: Number.isFinite(parsedAqi) ? parsedAqi : null,
            city,
            ts: Date.now()
          };
          if (payload.aqi === null) {
            payload.note = "aqi_unavailable";
          }
          upstreamCache.set(cacheKey, payload, cachePolicy.ttlMs);
        } else {
          const errorMessage = data?.data?.message || data?.message || data?.status || `http_${entry.status || "unknown"}`;
          payload = {
            ok: false,
            provider: "waqi",
            aqi: null,
            city: null,
            ts: Date.now(),
            error: errorMessage
          };
          upstreamCache.set(cacheKey, payload, errorCacheTtlMs);
          statusCode = 503;
        }
      } catch (err) {
        payload = {
          ok: false,
          provider: "waqi",
          aqi: null,
          city: null,
          ts: Date.now(),
          error: err?.message || "upstream_error"
        };
        upstreamCache.set(cacheKey, payload, errorCacheTtlMs);
        statusCode = 503;
      }

      return send(res, statusCode, JSON.stringify(payload), { "Content-Type": "application/json" });
    }

    // Diagnostics endpoint - test upstream service connectivity
    if (urlObj.pathname === "/api/diagnostics/allowlist" && req.method === "GET") {
      const allowlistedHosts = Array.from(NORMALIZED_ALLOWED_HOSTS).sort();
      const blockedHostsSample = Array.from(new Set([
        ...BLOCKED_HOSTNAMES.map(normalizeHost),
        "10.0.0.1",
        "172.16.0.1",
        "192.168.0.1",
        "169.254.1.1",
        "::1"
      ])).filter(Boolean);
      const response = {
        ok: true,
        allowlistedHosts,
        blockedHostsSample,
        notes: "If a feed fails due to blocked host, add to DEV_NOTES allowlist"
      };
      return send(res, 200, JSON.stringify(response, null, 2), { "Content-Type": "application/json" });
    }

    if (urlObj.pathname === "/api/diag/upstreams") {
      const cachePolicy = UPSTREAM_CACHE_TTLS.diagnostics;
      const cacheKey = "diag-upstreams";
      const cacheResult = await upstreamCache.wrap(
        cacheKey,
        cachePolicy.ttlMs,
        async () => {
          const results = await mapWithConcurrency(REQUIRED_UPSTREAMS, DIAG_CONCURRENCY, async (upstream) => {
            const expectedType = expectedTypeFromExpectList(upstream.expect);
            const start = Date.now();
            const lastSuccess = upstreamLastSuccess.get(upstream.name) || null;
            const result = {
              name: upstream.name,
              url: upstream.url,
              ok: false,
              status: "error",
              contentType: null,
              ms: null,
              bytes: null,
              errorCode: null,
              lastSuccess,
              required: upstream.required
            };

            try {
              const response = await fetchUpstreamWithLimits(upstream.url, {
                expectedType,
                timeoutMs: DIAG_TIMEOUT_MS,
                name: upstream.name,
                route: "diag-upstreams"
              });
              result.ms = response.ms;
              result.contentType = response.contentType || null;
              result.bytes = response.bytes || null;

              if (response.status === 200) {
                result.ok = true;
                result.status = "ok";
                const successTs = new Date().toISOString();
                result.lastSuccess = successTs;
                upstreamLastSuccess.set(upstream.name, successTs);
              } else {
                result.errorCode = `http_${response.status}`;
                result.status = lastSuccess ? "stale" : "error";
              }
            } catch (err) {
              result.ms = Date.now() - start;
              result.errorCode = err.code || "fetch_failed";
              result.status = lastSuccess ? "stale" : "error";
            }

            return result;
          });

          const okCount = results.filter(r => r.status === "ok").length;
          return {
            ok: okCount === results.length,
            summary: `${okCount}/${results.length} upstreams healthy`,
            timestamp: new Date().toISOString(),
            upstreams: results,
            optionalServices: {
              openuv: OPENUV_API_KEY ? "enabled" : "disabled (missing key)",
              waqi: WAQI_TOKEN ? "enabled" : "disabled (missing token)"
            }
          };
        },
        { staleTtlMs: cachePolicy.staleTtlMs }
      );

      const response = {
        ...cacheResult.value,
        cache: toCacheMeta(cacheResult.cache, cachePolicy.ttlMs),
        warning: cacheResult.warning || undefined
      };
      return send(res, 200, JSON.stringify(response, null, 2), { "Content-Type": "application/json" });
    }

    // Cache stats endpoint (detailed, dev-only)
    if (urlObj.pathname === "/cache/stats") {
      const cacheStats = cacheManager.stats();
      const cacheEntries = [];
      for (const [key, entry] of cacheManager.cache.entries()) {
        const age = Date.now() - entry.ts;
        const isFresh = age < entry.ttlMs;
        cacheEntries.push({
          key: key.slice(0, 80), // Truncate for readability
          age: age,
          ttl: entry.ttlMs,
          status: entry.status,
          bytes: entry.body?.length || 0,
          fresh: isFresh
        });
      }

      const backoffs = [];
      for (const [host, info] of hostBackoff.entries()) {
        backoffs.push({ host, errors: info.consecutiveErrors, backoffMs: info.backoffMs });
      }

      const stats = {
        cache: cacheStats,
        entries: cacheEntries.sort((a, b) => b.age - a.age).slice(0, 50), // Top 50 oldest
        hostBackoffs: backoffs
      };
      return send(res, 200, JSON.stringify(stats, null, 2), { "Content-Type": "application/json" });
    }

    // Debug memory endpoint (dev-only, disabled in production)
    if (urlObj.pathname === "/debug/memory") {
      // Check if production mode (disable in production)
      const isProduction = process.env.NODE_ENV === 'production';
      if (isProduction) {
        return send(res, 403, JSON.stringify({
          error: "forbidden",
          message: "/debug/memory endpoint is disabled in production mode"
        }), { "Content-Type": "application/json" });
      }

      const mem = process.memoryUsage();
      const cacheStats = cacheManager.stats();

      // Count active items in caches
      let activeItems = 0;
      for (const [_, entry] of cacheManager.cache.entries()) {
        const age = Date.now() - entry.ts;
        if (age < entry.ttlMs) activeItems++;
      }

      const debugInfo = {
        timestamp: new Date().toISOString(),
        uptime: {
          ms: Date.now() - SERVER_START_TIME,
          human: `${Math.floor((Date.now() - SERVER_START_TIME) / 1000 / 60)} minutes`
        },
        process: {
          memoryUsage: {
            rss: `${Math.round(mem.rss / 1024 / 1024)} MB`,
            heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)} MB`,
            heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)} MB`,
            external: `${Math.round(mem.external / 1024 / 1024)} MB`
          },
          pid: process.pid,
          nodeVersion: process.version
        },
        cache: {
          entries: cacheStats.entries,
          maxEntries: cacheStats.maxEntries,
          activeItems: activeItems,
          bytesUsed: cacheStats.bytes,
          maxBytes: cacheStats.maxBytes,
          utilizationPct: Math.round((cacheStats.bytes / cacheStats.maxBytes) * 100)
        },
        maps: {
          inflight: inflight.size,
          hostLast: hostLast.size,
          hostBackoff: hostBackoff.size,
          qqmsErrors: qqms.errorCounts.size
        },
        connections: {
          activeFetches: activeFetches,
          maxConcurrent: MAX_CONCURRENT
        }
      };

      return send(res, 200, JSON.stringify(debugInfo, null, 2), { "Content-Type": "application/json" });
    }

    // Crime Reports API endpoints
    if (urlObj.pathname === "/api/fxbg/crime-reports/refresh") {
      const months = parseInt(urlObj.searchParams.get("months") || "6", 10);
      const forceRefresh = urlObj.searchParams.get("force") === "1";
      const debugStartTime = Date.now();

      // Check throttle (unless force=1)
      const timeSinceLastRefresh = debugStartTime - crimeReportsState.lastResultTimestamp;
      if (!forceRefresh && timeSinceLastRefresh < CRIME_REFRESH_THROTTLE_MS && crimeReportsState.lastResult) {
        console.log(`[Crime Reports API] Throttled - returning cached result (${timeSinceLastRefresh}ms since last refresh)`);
        const cachedResponse = {
          ...crimeReportsState.lastResult,
          isStale: false,
          warning: `Throttled: refresh called within ${CRIME_REFRESH_THROTTLE_MS / 1000}s. Use force=1 to bypass.`,
          forced: false
        };
        return send(res, 200, JSON.stringify(cachedResponse, null, 2), { "Content-Type": "application/json" });
      }

      console.log(`[Crime Reports API] Refresh requested for ${months} months (force=${forceRefresh})`);

      try {
        // Run the real PDF scraping and parsing
        const result = await refreshCrimeReports(months);

        // Build standardized response
        const response = {
          ok: result.success,
          months: months,
          pdfCount: result.pdfCount || 0,
          parsedCount: result.count || 0,
          geocoded: result.geocoded || 0,
          forced: forceRefresh,
          strategyUsed: result.strategyUsed || "none",
          timestamp: new Date().toISOString()
        };

        // Add optional fields
        if (!result.success) {
          response.warning = result.message;
        } else if (result.warning) {
          response.warning = result.warning;
        }
        if (result.debug) {
          response.debug = result.debug;
        }
        if (result.diagnostics) {
          response.debug = response.debug || {};
          response.debug.diagnostics = result.diagnostics;
        }

        // Cache the result for throttling
        crimeReportsState.lastResult = response;
        crimeReportsState.lastResultTimestamp = Date.now();

        // Log completion
        const debugDuration = Date.now() - debugStartTime;
        logApp({
          level: result.success ? "INFO" : "WARN",
          kind: "crime_refresh_complete",
          msg: result.success ? "Crime reports refresh succeeded" : "Crime reports refresh had issues",
          pdfCount: result.pdfCount,
          parsedCount: result.count,
          strategyUsed: result.strategyUsed,
          ms: debugDuration
        });

        // IMPORTANT: Never return 500 for "no PDFs found" - use 200 with ok:false
        return send(res, 200, JSON.stringify(response, null, 2), { "Content-Type": "application/json" });
      } catch (err) {
        console.error("[Crime Reports API] Refresh error:", err);
        logApp({
          level: "ERROR",
          kind: "crime_refresh_error",
          msg: "Crime reports refresh failed with exception",
          errorCode: err.message
        });
        // Return 200 with ok:false for client-friendly error handling
        const errorResponse = {
          ok: false,
          months: months,
          pdfCount: 0,
          parsedCount: 0,
          geocoded: 0,
          forced: forceRefresh,
          strategyUsed: "none",
          timestamp: new Date().toISOString(),
          warning: err.message
        };
        return send(res, 200, JSON.stringify(errorResponse, null, 2), { "Content-Type": "application/json" });
      }
    }

    // Crime Reports Status endpoint
    if (urlObj.pathname === "/api/fxbg/crime-reports/status") {
      // Try to load latest info from incidents file
      let fileInfo = null;
      try {
        const incidentsFile = path.join(__dirname, "data", "fxbg-crime-reports", "incidents.json");
        const data = await fsp.readFile(incidentsFile, "utf8");
        const parsed = safeJsonParse(data, null, "crime incidents status");
        if (parsed && !Array.isArray(parsed)) {
          fileInfo = {
            lastUpdated: parsed.lastUpdated,
            pdfCount: parsed.pdfCount,
            incidentsCount: parsed.incidentCount || (parsed.incidents ? parsed.incidents.length : 0)
          };
        }
      } catch (e) {
        // File doesn't exist yet
      }

      // Determine staleness (older than 7 days)
      const lastUpdated = fileInfo?.lastUpdated || crimeReportsState.lastUpdated;
      const isStale = lastUpdated ? (Date.now() - new Date(lastUpdated).getTime() > 7 * 24 * 60 * 60 * 1000) : true;

      const status = {
        ok: true,
        lastRefreshAttempt: crimeReportsState.lastRefreshAttempt,
        lastRefreshOk: crimeReportsState.lastRefreshOk,
        lastRefreshMessage: crimeReportsState.lastRefreshMessage,
        lastUpdated: lastUpdated,
        pdfCount: fileInfo?.pdfCount || crimeReportsState.pdfCount,
        incidentsCount: fileInfo?.incidentsCount || crimeReportsState.incidentsCount,
        isStale: isStale
      };

      return send(res, 200, JSON.stringify(status, null, 2), { "Content-Type": "application/json" });
    }


    if (urlObj.pathname === "/api/hub/ping" && req.method === "POST") {
      // Intentionally no auth for LAN ops utility; future hardening should add auth and signatures.
      const body = await readBody(req, 64 * 1024);
      const payload = safeJsonParse(body.toString("utf8"), {}, "hub ping payload") || {};
      const client = touchHubClient({
        deviceId: payload.deviceId,
        userAgent: payload.userAgent || req.headers["user-agent"] || ""
      });
      if (!client) {
        return send(res, 400, JSON.stringify({ ok: false, error: "invalid_device_id" }), { "Content-Type": "application/json" });
      }
      return send(res, 200, JSON.stringify({ ok: true, lastSeen: client.lastSeen }, null, 2), { "Content-Type": "application/json" });
    }

    if (urlObj.pathname === "/api/hub/clients" && req.method === "GET") {
      const now = Date.now();
      const clients = Array.from(hubClients.values())
        .filter((entry) => now - Number(entry.lastSeen || 0) <= HUB_CLIENTS_MAX_AGE_MS)
        .sort((a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0))
        .map((entry) => ({
          deviceId: entry.deviceId,
          lastSeen: entry.lastSeen,
          userAgent: entry.userAgent
        }));
      return send(res, 200, JSON.stringify({ ok: true, clients }, null, 2), { "Content-Type": "application/json" });
    }
    if (urlObj.pathname === "/api/fxbg/crime-reports/incidents") {
      const months = parseInt(urlObj.searchParams.get("months") || "6", 10);
      try {
        const dataDir = path.join(__dirname, "data", "fxbg-crime-reports");
        const incidentsFile = path.join(dataDir, "incidents.json");
        const cachePolicy = UPSTREAM_CACHE_TTLS.crimeIncidents;
        const cacheKey = "crime-incidents";

        const cachedResult = await upstreamCache.wrap(
          cacheKey,
          cachePolicy.ttlMs,
          async () => {
            let incidents = [];
            let lastUpdated = null;
            let dataSource = "sample";

            try {
              const data = await fsp.readFile(incidentsFile, "utf8");
              const parsed = safeJsonParse(data, null, "crime incidents cache");

              if (Array.isArray(parsed)) {
                incidents = parsed;
              } else if (parsed && parsed.incidents && Array.isArray(parsed.incidents)) {
                incidents = parsed.incidents;
                lastUpdated = parsed.lastUpdated;
                dataSource = "scraped";
              }
            } catch (err) {
              console.log("[Crime Reports API] No cached data, generating sample incidents");
              incidents = generateSampleIncidents(months);
              dataSource = "sample";

              await fsp.mkdir(dataDir, { recursive: true });
              const sampleData = {
                lastUpdated: new Date().toISOString(),
                sourceUrl: "sample-data",
                incidentCount: incidents.length,
                incidents: incidents
              };
              await fsp.writeFile(incidentsFile, JSON.stringify(sampleData, null, 2), "utf8");
            }

            return { incidents, lastUpdated, dataSource };
          },
          { staleTtlMs: cachePolicy.staleTtlMs }
        );

        const incidents = cachedResult.value?.incidents || [];
        const lastUpdated = cachedResult.value?.lastUpdated || null;
        const dataSource = cachedResult.value?.dataSource || "sample";
        const cacheMeta = toCacheMeta(cachedResult.cache, cachePolicy.ttlMs);
        const cacheWarning = cachedResult.warning ? "Serving cached crime incidents data." : null;

        // Filter by date range
        const cutoffDate = new Date();
        cutoffDate.setMonth(cutoffDate.getMonth() - months);

        const filtered = incidents.filter(inc => {
          const incDate = new Date(inc.incidentDateISO);
          return incDate >= cutoffDate;
        });

        // Check if data is stale (older than 7 days)
        const isStale = lastUpdated && (Date.now() - new Date(lastUpdated).getTime() > 7 * 24 * 60 * 60 * 1000);

        // DEBUG: Log dataSource, lastUpdated, and isStale
        console.log(`[DEBUG Crime Incidents API] dataSource="${dataSource}" (scraped = real PDF data, sample = generated test data)`);
        console.log(`[DEBUG Crime Incidents API] lastUpdated=${lastUpdated || "null"}, isStale=${isStale}`);
        if (lastUpdated) {
          const ageMs = Date.now() - new Date(lastUpdated).getTime();
          const ageHours = (ageMs / 1000 / 60 / 60).toFixed(1);
          console.log(`[DEBUG Crime Incidents API] Data age: ${ageHours} hours (stale threshold: 168 hours / 7 days)`);
        }

        console.log(`[Crime Reports API] Returning ${filtered.length} incidents (${months} months, source: ${dataSource})`);
        return send(res, 200, JSON.stringify({
          ok: true,
          count: filtered.length,
          months: months,
          dataSource: dataSource,
          lastUpdated: lastUpdated,
          isStale: isStale,
          cache: cacheMeta,
          warning: cacheWarning || undefined,
          incidents: filtered
        }, null, 2), { "Content-Type": "application/json" });
      } catch (err) {
        console.error("[Crime Reports API] Incidents error:", err);
        return send(res, 200, JSON.stringify({ ok: false, error: err.message }), { "Content-Type": "application/json" });
      }
    }

    if (urlObj.pathname === "/proxy") {
      const target = urlObj.searchParams.get("url");
      if (!target) return send(res, 400, "Missing url param");
      if (!/^https?:\/\//i.test(target)) return send(res, 400, "Only http/https URLs are allowed");

      if (isProxyRecursionTarget(target, req)) {
        return send(res, 400, JSON.stringify({
          ok: false,
          error: "proxy_recursion_blocked",
          message: "Do not proxy local URLs; call /api/* directly."
        }), { "Content-Type": "application/json" });
      }

      // Security: Check if target URL is allowed
      const urlCheck = checkUrlAllowed(target);
      if (!urlCheck.allowed) {
        const blockedHost = urlCheck.host || (() => { try { return normalizeHost(new URL(target).hostname); } catch { return 'unknown'; } })();
        console.warn(`[proxy] Blocked host=${blockedHost} url=${target}. ${urlCheck.reason}. Add ${blockedHost} to ALLOWLIST if approved.`);
        let upstreamHost = '';
        try { upstreamHost = new URL(target).hostname; } catch {}
        const errorBody = JSON.stringify({
          ok: false,
          error: "blocked_target",
          upstream: upstreamHost,
          status: 403,
          message: "This URL is not permitted by the proxy security policy. " + urlCheck.reason
        });
        // Round 3: Ensure CORS headers on error responses
        return send(res, 403, errorBody, { "Content-Type": "application/json" });
      }

      try {
        const entry = await proxyFetch(target, req.headers);
        res.writeHead(entry.status, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Cache-TTL-MS, X-Timeout-MS, X-Access-Token, X-Api-Key, X-Requested-With, Accept",
          ...entry.headers,
        });
        return res.end(entry.body);
      } catch (proxyErr) {
        console.error(`[proxy] Failed to fetch ${target}:`, proxyErr.message);
        let upstreamHost = '';
        try { upstreamHost = new URL(target).hostname; } catch {}
        const errorBody = JSON.stringify({
          ok: false,
          error: "proxy_fetch_failed",
          upstream: upstreamHost,
          status: 502,
          message: proxyErr.message || String(proxyErr)
        });
        // Round 3: Ensure CORS headers on error responses (send() already adds them)
        return send(res, 502, errorBody, { "Content-Type": "application/json" });
      }
    }

    return serveStatic(req, res);
  } catch (err) {
    console.error("Server error:", err);
    logApp({
      level: "ERROR",
      kind: "server_error",
      msg: err.message || String(err)
    });
    return send(res, 500, String(err || "Server error"));
  }
});

async function startServer() {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  runAllowlistSanityCheck();
  await validateRequiredUpstreams();
  await loadHubClients();

  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(`[startup] Port ${PORT} already in use. Try: PORT=${PORT + 1} node proxy-server.js`);
      process.exit(1);
    }
    console.error("[startup] Server error:", err);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    console.log(`\n🧠 CITY MANAGER server running on ${HOST}:${PORT}\n`);
    console.log(`📱 Open on this device: http://127.0.0.1:${PORT}`);
    logApp({
      level: "INFO",
      kind: "startup",
      msg: `Server started on ${HOST}:${PORT}`
    });

    // Enumerate network interfaces and show LAN URLs
    const networkInterfaces = os.networkInterfaces();
    const lanIPs = [];

    for (const [name, interfaces] of Object.entries(networkInterfaces)) {
      for (const iface of interfaces) {
        // Only show IPv4, non-internal addresses
        if (iface.family === 'IPv4' && !iface.internal) {
          lanIPs.push(iface.address);
        }
      }
    }

    if (lanIPs.length > 0) {
      console.log(`\n💻 Open from laptop (tether/Wi-Fi):`);
      lanIPs.forEach(ip => {
        console.log(`   http://${ip}:${PORT}`);
      });
    }

    console.log(`\n🔧 Proxy endpoint: http://127.0.0.1:${PORT}/proxy?url=https://example.com/feed\n`);
  });
}

startServer().catch((err) => {
  console.error("[startup] Server failed to start:", err.message || err);
  process.exit(1);
});

process.on("exit", () => {
  logApp({
    level: "INFO",
    kind: "shutdown",
    msg: "Server shutting down."
  });
  try {
    appLogStream.end();
    upstreamLogStream.end();
  } catch (_) {
    // Ignore shutdown errors
  }
});
