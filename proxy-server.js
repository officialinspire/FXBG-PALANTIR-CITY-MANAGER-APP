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
    if (h.includes("511virginia.org") || h.includes("511.vdot.virginia.gov")) return 90 * 1000;
    if (h.includes("arcgis.com") || h.includes("virginiaroads.org")) return 90 * 1000;
    if (h.includes("data.virginia.gov")) return 120 * 1000; // Socrata APIs - cache longer
    // Increased RSS cache TTL to 6 minutes (360s) to exceed the 5-minute polling interval
    // and prevent upstream 429 rate limit errors
    if (p.endsWith(".rss") || p.includes("rss") || p.includes("feed")) return 360 * 1000;
    // Camera images should cache for 2 minutes
    if (p.match(/\.(jpg|jpeg|png|webp|gif)($|\?)/i)) return 120 * 1000;
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

      // Add Referer if provided by client
      if (reqHeaders["referer"]) {
        upstreamHeaders["Referer"] = reqHeaders["referer"];
      } else {
        // Set appropriate referer based on target URL
        try {
          const targetHost = new URL(targetUrl).hostname;
          if (targetHost.includes("511virginia.org") || targetHost.includes("511.vdot.virginia.gov")) {
            upstreamHeaders["Referer"] = "https://www.511virginia.org/";
          } else if (targetHost.includes("fredericksburgva.gov") || targetHost.includes("spotsylvania.va.us")) {
            upstreamHeaders["Referer"] = `https://${targetHost}/`;
          }
        } catch {}
      }

      upstream = await fetch(targetUrl, {
        method: "GET",
        redirect: "follow",
        headers: upstreamHeaders,
      });
      } catch (e) {
        console.error(`[proxy] Fetch error for ${targetUrl}:`, e.message || String(e));
        if (staleCandidate) {
          console.log(`[proxy] Using stale cache for ${targetUrl} (fetch error: ${e.message || 'unknown'})`);
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

      // For 429 rate limit or server errors, return stale cache if available
      if (staleCandidate && (upstream.status === 429 || upstream.status >= 500 || upstream.status === 404)) {
        console.log(`[proxy] Using stale cache for ${targetUrl} (upstream ${upstream.status})`);
        return {
          ...staleCandidate,
          headers: {
            ...staleCandidate.headers,
            "X-Proxy-Stale": "1",
            "X-Proxy-Upstream-Status": String(upstream.status),
            "X-Proxy-Cache-Used": "stale"
          },
          status: 200,
        };
      }

      // Log non-200 responses for debugging
      if (upstream.status !== 200) {
        console.warn(`[proxy] ${targetUrl} returned HTTP ${upstream.status}`);
      }

      // If we get 404 and have no stale cache, return the error
      if (upstream.status === 404) {
        const errorBody = Buffer.from(JSON.stringify({
          error: "Not Found",
          url: targetUrl,
          status: 404,
          message: "The requested resource was not found. Check the URL and try again."
        }));
        return {
          ts: nowMs(),
          ttlMs: 5000, // Cache 404s for 5 seconds to avoid hammering
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "X-Proxy-Error": "upstream_404"
          },
          body: errorBody
        };
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
            return {
              ...staleCandidate,
              headers: {
                ...staleCandidate.headers,
                "X-Proxy-Stale": "1",
                "X-Proxy-Error": "html_instead_of_data",
                "X-Proxy-Cache-Used": "stale"
              },
              status: 200,
            };
          }
        }
      }

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

      try {
        const entry = await proxyFetch(target, req.headers);
        res.writeHead(entry.status, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Cache-TTL-MS",
          ...entry.headers,
        });
        return res.end(entry.body);
      } catch (proxyErr) {
        console.error(`[proxy] Failed to fetch ${target}:`, proxyErr.message);
        const errorBody = JSON.stringify({
          error: "Proxy fetch failed",
          url: target,
          message: proxyErr.message || String(proxyErr)
        });
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
