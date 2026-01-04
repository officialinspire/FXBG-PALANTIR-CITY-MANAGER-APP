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

  // Geocoding
  'nominatim.openstreetmap.org',

  // External Cameras
  'wetmet.net',
  'api.wetmet.net',

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

server.listen(PORT, () => {
  console.log(`CITY MANAGER server running: http://localhost:${PORT}`);
  console.log(`Proxy endpoint: http://localhost:${PORT}/proxy?url=https://example.com/feed`);
});
