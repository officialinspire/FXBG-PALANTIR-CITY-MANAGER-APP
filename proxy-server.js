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

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Cache-TTL-MS",
    ...headers,
  });
  res.end(body);
}

// -------- Proxy cache + rate limits --------
const cache = new Map();   // key -> { ts, ttlMs, status, headers, body:Buffer }
const inflight = new Map(); // key -> Promise<cacheEntry>
const hostLast = new Map(); // host -> ts
let activeFetches = 0;
const MAX_CONCURRENT = 3;
const MIN_INTERVAL_PER_HOST_MS = 600; // spacing per host to reduce 429 bursts

function nowMs() { return Date.now(); }
function cacheKey(url, accept) { return `${accept || ""}::${url}`; }

function parseTtl(reqUrl, reqHeaders) {
  const hinted = Number(reqHeaders["x-cache-ttl-ms"] || 0);
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted, 10 * 60 * 1000);

  try {
    const u = new URL(reqUrl);
    const h = u.hostname;
    const p = u.pathname.toLowerCase();
    if (h.includes("api.weather.gov")) return 60 * 1000;
    if (h.includes("511virginia.org")) return 45 * 1000;
    if (h.includes("arcgis.com") || h.includes("virginiaroads.org")) return 90 * 1000;
    // Increased RSS cache TTL to 6 minutes (360s) to exceed the 5-minute polling interval
    // and prevent upstream 429 rate limit errors
    if (p.endsWith(".rss") || p.includes("rss")) return 360 * 1000;
  } catch {}
  return 60 * 1000;
}

async function waitForSlot(host) {
  while (activeFetches >= MAX_CONCURRENT) {
    await new Promise((r) => setTimeout(r, 40));
  }
  const last = hostLast.get(host) || 0;
  const delta = nowMs() - last;
  if (delta < MIN_INTERVAL_PER_HOST_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_PER_HOST_MS - delta));
  }
}

async function proxyFetch(targetUrl, reqHeaders) {
  const accept = String(reqHeaders["accept"] || "");
  const key = cacheKey(targetUrl, accept);

  const cached = cache.get(key);
  const isFresh = cached && (nowMs() - cached.ts) < cached.ttlMs;
  if (isFresh) return cached;
  const staleCandidate = cached || null;

  if (inflight.has(key)) return inflight.get(key);

  const ttlMs = parseTtl(targetUrl, reqHeaders);

  const prom = (async () => {
    let u;
    try { u = new URL(targetUrl); } catch { throw new Error("Invalid URL"); }

    await waitForSlot(u.hostname);
    activeFetches++;
    hostLast.set(u.hostname, nowMs());

    try {
      // Node 18+ has global fetch
      let upstream;
      try {
      upstream = await fetch(targetUrl, {
        method: "GET",
        redirect: "follow",
        headers: {
          // Disable gzip/deflate so we can cache raw bytes uniformly
          "Accept-Encoding": "identity",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "http://localhost",
          "User-Agent": "CityManagerProxy/1.0 (+localhost)",
          // Allow callers to hint a specific Accept header via the incoming request; fallback to */*
          "Accept": accept || "*/*",
        },
      });
      } catch (e) {
        if (staleCandidate) {
          return {
            ...staleCandidate,
            headers: { ...staleCandidate.headers, "X-Proxy-Stale": "1", "X-Proxy-Error": "fetch_failed" },
            ts: staleCandidate.ts,
            ttlMs: staleCandidate.ttlMs,
            status: 200,
          };
        }
        throw e;
      }

      if (staleCandidate && (upstream.status === 429 || upstream.status >= 500)) {
        return {
          ...staleCandidate,
          headers: { ...staleCandidate.headers, "X-Proxy-Stale": "1", "X-Proxy-Upstream-Status": String(upstream.status) },
          status: 200,
        };
      }

      const buf = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstream.headers.get("content-type") || "application/octet-stream";

      const entry = {
        ts: nowMs(),
        ttlMs: upstream.status === 429 ? Math.min(ttlMs, 15_000) : ttlMs,
        status: upstream.status,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "no-store",
          "X-Proxy-Cache-TTL": String(ttlMs),
          "X-Proxy-Upstream-Status": String(upstream.status),
        },
        body: buf,
      };

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

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 204, "");

    const urlObj = new URL(req.url, `http://${req.headers.host}`);

    if (urlObj.pathname === "/proxy") {
      const target = urlObj.searchParams.get("url");
      if (!target) return send(res, 400, "Missing url param");
      if (!/^https?:\/\//i.test(target)) return send(res, 400, "Only http/https URLs are allowed");

      const entry = await proxyFetch(target, req.headers);
      res.writeHead(entry.status, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Cache-TTL-MS",
        ...entry.headers,
      });
      return res.end(entry.body);
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
