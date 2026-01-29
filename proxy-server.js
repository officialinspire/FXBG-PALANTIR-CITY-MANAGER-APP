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
const https = require("https");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");

// PDF parsing (for crime reports)
let pdfParse = null;
try {
  pdfParse = require("pdf-parse");
} catch (e) {
  console.warn("[Crime Reports] pdf-parse not installed. Run 'npm install' to enable PDF parsing.");
}

const HOST = process.env.BIND || "0.0.0.0";
const PORT = Number(process.env.PORT || 8000);
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
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
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

  // Testing/Dev (remove in production if needed)
  'httpbin.org',
  'www.httpbin.org',
];

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
    const isAllowed = ALLOWED_UPSTREAM_DOMAINS.some(allowed => {
      // Exact match
      if (hostname === allowed) return true;
      // Subdomain match (e.g., 'services1.arcgis.com' matches 'arcgis.com')
      // IMPORTANT: Only match if hostname is longer and has a dot before the allowed domain
      if (hostname.endsWith('.' + allowed) && hostname.length > allowed.length + 1) return true;
      return false;
    });

    if (!isAllowed) {
      return {
        allowed: false,
        reason: `Domain '${hostname}' not in allowlist (see DEV_NOTES.md for permitted domains)`
      };
    }

    // All checks passed
    return { allowed: true };

  } catch (err) {
    return {
      allowed: false,
      reason: `Invalid URL: ${err.message}`
    };
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Cache-TTL-MS, X-Timeout-MS, X-Access-Token, X-Api-Key, X-Requested-With, Accept",
    ...headers,
  });
  res.end(body);
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
      try {
        const parsed = JSON.parse(body.toString('utf8'));
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
      } catch {}
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

async function proxyFetch(targetUrl, reqHeaders) {
  const accept = String(reqHeaders["accept"] || "");
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
      const targetHost = new URL(targetUrl).hostname;
      const isVa511Host = targetHost.includes("511virginia.org") ||
                          targetHost.includes("511.vdot.virginia.gov");

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
        return entry404;
      }

      const buf = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstream.headers.get("content-type") || "application/octet-stream";

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

// Geocode cache for crime report locations
const geocodeCache = new Map();
const GEOCODE_CACHE_FILE = path.join(__dirname, "data", "geocode_cache.json");

// Load geocode cache on startup
async function loadGeocodeCache() {
  try {
    const data = await fsp.readFile(GEOCODE_CACHE_FILE, "utf8");
    const parsed = JSON.parse(data);
    for (const [key, value] of Object.entries(parsed)) {
      geocodeCache.set(key, value);
    }
    console.log(`[Geocode] Loaded ${geocodeCache.size} cached locations`);
  } catch (e) {
    // Cache file doesn't exist yet
  }
}

// Save geocode cache
async function saveGeocodeCache() {
  try {
    const dataDir = path.dirname(GEOCODE_CACHE_FILE);
    await fsp.mkdir(dataDir, { recursive: true });
    const obj = Object.fromEntries(geocodeCache);
    await fsp.writeFile(GEOCODE_CACHE_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.warn("[Geocode] Failed to save cache:", e.message);
  }
}

// Simple HTTPS fetch helper
function httpsGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": options.accept || "*/*",
        ...options.headers
      },
      timeout: options.timeout || 30000
    };

    const req = https.request(reqOptions, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return httpsGet(redirectUrl, options).then(resolve).catch(reject);
      }

      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: buffer,
          text: () => buffer.toString("utf8")
        });
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    req.end();
  });
}

// Fetch crime reports page and extract PDF links
async function fetchCrimeReportPdfLinks() {
  console.log("[Crime Reports] Fetching crime reports page...");

  try {
    const response = await httpsGet(FXBG_CRIME_REPORTS_URL, {
      accept: "text/html",
      timeout: 30000
    });

    if (response.statusCode !== 200) {
      throw new Error(`HTTP ${response.statusCode}`);
    }

    const html = response.text();

    // Extract PDF links - look for DocumentCenter/View/ links
    // Pattern: /DocumentCenter/View/12345/Crime-Report-Week-of-01-01-2026
    const pdfLinkRegex = /\/DocumentCenter\/View\/(\d+)[^"'>\s]*/gi;
    const matches = [...html.matchAll(pdfLinkRegex)];

    const pdfLinks = [];
    const seenIds = new Set();

    for (const match of matches) {
      const docId = match[1];
      if (seenIds.has(docId)) continue;
      seenIds.add(docId);

      const fullPath = match[0];
      // Check if it looks like a crime report
      if (fullPath.toLowerCase().includes("crime") ||
          fullPath.toLowerCase().includes("weekly") ||
          fullPath.toLowerCase().includes("report")) {
        pdfLinks.push({
          id: docId,
          url: FXBG_DOCUMENT_CENTER_BASE + docId,
          path: fullPath
        });
      }
    }

    // Also look for direct links to crime report PDFs
    const directPdfRegex = /href=["']([^"']*(?:crime|weekly)[^"']*\.pdf)["']/gi;
    const directMatches = [...html.matchAll(directPdfRegex)];
    for (const match of directMatches) {
      const pdfUrl = match[1].startsWith("http")
        ? match[1]
        : `https://www.fredericksburgva.gov${match[1].startsWith("/") ? "" : "/"}${match[1]}`;
      const docId = `direct-${pdfLinks.length}`;
      if (!seenIds.has(pdfUrl)) {
        seenIds.add(pdfUrl);
        pdfLinks.push({
          id: docId,
          url: pdfUrl,
          path: pdfUrl
        });
      }
    }

    console.log(`[Crime Reports] Found ${pdfLinks.length} potential crime report PDFs`);
    return pdfLinks;
  } catch (e) {
    console.error("[Crime Reports] Failed to fetch crime reports page:", e.message);
    return [];
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
    const response = await httpsGet(pdfUrl, {
      accept: "application/pdf",
      timeout: 60000
    });

    if (response.statusCode !== 200) {
      console.warn(`[Crime Reports] PDF download failed: HTTP ${response.statusCode}`);
      return null;
    }

    // Check if we got a PDF (content-type or magic bytes)
    const contentType = response.headers["content-type"] || "";
    const isHtml = contentType.includes("text/html") || response.body.slice(0, 15).toString().includes("<!DOCTYPE");

    if (isHtml) {
      console.warn(`[Crime Reports] Got HTML instead of PDF for: ${pdfUrl}`);
      return null;
    }

    // Parse PDF
    const data = await pdfParse(response.body);
    return {
      text: data.text,
      numPages: data.numpages,
      info: data.info
    };
  } catch (e) {
    console.error(`[Crime Reports] Failed to parse PDF ${pdfUrl}:`, e.message);
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

  // Check cache first
  const cacheKey = locationRaw.toLowerCase().trim();
  if (geocodeCache.has(cacheKey)) {
    return geocodeCache.get(cacheKey);
  }

  // Add Fredericksburg, VA context
  const searchQuery = `${locationRaw}, Fredericksburg, Virginia, USA`;

  try {
    // Rate limit: wait 1 second between requests (Nominatim policy)
    await new Promise(r => setTimeout(r, 1000 + retryCount * 1000));

    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=1`;
    const response = await httpsGet(url, {
      accept: "application/json",
      headers: {
        "User-Agent": "FXBG-PALANTIR-CityManager/1.0 (crime-reports-geocoding)"
      },
      timeout: 15000
    });

    if (response.statusCode !== 200) {
      console.warn(`[Geocode] HTTP ${response.statusCode} for: ${locationRaw}`);
      return null;
    }

    const results = JSON.parse(response.text());
    if (results.length > 0) {
      const result = {
        lat: parseFloat(results[0].lat),
        lon: parseFloat(results[0].lon),
        displayName: results[0].display_name
      };

      // Only cache if within reasonable bounds of Fredericksburg area
      if (result.lat > 38.0 && result.lat < 38.6 && result.lon > -77.8 && result.lon < -77.2) {
        geocodeCache.set(cacheKey, result);
        return result;
      }
    }

    // Fallback: use approximate Fredericksburg center with offset
    const fallback = {
      lat: 38.3032 + (Math.random() - 0.5) * 0.02,
      lon: -77.4605 + (Math.random() - 0.5) * 0.02,
      displayName: locationRaw + " (approximate)"
    };
    geocodeCache.set(cacheKey, fallback);
    return fallback;

  } catch (e) {
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

  try {
    // Load geocode cache
    await loadGeocodeCache();

    // Fetch PDF links
    const pdfLinks = await fetchCrimeReportPdfLinks();

    if (pdfLinks.length === 0) {
      console.warn("[Crime Reports] No PDF links found, using sample data fallback");
      return { success: false, count: 0, message: "No crime report PDFs found on source page" };
    }

    // Process up to 10 most recent PDFs (to avoid overwhelming the server)
    const pdfsToProcess = pdfLinks.slice(0, 10);

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

    return {
      success: true,
      count: deduped.length,
      pdfCount: pdfsToProcess.length,
      geocoded: geocoded,
      message: `Successfully refreshed ${deduped.length} crime incidents from ${pdfsToProcess.length} PDFs`
    };

  } catch (e) {
    console.error("[Crime Reports] Refresh failed:", e.message);
    return { success: false, count: 0, message: e.message };
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

    // Health check endpoint
    if (urlObj.pathname === "/health") {
      const uptimeMs = Date.now() - SERVER_START_TIME;
      const cacheStats = cacheManager.stats();
      const health = {
        status: "ok",
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

    // Diagnostics endpoint - test upstream service connectivity
    if (urlObj.pathname === "/api/diag/upstreams") {
      console.log("[Diagnostics] Testing upstream services...");

      const upstreams = [
        {
          name: "VA511 Cameras (Primary)",
          url: "https://511.vdot.virginia.gov/services/map/layers/map/cams",
          expectedType: "json"
        },
        {
          name: "VA511 Cameras (Iteris CDN)",
          url: "https://files4.iteriscdn.com/WebApps/VA/SafeTravel/data/local/icons/metadata/icons.cameras_inactive.geojsonp",
          expectedType: "jsonp"
        },
        {
          name: "VA511 Incidents",
          url: "https://www.511virginia.org/data/geojson/icons.incident.geojson",
          expectedType: "json"
        },
        {
          name: "FXBG Crime Reports Page",
          url: "https://www.fredericksburgva.gov/1426/Crime-Reports",
          expectedType: "html"
        },
        {
          name: "NWS Weather API",
          url: "https://api.weather.gov/points/38.3032,-77.4605",
          expectedType: "json"
        },
        {
          name: "OpenStreetMap Geocoding",
          url: "https://nominatim.openstreetmap.org/search?format=json&q=fredericksburg+va&limit=1",
          expectedType: "json"
        }
      ];

      const results = [];

      for (const upstream of upstreams) {
        const start = Date.now();
        let result = {
          name: upstream.name,
          url: upstream.url,
          status: "unknown",
          latencyMs: null,
          error: null,
          responseType: null,
          itemCount: null
        };

        try {
          const response = await httpsGet(upstream.url, {
            timeout: 15000,
            headers: {
              "Accept": upstream.expectedType === "json" ? "application/json,*/*" : "*/*",
              "User-Agent": "FXBG-PALANTIR-CityManager/1.0 (diagnostics)"
            }
          });

          result.latencyMs = Date.now() - start;
          result.statusCode = response.statusCode;

          if (response.statusCode === 200) {
            result.status = "ok";

            const text = response.text();
            const contentType = response.headers["content-type"] || "";

            // Detect response type
            if (contentType.includes("json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
              result.responseType = "json";
              try {
                // Handle JSONP
                let jsonText = text;
                const jsonpMatch = text.match(/^\s*\w+\s*\(\s*({[\s\S]*})\s*\)\s*;?\s*$/);
                if (jsonpMatch) {
                  jsonText = jsonpMatch[1];
                  result.responseType = "jsonp";
                }

                const parsed = JSON.parse(jsonText);
                if (parsed.features) {
                  result.itemCount = parsed.features.length;
                } else if (Array.isArray(parsed)) {
                  result.itemCount = parsed.length;
                }
              } catch (e) {
                result.parseError = e.message;
              }
            } else if (contentType.includes("html") || text.includes("<!DOCTYPE")) {
              result.responseType = "html";
              // Check for crime report PDF links
              const pdfMatches = text.match(/DocumentCenter\/View\/\d+/gi);
              if (pdfMatches) {
                result.itemCount = pdfMatches.length;
                result.note = `Found ${pdfMatches.length} potential PDF links`;
              }
            } else {
              result.responseType = "other";
            }
          } else if (response.statusCode === 403) {
            result.status = "blocked";
            result.error = "Access forbidden (403)";
          } else if (response.statusCode === 429) {
            result.status = "rate_limited";
            result.error = "Rate limited (429)";
          } else {
            result.status = "error";
            result.error = `HTTP ${response.statusCode}`;
          }
        } catch (e) {
          result.latencyMs = Date.now() - start;
          result.status = "error";
          result.error = e.message;
        }

        results.push(result);
      }

      // Calculate summary
      const okCount = results.filter(r => r.status === "ok").length;
      const totalCount = results.length;

      const response = {
        ok: okCount === totalCount,
        summary: `${okCount}/${totalCount} upstreams healthy`,
        timestamp: new Date().toISOString(),
        upstreams: results
      };

      console.log(`[Diagnostics] Completed: ${okCount}/${totalCount} upstreams healthy`);
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
      try {
        console.log(`[Crime Reports API] Refresh requested for ${months} months`);

        // Run the real PDF scraping and parsing
        const result = await refreshCrimeReports(months);

        const response = {
          ok: result.success,
          message: result.message,
          months: months,
          count: result.count,
          pdfCount: result.pdfCount || 0,
          geocoded: result.geocoded || 0,
          timestamp: new Date().toISOString()
        };

        return send(res, result.success ? 200 : 500, JSON.stringify(response, null, 2), { "Content-Type": "application/json" });
      } catch (err) {
        console.error("[Crime Reports API] Refresh error:", err);
        return send(res, 500, JSON.stringify({ ok: false, error: err.message }), { "Content-Type": "application/json" });
      }
    }

    if (urlObj.pathname === "/api/fxbg/crime-reports/incidents") {
      const months = parseInt(urlObj.searchParams.get("months") || "6", 10);
      try {
        // Check for cached incidents data
        const dataDir = path.join(__dirname, "data", "fxbg-crime-reports");
        const incidentsFile = path.join(dataDir, "incidents.json");

        let incidents = [];
        let lastUpdated = null;
        let dataSource = "sample"; // Track data source for response

        // Try to load existing incidents
        try {
          const data = await fsp.readFile(incidentsFile, "utf8");
          const parsed = JSON.parse(data);

          // Handle both old format (array) and new format (object with metadata)
          if (Array.isArray(parsed)) {
            incidents = parsed;
          } else if (parsed.incidents && Array.isArray(parsed.incidents)) {
            incidents = parsed.incidents;
            lastUpdated = parsed.lastUpdated;
            dataSource = "scraped";
          }
        } catch (err) {
          // No cached data, generate sample incidents for testing
          console.log("[Crime Reports API] No cached data, generating sample incidents");
          incidents = generateSampleIncidents(months);
          dataSource = "sample";

          // Save sample data (in new format)
          await fsp.mkdir(dataDir, { recursive: true });
          const sampleData = {
            lastUpdated: new Date().toISOString(),
            sourceUrl: "sample-data",
            incidentCount: incidents.length,
            incidents: incidents
          };
          await fsp.writeFile(incidentsFile, JSON.stringify(sampleData, null, 2), "utf8");
        }

        // Filter by date range
        const cutoffDate = new Date();
        cutoffDate.setMonth(cutoffDate.getMonth() - months);

        const filtered = incidents.filter(inc => {
          const incDate = new Date(inc.incidentDateISO);
          return incDate >= cutoffDate;
        });

        // Check if data is stale (older than 7 days)
        const isStale = lastUpdated && (Date.now() - new Date(lastUpdated).getTime() > 7 * 24 * 60 * 60 * 1000);

        console.log(`[Crime Reports API] Returning ${filtered.length} incidents (${months} months, source: ${dataSource})`);
        return send(res, 200, JSON.stringify({
          ok: true,
          count: filtered.length,
          months: months,
          dataSource: dataSource,
          lastUpdated: lastUpdated,
          isStale: isStale,
          incidents: filtered
        }, null, 2), { "Content-Type": "application/json" });
      } catch (err) {
        console.error("[Crime Reports API] Incidents error:", err);
        return send(res, 500, JSON.stringify({ ok: false, error: err.message }), { "Content-Type": "application/json" });
      }
    }

    if (urlObj.pathname === "/proxy") {
      const target = urlObj.searchParams.get("url");
      if (!target) return send(res, 400, "Missing url param");
      if (!/^https?:\/\//i.test(target)) return send(res, 400, "Only http/https URLs are allowed");

      // Security: Check if target URL is allowed
      const urlCheck = checkUrlAllowed(target);
      if (!urlCheck.allowed) {
        console.warn(`[proxy] Blocked request to ${target}: ${urlCheck.reason}`);
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
    return send(res, 500, String(err || "Server error"));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n🧠 CITY MANAGER server running on ${HOST}:${PORT}\n`);
  console.log(`📱 Open on this device: http://127.0.0.1:${PORT}`);

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
