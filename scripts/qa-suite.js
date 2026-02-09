#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8000";
const ROOT_DIR = path.resolve(__dirname, "..");
const RSS_ACCEPT = "application/rss+xml, application/atom+xml, application/xml, text/xml, */*";
const FETCH_TIMEOUT_MS = 12000;

function logPass(name, detail) {
  const suffix = detail ? ` - ${detail}` : "";
  console.log(`[PASS] ${name}${suffix}`);
}

function logWarn(name, detail) {
  const suffix = detail ? ` - ${detail}` : "";
  console.warn(`[WARN] ${name}${suffix}`);
}

function logFail(name, detail) {
  const suffix = detail ? ` - ${detail}` : "";
  console.error(`[FAIL] ${name}${suffix}`);
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function fetchText(url, { headers = {}, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    return { response, text };
  } catch (error) {
    return { error };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(pathname) {
  const url = new URL(pathname, BASE_URL).toString();
  const { response, text, error } = await fetchText(url, {
    headers: { Accept: "application/json" }
  });

  if (error) {
    return { ok: false, error: error.message || String(error) };
  }

  let data = null;
  try {
    data = JSON.parse(text);
  } catch (parseError) {
    return {
      ok: false,
      status: response.status,
      error: `invalid_json: ${parseError.message || parseError}`
    };
  }

  return { ok: true, status: response.status, data };
}

function warn(message) {
  return { status: "warn", message };
}

function fail(message) {
  return { status: "fail", message };
}

async function runTest(name, fn, results) {
  try {
    const outcome = await fn();
    if (outcome && outcome.status === "warn") {
      logWarn(name, outcome.message);
      results.warnings += 1;
    } else if (outcome && outcome.status === "fail") {
      logFail(name, outcome.message);
      results.failures += 1;
    } else {
      logPass(name, outcome?.message);
    }
  } catch (error) {
    logFail(name, error.message || String(error));
    results.failures += 1;
  }
}

function extractRssFeeds() {
  const configPath = path.join(ROOT_DIR, "index.js");
  if (!fs.existsSync(configPath)) {
    return { feeds: [], warning: `Missing index.js at ${configPath}` };
  }

  const content = fs.readFileSync(configPath, "utf8");
  const rssIndex = content.indexOf("rss: [");
  if (rssIndex === -1) {
    return { feeds: [], warning: "No rss: [ block found in index.js" };
  }

  const arrayStart = content.indexOf("[", rssIndex);
  if (arrayStart === -1) {
    return { feeds: [], warning: "Unable to locate rss array start" };
  }

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

  if (arrayEnd === -1) {
    return { feeds: [], warning: "Unable to find rss array end" };
  }

  const rssBlock = content.slice(arrayStart + 1, arrayEnd);
  const feeds = [];
  const seen = new Set();
  const entryRegex = /id:\s*"([^"]+)"[\s\S]*?url:\s*"([^"]+)"/g;
  let match = null;
  while ((match = entryRegex.exec(rssBlock)) !== null) {
    const id = match[1];
    const url = match[2];
    if (!seen.has(url)) {
      feeds.push({ id, url });
      seen.add(url);
    }
  }

  if (feeds.length === 0) {
    const urlRegex = /url:\s*"([^"]+)"/g;
    while ((match = urlRegex.exec(rssBlock)) !== null) {
      const url = match[1];
      if (!seen.has(url)) {
        feeds.push({ id: url, url });
        seen.add(url);
      }
    }
  }

  return { feeds };
}

async function fetchRssRegistryFeeds() {
  const url = new URL("/api/feeds/registry", BASE_URL).toString();
  const { response, text, error } = await fetchText(url, {
    headers: { Accept: "application/json" }
  });

  if (error) {
    return { ok: false, warning: `Feed registry request failed: ${error.message || error}` };
  }

  if (!response || response.status === 404) {
    return { ok: false, warning: "Feed registry not available" };
  }

  let data = null;
  try {
    data = JSON.parse(text);
  } catch (parseError) {
    return {
      ok: false,
      warning: `Feed registry invalid JSON: ${parseError.message || parseError}`
    };
  }

  if (!isObject(data) || data.ok !== true || !Array.isArray(data.feeds)) {
    return { ok: false, warning: "Feed registry response missing ok:true or feeds[]" };
  }

  const feeds = data.feeds
    .filter((feed) => feed && typeof feed.url === "string")
    .map((feed) => ({
      id: feed.key || feed.id || feed.url,
      url: feed.url
    }));

  return { ok: true, feeds };
}

async function discoverRssFeeds() {
  const registry = await fetchRssRegistryFeeds();
  if (registry.ok) {
    return { feeds: registry.feeds, warning: registry.warning };
  }

  const fallback = extractRssFeeds();
  return { feeds: fallback.feeds, warning: registry.warning || fallback.warning };
}

async function testHealth() {
  const result = await getJson("/api/health");
  if (!result.ok) return fail(result.error);
  if (result.status !== 200) return fail(`status ${result.status}`);
  const data = result.data;
  if (!isObject(data)) return fail("response is not an object");
  if (!(data.ok === true || data.status === "ok")) {
    return fail("missing ok:true or status:ok");
  }
  return { message: data.status || "ok" };
}

async function testHealthUpstreams() {
  const result = await getJson("/api/health/upstreams");
  if (!result.ok) return fail(result.error);
  if (result.status !== 200) return fail(`status ${result.status}`);
  const data = result.data;
  if (!isObject(data)) return fail("response is not an object");
  if (!Array.isArray(data.upstreams)) return fail("missing upstreams array");
  return { message: `${data.upstreams.length} upstreams` };
}

async function testHealthTestUpstreams(quick) {
  const suffix = quick ? "quick=1" : "quick=0";
  const result = await getJson(`/api/health/test-upstreams?${suffix}`);
  if (!result.ok) return fail(result.error);
  if (result.status === 404) return warn("endpoint not supported (404)");
  if (result.status !== 200) return fail(`status ${result.status}`);
  const data = result.data;
  if (!isObject(data)) return fail("response is not an object");
  if (data.error === "rate_limited") {
    return warn("rate_limited; retry after cooldown");
  }
  if (!Array.isArray(data.upstreams)) return fail("missing upstreams array");
  return { message: `${data.upstreams.length} upstreams` };
}

async function testCrimeStatus() {
  const result = await getJson("/api/fxbg/crime-reports/status");
  if (!result.ok) return fail(result.error);
  if (result.status !== 200) return fail(`status ${result.status}`);
  const data = result.data;
  if (!isObject(data)) return fail("response is not an object");
  if (!("ok" in data || "status" in data)) {
    return fail("missing ok/status field");
  }
  return { message: data.ok === true ? "ok" : "status" };
}

async function testCrimeIncidents() {
  const result = await getJson("/api/fxbg/crime-reports/incidents?days=7");
  if (!result.ok) return fail(result.error);
  if (result.status !== 200) return fail(`status ${result.status}`);
  const data = result.data;
  if (!isObject(data)) return fail("response is not an object");
  if (!Array.isArray(data.incidents)) return fail("missing incidents array");
  return { message: `${data.incidents.length} incidents` };
}

async function testCacheStats() {
  const result = await getJson("/cache/stats");
  if (!result.ok) return fail(result.error);
  if (result.status !== 200) return fail(`status ${result.status}`);
  const data = result.data;
  if (!isObject(data)) return fail("response is not an object");
  if (!isObject(data.cache)) return fail("missing cache object");
  return { message: "cache stats" };
}

async function testVa511Status() {
  const result = await getJson("/api/va511/status");
  if (!result.ok) return fail(result.error);
  if (result.status === 404) return warn("endpoint not supported (404)");
  if (result.status !== 200 && result.status !== 502) return fail(`status ${result.status}`);
  const data = result.data;
  if (!isObject(data)) return fail("response is not an object");
  if (!("ok" in data || "status" in data)) return fail("missing ok/status field");
  return { message: data.ok === false ? "reported not ok" : "ok" };
}

async function testRssFeed(feed, results) {
  const name = `RSS ${feed.id}`;
  const url = `${BASE_URL}/proxy?url=${encodeURIComponent(feed.url)}`;
  const { response, text, error } = await fetchText(url, { headers: { Accept: RSS_ACCEPT } });

  if (error) {
    results.failures += 1;
    logFail(name, `host=${safeHost(feed.url)} error=${error.message || error}`);
    results.failedFeeds.push({ feed, error: error.message || String(error) });
    return;
  }

  if (response.status !== 200) {
    results.failures += 1;
    logFail(name, `host=${safeHost(feed.url)} status=${response.status}`);
    results.failedFeeds.push({ feed, error: `status_${response.status}` });
    return;
  }

  const body = text || "";
  const bodyLower = body.toLowerCase();
  const hasRssTag = bodyLower.includes("<rss") || bodyLower.includes("<feed") || bodyLower.includes("<channel") || bodyLower.includes("xml");

  if (!hasRssTag) {
    results.failures += 1;
    logFail(name, `host=${safeHost(feed.url)} missing rss markup`);
    results.failedFeeds.push({ feed, error: "missing_rss_markup" });
    return;
  }

  if (body.length <= 200) {
    results.failures += 1;
    logFail(name, `host=${safeHost(feed.url)} body too small (${body.length})`);
    results.failedFeeds.push({ feed, error: "body_too_small" });
    return;
  }

  logPass(name, safeHost(feed.url));
}

function safeHost(feedUrl) {
  try {
    return new URL(feedUrl).host;
  } catch {
    return "unknown-host";
  }
}

async function main() {
  const results = { failures: 0, warnings: 0, failedFeeds: [] };

  console.log(`[qa-suite] BASE_URL=${BASE_URL}`);

  await runTest("Health /api/health", testHealth, results);
  await runTest("Health /api/health/upstreams", testHealthUpstreams, results);
  await runTest("Health /api/health/test-upstreams?quick=1", () => testHealthTestUpstreams(true), results);
  await runTest("Health /api/health/test-upstreams?quick=0", () => testHealthTestUpstreams(false), results);

  await runTest("Crime reports /api/fxbg/crime-reports/status", testCrimeStatus, results);
  await runTest("Crime reports /api/fxbg/crime-reports/incidents?days=7", testCrimeIncidents, results);

  await runTest("Cache /cache/stats", testCacheStats, results);
  await runTest("VA511 /api/va511/status", testVa511Status, results);

  const { feeds, warning } = await discoverRssFeeds();
  if (warning) {
    logWarn("RSS feed discovery", warning);
    results.warnings += 1;
  }

  if (feeds.length === 0) {
    logFail("RSS feed discovery", "no feeds found");
    results.failures += 1;
  } else {
    for (const feed of feeds) {
      // eslint-disable-next-line no-await-in-loop
      await testRssFeed(feed, results);
    }
  }

  if (results.failedFeeds.length > 0) {
    console.error("[qa-suite] Failed RSS feeds:");
    for (const entry of results.failedFeeds) {
      console.error(`  - ${entry.feed.id} (${safeHost(entry.feed.url)}) :: ${entry.error}`);
    }
  }

  const summary = `[qa-suite] Summary: ${results.failures} failures, ${results.warnings} warnings`;
  if (results.failures > 0) {
    console.error(summary);
    process.exit(1);
  } else {
    console.log(summary);
    process.exit(0);
  }
}

main();
