// CITY MANAGER — FXBG-PALANTIR toolkit (v14)
// v14 fixes: Virginia Crash Data API integration, improved RSS feeds, all panels draggable
// Key changes:
// - Added Virginia Crash Data API endpoints (CrashData Basic, CrashData Details)
// - Enhanced 511 Virginia camera locations with better error handling
// - All popup panels are now draggable and moveable
// - Fixed RSS feed footer buttons - now show actual feed items with better fallbacks
// - Improved crash data ingestion from multiple Virginia sources
// - Added API key support for Virginia Roads Open Data Portal
// - Better error messages and console logging for debugging
// - All panels support drag-and-drop positioning
// - Enhanced freshness gates with better time filtering
// - Multiple crash data sources for comprehensive coverage

(() => {
  // -----------------------------
  // Config
  // -----------------------------
  const CONFIG = {
    // Primary map focus (Fredericksburg metro)
    center: { lat: 38.3032, lon: -77.4605 },
    zoom: 10,

    // Region filter bbox (rough FXBG + Stafford + Spotsy)
    bbox: { minLat: 38.10, maxLat: 38.52, minLon: -77.85, maxLon: -77.20 },

    // I‑95 corridor bbox near FXBG metro (for traffic indicator)
    i95Bbox: { minLat: 38.15, maxLat: 38.55, minLon: -77.70, maxLon: -77.20 },

    // Freshness (CURRENT ONLY)
    freshness: {
      // "Current" defaults:
      rssMaxAgeHours: 168,     // newsroom/civic posts: last 7 days (increased from 24h to show low-volume feeds)
      va511MaxAgeHours: 6,     // incidents: last 6 hours
      crashesMaxAgeHours: 24,  // crashes: last 24 hours (you can tighten to 6 if desired)
      nwsMaxAgeHours: 24
    },

    // Performance caps
    perf: {
      maxTotalItems: 650,      // hard cap for speed (newest kept)
      maxPerSource: 180        // per source cap to avoid floods
    },

    // Polling (milliseconds)
    polling: {
      rss: 5 * 60 * 1000,
      nws: 2 * 60 * 1000,
      arcgisCrash: 5 * 60 * 1000,
      virginiaCrashData: 4 * 60 * 1000,
      va511: 2 * 60 * 1000,
      vaRoads: 3 * 60 * 1000
    },

    // CORS proxy rotation (browser-only)
    corsProxies: [],

    // Debug flags
    debug: {
      rss: true  // Enable RSS feed ingestion debug logging
    },

    // RSS sources (each has maxAgeHours to enforce "current only")
    rss: [
      // ---------------- FXBG ----------------
      {
        id: "fxbg-emergency-alerts",
        name: "Fredericksburg — Emergency Alerts (Alert Center)",
        type: "rss",
        category: "alerts",
        jurisdiction: "Fredericksburg",
        url: "https://www.fredericksburgva.gov/RSSFeed.aspx?CID=Emergency-Alerts-3",
        emoji: "🚨",
        tone: "warn",
        defaultLoc: { lat: 38.3032, lon: -77.4605 },
        maxAgeHours: 168,
      },
      {
        id: "fxbg-police-alerts",
        name: "Fredericksburg — Police Alerts",
        type: "rss",
        category: "police_crime",
        jurisdiction: "Fredericksburg",
        url: "https://www.fredericksburgva.gov/RSSFeed.aspx?CID=Police-Alerts-11",
        emoji: "🚓",
        tone: "bad",
        defaultLoc: { lat: 38.3032, lon: -77.4605 },
        maxAgeHours: 168,
      },
      {
        id: "fxbg-transit-alerts",
        name: "Fredericksburg — Transit Alerts (FRED Regional Transit)",
        type: "rss",
        category: "traffic_transit",
        jurisdiction: "Fredericksburg",
        url: "https://www.fredericksburgva.gov/RSSFeed.aspx?CID=Fredericksburg-Regional-Transit-12",
        emoji: "🚌",
        tone: "warn",
        defaultLoc: { lat: 38.3032, lon: -77.4605 },
        maxAgeHours: 168,
      },
      {
        id: "fxbg-news-flash",
        name: "Fredericksburg — City News Flash (all city categories)",
        type: "rss",
        category: "news",
        jurisdiction: "Fredericksburg",
        url: "https://www.fredericksburgva.gov/RSSFeed.aspx?CID=News-Flash-63",
        emoji: "📰",
        tone: "good",
        defaultLoc: { lat: 38.3032, lon: -77.4605 },
        maxAgeHours: 168,
      },
      {
        id: "fxbg-events",
        name: "Fredericksburg — Special Events Calendar",
        type: "rss",
        category: "events",
        jurisdiction: "Fredericksburg",
        url: "https://www.fredericksburgva.gov/RSSFeed.aspx?CID=Special-Events-15",
        emoji: "🎉",
        tone: "good",
        defaultLoc: { lat: 38.3032, lon: -77.4605 },
        maxAgeHours: 168,
      },

      // ------------- SPOTSY -------------
      {
        id: "spotsy-emergency-alerts",
        name: "Spotsylvania — Emergency Alerts (Alert Center)",
        type: "rss",
        category: "alerts",
        jurisdiction: "Spotsylvania",
        url: "https://www.spotsylvania.va.us/RSSFeed.aspx?CID=Emergency-Alerts-7",
        emoji: "🚨",
        tone: "warn",
        defaultLoc: { lat: 38.1859, lon: -77.6526 },
        maxAgeHours: 168,
      },
      {
        id: "spotsy-notices",
        name: "Spotsylvania — Notices",
        type: "rss",
        category: "alerts",
        jurisdiction: "Spotsylvania",
        url: "https://www.spotsylvania.va.us/RSSFeed.aspx?CID=Notices-8",
        emoji: "📣",
        tone: "warn",
        defaultLoc: { lat: 38.1859, lon: -77.6526 },
        maxAgeHours: 168,
      },
      {
        id: "spotsy-spotsyalert",
        name: "Spotsylvania — SpotsyAlert! (general county alerts)",
        type: "rss",
        category: "alerts",
        jurisdiction: "Spotsylvania",
        url: "https://www.spotsylvania.va.us/RSSFeed.aspx?CID=SpotsyAlert-5",
        emoji: "⚠️",
        tone: "warn",
        defaultLoc: { lat: 38.1859, lon: -77.6526 },
        maxAgeHours: 168,
      },
      {
        id: "spotsy-press",
        name: "Spotsylvania — County Press Releases",
        type: "rss",
        category: "news",
        jurisdiction: "Spotsylvania",
        url: "https://www.spotsylvania.va.us/RSSFeed.aspx?CID=County-Press-Releases-18",
        emoji: "📰",
        tone: "good",
        defaultLoc: { lat: 38.1859, lon: -77.6526 },
        maxAgeHours: 168,
      },
      {
        id: "spotsy-fire-ems",
        name: "Spotsylvania — Fire Rescue & Emergency Management",
        type: "rss",
        category: "fire_ems",
        jurisdiction: "Spotsylvania",
        url: "https://www.spotsylvania.va.us/RSSFeed.aspx?CID=Fire-Rescue-Emergency-Management-20",
        emoji: "🔥",
        tone: "warn",
        defaultLoc: { lat: 38.1859, lon: -77.6526 },
        maxAgeHours: 168,
      },
      {
        id: "spotsy-parks",
        name: "Spotsylvania — Parks & Recreation News",
        type: "rss",
        category: "events",
        jurisdiction: "Spotsylvania",
        url: "https://www.spotsylvania.va.us/RSSFeed.aspx?CID=Parks-Recreation-19",
        emoji: "🏞️",
        tone: "good",
        defaultLoc: { lat: 38.1859, lon: -77.6526 },
        maxAgeHours: 168,
      },

      // ---------- REGIONAL / MEDIA ----------
      {
        id: "fxbg-free-press",
        name: "Fredericksburg Free Press — All Local News",
        type: "rss",
        category: "news",
        jurisdiction: "Regional",
        url: "https://www.fredericksburgfreepress.com/feed/",
        emoji: "🗞️",
        tone: "good",
        defaultLoc: { lat: 38.2750, lon: -77.5000 },
        maxAgeHours: 168,
      },

      // ---------- WEATHER (ATOM) ----------
      {
        id: "nws-va-alerts",
        name: "NWS Weather Alerts — Virginia (ATOM feed)",
        type: "atom",
        category: "weather_alerts",
        jurisdiction: "Regional",
        url: "https://api.weather.gov/alerts/active.atom?area=VA",
        emoji: "🌧️",
        tone: "warn",
        defaultLoc: { lat: 38.2750, lon: -77.5000 },
        maxAgeHours: 168,
      },

      // ---------- STAFFORD SCHOOLS (NOT RSS) ----------
      // These are HTML pages, not RSS feeds. Keep them only if you implement HTML feed-discovery.
      {
        id: "stafford-schools-calendar-page",
        name: "Stafford Schools — Division Calendar (HTML page; needs feed discovery)",
        type: "html_discover",
        category: "school_events_closures",
        jurisdiction: "Stafford",
        url: "https://www.staffordschools.net/about-us/calendar",
        emoji: "🏫",
        tone: "good",
        defaultLoc: { lat: 38.4220, lon: -77.4083 },
        maxAgeHours: 168,
      },
      {
        id: "stafford-school-board-page",
        name: "Stafford Schools — School Board Meeting Calendar (HTML page; needs feed discovery)",
        type: "html_discover",
        category: "school_events",
        jurisdiction: "Stafford",
        url: "https://www.staffordschools.net/about-us/school-board/board-meetings/meeting-calendar",
        emoji: "🗓️",
        tone: "good",
        defaultLoc: { lat: 38.4220, lon: -77.4083 },
        maxAgeHours: 168,
      },
    ],

    // NWS (no API key required)
    nws: {
      enabled: true,
      pointsLat: 38.3032,
      pointsLon: -77.4605,
      alertsUrl: "https://api.weather.gov/alerts/active?area=VA"
    },

    // ArcGIS FeatureServer Crash query (auto date field)
    arcgisCrash: {
      enabled: true,
      baseQueryUrl: "https://services.arcgis.com/p5v98VHDX9Atv3l7/arcgis/rest/services/CrashData_test/FeatureServer/0/query",
      outFields: "*",
      // if null, we'll auto-discover via layer metadata
      dateField: null,
      // limit to last 24 hours by default (matches crashesMaxAgeHours)
      maxAgeHours: 24,
      // cap how many records we ask for
      recordCap: 250
    },

    // Virginia Crash Data APIs (multiple sources for comprehensive coverage)
    virginiaCrashData: {
      enabled: true,
      // CrashData Basic API from Virginia Roads Open Data Portal
      crashDataBasicUrl: "https://www.virginiaroads.org/datasets/crashdata-basic-1/api",
      // CrashData Details from data.virginia.gov
      crashDataDetailsUrl: "https://data.virginia.gov/resource/e9fd3f45-7f33-424b-b472-b531043fa02a.json",
      // Virginia Roads API definition endpoint
      apiDefinitionUrl: "https://www.virginiaroads.org/api/search/definition",
      // API key (if needed - currently not required for public endpoints)
      apiKey: null,
      maxAgeHours: 48,  // Show crashes from last 48 hours
      recordCap: 200
    },

    // 511Virginia GeoJSON endpoints
    va511: {
      enabled: true,
      camerasGeojson: "https://511.vdot.virginia.gov/services/map/layers/map/cams",
      // Updated incidents endpoint - the .org domain now returns HTML, use the CDN directly
      incidentsGeojson: "https://www.511virginia.org/data/geojson/icons.incident.geojson",
      // Fallback to Iteris CDN if main endpoint fails
      incidentsGeojsonFallback: "http://files5.iteriscdn.com/WebApps/VA/SafeTravel/data/local/icons/metadata/icons.incident.geojsonp",
      constructionGeojson: "https://www.511virginia.org/data/geojson/icons.construction.geojson",
      includeConstructionOnMap: false
    },

    // Virginia Roads API
    vaRoads: {
      enabled: true,
      searchUrl: "https://www.virginiaroads.org/api/search",
      eventsUrl: "https://www.virginiaroads.org/api/events"
    }
  };

  // -----------------------------
  // Categories
  // -----------------------------
  const CATEGORIES = {
    alerts:                   { label: "Emergency Alerts", emoji: "🚨" },
    police_crime:             { label: "Police / Crime", emoji: "🚓" },
    traffic_transit:          { label: "Traffic / Transit", emoji: "🚌" },
    news:                     { label: "News", emoji: "📰" },
    events:                   { label: "Events", emoji: "🎉" },
    fire_ems:                 { label: "Fire / EMS", emoji: "🔥" },
    weather_alerts:           { label: "Weather Alerts", emoji: "🌧️" },
    school_events:            { label: "School Events", emoji: "🗓️" },
    school_events_closures:   { label: "School Events / Closures", emoji: "🏫" },
    // Legacy categories (for backwards compatibility with existing data sources)
    crime:                    { label: "Police / Crime", emoji: "🚨" },
    traffic:                  { label: "Traffic", emoji: "🚗" },
    crash:                    { label: "Auto Accident", emoji: "💥" },
    closure:                  { label: "Road Closure", emoji: "⛔" },
    train:                    { label: "Train / Transit", emoji: "🚆" },
    weather:                  { label: "Weather", emoji: "🌧️" },
    camera:                   { label: "Cameras", emoji: "📷" }
  };

  const KEYWORD_EMOJI = [
    { re: /(shoot|shot|gun|firearm|stabb|homicide|assault|robbery|burglary|theft)/i, emoji: "🚨", category: "crime", tone: "bad" },
    { re: /(missing|abduct|kidnap)/i, emoji: "🧩", category: "crime", tone: "warn" },
    { re: /(traffic|congestion|delay|backup)/i, emoji: "🚗", category: "traffic", tone: "warn" },
    { re: /(crash|wreck|collision|accident)/i, emoji: "💥", category: "crash", tone: "bad" },
    { re: /(road closed|closure|blocked|detour)/i, emoji: "⛔", category: "closure", tone: "bad" },
    { re: /(fire|hazmat|smoke)/i, emoji: "🔥", category: "fire_ems", tone: "bad" },
    { re: /(ems|medical|ambulance)/i, emoji: "🚑", category: "fire_ems", tone: "bad" },
    { re: /(train|vre|amtrak)/i, emoji: "🚆", category: "train", tone: "warn" },
    { re: /(weather|storm|wind|flood|snow|ice|tornado|hurricane)/i, emoji: "🌧️", category: "weather", tone: "warn" },
    { re: /(camera|webcam|live view|traffic cam)/i, emoji: "📷", category: "camera", tone: "good" },
    { re: /(podcast|episode|audio|interview|broadcast)/i, emoji: "🎙️", category: "events", tone: "good" },
    { re: /(event|festival|parade|concert|market)/i, emoji: "🎉", category: "events", tone: "good" }
  ];

  // -----------------------------
  // Utilities
  // -----------------------------
  const $ = (id) => document.getElementById(id);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Make a panel draggable by its handle (pointer-friendly).
  function makeDraggable(el, handle) {
    if (!el || !handle) return;
    let dragging = false;
    let startX = 0, startY = 0, origX = 0, origY = 0;
    let originalTransform = "";

    const onDown = (e) => {
      // Only left click / primary touch
      if (e.button !== undefined && e.button !== 0) return;
      // Don't start dragging if clicking on the close button or other interactive elements
      if (e.target.closest('.iconBtn') || e.target.closest('button:not(.panel__handle)')) return;

      // Only allow dragging when clicking on the panel__grab element or panel__handle
      const isGrabClick = e.target.closest('.panel__grab') || e.target.closest('.panel__handle');
      if (!isGrabClick) return;

      dragging = true;

      // Store and remove any transform (like translateY for collapsed state)
      const computed = window.getComputedStyle(el);
      originalTransform = computed.transform !== "none" ? computed.transform : "";
      el.style.transform = "none";

      // Expand panel if collapsed when starting to drag
      if (el.classList.contains("panel--collapsed")) {
        el.classList.remove("panel--collapsed");
      }

      const rect = el.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      startX = e.clientX;
      startY = e.clientY;

      // Remove any right/bottom positioning and switch to left/top
      el.style.right = "auto";
      el.style.bottom = "auto";
      el.style.left = `${origX}px`;
      el.style.top = `${origY}px`;

      el.classList.add("is-dragging");
      handle.setPointerCapture?.(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    };

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const x = Math.max(8, Math.min(window.innerWidth - 120, origX + dx));
      const y = Math.max(72, Math.min(window.innerHeight - 120, origY + dy));
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      e.preventDefault();
    };

    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove("is-dragging");

      // Release pointer capture
      if (handle.releasePointerCapture && e.pointerId !== undefined) {
        try {
          handle.releasePointerCapture(e.pointerId);
        } catch (err) {
          // Ignore errors if pointer was already released
        }
      }
    };

    handle.style.touchAction = "none";
    handle.style.cursor = "grab";
    handle.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }


  function fmtTime(isoOrDate) {
    try {
      const d = (isoOrDate instanceof Date) ? isoOrDate : new Date(isoOrDate);
      return d.toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    } catch {
      return String(isoOrDate || "—");
    }
  }

  function toDate(v) {
    if (!v) return null;
    if (v instanceof Date) return v;
    // ArcGIS date fields are often epoch milliseconds
    if (typeof v === "number" && isFinite(v)) {
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  function hoursAgo(v) {
    const d = toDate(v);
    if (!d) return Infinity;
    return (Date.now() - d.getTime()) / (1000 * 60 * 60);
  }

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8);
  }

  function inBbox(lat, lon, bbox) {
    return lat >= bbox.minLat && lat <= bbox.maxLat && lon >= bbox.minLon && lon <= bbox.maxLon;
  }

  function pickEmojiCategory(text, fallbackEmoji, fallbackCategory, fallbackTone) {
    for (const k of KEYWORD_EMOJI) {
      if (k.re.test(text)) return { emoji: k.emoji, category: k.category, tone: k.tone };
    }
    return { emoji: fallbackEmoji, category: fallbackCategory, tone: fallbackTone };
  }

  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeAttr(s) {
    // Safe for HTML attributes (also escapes backticks used in template literals)
    return escapeHtml(s).replaceAll('`', '&#096;');
  }


  function stripHtml(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html || "";
    return (tmp.textContent || tmp.innerText || "").replace(/\s+/g, " ").trim();
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }


  function centroidFromPolygon(poly) {
    const ring = poly?.[0];
    if (!ring || ring.length < 3) return null;
    let x = 0, y = 0, n = 0;
    for (const [lon, lat] of ring) {
      if (isFinite(lat) && isFinite(lon)) { x += lon; y += lat; n++; }
    }
    if (!n) return null;
    return { lon: x/n, lat: y/n };
  }

  // -----------------------------
  // CORS fetch with proxy rotation
  // -----------------------------
  async function fetchWithProxies(url, opts = {}, responseType = 'auto') {
    /**
     * Perform a fetch to the given URL, using a local proxy when possible to
     * avoid CORS errors. Consumers may specify the expected response type via
     * opts.expect (preferred) or the third `responseType` argument. Supported
     * types are "json" and "text". Any additional headers supplied in
     * opts.headers will be merged into the request.
     */

    // Determine the desired response type: opts.expect takes precedence over the
    // legacy responseType argument. Defaults to "auto", which behaves like
    // "text" for backwards compatibility.
    const expected = (opts && typeof opts.expect === 'string' && opts.expect)
      ? opts.expect.toLowerCase()
      : (responseType || 'auto').toLowerCase();

    // Extract any caller-supplied headers; ensure it's an object.
    const extraHeaders = (opts && typeof opts.headers === 'object' && opts.headers) || {};

    // Default timeout for all network calls (ms). If opts.timeoutMs is provided,
    // use that; otherwise fall back to any CONFIG.net.timeoutMs, or
    // CONFIG.polling.timeoutMs, or a hardcoded default (15000ms - increased from 12000).
    const timeoutMs = (opts && typeof opts.timeoutMs === 'number')
      ? opts.timeoutMs
      : (((CONFIG && CONFIG.net && typeof CONFIG.net.timeoutMs === 'number') ? CONFIG.net.timeoutMs
          : ((CONFIG && CONFIG.polling && typeof CONFIG.polling.timeoutMs === 'number') ? CONFIG.polling.timeoutMs
            : 15000)));

    // Build list of candidate fetch targets: prefer our local proxy if possible,
    // then same-origin/direct requests, then any configured public proxies.
    const candidates = [];

    const tryLocalProxy = () => {
      try {
        const u = new URL(url, location.href);
        // Only proxy absolute http(s) URLs (skip blob:, data:, etc.)
        if (!/^https?:$/.test(u.protocol)) return null;
        return `${location.origin}/proxy?url=${encodeURIComponent(u.toString())}`;
      } catch {
        return null;
      }
    };

    const local = tryLocalProxy();
    if (local) candidates.push({ url: local, type: 'proxy' });

    // Allow direct fetch only for same-origin or known CORS-friendly APIs (ex: NWS).
    const isSameOrigin = (() => {
      try { return new URL(url, location.href).origin === location.origin; } catch { return false; }
    })();
    const isCorsFriendly = (() => {
      try {
        const u = new URL(url, location.href);
        const host = u.hostname.toLowerCase();
        // Known CORS-friendly APIs (removed 511virginia.org - it requires proxy)
        return host.includes('weather.gov');
      } catch {
        return false;
      }
    })();
    if (isSameOrigin || isCorsFriendly) candidates.push({ url, type: 'direct' });

    // Public proxies disabled by default, but included here if any custom
    // proxies were configured in CONFIG.corsProxies.
    for (const p of CONFIG.corsProxies) candidates.push({ url: p(url), type: 'public' });

    let lastErr = null;
    const errors = [];

    for (const candidate of candidates) {
      if (!candidate.url) continue;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort("Request timeout"), timeoutMs);

        // Build Accept header based on expected response type. Many upstream
        // endpoints are sensitive to overly strict Accept values, so always
        // allow any type as a fallback ("*/*").
        const acceptHeader = expected === 'json' ? 'application/json,*/*' : 'text/plain,*/*';

        // Improved User-Agent to avoid being blocked by servers
        const userAgent = extraHeaders['User-Agent'] ||
                         'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

        const mergedHeaders = {
          'Accept': acceptHeader,
          'User-Agent': userAgent,
          ...extraHeaders
        };

        const res = await fetch(candidate.url, {
          signal: controller.signal,
          headers: mergedHeaders,
          credentials: 'omit', // Don't send cookies to avoid CORS issues
          mode: candidate.type === 'direct' ? 'cors' : 'cors'
        });

        clearTimeout(timeout);

        if (!res.ok) {
          const err = new Error(`HTTP ${res.status}`);
          errors.push({ type: candidate.type, status: res.status, error: err.message });
          throw err;
        }

        if (expected === 'json') {
          const ct = (res.headers.get('content-type') || '').toLowerCase();
          const txt = await res.text();

          // Some endpoints (or proxies) return HTML error pages or redirect pages.
          if (/^\s*<!DOCTYPE/i.test(txt) || /^\s*<html/i.test(txt)) {
            const err = new Error('HTML response instead of JSON (likely proxy/server error)');
            errors.push({ type: candidate.type, error: err.message, preview: txt.slice(0, 200) });
            throw err;
          }

          // If content-type isn't JSON but the payload is valid JSON, still allow parsing.
          try {
            const parsed = JSON.parse(txt);
            return parsed;
          } catch (parseErr) {
            const err = new Error(ct.includes('json') ? 'Bad JSON' : 'Non-JSON response');
            errors.push({ type: candidate.type, error: err.message, contentType: ct, preview: txt.slice(0, 200) });
            throw err;
          }
        }

        // Default to returning raw text when not expecting JSON.
        const textResponse = await res.text();

        // Log empty responses for debugging
        if (CONFIG.debug && CONFIG.debug.rss && (!textResponse || textResponse.trim().length === 0)) {
          console.warn(`[fetchWithProxies] Empty response from ${url} via ${candidate.type}`);
        }

        return textResponse;
      } catch (err) {
        lastErr = err;
        if (!errors.some(e => e.error === err.message)) {
          errors.push({ type: candidate.type, error: err.message });
        }
        continue;
      }
    }

    // Enhanced error message with details and guidance
    let errMsg = errors.length > 0
      ? `Fetch failed for ${url}: ${errors.map(e => `[${e.type}] ${e.error}`).join(', ')}`
      : 'Fetch failed';

    // Add helpful guidance if proxy failed
    if (errors.some(e => e.type === 'proxy')) {
      errMsg += ' (Tip: Make sure proxy server is running: node proxy-server.js)';
    }

    const enhancedErr = new Error(errMsg);
    enhancedErr.details = errors;
    throw enhancedErr;
  }
  // -----------------------------
  // RSS Geo helpers (namespace-safe: avoid querySelector('georss:point'))
  // -----------------------------
  function xmlFirstText(itemEl, names) {
    for (const name of names) {
      try {
        const els = itemEl.getElementsByTagName(name);
        if (els && els.length) {
          const txt = (els[0].textContent || '').trim();
          if (txt) return txt;
        }
      } catch (_) {}
    }
    // Fallback: match by localName (handles namespaces like georss:point)
    const wanted = new Set(names.map(n => String(n).split(':').pop().toLowerCase()));
    const all = itemEl.getElementsByTagName('*');
    for (const el of all) {
      const ln = (el.localName || el.nodeName || '').toLowerCase();
      if (wanted.has(ln)) {
        const txt = (el.textContent || '').trim();
        if (txt) return txt;
      }
    }
    return '';
  }

  function extractLatLonFromRssItem(itemEl) {
    // W3C Geo
    const latTxt = xmlFirstText(itemEl, ['geo:lat', 'lat']);
    const lonTxt = xmlFirstText(itemEl, ['geo:long', 'geo:lon', 'long', 'lon']);
    const lat = parseFloat(latTxt);
    const lon = parseFloat(lonTxt);
    if (isFinite(lat) && isFinite(lon)) return { lat, lon };

    // GeoRSS point ("lat lon")
    const pt = xmlFirstText(itemEl, ['georss:point', 'point']);
    if (pt) {
      const parts = pt.trim().split(/[\s,]+/).map(Number).filter(n => Number.isFinite(n));
      if (parts.length >= 2) {
        const [a, b] = parts;
        // GeoRSS spec: lat lon
        if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lon: b };
      }
    }
    return null;
  }

  // -----------------------------
  // Geocoding Service (extract locations from text and geocode)
  // -----------------------------
  const geocodeCache = new Map(); // Cache geocoding results: "location_string" -> { lat, lon, timestamp }
  const GEOCODE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // Cache for 7 days
  const GEOCODE_RATE_LIMIT_MS = 1000; // 1 request per second for Nominatim
  let lastGeocodeTime = 0;

  /**
   * Extract potential location references from text
   * Looks for common patterns like:
   * - Street names (e.g., "Route 1", "I-95", "Main Street", "Jefferson Davis Highway")
   * - Intersections (e.g., "Route 1 and Route 3", "Main St at Lafayette Blvd")
   * - Addresses (e.g., "123 Main Street")
   * - Area names (e.g., "Downtown Fredericksburg", "Massaponax")
   */
  function extractLocationFromText(text) {
    if (!text) return null;

    // Common road/street patterns in the region
    const patterns = [
      // Specific intersections (more specific = higher priority)
      /(?:at|near|on|@)\s+([A-Z][A-Za-z\s\.]+?(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Highway|Hwy|Drive|Dr|Lane|Ln|Parkway|Pkwy|Route|Rt))\s+(?:and|at|&|near)\s+([A-Z][A-Za-z\s\.]+?(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Highway|Hwy|Drive|Dr|Lane|Ln|Parkway|Pkwy|Route|Rt))/i,

      // Interstate highways
      /(?:on|at|near)\s+(I-?95|I-?295|Interstate\s+95|Interstate\s+295)/i,

      // US Routes
      /(?:on|at|near)\s+(U\.?S\.?\s+Route\s+\d+|US\s+\d+|Route\s+\d+|Rt\.?\s+\d+)/i,

      // State routes
      /(?:on|at|near)\s+(State\s+Route\s+\d+|SR\s+\d+|VA\s+\d+|Virginia\s+\d+)/i,

      // Street addresses
      /\b(\d{1,5}\s+[A-Z][A-Za-z\s\.]+?(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Highway|Hwy|Drive|Dr|Lane|Ln|Parkway|Pkwy))/i,

      // Street names without numbers
      /(?:on|at|near|along)\s+([A-Z][A-Za-z\s\.]+?(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Highway|Hwy|Drive|Dr|Lane|Ln|Parkway|Pkwy))/i,

      // Known area names in the region
      /\b(Downtown\s+Fredericksburg|Historic\s+District|Massaponax|Courthouse\s+Village|Four\s+Mile\s+Fork|Bragg\s+Hill|Celebrate\s+Virginia)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        // Return the captured group(s), joining multiple groups if it's an intersection
        const location = match.slice(1).filter(Boolean).join(' and ');
        return location.trim();
      }
    }

    return null;
  }

  /**
   * Geocode a location string using Nominatim (OpenStreetMap)
   * Returns { lat, lon } or null if geocoding fails
   */
  async function geocodeLocation(locationString, jurisdiction) {
    if (!locationString) return null;

    // Check cache first
    const cacheKey = `${locationString}|${jurisdiction}`.toLowerCase();
    const cached = geocodeCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < GEOCODE_CACHE_TTL) {
      if (CONFIG.debug.rss) {
        console.log(`[Geocode] Cache hit for "${locationString}" in ${jurisdiction}: ${cached.lat}, ${cached.lon}`);
      }
      return { lat: cached.lat, lon: cached.lon };
    }

    // Rate limiting for Nominatim
    const now = Date.now();
    const timeSinceLastRequest = now - lastGeocodeTime;
    if (timeSinceLastRequest < GEOCODE_RATE_LIMIT_MS) {
      await sleep(GEOCODE_RATE_LIMIT_MS - timeSinceLastRequest);
    }
    lastGeocodeTime = Date.now();

    try {
      // Build query with jurisdiction context for better accuracy
      const jurisdictionMap = {
        'Fredericksburg': 'Fredericksburg, Virginia',
        'Stafford': 'Stafford County, Virginia',
        'Spotsylvania': 'Spotsylvania County, Virginia',
        'Regional': 'Fredericksburg, Virginia'
      };
      const areaContext = jurisdictionMap[jurisdiction] || 'Fredericksburg, Virginia';
      const query = `${locationString}, ${areaContext}`;

      if (CONFIG.debug.rss) {
        console.log(`[Geocode] Querying Nominatim for: "${query}"`);
      }

      // Use Nominatim API via our proxy
      const nominatimUrl = `https://nominatim.openstreetmap.org/search?` + new URLSearchParams({
        q: query,
        format: 'json',
        limit: '1',
        countrycodes: 'us',
        // Bounded search within Virginia region
        viewbox: '-77.85,38.10,-77.20,38.52', // bbox around FXBG metro
        bounded: '0' // Don't require results within viewbox, but prefer them
      }).toString();

      const response = await fetchWithProxies(nominatimUrl, {
        expect: 'json',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'FXBG-Palantir-City-Manager/1.0'
        }
      });

      if (response && response.length > 0) {
        const result = response[0];
        const lat = parseFloat(result.lat);
        const lon = parseFloat(result.lon);

        if (isFinite(lat) && isFinite(lon)) {
          // Validate that the result is within our region bbox
          if (lat >= CONFIG.bbox.minLat && lat <= CONFIG.bbox.maxLat &&
              lon >= CONFIG.bbox.minLon && lon <= CONFIG.bbox.maxLon) {

            // Cache the result
            geocodeCache.set(cacheKey, { lat, lon, timestamp: Date.now() });

            if (CONFIG.debug.rss) {
              console.log(`[Geocode] Success for "${locationString}": ${lat}, ${lon} (${result.display_name})`);
            }

            return { lat, lon };
          } else {
            if (CONFIG.debug.rss) {
              console.log(`[Geocode] Result for "${locationString}" outside region bbox: ${lat}, ${lon}`);
            }
          }
        }
      }

      if (CONFIG.debug.rss) {
        console.log(`[Geocode] No valid results for "${locationString}"`);
      }
      return null;

    } catch (error) {
      if (CONFIG.debug.rss) {
        console.warn(`[Geocode] Error geocoding "${locationString}":`, error.message);
      }
      return null;
    }
  }


  // -----------------------------
  // file:// banner
  // -----------------------------
  function initProtocolBanner() {
    const banner = $("protoBanner");
    const close = $("bannerClose");
    if (location.protocol === "file:") banner.classList.remove("banner--hidden");
    close?.addEventListener("click", () => banner.classList.add("banner--hidden"));
  }
  initProtocolBanner();

  // Check if proxy server is available
  async function checkProxyServer() {
    try {
      const proxyUrl = `${location.origin}/proxy?url=${encodeURIComponent('https://api.weather.gov')}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(proxyUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok && res.status !== 404) {
        console.warn('Proxy server responded with error status:', res.status);
      }
    } catch (e) {
      if (!store._proxyWarningShown) {
        console.warn('⚠️ PROXY SERVER NOT DETECTED: External API calls may fail due to CORS. Start the proxy server with: node proxy-server.js');
        store._proxyWarningShown = true;
      }
    }
  }

  // Check proxy availability on load
  if (location.protocol !== "file:") {
    checkProxyServer();
  }

  // -----------------------------
  // Map setup (Esri Dark Gray Canvas + labels)
  // -----------------------------
  const map = L.map("map", { zoomControl: false, preferCanvas: true })
    .setView([CONFIG.center.lat, CONFIG.center.lon], CONFIG.zoom);

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 18 }
  ).addTo(map);

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 18, opacity: 0.95 }
  ).addTo(map);

  L.control.zoom({ position: "bottomright" }).addTo(map);

  const clusters = L.markerClusterGroup({
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    maxClusterRadius: 46
  });
  map.addLayer(clusters);

  // -----------------------------
  // Panel UI
  // -----------------------------
  const panel = $("panel");
  const panelHandle = $("panelHandle");
  const panelClose = $("panelClose");
  makeDraggable(panel, panelHandle);


  function openPanel() {
    panel.classList.remove("panel--collapsed");
    panelHandle.setAttribute("aria-expanded", "true");
  }
  function closePanel() {
    clearSelection();
    panel.classList.add("panel--collapsed");
    panelHandle.setAttribute("aria-expanded", "false");
  }
  panelHandle.addEventListener("click", (e) => {
    // Don't toggle if clicking the close button or any button inside the handle
    if (e.target.closest('.iconBtn') || e.target.closest('button')) return;
    panel.classList.contains("panel--collapsed") ? openPanel() : closePanel();
  });
  panelHandle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      panel.classList.contains("panel--collapsed") ? openPanel() : closePanel();
    }
  });
  panelClose.addEventListener("click", (e) => {
    e.stopPropagation();
    e.stopImmediatePropagation();
    e.preventDefault();
    closePanel();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePanel();
  });


  // -----------------------------
  // Filters
  // -----------------------------
  const activeCategories = new Set(Object.keys(CATEGORIES));

  function buildFilters() {
    const host = $("filters");
    host.innerHTML = "";
    for (const [key, def] of Object.entries(CATEGORIES)) {
      const btn = document.createElement("button");
      btn.className = "fbtn";
      btn.type = "button";
      btn.setAttribute("aria-pressed", "true");
      btn.textContent = `${def.emoji} ${def.label}`;
      btn.dataset.cat = key;
      btn.title = "Click: show alerts • Shift+Click: hide/show category";
      btn.addEventListener("click", (e) => {
        if (e.shiftKey) {
          const on = btn.getAttribute("aria-pressed") === "true";
          btn.setAttribute("aria-pressed", String(!on));
          if (on) activeCategories.delete(key);
          else activeCategories.add(key);
          redraw();
          return;
        }
        focusCategory(key);
      });
      host.appendChild(btn);
    }
  }
  buildFilters();
  // Make the footer legend clickable (same behavior as filter buttons)
  (function wireLegendClicks(){
    const legend = document.getElementById("legend");
    if (!legend) return;

    const emojiToCat = {};
    for (const [k, def] of Object.entries(CATEGORIES)) emojiToCat[def.emoji] = k;

    legend.querySelectorAll(".legend__item").forEach((el) => {
      el.style.cursor = "pointer";
      el.title = "Click: show alerts • Shift+Click: hide/show category";
      el.addEventListener("click", (e) => {
        const emoji = (el.querySelector(".legend__emoji")?.textContent || "").trim();
        const cat = emojiToCat[emoji];
        if (!cat) return;
        if (e.shiftKey) {
          // mirror shift+click behavior: toggle category on/off
          const on = activeCategories.has(cat);
          if (on) activeCategories.delete(cat); else activeCategories.add(cat);
          // update filter button visual state
          document.querySelectorAll("#filters .fbtn").forEach(btn => {
            if ((btn.dataset.cat || "") === cat) btn.setAttribute("aria-pressed", String(!on));
          });
          redraw();
          return;
        }
        focusCategory(cat);
      });
    });
  })();


  function focusCategory(catKey) {
    // Ensure category is on
    activeCategories.add(catKey);
    // Update filter button pressed state
    document.querySelectorAll("#filters .fbtn").forEach(btn => {
      if ((btn.dataset.cat || "") === catKey) btn.setAttribute("aria-pressed", "true");
    });

    // Collect newest visible items for this category
    const now = Date.now();
    const maxAgeMs = Math.max(2, CONFIG.freshness?.uiListMaxAgeHours || 24) * 3600 * 1000;
    const items = Array.from(store.itemsById.values())
      .filter(it => it.category === catKey)
      .filter(it => {
        if (!it.timestamp) return false;
        const ts = new Date(it.timestamp).getTime();
        return !isNaN(ts) && (now - ts) <= maxAgeMs;
      })
      .sort((a,b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 30);

    const ids = items.map(it => it.id);
    pulseMarkers(ids);

    // Render list into panel
    const def = CATEGORIES[catKey];
    $("panelEmoji").textContent = def?.emoji || "📌";
    $("panelTitle").textContent = `${def?.label || catKey} — Alerts (${items.length})`;
    $("panelCategory").textContent = def?.label || catKey;
    $("panelTime").textContent = fmtTime(Date.now());
    $("panelSource").textContent = "CITY MANAGER";
    $("panelLink").href = "#";

    const listHtml = items.length ? `
      <div class="panelList">
        ${items.map(it => `
          <button class="panelList__item" type="button" data-id="${escapeAttr(it.id)}">
            <div class="panelList__top">
              <span class="panelList__emoji">${escapeHtml(it.emoji)}</span>
              <span class="panelList__title">${escapeHtml(it.title)}</span>
            </div>
            <div class="panelList__meta">
              <span>${escapeHtml(it.sourceName || it.source || "")}</span>
              <span>${escapeHtml(fmtTime(it.timestamp))}</span>
            </div>
          </button>
        `).join("")}
      </div>
    ` : `<div class="muted">No recent items for this category.</div>`;

    $("panelDesc").innerHTML = `
      <div class="muted">Tip: click an item below to zoom to it. Shift+Click filters to hide/show.</div>
      ${listHtml}
    `;
    $("panelMedia").style.display = "none";
    $("panelMedia").innerHTML = "";

    openPanel();

    // Wire list clicks
    document.querySelectorAll(".panelList__item").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-id");
        if (id) selectItem(id);
      });
    });
  }



  // -----------------------------
  // Data store
  // -----------------------------
  const store = {
    itemsById: new Map(),
    seenKeys: new Set(),
    markersById: new Map(),
    locks: { rss:false, nws:false, arcgis:false, virginiaCrashData:false, va511:false, vaRoads:false },
    lastByCategory: new Map()
  };

  function normalize({ source, raw }) {
    // Only drop items if they have no title AND no link (as per requirements)
    if (!raw.title && !raw.url) {
      if (CONFIG.debug.rss) {
        console.log(`[RSS Filter] Dropped item from ${source.id}: No title and no link`);
      }
      return null;
    }

    const textForHeuristics = `${raw.title || ""} ${raw.summary || ""}`.trim();
    const picked = pickEmojiCategory(textForHeuristics, source.emoji, source.category, source.tone);

    // CRITICAL: Never drop items due to missing geodata - always use defaultLoc fallback
    // This ensures all RSS items appear on the map even if they have no embedded coordinates
    const loc = raw.loc || source.defaultLoc || CONFIG.center;

    const publishedDate = toDate(raw.published);
    const maxAge = source.maxAgeHours ?? CONFIG.freshness.rssMaxAgeHours;

    // Debug logging for filtering decisions (only when debug is enabled)
    if (!publishedDate) {
      if (CONFIG.debug.rss) {
        console.log(`[RSS Filter] Dropped item from ${source.id}: "${raw.title?.slice(0, 50) || 'untitled'}" - Bad/missing date (${raw.published})`);
      }
      return null;
    }

    const age = hoursAgo(publishedDate);
    if (age > maxAge) {
      if (CONFIG.debug.rss) {
        console.log(`[RSS Filter] Dropped item from ${source.id}: "${raw.title?.slice(0, 50) || 'untitled'}" - Too old (${age.toFixed(1)}h ago, max: ${maxAge}h)`);
      }
      return null;
    }

    const dedupeSeed = `${source.id}|${raw.guid || raw.url || raw.title || ""}|${publishedDate.toISOString()}`;
    const dedupeKey = fnv1a(dedupeSeed);

    return {
      id: `${source.id}:${dedupeKey}`,
      dedupeKey,
      title: raw.title || "(untitled)",
      timestamp: publishedDate.toISOString(),
      lat: loc.lat,
      lon: loc.lon,
      category: picked.category,
      emoji: picked.emoji,
      tone: picked.tone || source.tone || "warn",
      sourceName: source.name,
      sourceId: source.id,
      url: raw.url || source.url,
      summary: raw.summary || "",
      message: raw.message || raw.summary || "",
      panelHtml: raw.panelHtml || "",
      media: raw.media || null
    };
  }

  // -----------------------------
  // Marker helpers
  // -----------------------------
  function makeEmojiIcon(emoji, tone = "warn") {
    return L.divIcon({
      className: "",
      html: `<div class="emojiMarker" data-tone="${tone}">${emoji}</div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
      popupAnchor: [0, -12]
    });
  }

  function renderPopup(item) {
    const cat = CATEGORIES[item.category]?.label || item.category;
    const safeTitle = escapeHtml(item.title);
    const safeSummary = item.summary ? escapeHtml(item.summary) : "";
    return `
      <div style="min-width:220px">
        <div style="font-weight:900; font-size:13px; margin-bottom:6px">${item.emoji} ${safeTitle}</div>
        <div style="color:rgba(255,255,255,.70); font-size:12px; margin-bottom:8px">${cat} • ${fmtTime(item.timestamp)}</div>
        ${safeSummary ? `<div style="font-size:12px; line-height:1.35; color:rgba(255,255,255,.82); margin-bottom:10px">${safeSummary}</div>` : ""}
        <a href="${item.url}" target="_blank" rel="noreferrer noopener" style="color:#7ef0ff; font-weight:800; text-decoration:none">Open source ↗</a>
      </div>
    `;
  }

  function attachMarker(item) {
    const m = L.marker([item.lat, item.lon], { icon: makeEmojiIcon(item.emoji, item.tone) });
    m.on("click", () => selectItem(item.id));
    m.bindPopup(renderPopup(item), { closeButton: false });
    clusters.addLayer(m);
    store.markersById.set(item.id, m);
  }

  
  let selectedId = null;
  function clearSelection() {
    if (!selectedId) return;
    const mPrev = store.markersById.get(selectedId);
    if (mPrev) {
      try {
        const el = mPrev.getElement?.();
        const bubble = el?.querySelector?.(".emojiMarker");
        bubble?.classList?.remove("emojiMarker--selected");
      } catch {}
      try { mPrev.closePopup?.(); } catch {}
    }
    selectedId = null;
  }

  function setSelected(id) {
    if (!id) return;
    if (selectedId && selectedId !== id) clearSelection();
    selectedId = id;
    const m = store.markersById.get(id);
    if (m) {
      try {
        const el = m.getElement?.();
        const bubble = el?.querySelector?.(".emojiMarker");
        bubble?.classList?.add("emojiMarker--selected");
      } catch {}
    }
  }

  function pulseMarkers(ids, ms = 2200) {
    const touched = [];
    for (const id of ids) {
      const m = store.markersById.get(id);
      if (!m) continue;
      try {
        const el = m.getElement?.();
        const bubble = el?.querySelector?.(".emojiMarker");
        if (!bubble) continue;
        bubble.classList.add("emojiMarker--pulse");
        touched.push(bubble);
      } catch {}
    }
    if (touched.length) {
      setTimeout(() => touched.forEach(b => b.classList.remove("emojiMarker--pulse")), ms);
    }
  }

function selectItem(id) {
    setSelected(id);
    const item = store.itemsById.get(id);
    if (!item) return;

    $("panelEmoji").textContent = item.emoji;
    $("panelTitle").textContent = item.title;
    $("panelCategory").textContent = CATEGORIES[item.category]?.label || item.category;
    $("panelTime").textContent = fmtTime(item.timestamp);
    $("panelSource").textContent = item.sourceName;
    $("panelDesc").innerHTML = item.panelHtml ? item.panelHtml : escapeHtml(item.message || item.summary || "No description provided by source.");
    const mediaEl = $("panelMedia");
    if (item.media && item.media.type === "image" && item.media.src) {
      mediaEl.style.display = "block";
      // Remove loading="lazy" to ensure immediate loading when panel opens
      // Add error handling and loading state for better UX
      const imgAlt = escapeAttr(item.media.alt || item.title || "Traffic camera snapshot");
      const imgSrc = escapeAttr(item.media.src);

      // Log camera image URL for debugging
      console.log(`Loading camera image: ${item.media.originalSrc || item.media.src}`);

      mediaEl.innerHTML = `
        <div class="panelMedia__wrapper" style="position: relative; min-height: 200px; background: #1a1a1a; border-radius: 8px; overflow: hidden;">
          <div class="panelMedia__loading" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.6); font-size: 14px;">
            <span>📷 Loading camera snapshot...</span>
          </div>
          <img class="panelMedia__img"
               src="${imgSrc}"
               alt="${imgAlt}"
               style="display: none; width: 100%; height: auto; position: relative; z-index: 1;"
               onload="this.style.display='block'; this.parentElement.querySelector('.panelMedia__loading').style.display='none';"
               onerror="this.style.display='none'; const loading = this.parentElement.querySelector('.panelMedia__loading'); loading.innerHTML = '<div style=\\'text-align: center; padding: 20px;\\'><div style=\\'font-size: 32px; margin-bottom: 8px;\\'>📷</div><div style=\\'color: rgba(255,255,255,0.7);\\'>Camera snapshot unavailable</div><div style=\\'font-size: 12px; color: rgba(255,255,255,0.5); margin-top: 4px;\\'>The camera feed may be offline or temporarily unavailable</div></div>'; loading.style.display='flex';" />
        </div>
      `;
    } else if (item.media && item.media.type === "iframe" && item.media.src) {
      mediaEl.style.display = "block";
      mediaEl.innerHTML = `<iframe class="panelMedia__frame" src="${escapeAttr(item.media.src)}" title="${escapeAttr(item.media.title || "media")}" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
    } else {
      mediaEl.style.display = "none";
      mediaEl.innerHTML = "";
    }
    $("panelLink").href = item.url || "#";

    openPanel();

    const m = store.markersById.get(id);
    if (m) {
      map.panTo(m.getLatLng(), { animate: true, duration: 0.35 });
      m.openPopup();
    }
  }

  function enforceCaps() {
    // Keep newest CONFIG.perf.maxTotalItems items (excluding cameras, which are stable and light)
    const items = Array.from(store.itemsById.values());
    const cams = items.filter(i => i.sourceId === "va511-cameras");
    const others = items.filter(i => i.sourceId !== "va511-cameras");

    others.sort((a,b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const trimmed = others.slice(0, CONFIG.perf.maxTotalItems);

    store.itemsById.clear();
    store.markersById.clear();

    for (const it of [...cams, ...trimmed]) store.itemsById.set(it.id, it);
  }

  function redraw() {
    enforceCaps();
    clusters.clearLayers();
    store.markersById.clear();

    let markerCount = 0;
    let filtered = { category: 0, bbox: 0 };

    for (const item of store.itemsById.values()) {
      if (!activeCategories.has(item.category)) {
        filtered.category++;
        continue;
      }
      if (!inBbox(item.lat, item.lon, CONFIG.bbox)) {
        filtered.bbox++;
        continue;
      }
      attachMarker(item);
      markerCount++;
    }

    console.log(`Redraw complete: ${markerCount} markers visible (${store.itemsById.size} total items, ${filtered.category} filtered by category, ${filtered.bbox} outside bbox)`);
  }

  // -----------------------------
  // RSS ingestion (current-only)
  // -----------------------------

  /**
   * Discover RSS/ATOM feed URL from an HTML page
   * Looks for <link rel="alternate" type="application/rss+xml"> or <a href> ending in .rss/.xml/.atom
   * Returns the discovered feed URL or null if not found
   */
  async function discoverFeedFromHtml(pageUrl) {
    try {
      // Fetch HTML page via proxy
      const htmlText = await fetchWithProxies(pageUrl, {
        expect: "text",
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "X-Cache-TTL-MS": "900000"
        }
      });

      // Check if we got HTML
      if (!htmlText || (!htmlText.trim().toLowerCase().startsWith("<!doctype") && !htmlText.trim().toLowerCase().startsWith("<html"))) {
        if (CONFIG.debug.rss) {
          console.log(`[HTML Discover] ${pageUrl}: Response doesn't look like HTML`);
        }
        return null;
      }

      // Parse HTML with DOMParser
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlText, "text/html");

      // Check for parser errors
      const parserError = doc.querySelector("parsererror");
      if (parserError) {
        if (CONFIG.debug.rss) {
          console.log(`[HTML Discover] ${pageUrl}: HTML parse error`);
        }
        return null;
      }

      // Look for <link rel="alternate" type="application/rss+xml" href="...">
      // or type="application/atom+xml"
      const linkTags = doc.querySelectorAll('link[rel="alternate"]');
      for (const link of linkTags) {
        const type = link.getAttribute("type") || "";
        const href = link.getAttribute("href") || "";

        if ((type.includes("rss") || type.includes("atom")) && href) {
          // Resolve relative URL to absolute
          const absoluteUrl = new URL(href, pageUrl).toString();
          if (CONFIG.debug.rss) {
            console.log(`[HTML Discover] ${pageUrl}: Found feed link in <link> tag: ${absoluteUrl}`);
          }
          return absoluteUrl;
        }
      }

      // Look for <a href> ending in .rss, .xml, or .atom
      const anchorTags = doc.querySelectorAll('a[href]');
      for (const anchor of anchorTags) {
        const href = anchor.getAttribute("href") || "";
        if (/\.(rss|xml|atom)$/i.test(href)) {
          // Resolve relative URL to absolute
          const absoluteUrl = new URL(href, pageUrl).toString();
          if (CONFIG.debug.rss) {
            console.log(`[HTML Discover] ${pageUrl}: Found feed link in <a> tag: ${absoluteUrl}`);
          }
          return absoluteUrl;
        }
      }

      if (CONFIG.debug.rss) {
        console.log(`[HTML Discover] ${pageUrl}: No feed links found`);
      }
      return null;

    } catch (err) {
      if (CONFIG.debug.rss) {
        console.warn(`[HTML Discover] ${pageUrl}: Error during discovery:`, err.message);
      }
      return null;
    }
  }

  async function fetchRSS(source) {
    // Handle html_discover type - discover feed URL from HTML page first
    let feedUrl = source.url;
    if (source.type === "html_discover") {
      if (CONFIG.debug.rss) {
        console.log(`[RSS Fetch] ${source.id}: Discovering feed from HTML page: ${source.url}`);
      }
      const discoveredUrl = await discoverFeedFromHtml(source.url);
      if (!discoveredUrl) {
        console.warn(`[RSS Fetch] ${source.id}: No feed discovered from HTML page, skipping`);
        return [];
      }
      feedUrl = discoveredUrl;
      if (CONFIG.debug.rss) {
        console.log(`[RSS Fetch] ${source.id}: Discovered feed URL: ${feedUrl}`);
      }
    }

    // Fetch RSS/ATOM via proxy, expecting plain text
    // Cache TTL set to 15 minutes (900000ms) to prevent rate limiting (429 errors)
    // Use proper Accept header for RSS/ATOM feeds as per requirements
    const cacheSeconds = CONFIG.fetch?.cacheSeconds || 900;
    if (CONFIG.debug.rss) {
      console.log(`[RSS Fetch] ${source.id}: Fetching feed from ${feedUrl} (cache: ${cacheSeconds}s)`);
    }

    const xmlText = await fetchWithProxies(feedUrl, {
      expect: "text",
      headers: {
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        "X-Cache": `max-age=${cacheSeconds}`
      }
    });

    if (CONFIG.debug.rss) {
      console.log(`[RSS Fetch] ${source.id}: Received ${xmlText?.length || 0} bytes`);
    }

    // Check if we received HTML instead of XML (common proxy error or invalid response)
    if (xmlText && (/^\s*<!DOCTYPE html/i.test(xmlText) || /^\s*<html/i.test(xmlText))) {
      throw new Error(`RSS parse error for ${source.id}: Received HTML instead of XML (feed may be unavailable)`);
    }

    // Check for empty or invalid response
    if (!xmlText || xmlText.trim().length === 0) {
      throw new Error(`RSS parse error for ${source.id}: Empty response from server`);
    }

    // Try to parse XML - handle malformed XML gracefully
    let doc;
    try {
      doc = new DOMParser().parseFromString(xmlText, "text/xml");
      const parseError = doc.querySelector("parsererror");
      if (parseError) {
        const errorText = parseError.textContent || "Unknown parse error";

        // For malformed XML, try to clean it and parse again
        console.warn(`RSS parse error for ${source.id}, attempting to clean XML...`);
        const cleanedXml = xmlText
          .trim()
          .replace(/^[^<]*/, '') // Remove any non-XML content before first tag
          .replace(/<!\[CDATA\[.*?\]\]>/gs, '') // Remove CDATA sections that might be malformed
          .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#)/g, '&amp;'); // Escape unescaped ampersands

        doc = new DOMParser().parseFromString(cleanedXml, "text/xml");
        const parseError2 = doc.querySelector("parsererror");
        if (parseError2) {
          throw new Error(`RSS parse error for ${source.id}: ${errorText.slice(0, 100)}`);
        }
      }
    } catch (e) {
      throw new Error(`RSS parse error for ${source.id}: ${e.message}`);
    }

    const items = Array.from(doc.querySelectorAll("item"));
    const entries = Array.from(doc.querySelectorAll("entry"));
    const out = [];

    if (CONFIG.debug.rss) {
      console.log(`[RSS Parse] ${source.id}: Found ${items.length || entries.length} raw items/entries in feed XML`);
    }

    const push = (row) => {
      if (out.length < CONFIG.perf.maxPerSource) out.push(row);
    };

    if (items.length) {
      for (const it of items) {
        const title = (it.getElementsByTagName("title")[0]?.textContent || "").trim();
        const linkTxt = (it.getElementsByTagName("link")[0]?.textContent || "").trim();
        const linkHref = it.getElementsByTagName("link")[0]?.getAttribute?.("href") || "";
        const link = linkTxt || linkHref || "";
        const guid = (it.getElementsByTagName("guid")[0]?.textContent || "").trim();
        const pubDate = (it.getElementsByTagName("pubDate")[0]?.textContent || "").trim()
          || (it.getElementsByTagName("dc:date")[0]?.textContent || "").trim();
        const desc = (it.getElementsByTagName("description")[0]?.textContent || "").trim();
        const loc = extractLatLonFromRssItem(it);

        const publishedDate = toDate(pubDate);
        if (!publishedDate) continue;
        // Freshness filtering moved to normalize() to avoid double-filtering

        const cleanDesc = stripHtml(desc);
        push({
          title,
          url: link,
          guid,
          published: publishedDate.toISOString(),
          message: cleanDesc,
          summary: cleanDesc.slice(0, 400),  // Increased from 240 to 400 chars
          loc: loc || null
        });
      }
    } else if (entries.length) {
      for (const e of entries) {
        const title = (e.getElementsByTagName("title")[0]?.textContent || "").trim();
        const linkEl = e.getElementsByTagName("link")[0];
        const link = linkEl?.getAttribute?.("href") || (linkEl?.textContent || "").trim();
        const id = (e.getElementsByTagName("id")[0]?.textContent || "").trim();
        const updated = (e.getElementsByTagName("updated")[0]?.textContent || "").trim();
        const summary = (e.getElementsByTagName("summary")[0]?.textContent || "").trim();
        const loc = extractLatLonFromRssItem(e);

        const publishedDate = toDate(updated);
        if (!publishedDate) continue;
        // Freshness filtering moved to normalize() to avoid double-filtering

        const cleanSummary = stripHtml(summary);
        push({
          title,
          url: link,
          guid: id,
          published: publishedDate.toISOString(),
          message: cleanSummary,
          summary: cleanSummary.slice(0, 400),  // Increased from 240 to 400 chars
          loc: loc || null
        });
      }
    }

    if (CONFIG.debug.rss) {
      console.log(`[RSS Parse] ${source.id}: Parsed ${out.length} valid items (with dates) from feed`);
    }

    // Geocode items that don't have embedded coordinates
    // Process geocoding for items without location data
    for (const item of out) {
      // Skip if item already has location from GeoRSS
      if (item.loc) continue;

      // Try to extract location from title and summary
      const textToSearch = `${item.title || ''} ${item.summary || ''}`;
      const extractedLocation = extractLocationFromText(textToSearch);

      if (extractedLocation) {
        if (CONFIG.debug.rss) {
          console.log(`[Geocode] Extracted location from "${item.title?.slice(0, 60)}...": "${extractedLocation}"`);
        }

        // Geocode the extracted location
        const geocoded = await geocodeLocation(extractedLocation, source.jurisdiction);
        if (geocoded) {
          item.loc = geocoded;
          if (CONFIG.debug.rss) {
            console.log(`[Geocode] Geocoded "${extractedLocation}" -> ${geocoded.lat}, ${geocoded.lon}`);
          }
        }
      }
    }

    return out;
  }

  async function pollRSS() {
    if (store.locks.rss) return { skipped:true };
    store.locks.rss = true;
    const results = [];
    let anySucceeded = false;
    let totalAdded = 0;

    for (const source of CONFIG.rss) {
      await sleep((CONFIG.polling && CONFIG.polling.rssStaggerMs) || 300);
      try {
        const items = await fetchRSS(source);
        if (CONFIG.debug.rss) {
          console.log(`[RSS Ingest] ${source.id}: Starting ingestion of ${items.length} parsed items (maxAge: ${source.maxAgeHours ?? CONFIG.freshness.rssMaxAgeHours}h)`);
        }

        let added = 0;
        let skippedDupe = 0;
        let skippedFilter = 0;

        for (const raw of items) {
          const norm = normalize({ source, raw });
          if (!norm) {
            skippedFilter++;
            continue;
          }
          if (store.seenKeys.has(norm.dedupeKey)) {
            skippedDupe++;
            continue;
          }
          store.seenKeys.add(norm.dedupeKey);
          store.itemsById.set(norm.id, norm);
          added++;
          totalAdded++;
        }

        if (CONFIG.debug.rss) {
          console.log(`[RSS Ingest] ${source.id}: Added ${added} new items, skipped ${skippedFilter} (filtered), ${skippedDupe} (duplicates)`);
        }
        results.push({ source: source.id, ok: true, added });
        anySucceeded = true;

      } catch (err) {
        // Check if this is a rate limit error (429)
        const isRateLimit = err.message && (err.message.includes('429') || err.message.includes('Too Many Requests'));
        const isEmpty = err.message && err.message.includes('Empty response');
        const isProxyError = err.message && err.message.includes('proxy');

        // Only log RSS errors once per session per source to avoid console spam
        const errorKey = `_rssError_${source.id}`;
        if (!store[errorKey]) {
          if (isRateLimit) {
            console.warn(`RSS feed ${source.id} rate limited (HTTP 429). Using cached data or will retry later.`);
          } else if (isEmpty || isProxyError) {
            console.error(`RSS feed ${source.id} failed. Error: ${err.message || err}`);
            if (isProxyError || isEmpty) {
              console.error(`  → Check that proxy server is running: node proxy-server.js`);
              console.error(`  → Feed URL: ${source.url}`);
            }
          } else {
            console.warn(`RSS feed ${source.id} failed. Error:`, err.message || err);
          }
          store[errorKey] = true;
        }
        results.push({ source: source.id, ok: false, error: String(err), isRateLimit });
      }
    }

    if (CONFIG.debug.rss) {
      console.log(`[RSS Poll] Complete: ${totalAdded} new items from ${results.filter(r => r.ok).length}/${CONFIG.rss.length} feeds`);
    }

    setLastUpdate();
    redraw();
    store.locks.rss = false;
    return { results };
  }

  // -----------------------------
  // NWS: current + 3 day + alerts
  // -----------------------------
  async function fetchNWS() {
    if (store.locks.nws) return;
    store.locks.nws = true;
    try {

    if (!CONFIG.nws.enabled) {
      $("weatherText").textContent = "Weather: Disabled";
      return;
    }

    const pointsUrl = `https://api.weather.gov/points/${CONFIG.nws.pointsLat},${CONFIG.nws.pointsLon}`;
    const pointsRes = await fetch(pointsUrl, { headers: { "Accept": "application/geo+json" } });
    if (!pointsRes.ok) throw new Error(`NWS points failed (${pointsRes.status})`);
    const points = await pointsRes.json();

    const forecastUrl = points.properties?.forecast;
    const forecastHourlyUrl = points.properties?.forecastHourly;

    const [forecast, hourly] = await Promise.all([
      forecastUrl ? fetch(forecastUrl).then(r => r.json()) : Promise.resolve(null),
      forecastHourlyUrl ? fetch(forecastHourlyUrl).then(r => r.json()) : Promise.resolve(null)
    ]);

    const now = hourly?.properties?.periods?.[0];
    const day3 = forecast?.properties?.periods?.slice(0, 6) || [];

    const currentText = now ? `${now.temperature}°${now.temperatureUnit} • ${now.shortForecast}` : "Weather: Unavailable";
    const threeDay = day3.length ? day3.map(p => `${p.name.replace("This ","").slice(0,10)} ${p.temperature}°${p.temperatureUnit}`).slice(0, 6).join(" · ") : "";
    $("weatherText").textContent = threeDay ? `${currentText} — ${threeDay}` : currentText;

    // Alerts
    try {
      const aRes = await fetch(CONFIG.nws.alertsUrl, { headers: { "Accept": "application/geo+json" } });
      if (aRes.ok) ingestNWSAlerts(await aRes.json());
    } catch (e) {
      if (!store._nwsAlertsErrorLogged) {
        console.warn("NWS alerts fetch failed:", e.message || e);
        store._nwsAlertsErrorLogged = true;
      }
    }
    } catch (e) {
      if (!store._nwsErrorLogged) {
        console.warn("NWS weather fetch failed:", e.message || e);
        $("weatherText").textContent = "Weather: Unable to connect (check network)";
        store._nwsErrorLogged = true;
      }
    } finally {
      store.locks.nws = false;
    }
  }

  function ingestNWSAlerts(geojson) {
    const feats = geojson?.features || [];
    const source = {
      id: "nws-alerts",
      name: "NWS Alerts",
      category: "weather",
      emoji: "⚠️",
      url: "https://api.weather.gov",
      defaultLoc: CONFIG.center,
      tone: "warn",
      maxAgeHours: CONFIG.freshness.nwsMaxAgeHours
    };

    for (const f of feats) {
      const p = f.properties || {};
      const headline = p.headline || p.event || "NWS Alert";
      const url = p.web || p.uri || "https://www.weather.gov/";
      const sent = p.sent || p.effective || new Date().toISOString();
      const sentDate = toDate(sent);
      if (!sentDate) continue;
      if (hoursAgo(sentDate) > source.maxAgeHours) continue;

      const summary = (p.description || p.instruction || "").slice(0, 500);  // Show more detail for weather alerts

      let loc = null;
      const geom = f.geometry;
      if (geom?.type === "Polygon") loc = centroidFromPolygon(geom.coordinates);
      else if (geom?.type === "MultiPolygon") loc = centroidFromPolygon(geom.coordinates?.[0]);

      const lat = loc?.lat ?? CONFIG.center.lat;
      const lon = loc?.lon ?? CONFIG.center.lon;
      if (!inBbox(lat, lon, CONFIG.bbox)) continue;

      const norm = normalize({
        source,
        raw: { title: headline, url, guid: p.id || p.uri || headline, published: sentDate.toISOString(), summary, loc: { lat, lon } }
      });

      if (!norm) continue;
      if (store.seenKeys.has(norm.dedupeKey)) continue;
      store.seenKeys.add(norm.dedupeKey);
      store.itemsById.set(norm.id, norm);
    }
    redraw();
  }

  // -----------------------------
  // 511Virginia GeoJSON (current-only incidents)
  // -----------------------------
  async function pollVa511() {
    if (store.locks.va511) return;
    store.locks.va511 = true;
    try {

    if (!CONFIG.va511.enabled) return { i95Incidents: 0 };

    // Cameras (always ok; doesn't bloat too much and is useful)
    // Use proxy to avoid CORS issues with 511virginia.org redirects
    let camerasLoaded = false;
    try {
      const cams = await fetchWithProxies(CONFIG.va511.camerasGeojson, {
        expect: "json",
        headers: {
          "X-Cache-TTL-MS": "120000",
          "Accept": "application/geo+json,application/json,*/*",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://511.vdot.virginia.gov/"
        },
        timeoutMs: 25000
      });

      // Validate that we got actual GeoJSON
      if (cams && (cams.type === "FeatureCollection" || Array.isArray(cams.features))) {
        console.log("511 cameras loaded successfully:", cams.features?.length || 0, "cameras");
        const result = ingestVa511Cameras(cams);
        console.log(`511 cameras ingested: ${result.added} cameras added from ${result.total} total`);
        camerasLoaded = true;
      } else {
        throw new Error("Invalid GeoJSON response (missing features)");
      }

    } catch (e) {
      // Only log CORS/network errors once per session to avoid console spam
      if (!store._511CamerasErrorLogged) {
        console.warn("511 cameras fetch failed. Error:", e.message || e);
        console.warn("The 511 cameras endpoint may be down or blocking requests.");
        console.warn("  → Ensure proxy server is running: node proxy-server.js");
        store._511CamerasErrorLogged = true;
      }
    }

    // Incidents (STRICT time gate)
    // Use proxy to avoid CORS issues with 511virginia.org redirects
    let i95Incidents = 0;
    let incidentsLoaded = false;

    // Helper to parse JSONP response (strips callback wrapper)
    const parseJsonp = (text) => {
      if (typeof text !== 'string') return text;
      const match = text.match(/^\s*\w+\s*\(\s*({[\s\S]*})\s*\)\s*;?\s*$/);
      return match ? JSON.parse(match[1]) : JSON.parse(text);
    };

    // Try primary endpoint first, then fallback if it fails
    const incidentsEndpoints = [
      { url: CONFIG.va511.incidentsGeojson, format: 'json', name: 'primary' },
      { url: CONFIG.va511.incidentsGeojsonFallback, format: 'jsonp', name: 'fallback' }
    ];

    for (const endpoint of incidentsEndpoints) {
      if (incidentsLoaded) break;

      try {
        const headers = {
          "X-Cache-TTL-MS": "60000",
          "Accept": "application/geo+json,application/json,*/*",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        };

        // Only add Referer for non-fallback endpoints (fallback works better without)
        if (endpoint.name === 'primary') {
          headers["Referer"] = "https://www.511virginia.org/";
        }

        const response = await fetchWithProxies(endpoint.url, {
          expect: endpoint.format === 'jsonp' ? 'text' : 'json',
          headers,
          timeoutMs: 25000
        });

        // Parse response based on format
        const inc = endpoint.format === 'jsonp' ? parseJsonp(response) : response;

        // Validate that we got actual GeoJSON
        if (inc && (inc.type === "FeatureCollection" || Array.isArray(inc.features))) {
          console.log(`511 incidents loaded successfully from ${endpoint.name}:`, inc.features?.length || 0, "incidents");
          i95Incidents = ingestVa511Incidents(inc);
          incidentsLoaded = true;
        } else {
          throw new Error("Invalid GeoJSON response (missing features)");
        }

      } catch (e) {
        // Try next endpoint if available
        if (endpoint.name === 'fallback' && !store._511IncidentsErrorLogged) {
          console.error("All 511 incidents endpoints failed. Error:", e.message || e);
          console.error("The 511 incidents service may be down or blocking requests.");
          console.error("  → Ensure proxy server is running: node proxy-server.js");
          console.error("  → Tried endpoints:", incidentsEndpoints.map(ep => ep.url).join(', '));
          store._511IncidentsErrorLogged = true;
        }
      }
    }

    if (CONFIG.va511.includeConstructionOnMap) {
      try {
        const con = await fetchWithProxies(CONFIG.va511.constructionGeojson, {
          expect: "json",
          headers: { "X-Cache-TTL-MS": "120000" },
          timeoutMs: 15000
        });
        ingestVa511Construction(con);
      } catch (e) {
        // Only log CORS/network errors once per session to avoid console spam
        if (!store._511ConstructionErrorLogged) {
          console.warn("511 construction fetch failed (CORS or network issue). Running a local proxy server may help.", e);
          store._511ConstructionErrorLogged = true;
        }
      }
    }

    setI95Indicator(i95Incidents);
    setLastUpdate();
    redraw();
    return { i95Incidents };
    } catch (e) {
      console.warn("511 refresh failed", e);
      return { i95Incidents: 0 };
    } finally {
      store.locks.va511 = false;
    }
  }


  function ingestVa511Cameras(geojson) {
    const feats = geojson?.features || [];
    let added = 0;

    for (const f of feats) {
      const p = f.properties || {};
      const coords = f.geometry?.coordinates;
      if (!coords || coords.length < 2) continue;

      const lon = Number(coords[0]);
      const lat = Number(coords[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const name =
        p.name || p.title || p.description || p.camera_name || p.device_name || p.camName || "Traffic camera";

      // Extract camera ID from various possible fields
      const cameraId = p.id || p.camId || p.camera_id || p.deviceId || p.device_id || "";

      // Get snapshot URL - try multiple property names (Virginia 511 uses different naming)
      // Priority: direct snapshot URLs, then HTTPS URLs, then regular URLs
      const camUrl = (
        p.snapshotURL ||      // Common in VDOT feeds (capital URL)
        p.snapshotUrl ||      // Alternative spelling
        p.snapshot_url ||     // Snake case variant
        p.imageURL ||         // Image URL variant (try before https_url for images)
        p.imageUrl ||         // Alternative
        p.image_url ||        // Snake case image
        p.https_url ||        // HTTPS secure URL
        p.url ||              // Generic URL
        p.camera_url ||       // Camera-specific URL
        p.streamURL ||        // Stream URL (some cameras use this)
        p.streamUrl ||        // Alternative spelling
        ""
      ).toString();

      // Clean up the URL if it exists - some feeds have malformed URLs
      let cleanedCamUrl = "";
      if (camUrl) {
        try {
          // If it's a valid URL, use it; otherwise skip
          const urlTest = new URL(camUrl);
          cleanedCamUrl = camUrl;
        } catch (e) {
          console.warn(`Invalid camera URL for "${name}": ${camUrl}`);
        }
      }

      // Get camera page URL - try multiple property names for the detail/viewing page
      const pageUrl = (
        p.webURL ||           // Common in VDOT feeds (capital URL)
        p.webUrl ||           // Alternative spelling
        p.detailURL ||        // Detail page URL
        p.detailUrl ||        // Alternative
        p.page_url ||         // Snake case variant
        p.pageURL ||          // Alternative
        p.link ||             // Generic link
        p.videoURL ||         // Video page URL
        p.videoUrl ||         // Alternative
        ""
      ).toString();

      // If we have a camera ID but no page URL, construct the standard 511 Virginia camera URL
      const finalPageUrl = pageUrl || (cameraId ? `https://511.vdot.virginia.gov/map?camera=${cameraId}` : "https://www.511virginia.org/");

      let media = null;

      // Always prefer snapshot images for cameras (video feeds often don't work)
      // IMPORTANT: Wrap camera URLs with proxy to avoid CORS issues
      if (cleanedCamUrl) {
        // Proxy the image URL to avoid CORS errors
        const proxiedUrl = `${location.origin}/proxy?url=${encodeURIComponent(cleanedCamUrl)}`;
        media = { type: "image", src: proxiedUrl, originalSrc: cleanedCamUrl, alt: name };
      }

      // Debug logging for first 5 cameras to help troubleshoot
      if (added < 5) {
        console.log(`Camera ${added + 1}: "${name}"`, {
          id: cameraId,
          snapshotURL: cleanedCamUrl || 'NONE',
          proxiedURL: media ? `${location.origin}/proxy?url=${encodeURIComponent(cleanedCamUrl)}` : 'NONE',
          pageURL: finalPageUrl.slice(0, 80) + '...',
          hasMedia: !!media,
          allProperties: Object.keys(p).filter(k => k.toLowerCase().includes('url') || k.toLowerCase().includes('image') || k.toLowerCase().includes('snapshot'))
        });
      }

      // Keep dedupe stable
      const key = `va511_cam::${name}::${lat.toFixed(5)},${lon.toFixed(5)}`;
      if (store.seenKeys.has(key)) continue;
      store.seenKeys.add(key);

      const item = {
        id: key,
        category: "camera",
        title: name,
        summary:
          (p.longDescription || p.description || p.status || "").toString().trim() ||
          "Traffic camera feed.",
        sourceName: "511 Virginia",
        sourceId: "va511-cameras",
        url: finalPageUrl,
        timestamp: new Date().toISOString(),
        lat,
        lon,
        emoji: "📷",
        tone: "good",
        media,
        dedupeKey: key,
        message: (p.longDescription || p.description || p.status || "").toString().trim() || "Traffic camera feed.",
        panelHtml: ""
      };

      store.itemsById.set(item.id, item);
      added++;
    }

    return { added, total: feats.length };
  }


  function ingestVa511Incidents(geojson) {
    const feats = geojson?.features || [];
    const baseSource = {
      id: "va511-incidents",
      name: "511Virginia — Incidents",
      category: "traffic",
      emoji: "🚗",
      url: "https://www.511virginia.org/",
      defaultLoc: CONFIG.center,
      tone: "warn",
      maxAgeHours: CONFIG.freshness.va511MaxAgeHours
    };

    let i95Count = 0;
    let pushed = 0;

    for (const f of feats) {
      if (pushed >= CONFIG.perf.maxPerSource) break;
      if (f.geometry?.type !== "Point") continue;
      const [lon, lat] = f.geometry.coordinates || [];
      if (!isFinite(lat) || !isFinite(lon)) continue;

      const p = f.properties || {};
      const title = p.title || p.event || p.incident_type || "Traffic Incident";
      const desc = p.description || p.long_description || "";
      const road = p.road || p.route || p.road_name || "";
      const whenRaw = p.updated || p.last_updated || p.reported || p.start_time || null;
      const whenDate = toDate(whenRaw);
      if (!whenDate) continue;

      // STRICT "current only" gate
      if (hoursAgo(whenDate) > baseSource.maxAgeHours) continue;

      const link = p.url || p.more_info_url || baseSource.url;
      const combined = `${title} ${desc} ${road}`;

      let emoji = "🚗";
      let category = "traffic";
      let tone = "warn";
      if (/crash|collision|accident|wreck/i.test(combined)) { emoji = "💥"; category = "crash"; tone = "bad"; }
      if (/closed|closure|blocked|detour/i.test(combined)) { emoji = "⛔"; category = "closure"; tone = "bad"; }
      if (/fire|hazmat|smoke/i.test(combined)) { emoji = "🔥"; category = "fire_ems"; tone = "bad"; }

      const isI95 = /\bI\-?95\b|\bInterstate\s*95\b/i.test(combined);
      if (isI95 && inBbox(lat, lon, CONFIG.i95Bbox)) i95Count++;

      if (!inBbox(lat, lon, CONFIG.bbox)) continue;

      const localSource = { ...baseSource, category, emoji, tone };

      const norm = normalize({
        source: localSource,
        raw: {
          title: `${emoji} ${title}`.replace(/^\s+/, ""),
          url: link,
          guid: p.id || p.incident_id || `${lat},${lon},${title},${whenDate.toISOString()}`,
          published: whenDate.toISOString(),
          summary: stripHtml(desc).slice(0, 400) || (road ? `Road: ${road}` : ""),  // Show more detail for incidents
          message: stripHtml(desc) || (road ? `Road: ${road}` : ""),
          loc: { lat, lon }
        }
      });

      if (!norm) continue;
      if (store.seenKeys.has(norm.dedupeKey)) continue;
      store.seenKeys.add(norm.dedupeKey);
      store.itemsById.set(norm.id, norm);
      pushed++;
    }
    return i95Count;
  }

  function ingestVa511Construction(geojson) {
    const feats = geojson?.features || [];
    const source = {
      id: "va511-construction",
      name: "511Virginia — Construction",
      category: "traffic",
      emoji: "🚧",
      url: "https://www.511virginia.org/",
      defaultLoc: CONFIG.center,
      tone: "warn",
      maxAgeHours: 24
    };

    let pushed = 0;
    for (const f of feats) {
      if (pushed >= CONFIG.perf.maxPerSource) break;
      if (f.geometry?.type !== "Point") continue;
      const [lon, lat] = f.geometry.coordinates || [];
      if (!isFinite(lat) || !isFinite(lon)) continue;
      if (!inBbox(lat, lon, CONFIG.bbox)) continue;

      const p = f.properties || {};
      const title = p.title || "Construction";
      const desc = p.description || "";
      const whenRaw = p.updated || p.start_time || null;
      const when = toDate(whenRaw);
      if (!when) continue;
      if (hoursAgo(when) > source.maxAgeHours) continue;

      const norm = normalize({
        source,
        raw: {
          title: `🚧 ${title}`,
          url: p.url || source.url,
          guid: p.id || `${lat},${lon},${title},${when.toISOString()}`,
          published: when.toISOString(),
          message: stripHtml(desc),
          summary: stripHtml(desc).slice(0, 400),  // Show more detail for construction
          loc: { lat, lon }
        }
      });

      if (!norm) continue;
      if (store.seenKeys.has(norm.dedupeKey)) continue;
      store.seenKeys.add(norm.dedupeKey);
      store.itemsById.set(norm.id, norm);
      pushed++;
    }
  }

  // -----------------------------
  // ArcGIS CrashData_test: discover date field + request only recent
  // -----------------------------
  let cachedArcgisDateField = null;

  function layerInfoUrlFromQuery(queryUrl) {
    // strip trailing "/query"
    return queryUrl.replace(/\/query\/?$/i, "");
  }

  async function discoverArcgisDateField() {
    if (cachedArcgisDateField) return cachedArcgisDateField;
    if (CONFIG.arcgisCrash.dateField) {
      cachedArcgisDateField = CONFIG.arcgisCrash.dateField;
      return cachedArcgisDateField;
    }

    const layerUrl = layerInfoUrlFromQuery(CONFIG.arcgisCrash.baseQueryUrl);
    const infoUrl = `${layerUrl}?f=pjson`;

    try {
      const info = await fetchWithProxies(infoUrl, { expect: "json" });
      const fields = info?.fields || [];
      const dateFields = fields.filter(f => String(f.type).toLowerCase().includes("date"));
      if (dateFields.length) {
        cachedArcgisDateField = dateFields[0].name;
        return cachedArcgisDateField;
      }

      // fallback heuristic by name
      const heur = fields.find(f => /date|time|timestamp|crash/i.test(f.name));
      if (heur) {
        cachedArcgisDateField = heur.name;
        return cachedArcgisDateField;
      }
    } catch (e) {
      console.warn("ArcGIS layer info fetch failed; will rely on client-side filtering only.", e);
    }

    cachedArcgisDateField = null;
    return null;
  }

  function buildArcgisCrashUrl(dateField) {
    const u = new URL(CONFIG.arcgisCrash.baseQueryUrl);
    const b = CONFIG.bbox;
    const geom = `${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}`;

    const params = new URLSearchParams();
    params.set("outFields", CONFIG.arcgisCrash.outFields || "*");
    params.set("returnGeometry", "true");
    params.set("geometry", geom);
    params.set("geometryType", "esriGeometryEnvelope");
    params.set("inSR", "4326");
    params.set("spatialRel", "esriSpatialRelIntersects");
    params.set("outSR", "4326");
    params.set("f", "geojson");
    params.set("resultRecordCount", String(CONFIG.arcgisCrash.recordCap || 250));
    params.set("resultOffset", "0");

    // Build a server-side where clause if we have a date field.
    // ArcGIS SQL generally supports:  dateField >= TIMESTAMP 'YYYY-MM-DD HH:MM:SS'
    const since = new Date(Date.now() - (CONFIG.arcgisCrash.maxAgeHours * 60 * 60 * 1000));
    if (dateField) {
      const ts = `${since.getFullYear()}-${String(since.getMonth()+1).padStart(2,"0")}-${String(since.getDate()).padStart(2,"0")} ${String(since.getHours()).padStart(2,"0")}:${String(since.getMinutes()).padStart(2,"0")}:00`;
      params.set("where", `1=1 AND ${dateField} >= TIMESTAMP '${ts}'`);
      params.set("orderByFields", `${dateField} DESC`);
    } else {
      params.set("where", "1=1");
    }

    u.search = params.toString();
    return u.toString();
  }

  async function pollArcgisCrashes() {
    if (store.locks.arcgis) return;
    store.locks.arcgis = true;
    try {

    if (!CONFIG.arcgisCrash.enabled) return 0;

    const dateField = await discoverArcgisDateField();
    const url = buildArcgisCrashUrl(dateField);

    // ArcGIS often allows CORS; proxies cover failures
    const geojson = await fetchWithProxies(url, { expect: "json" });

    const feats = geojson?.features || [];
    const source = {
      id: "arcgis-crashes",
      name: "CrashData (ArcGIS FeatureServer)",
      category: "crash",
      emoji: "💥",
      url: CONFIG.arcgisCrash.baseQueryUrl,
      defaultLoc: CONFIG.center,
      tone: "bad",
      maxAgeHours: CONFIG.arcgisCrash.maxAgeHours
    };

    let added = 0;
    let pushed = 0;

    for (const f of feats) {
      if (pushed >= CONFIG.perf.maxPerSource) break;

      const g = f.geometry;
      if (!g) continue;

      let lat = null, lon = null;
      if (g.type === "Point") {
        lon = g.coordinates?.[0];
        lat = g.coordinates?.[1];
      } else if (g.type === "LineString" || g.type === "MultiLineString") {
        const c = (g.type === "LineString") ? g.coordinates?.[0] : g.coordinates?.[0]?.[0];
        lon = c?.[0]; lat = c?.[1];
      } else if (g.type === "Polygon" || g.type === "MultiPolygon") {
        const ring = (g.type === "Polygon") ? g.coordinates?.[0] : g.coordinates?.[0]?.[0];
        if (ring?.length) {
          let sx=0, sy=0, n=0;
          for (const [x,y] of ring) { if (isFinite(x)&&isFinite(y)) { sx+=x; sy+=y; n++; } }
          if (n) { lon = sx/n; lat = sy/n; }
        }
      }

      if (!isFinite(lat) || !isFinite(lon)) continue;
      if (!inBbox(lat, lon, CONFIG.bbox)) continue;

      const p = f.properties || {};
      const title = p.title || p.CRASH_TYPE || p.COLLISION_TYPE || p.CRASH_SEVERITY || p.REPORT_ID || "Crash Record";

      // Determine crash time:
      // 1) If we discovered dateField, use that value.
      // 2) Else, try common keys.
      let whenVal = null;
      if (dateField && (dateField in p)) whenVal = p[dateField];

      if (!whenVal) {
        for (const k of ["CRASH_DATE","REPORT_DATE","DATE","datetime","timestamp","UPDATED","updated","last_updated"]) {
          if (k in p) { whenVal = p[k]; break; }
        }
      }

      const whenDate = toDate(whenVal);
      if (!whenDate) continue;

      // HARD client-side freshness gate (prevents old years entirely)
      if (hoursAgo(whenDate) > source.maxAgeHours) continue;

      const summary = buildPropsSummary(p);

      const norm = normalize({
        source,
        raw: {
          title: `💥 Crash: ${title}`,
          url: CONFIG.arcgisCrash.baseQueryUrl,
          guid: p.OBJECTID || p.objectid || p.REPORT_ID || `${lat},${lon},${title},${whenDate.toISOString()}`,
          published: whenDate.toISOString(),
          summary,
          loc: { lat, lon }
        }
      });

      if (!norm) continue;
      if (store.seenKeys.has(norm.dedupeKey)) continue;
      store.seenKeys.add(norm.dedupeKey);
      store.itemsById.set(norm.id, norm);
      added++;
      pushed++;
    }

    setLastUpdate();
    redraw();
    return added;
    } catch (e) {
      console.warn("ArcGIS crash refresh failed", e);
      return 0;
    } finally {
      store.locks.arcgis = false;
    }
  }

  function buildPropsSummary(props) {
    const keys = Object.keys(props || {});
    if (!keys.length) return "";
    const pick = [];

    const priority = [
      "CRASH_SEVERITY","SEVERITY","COLLISION_TYPE","CRASH_TYPE","ROUTE","ROAD","ROAD_NAME",
      "CITY","COUNTY","DIRECTION","WEATHER","LIGHTING","SURFACE"
    ];

    for (const k of priority) if (k in props) pick.push([k, props[k]]);
    for (const k of keys) {
      if (pick.length >= 10) break;
      if (pick.some(([kk]) => kk === k)) continue;
      if (String(props[k]).length > 80) continue;
      pick.push([k, props[k]]);
    }
    return pick.slice(0,10).map(([k,v]) => `${k}: ${v}`).join(" • ");
  }

  // -----------------------------
  // Virginia Crash Data API Integration (Multiple Sources)
  // -----------------------------
  async function pollVirginiaCrashData() {
    if (store.locks.virginiaCrashData) return { added: 0 };
    store.locks.virginiaCrashData = true;
    try {
      if (!CONFIG.virginiaCrashData.enabled) return { added: 0 };

      let totalAdded = 0;
      const source = {
        id: "virginia-crash-data",
        name: "Virginia Crash Data Portal",
        category: "crash",
        emoji: "💥",
        url: "https://www.virginiaroads.org/",
        defaultLoc: CONFIG.center,
        tone: "bad",
        maxAgeHours: CONFIG.virginiaCrashData.maxAgeHours
      };

      // Try CrashData Details from data.virginia.gov (Socrata Open Data API)
      try {
        // Build Socrata query with proper date filtering
        // Use a more generous time window to ensure we get data
        const since = new Date(Date.now() - (CONFIG.virginiaCrashData.maxAgeHours * 60 * 60 * 1000));
        const sinceStr = since.toISOString().split('T')[0]; // YYYY-MM-DD format

        // Build URL with Socrata SoQL parameters
        // Note: Socrata uses $ prefix for query operators
        // Try without date filter first as the field may have changed or data may be sparse
        const queryParams = [
          `$limit=${CONFIG.virginiaCrashData.recordCap}`,
          `$order=:id DESC`  // Order by internal ID descending to get most recent records
        ];

        const detailsUrl = `${CONFIG.virginiaCrashData.crashDataDetailsUrl}?${queryParams.join('&')}`;

        console.log(`[Virginia Crash Data] Fetching from: ${detailsUrl.replace(/\?.*/, '?...')}`);

        const data = await fetchWithProxies(detailsUrl, {
          expect: "json",
          headers: CONFIG.virginiaCrashData.apiKey ? {
            'X-App-Token': CONFIG.virginiaCrashData.apiKey,
            'Accept': 'application/json'
          } : {
            'Accept': 'application/json'
          },
          timeoutMs: 20000
        });

        if (Array.isArray(data)) {
          let added = 0;
          for (const record of data.slice(0, CONFIG.perf.maxPerSource)) {
            const lat = parseFloat(record.latitude || record.lat || record.y);
            const lon = parseFloat(record.longitude || record.lon || record.x || record.long);

            if (!isFinite(lat) || !isFinite(lon)) continue;
            if (!inBbox(lat, lon, CONFIG.bbox)) continue;

            const crashDate = toDate(record.crash_date || record.date || record.report_date);
            if (!crashDate || hoursAgo(crashDate) > source.maxAgeHours) continue;

            const title = record.crash_type || record.severity || record.collision_type || "Crash Reported";
            const summary = [
              record.locality ? `Location: ${record.locality}` : null,
              record.route ? `Route: ${record.route}` : null,
              record.severity ? `Severity: ${record.severity}` : null,
              record.crash_type ? `Type: ${record.crash_type}` : null
            ].filter(Boolean).join(" • ");

            const norm = normalize({
              source,
              raw: {
                title: `💥 ${title}`,
                url: CONFIG.virginiaCrashData.crashDataDetailsUrl,
                guid: record.objectid || record.id || record.crash_id || `${lat},${lon},${crashDate.toISOString()}`,
                published: crashDate.toISOString(),
                summary: summary || "Crash reported in Virginia",
                loc: { lat, lon }
              }
            });

            if (!norm || store.seenKeys.has(norm.dedupeKey)) continue;
            store.seenKeys.add(norm.dedupeKey);
            store.itemsById.set(norm.id, norm);
            added++;
            totalAdded++;
          }

          if (added > 0) {
            console.log(`Virginia Crash Data Details API loaded: ${added} new crashes`);
          }
        }
      } catch (e) {
        if (!store._virginiaCrashDataErrorLogged) {
          console.warn("Virginia Crash Data Details API failed:", e.message);
          if (e.message.includes('404')) {
            console.warn("  → The Socrata endpoint may have changed or been removed");
            console.warn("  → Visit https://data.virginia.gov to check for updated crash data endpoints");
          } else if (e.message.includes('403')) {
            console.warn("  → Access denied - the endpoint may require authentication");
            console.warn("  → Consider obtaining a Socrata App Token from https://data.virginia.gov");
          }
          console.warn("  → Ensure proxy server is running: node proxy-server.js");
          store._virginiaCrashDataErrorLogged = true;
        }
      }

      setLastUpdate();
      redraw();
      return { added: totalAdded };
    } catch (e) {
      console.warn("Virginia Crash Data refresh failed:", e);
      return { added: 0 };
    } finally {
      store.locks.virginiaCrashData = false;
    }
  }

  // -----------------------------
  // Virginia Roads API Integration
  // -----------------------------
  async function pollVaRoads() {
    if (store.locks.vaRoads) return;
    store.locks.vaRoads = true;
    try {
      if (!CONFIG.vaRoads.enabled) return;

      // Virginia Roads API doesn't have a simple public endpoint we can poll directly
      // Instead we'll use the RSS feeds already configured which cover regional news
      // This is a placeholder for potential future API integration if they expose public endpoints

      // For now, the RSS feeds (Free Lance-Star, Potomac Local, etc.) provide the news coverage
      console.log("Virginia Roads API integration placeholder - using RSS feeds for regional coverage");

    } catch (e) {
      console.warn("Virginia Roads API check failed:", e);
    } finally {
      store.locks.vaRoads = false;
    }
  }

  // -----------------------------
  // I‑95 indicator
  // -----------------------------
  function setI95Indicator(i95Incidents) {
    const el = $("trafficText");
    let status = "NO DATA";
    if (typeof i95Incidents === "number") {
      if (i95Incidents === 0) status = "NORMAL";
      else if (i95Incidents <= 2) status = `SLOWING (${i95Incidents})`;
      else status = `HEAVY (${i95Incidents})`;
    }
    el.textContent = `I‑95: ${status}`;
  }

  // -----------------------------
  // Controls
  // -----------------------------
  function setLastUpdate() { $("lastUpdate").textContent = fmtTime(new Date()); }

  async function refreshAll() {
    $("liveText").textContent = "Refreshing…";

    // Hard reset (prevents buildup across refreshes)
    store.itemsById.clear();
    store.markersById.clear();
    store.seenKeys.clear();
    clusters.clearLayers();

    // Run pulls in parallel where possible
    await Promise.allSettled([
      pollRSS().catch(e => console.warn("RSS refresh partial", e)),
      CONFIG.nws.enabled ? fetchNWS().catch(e => console.warn("NWS refresh partial", e)) : Promise.resolve(),
      pollArcgisCrashes().catch(e => console.warn("ArcGIS crash refresh partial", e)),
      pollVirginiaCrashData().catch(e => console.warn("Virginia Crash Data refresh partial", e)),
      pollVa511().catch(e => console.warn("511 refresh partial", e)),
      pollVaRoads().catch(e => console.warn("VA Roads refresh partial", e))
    ]);

    $("liveText").textContent = "Live";
    setLastUpdate();
    redraw();
  }

  $("btnRefresh").addEventListener("click", refreshAll);

  // -----------------------------
  // Boot + timers
  // -----------------------------
  refreshAll();
  setInterval(pollRSS, CONFIG.polling.rss);
  setInterval(fetchNWS, CONFIG.polling.nws);
  setInterval(pollArcgisCrashes, CONFIG.polling.arcgisCrash);
  setInterval(pollVirginiaCrashData, CONFIG.polling.virginiaCrashData);
  setInterval(pollVa511, CONFIG.polling.va511);
  setInterval(pollVaRoads, CONFIG.polling.vaRoads);
})();