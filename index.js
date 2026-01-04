// CITY MANAGER — FXBG-PALANTIR toolkit (v16)
// v16 changes: Fixed 403 proxy errors and restored Virginia Crash Data
// Key changes:
// - Fixed proxy to handle 403 Forbidden errors with stale cache (for CDC and other APIs)
// - Restored Virginia Crash Data API integration (data.virginia.gov Socrata endpoint)
// - Virginia Crash Data enabled with 48-hour window, loads after RSS feeds
// - Proxy now gracefully handles 403/429/5xx errors by serving cached data
// - All crash data populates map markers and footer category panel
// - Enhanced 511 Virginia camera locations with better error handling
// - All popup panels are draggable and moveable
// - Fixed RSS feed footer buttons - show actual feed items with better fallbacks
// - Improved crash data ingestion from multiple Virginia sources
// - Better error messages and console logging for debugging
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
      crashesMaxAgeHours: 48,  // crashes: last 48 hours (loads after RSS and other APIs)
      nwsMaxAgeHours: 24,
      uiListMaxAgeHours: 168   // footer panel list: match RSS max age to show all map items (7 days)
    },

    // Performance caps
    perf: {
      maxTotalItems: 650,      // hard cap for speed (newest kept)
      maxPerSource: 180        // per source cap to avoid floods
    },

    // Polling (milliseconds)
    polling: {
      rss: 20 * 60 * 1000,         // RSS feeds update every 20 minutes (15-30 minute range)
      nws: 2 * 60 * 1000,
      arcgisCrash: 5 * 60 * 1000,
      virginiaCrashData: 4 * 60 * 1000,
      va511: 2 * 60 * 1000,
      openUV: 30 * 60 * 1000,      // UV data updates every 30 minutes
      cdc: 24 * 60 * 60 * 1000     // CDC data updates daily
    },

    // Round 3: Load shedding + adaptive polling (reliability improvements)
    reliability: {
      // Per-refresh cycle budgets (prevent request storms)
      maxRequestsPerCycle: 20,      // Max network requests in single refreshAll cycle
      maxTimePerCycleMs: 20000,     // Max time budget for refresh cycle (20s)

      // Adaptive backoff per source
      backoffMinMs: 2 * 60 * 1000,   // Start at 2 minutes
      backoffMaxMs: 20 * 60 * 1000,  // Cap at 20 minutes
      backoffMultiplier: 2,           // Exponential multiplier (2x)
      maxBackoffEntries: 100,         // Cap Map size to prevent leaks

      // Degraded mode thresholds
      degradedModeFailureThreshold: 3,  // If 3+ sources fail, enter degraded mode
      degradedModeSkipClustering: true, // Skip expensive cluster rebuild in degraded mode
      degradedModeSkipListRender: true, // Skip expensive list re-renders in degraded mode

      // Near-duplicate suppression (for 511 + ArcGIS)
      dedupeTimeWindowMs: 10 * 60 * 1000,  // 10-minute window for near-duplicates
      dedupeDistanceThresholdM: 50,         // Same location if within 50 meters

      // Pruning intervals (memory leak prevention)
      pruneIntervalMs: 10 * 60 * 1000,      // Prune old state every 10 minutes
      geocodeCacheTTLMs: 7 * 24 * 60 * 60 * 1000, // Geocode cache: 7 days
      clientCacheTTLMs: 30 * 60 * 1000,     // Client response cache: 30 minutes

      // Simulated failure mode (dev/testing only - DO NOT ENABLE IN PRODUCTION)
      simulateFailure: {
        enabled: false,              // MUST be false in production
        targetSource: null,          // e.g., 'rss', 'va511', 'arcgisCrash', etc.
        failureType: '429'           // '429', 'timeout', '500', etc.
      }
    },

    // CORS proxy rotation (browser-only)
    corsProxies: [],

    // Debug flags
    debug: {
      rss: true  // Enable RSS feed ingestion debug logging
    },

    // RSS sources (each has maxAgeHours to enforce "current only")
    // NOTE: Many .gov RSS feeds (fredericksburgva.gov, spotsylvania.va.us) are currently
    // returning empty responses (0 bytes) or blocking automated requests with 403 Forbidden
    // (x-deny-reason: host_not_allowed). This appears to be an anti-scraping measure.
    // The proxy server will cache the last successful response and use stale data when
    // fresh fetches fail. Check console for WARNING messages about empty/blocked feeds.
    rss: [
      // ---------------- FXBG ----------------
      // NOTE: fredericksburgva.gov RSS feeds are currently blocking automated requests
      // returning 403 Forbidden with "x-deny-reason: host_not_allowed"
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
      {
        id: "fxbg-police-news",
        name: "Fredericksburg — Police News & Updates",
        type: "rss",
        category: "police_crime",
        jurisdiction: "Fredericksburg",
        url: "https://www.fredericksburgva.gov/RSSFeed.aspx?ModID=63&CID=Police-9",
        emoji: "🚓",
        tone: "warn",
        defaultLoc: { lat: 38.3032, lon: -77.4605 },  // City Hall / Police HQ area
        maxAgeHours: 168,
      },
      {
        id: "fxbg-courts-info",
        name: "Fredericksburg — Courts Information",
        type: "rss",
        category: "legal_courts",
        jurisdiction: "Fredericksburg",
        url: "https://www.fredericksburgva.gov/RSSFeed.aspx?ModID=63&CID=Courts-Information-7",
        emoji: "⚖️",
        tone: "good",
        defaultLoc: { lat: 38.3015, lon: -77.4596 },  // Courthouse area
        maxAgeHours: 168,
      },
      {
        id: "fxbg-city-council",
        name: "Fredericksburg — City Council Meetings & Agendas",
        type: "rss",
        category: "government",
        jurisdiction: "Fredericksburg",
        url: "https://www.fredericksburgva.gov/RSSFeed.aspx?ModID=65&CID=City-Council-1",
        emoji: "🏛️",
        tone: "good",
        defaultLoc: { lat: 38.3032, lon: -77.4605 },  // City Hall
        maxAgeHours: 168,
      },
      {
        id: "fxbg-eda",
        name: "Fredericksburg — Economic Development Authority",
        type: "rss",
        category: "government",
        jurisdiction: "Fredericksburg",
        url: "https://www.fredericksburgva.gov/RSSFeed.aspx?ModID=65&CID=Economic-Development-Authority-17",
        emoji: "💼",
        tone: "good",
        defaultLoc: { lat: 38.3032, lon: -77.4605 },  // City Hall / EDA offices
        maxAgeHours: 168,
      },
      {
        id: "fxbg-riverfront",
        name: "Fredericksburg — Riverfront Task Force",
        type: "rss",
        category: "government",
        jurisdiction: "Fredericksburg",
        url: "https://www.fredericksburgva.gov/RSSFeed.aspx?ModID=65&CID=Riverfront-Task-Force-12",
        emoji: "🌊",
        tone: "good",
        defaultLoc: { lat: 38.2985, lon: -77.4689 },  // Riverfront area
        maxAgeHours: 168,
      },
      {
        id: "fxbg-towing-board",
        name: "Fredericksburg — Towing and Recovery Board",
        type: "rss",
        category: "government",
        jurisdiction: "Fredericksburg",
        url: "https://www.fredericksburgva.gov/RSSFeed.aspx?ModID=65&CID=Towing-and-Recovery-Board-13",
        emoji: "🚛",
        tone: "good",
        defaultLoc: { lat: 38.3032, lon: -77.4605 },
        maxAgeHours: 168,
      },
      {
        id: "fxbg-emergency-alerts-mod63",
        name: "Fredericksburg — Emergency Alerts (Public Safety)",
        type: "rss",
        category: "alerts",
        jurisdiction: "Fredericksburg",
        url: "https://www.fredericksburgva.gov/RSSFeed.aspx?ModID=63&CID=Emergency-Alerts-5",
        emoji: "🚨",
        tone: "bad",
        defaultLoc: { lat: 38.3032, lon: -77.4605 },
        maxAgeHours: 168,
      },
      {
        id: "fxbg-info-alerts",
        name: "Fredericksburg — Information Alerts",
        type: "rss",
        category: "alerts",
        jurisdiction: "Fredericksburg",
        url: "https://www.fredericksburgva.gov/RSSFeed.aspx?ModID=63&CID=Information-Alerts-6",
        emoji: "ℹ️",
        tone: "warn",
        defaultLoc: { lat: 38.3032, lon: -77.4605 },
        maxAgeHours: 168,
      },
      {
        id: "fxbg-fire-dept",
        name: "Fredericksburg — Fire Department News",
        type: "rss",
        category: "fire_ems",
        jurisdiction: "Fredericksburg",
        url: "https://www.fredericksburgva.gov/RSSFeed.aspx?ModID=58&CID=Fire-Department-24",
        emoji: "🔥",
        tone: "warn",
        defaultLoc: { lat: 38.3032, lon: -77.4605 },  // Fire Station area
        maxAgeHours: 168,
      },
      {
        id: "fxbg-fred-transit",
        name: "Fredericksburg — FRED Regional Transit Updates",
        type: "rss",
        category: "traffic_transit",
        jurisdiction: "Fredericksburg",
        url: "https://www.fredericksburgva.gov/RSSFeed.aspx?ModID=58&CID=FRED-Regional-Transit-29",
        emoji: "🚌",
        tone: "good",
        defaultLoc: { lat: 38.3032, lon: -77.4605 },  // Transit hub area
        maxAgeHours: 168,
      },
      {
        id: "fxbg-safety",
        name: "Fredericksburg — Public Safety Information",
        type: "rss",
        category: "alerts",
        jurisdiction: "Fredericksburg",
        url: "https://www.fredericksburgva.gov/RSSFeed.aspx?ModID=58&CID=Safety-37",
        emoji: "🦺",
        tone: "warn",
        defaultLoc: { lat: 38.3032, lon: -77.4605 },
        maxAgeHours: 168,
      },
      {
        id: "fxbg-transit-service",
        name: "Fredericksburg — Transit Service Updates",
        type: "rss",
        category: "traffic_transit",
        jurisdiction: "Fredericksburg",
        url: "https://www.fredericksburgva.gov/RSSFeed.aspx?ModID=58&CID=Transit-52",
        emoji: "🚍",
        tone: "good",
        defaultLoc: { lat: 38.3032, lon: -77.4605 },
        maxAgeHours: 168,
      },

      // ------------- SPOTSY -------------
      // NOTE: spotsylvania.va.us RSS feeds are currently blocking automated requests
      // returning 403 Forbidden with "x-deny-reason: host_not_allowed"
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
      {
        id: "spotsy-emergency-alerts-mod63",
        name: "Spotsylvania — Emergency Alerts (Public Safety Module)",
        type: "rss",
        category: "alerts",
        jurisdiction: "Spotsylvania",
        url: "https://www.spotsylvania.va.us/RSSFeed.aspx?ModID=63&CID=Emergency-Alerts-6",
        emoji: "🚨",
        tone: "bad",
        defaultLoc: { lat: 38.1859, lon: -77.6526 },
        maxAgeHours: 168,
      },
      {
        id: "spotsy-fire-rescue-mod1",
        name: "Spotsylvania — Fire Rescue & Emergency Management (News Flash)",
        type: "rss",
        category: "fire_ems",
        jurisdiction: "Spotsylvania",
        url: "https://www.spotsylvania.va.us/RSSFeed.aspx?ModID=1&CID=FIRE-RESCUE-EMERGENCY-MGT-30",
        emoji: "🚒",
        tone: "warn",
        defaultLoc: { lat: 38.1859, lon: -77.6526 },
        maxAgeHours: 168,
      },
      {
        id: "spotsy-notices-mod63",
        name: "Spotsylvania — Notices (Public Safety Module)",
        type: "rss",
        category: "alerts",
        jurisdiction: "Spotsylvania",
        url: "https://www.spotsylvania.va.us/RSSFeed.aspx?ModID=63&CID=Notices-7",
        emoji: "📢",
        tone: "warn",
        defaultLoc: { lat: 38.1859, lon: -77.6526 },
        maxAgeHours: 168,
      },

      // ---------- CAROLINE COUNTY ----------
      {
        id: "caroline-all-alerts",
        name: "Caroline County — All Alerts & News",
        type: "rss",
        category: "alerts",
        jurisdiction: "Caroline",
        url: "https://co.caroline.va.us/RSSFeed.aspx?ModID=63&CID=All-0",
        emoji: "📰",
        tone: "warn",
        defaultLoc: { lat: 38.0527, lon: -77.2697 },
        maxAgeHours: 168,
      },
      {
        id: "caroline-calendar",
        name: "Caroline County — Events Calendar",
        type: "rss",
        category: "events",
        jurisdiction: "Caroline",
        url: "https://co.caroline.va.us/RSSFeed.aspx?ModID=58&CID=All-calendar.xml",
        emoji: "📅",
        tone: "good",
        defaultLoc: { lat: 38.0527, lon: -77.2697 },
        maxAgeHours: 168,
      },
      {
        id: "caroline-newsflash",
        name: "Caroline County — News Flash",
        type: "rss",
        category: "news",
        jurisdiction: "Caroline",
        url: "https://co.caroline.va.us/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml",
        emoji: "📰",
        tone: "good",
        defaultLoc: { lat: 38.0527, lon: -77.2697 },
        maxAgeHours: 168,
      },

      // ---------- WARRENTON (FAUQUIER) ----------
      {
        id: "warrenton-all-alerts",
        name: "Warrenton — All Alerts & News",
        type: "rss",
        category: "alerts",
        jurisdiction: "Warrenton",
        url: "https://www.warrentonva.gov/RSSFeed.aspx?ModID=63&CID=All-0",
        emoji: "📰",
        tone: "warn",
        defaultLoc: { lat: 38.7134, lon: -77.7953 },
        maxAgeHours: 168,
      },
      {
        id: "warrenton-calendar",
        name: "Warrenton — Events Calendar",
        type: "rss",
        category: "events",
        jurisdiction: "Warrenton",
        url: "https://www.warrentonva.gov/RSSFeed.aspx?ModID=58&CID=All-calendar.xml",
        emoji: "📅",
        tone: "good",
        defaultLoc: { lat: 38.7134, lon: -77.7953 },
        maxAgeHours: 168,
      },
      {
        id: "warrenton-newsflash",
        name: "Warrenton — News Flash",
        type: "rss",
        category: "news",
        jurisdiction: "Warrenton",
        url: "https://www.warrentonva.gov/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml",
        emoji: "📰",
        tone: "good",
        defaultLoc: { lat: 38.7134, lon: -77.7953 },
        maxAgeHours: 168,
      },

      // ---------- REGIONAL / MEDIA ----------
      {
        id: "potomac-local-fxbg",
        name: "Potomac Local — Fredericksburg News",
        type: "rss",
        category: "news",
        jurisdiction: "Regional",
        url: "http://www.potomaclocal.com/fredericksburg/feed/",
        emoji: "📰",
        tone: "good",
        defaultLoc: { lat: 38.3032, lon: -77.4605 },
        maxAgeHours: 168,
      },
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
      // limit to last 48 hours (matches crashesMaxAgeHours) - loads after RSS and other APIs
      maxAgeHours: 48,
      // cap how many records we ask for
      recordCap: 250
    },

    // Virginia Crash Data APIs (multiple sources for comprehensive coverage)
    virginiaCrashData: {
      // DISABLED: Socrata endpoint (e9fd3f45-7f33-424b-b472-b531043fa02a) returns 404 - dataset removed/changed
      // Use arcgisCrash endpoint instead, which provides the same crash data and is working
      enabled: false,
      // CrashData Basic API from Virginia Roads Open Data Portal
      crashDataBasicUrl: "https://www.virginiaroads.org/datasets/crashdata-basic-1/api",
      // CrashData Details from data.virginia.gov (Socrata Open Data)
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
      // Camera endpoints with fallbacks (new VDOT endpoint uses vdotcameras.com for snapshots)
      camerasGeojson: "https://511.vdot.virginia.gov/services/map/layers/map/cams",
      // OLD fallback (deprecated - old icons.cameras.geojson endpoint no longer active):
      // camerasGeojsonFallback: "http://www.511virginia.org/data/icons.cameras.geojson",
      camerasGeojsonFallback: "http://files4.iteriscdn.com/WebApps/VA/SafeTravel/data/local/icons/metadata/icons.cameras_inactive.geojsonp",
      camerasGeojsonFallback2: "",
      // Primary incidents endpoint - may return HTML error pages during outages
      incidentsGeojson: "https://www.511virginia.org/data/geojson/icons.incident.geojson",
      // Fallback to Iteris CDN if main endpoint fails (JSONP format - auto-stripped)
      incidentsGeojsonFallback: "http://files5.iteriscdn.com/WebApps/VA/SafeTravel/data/local/icons/metadata/icons.incident.geojsonp",
      constructionGeojson: "https://www.511virginia.org/data/geojson/icons.construction.geojson",
      includeConstructionOnMap: false
    },


    // OpenUV API - UV Index data for Fredericksburg area
    openUV: {
      enabled: true,
      apiKey: "openuv-42jtmrmjxewbj3-io",  // OpenUV API key
      lat: 38.3032,
      lon: -77.4605,
      baseUrl: "https://api.openuv.io/api/v1/uv"
    },

    // CDC Data API - Health/disease surveillance data
    cdc: {
      enabled: true,
      // CDC Wonder API - locality-specific health data
      wonderApiUrl: "https://data.cdc.gov/api/v3/views/psx4-wq38/query.json",
      maxAgeHours: 168  // Cache for 7 days
    }
  };

  // -----------------------------
  // Proxy Base Configuration (USB Tether Support)
  // -----------------------------
  /**
   * Normalize proxy base URL: remove trailing slash
   */
  function normalizeProxyBase(s) {
    if (typeof s !== 'string' || !s) return '';
    return s.replace(/\/+$/, '');
  }

  /**
   * Get default proxy base URL
   * - If served over http(s): use location.origin (existing behavior)
   * - If opened via file:// or origin is "null": default to http://localhost:8000
   */
  function defaultProxyBase() {
    if (location.protocol === 'file:' || location.origin === 'null') {
      return 'http://localhost:8000';
    }
    return location.origin;
  }

  /**
   * Get current proxy base URL with priority order:
   * 1. URL param: ?proxyBase=... or ?proxy=...
   * 2. localStorage: cm_proxy_base
   * 3. Default: location.origin or http://localhost:8000 (for file://)
   */
  function getProxyBase() {
    try {
      // Priority 1: URL param
      const urlParams = new URLSearchParams(location.search);
      const paramBase = urlParams.get('proxyBase') || urlParams.get('proxy');
      if (paramBase) {
        return normalizeProxyBase(paramBase);
      }

      // Priority 2: localStorage
      const storedBase = localStorage.getItem('cm_proxy_base');
      if (storedBase) {
        return normalizeProxyBase(storedBase);
      }

      // Priority 3: Default
      return normalizeProxyBase(defaultProxyBase());
    } catch (e) {
      console.warn('[Proxy] Failed to get proxy base:', e);
      return normalizeProxyBase(defaultProxyBase());
    }
  }

  /**
   * Set proxy base URL (stores to localStorage and reloads page)
   * @param {string} valueOrBlank - New proxy base URL, or blank/null to reset to default
   */
  function setProxyBase(valueOrBlank) {
    try {
      if (!valueOrBlank || typeof valueOrBlank !== 'string' || valueOrBlank.trim() === '') {
        // Clear override - revert to default
        localStorage.removeItem('cm_proxy_base');
        console.log('[Proxy] Cleared custom proxy base, reverting to default');
      } else {
        // Store override
        const normalized = normalizeProxyBase(valueOrBlank.trim());
        localStorage.setItem('cm_proxy_base', normalized);
        console.log('[Proxy] Set custom proxy base:', normalized);
      }
      // Reload to apply changes
      location.reload();
    } catch (e) {
      console.error('[Proxy] Failed to set proxy base:', e);
      alert('Failed to update proxy settings: ' + e.message);
    }
  }

  // Auto-persist URL param to localStorage on load
  (() => {
    try {
      const urlParams = new URLSearchParams(location.search);
      const paramBase = urlParams.get('proxyBase') || urlParams.get('proxy');
      if (paramBase) {
        const normalized = normalizeProxyBase(paramBase);
        localStorage.setItem('cm_proxy_base', normalized);
        console.log('[Proxy] Auto-persisted URL param proxy base to localStorage:', normalized);
      }
    } catch (e) {
      console.warn('[Proxy] Failed to persist URL param:', e);
    }
  })();

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
    government:               { label: "Government / Meetings", emoji: "🏛️" },
    legal_courts:             { label: "Legal / Courts", emoji: "⚖️" },
    health:                   { label: "Health / Safety", emoji: "🏥" },
    uv_index:                 { label: "UV Index", emoji: "☀️" },
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

  // Sound effects system using Web Audio API
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();

  function playClickSound(type = 'default') {
    try {
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      // Different sounds for different button types
      if (type === 'close') {
        oscillator.frequency.value = 400;
        gainNode.gain.setValueAtTime(0.08, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.15);
      } else if (type === 'open') {
        oscillator.frequency.value = 600;
        gainNode.gain.setValueAtTime(0.08, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.15);
      } else {
        // Default click
        oscillator.frequency.value = 500;
        gainNode.gain.setValueAtTime(0.06, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);
      }

      oscillator.type = 'sine';
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.15);
    } catch (e) {
      // Silently fail if audio context is not available
      console.debug('Audio playback not available:', e);
    }
  }

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

  /**
   * Client-side response cache to prevent rapid re-fetch storms during polling.
   * Short TTL (10s) to reduce upstream load without affecting data freshness.
   */
  const clientCache = new Map(); // key -> { response, ts }
  const clientCacheTTL = 10000; // 10 seconds
  const clientCacheMaxSize = 100; // Bounded to prevent memory leaks

  function getClientCacheKey(url, opts) {
    // Simple key: url + expect type
    const expect = opts?.expect || 'auto';
    return `${expect}::${url}`;
  }

  function cleanupClientCache() {
    const now = Date.now();
    const keysToDelete = [];
    for (const [key, entry] of clientCache.entries()) {
      if ((now - entry.ts) > clientCacheTTL) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      clientCache.delete(key);
    }
    // Also enforce size limit (LRU-like: remove oldest entries)
    if (clientCache.size > clientCacheMaxSize) {
      const entries = Array.from(clientCache.entries())
        .sort((a, b) => a[1].ts - b[1].ts); // Oldest first
      const toRemove = entries.slice(0, clientCache.size - clientCacheMaxSize);
      for (const [key] of toRemove) {
        clientCache.delete(key);
      }
    }
  }

  // Periodic cleanup every 30 seconds
  setInterval(cleanupClientCache, 30000);

  /**
   * Round 3: Proactive pruning for all long-lived Maps (memory leak prevention)
   * Runs every 10 minutes to remove stale/expired entries from all caches
   */
  function pruneAllMaps() {
    const now = Date.now();
    let totalPruned = 0;

    // 1. Prune geocodeCache (remove entries older than TTL)
    const geocodePruneCount = (() => {
      const geocodeCacheTTL = CONFIG.reliability.geocodeCacheTTLMs;
      let count = 0;
      for (const [key, entry] of geocodeCache.entries()) {
        const age = now - (entry.timestamp || 0);
        if (age > geocodeCacheTTL) {
          geocodeCache.delete(key);
          count++;
        }
      }
      return count;
    })();
    totalPruned += geocodePruneCount;

    // 2. Prune sourceBackoff (remove entries older than max backoff time)
    const backoffPruneCount = (() => {
      const maxAge = CONFIG.reliability.backoffMaxMs * 2; // Remove if 2x max backoff has passed
      let count = 0;
      for (const [sourceName, data] of sourceBackoff.entries()) {
        if (now > data.nextAllowedMs + maxAge) {
          sourceBackoff.delete(sourceName);
          count++;
        }
      }
      return count;
    })();
    totalPruned += backoffPruneCount;

    // 3. Prune healthTracker recentErrors (already has internal cleanup, but double-check)
    const healthPruneCount = (() => {
      let count = 0;
      for (const [feedId, data] of healthTracker.recentErrors.entries()) {
        if (now - data.firstSeen > healthTracker.windowMs) {
          healthTracker.recentErrors.delete(feedId);
          count++;
        }
      }
      return count;
    })();
    totalPruned += healthPruneCount;

    // 4. Log pruning stats
    if (totalPruned > 0) {
      console.log(`[Prune] Removed ${totalPruned} stale entries (geocode: ${geocodePruneCount}, backoff: ${backoffPruneCount}, health: ${healthPruneCount})`);
    }

    // 5. Log Map sizes for monitoring
    console.log(`[Prune] Map sizes: geocodeCache=${geocodeCache.size}, sourceBackoff=${sourceBackoff.size}, clientCache=${clientCache.size}, healthErrors=${healthTracker.recentErrors.size}`);
  }

  // Run pruning tick every 10 minutes
  setInterval(pruneAllMaps, CONFIG.reliability.pruneIntervalMs);

  /**
   * Health indicator tracking (Round 2 observability)
   * Tracks feed failures and stale data usage to compute system health
   *
   * Round 3 enhancement: Tracks stale age for UI display
   */
  const healthTracker = {
    recentErrors: new Map(), // feedId -> errorCount
    staleDataCount: 0,
    lastStaleAgeMs: 0, // Round 3: Track most recent stale age
    lastHealthUpdate: 0,
    windowMs: 5 * 60 * 1000, // 5-minute rolling window

    recordError(feedId) {
      const now = Date.now();
      const existing = this.recentErrors.get(feedId) || { count: 0, firstSeen: now };

      // Reset if outside window
      if (now - existing.firstSeen > this.windowMs) {
        this.recentErrors.set(feedId, { count: 1, firstSeen: now });
      } else {
        existing.count++;
      }

      this.updateHealthIndicator();
    },

    recordStaleData(staleAgeMs = 0) {
      this.staleDataCount++;
      this.lastStaleAgeMs = staleAgeMs || 0;
      this.updateHealthIndicator();
    },

    computeHealth() {
      const now = Date.now();

      // Clean up old entries
      for (const [feedId, data] of this.recentErrors.entries()) {
        if (now - data.firstSeen > this.windowMs) {
          this.recentErrors.delete(feedId);
        }
      }

      const errorCount = this.recentErrors.size;
      const staleUsed = this.staleDataCount > 0;

      // Round 3: Format stale age for display
      const staleAgeStr = (() => {
        if (!staleUsed || !this.lastStaleAgeMs) return '';
        const ageMinutes = Math.floor(this.lastStaleAgeMs / 1000 / 60);
        const ageHours = Math.floor(ageMinutes / 60);
        if (ageHours > 0) return ` (stale: ${ageHours}h)`;
        if (ageMinutes > 0) return ` (stale: ${ageMinutes}m)`;
        return ' (stale: <1m)';
      })();

      // Health logic:
      // LIVE: No errors, no stale data
      // PARTIAL: 1-2 failing feeds OR stale data in use
      // DEGRADED: 3+ failing feeds
      if (errorCount === 0 && !staleUsed) {
        return { status: 'LIVE', color: 'chip--live', title: 'All feeds operational' };
      } else if (errorCount >= 3) {
        return { status: 'DEGRADED', color: 'chip--degraded', title: `${errorCount} feeds failing, using cached data${staleAgeStr}` };
      } else {
        const reason = errorCount > 0 ? `${errorCount} feed(s) failing` : 'using cached data';
        return { status: 'PARTIAL', color: 'chip--partial', title: `Partial service: ${reason}${staleAgeStr}` };
      }
    },

    updateHealthIndicator() {
      const now = Date.now();
      // Throttle updates to once per second
      if (now - this.lastHealthUpdate < 1000) return;
      this.lastHealthUpdate = now;

      const liveChip = document.getElementById('chipLive');
      const liveText = document.getElementById('liveText');
      if (!liveChip || !liveText) return;

      const health = this.computeHealth();

      // Update UI
      liveChip.className = `chip ${health.color}`;
      liveText.textContent = health.status;
      liveChip.title = health.title;

      // Reset stale count after update (it's a transient indicator)
      // Round 3: Also clear stale age when resetting count
      setTimeout(() => {
        this.staleDataCount = 0;
        this.lastStaleAgeMs = 0;
      }, 2000);
    }
  };

  /**
   * Round 3: Adaptive Backoff System (per-source failure tracking)
   * Prevents hammering failing/rate-limited sources by exponentially increasing delays
   */
  const sourceBackoff = new Map(); // sourceName -> { consecutiveErrors, nextAllowedMs, lastError }
  const cycleStats = {
    requestCount: 0,
    startTime: 0,
    failureCount: 0,
    degradedMode: false
  };

  /**
   * Check if source should be skipped due to backoff
   * Returns { allowed: boolean, delayMs?: number }
   */
  function checkSourceBackoff(sourceName) {
    const backoffData = sourceBackoff.get(sourceName);
    if (!backoffData) return { allowed: true };

    const now = Date.now();
    if (now < backoffData.nextAllowedMs) {
      const delayMs = backoffData.nextAllowedMs - now;
      return { allowed: false, delayMs };
    }

    return { allowed: true };
  }

  /**
   * Record source success (reset backoff)
   */
  function recordSourceSuccess(sourceName) {
    sourceBackoff.delete(sourceName);
  }

  /**
   * Record source failure (escalate backoff)
   */
  function recordSourceFailure(sourceName, errorType = 'unknown') {
    const now = Date.now();
    const existing = sourceBackoff.get(sourceName);

    if (!existing) {
      // First failure: apply minimum backoff
      sourceBackoff.set(sourceName, {
        consecutiveErrors: 1,
        nextAllowedMs: now + CONFIG.reliability.backoffMinMs,
        lastError: errorType
      });
      console.warn(`[Backoff] ${sourceName}: First failure (${errorType}), next attempt in ${CONFIG.reliability.backoffMinMs / 1000}s`);
    } else {
      // Escalate backoff exponentially
      const newErrors = existing.consecutiveErrors + 1;
      const newBackoffMs = Math.min(
        CONFIG.reliability.backoffMinMs * Math.pow(CONFIG.reliability.backoffMultiplier, newErrors - 1),
        CONFIG.reliability.backoffMaxMs
      );
      sourceBackoff.set(sourceName, {
        consecutiveErrors: newErrors,
        nextAllowedMs: now + newBackoffMs,
        lastError: errorType
      });
      console.warn(`[Backoff] ${sourceName}: ${newErrors} consecutive failures (${errorType}), next attempt in ${Math.round(newBackoffMs / 1000)}s`);
    }

    // Prune map if it grows too large (safety cap)
    if (sourceBackoff.size > CONFIG.reliability.maxBackoffEntries) {
      const entries = Array.from(sourceBackoff.entries())
        .sort((a, b) => a[1].consecutiveErrors - b[1].consecutiveErrors);
      const toRemove = sourceBackoff.size - CONFIG.reliability.maxBackoffEntries;
      for (let i = 0; i < toRemove; i++) {
        sourceBackoff.delete(entries[i][0]);
      }
      console.log(`[Backoff] Pruned ${toRemove} entries from sourceBackoff map (${sourceBackoff.size} remaining)`);
    }

    // Track cycle failures for degraded mode
    cycleStats.failureCount++;
  }

  /**
   * Check if refresh cycle budget exceeded
   */
  function checkCycleBudget() {
    const elapsed = Date.now() - cycleStats.startTime;

    if (cycleStats.requestCount >= CONFIG.reliability.maxRequestsPerCycle) {
      console.warn(`[Budget] Max requests per cycle exceeded (${cycleStats.requestCount}/${CONFIG.reliability.maxRequestsPerCycle})`);
      return { exceeded: true, reason: 'max_requests' };
    }

    if (elapsed >= CONFIG.reliability.maxTimePerCycleMs) {
      console.warn(`[Budget] Max time per cycle exceeded (${Math.round(elapsed / 1000)}s/${CONFIG.reliability.maxTimePerCycleMs / 1000}s)`);
      return { exceeded: true, reason: 'max_time' };
    }

    return { exceeded: false };
  }

  /**
   * Simulated failure (dev/testing only)
   */
  function shouldSimulateFailure(sourceName) {
    const sim = CONFIG.reliability.simulateFailure;
    if (!sim.enabled) return false;
    if (sim.targetSource && sim.targetSource !== sourceName) return false;
    console.warn(`[SimFailure] Simulating ${sim.failureType} failure for ${sourceName}`);
    return true;
  }

  /**
   * Stale data indicator - shows when proxy returns stale cached data
   * Round 3: Now accepts stale age for UI display
   */
  function showStaleDataIndicator(staleAgeMs = 0) {
    healthTracker.recordStaleData(staleAgeMs);
  }

  /**
   * Record feed error for health tracking
   */
  function recordFeedError(feedId) {
    healthTracker.recordError(feedId);
  }

  async function fetchWithProxies(url, opts = {}, responseType = 'auto') {
    /**
     * Perform a fetch to the given URL, using a local proxy when possible to
     * avoid CORS errors. Consumers may specify the expected response type via
     * opts.expect (preferred) or the third `responseType` argument. Supported
     * types are "json" and "text". Any additional headers supplied in
     * opts.headers will be merged into the request.
     *
     * DEFENSIVE HARDENING (Round 2):
     * - Gracefully handles missing headers (content-type, x-proxy-stale, x-proxy-cache-state)
     * - All header access checks for existence before .get()
     * - Existing exception-based error handling preserved for compatibility
     *
     * RELIABILITY (Round 3):
     * - Tracks cycle request count for budget enforcement
     * - Extracts stale age metadata from proxy headers
     * - Supports simulated failures for testing
     */

    // Round 3: Track cycle request count
    cycleStats.requestCount++;

    // Round 3: Check for simulated failure (dev/testing only)
    const sourceName = opts.sourceName || 'unknown';
    if (shouldSimulateFailure(sourceName)) {
      const sim = CONFIG.reliability.simulateFailure;
      if (sim.failureType === '429') {
        throw new Error('Simulated 429 rate limit');
      } else if (sim.failureType === 'timeout') {
        await new Promise(r => setTimeout(r, 35000)); // Exceed timeout
        throw new Error('Simulated timeout');
      } else if (sim.failureType === '500') {
        throw new Error('Simulated 500 server error');
      }
    }

    // Check client-side cache first (short-lived to prevent re-render storms)
    const cacheKey = getClientCacheKey(url, opts);
    const cached = clientCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < clientCacheTTL) {
      return cached.response;
    }

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
        return `${getProxyBase()}/proxy?url=${encodeURIComponent(u.toString())}`;
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

        // Round 3: Extract stale age metadata from proxy headers
        const isStale = (res.headers.get && res.headers.get('X-Proxy-Stale')) === '1';
        const staleAgeMs = (res.headers.get && res.headers.get('X-QQMS-Age-Ms'))
          ? parseInt(res.headers.get('X-QQMS-Age-Ms'), 10)
          : 0;
        const cacheState = (res.headers.get && res.headers.get('X-Proxy-Cache-State')) || 'unknown';

        if (isStale) {
          showStaleDataIndicator(staleAgeMs);
        }

        // Store stale age metadata for UI display (attached to response object if possible)
        const metadata = {
          isStale,
          staleAgeMs,
          cacheState,
          proxyRequestId: (res.headers.get && res.headers.get('X-Proxy-Request-ID')) || null
        };

        if (!res.ok) {
          const err = new Error(`HTTP ${res.status}`);
          errors.push({ type: candidate.type, status: res.status, error: err.message });
          throw err;
        }

        if (expected === 'json') {
          // DEFENSIVE: Handle missing content-type header gracefully
          const ct = (res.headers.get && res.headers.get('content-type') || '').toLowerCase();
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
            // Cache successful response
            clientCache.set(cacheKey, { response: parsed, ts: Date.now() });
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

        // Cache successful response
        clientCache.set(cacheKey, { response: textResponse, ts: Date.now() });
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
   * - Local landmarks and facilities
   */
  function extractLocationFromText(text) {
    if (!text) return null;

    // FXBG-specific landmarks and facilities (highest priority for exact matches)
    const landmarks = [
      // Government buildings
      /\b(Fredericksburg\s+City\s+Hall|City\s+Hall|Fredericksburg\s+Police\s+(?:Station|Department)|Police\s+(?:Station|HQ|Headquarters)|Circuit\s+Court(?:house)?|General\s+District\s+Court|Juvenile\s+(?:and\s+)?Domestic\s+Relations\s+Court)/i,
      // Parks and rec
      /\b(Riverfront\s+Park|Motts\s+Run\s+Reservoir|Old\s+Mill\s+Park|Memorial\s+Park|Alum\s+Spring\s+Park|City\s+Dock|Canal\s+Path)/i,
      // Schools and institutions
      /\b(University\s+of\s+Mary\s+Washington|UMW|Germanna\s+Community\s+College|Walker-Grant\s+(?:Middle\s+)?School|Hugh\s+Mercer\s+Elementary|James\s+Monroe\s+High\s+School)/i,
      // Shopping and commercial
      /\b(Central\s+Park|Celebrate\s+Virginia|Spotsylvania\s+Towne\s+Centre|Wegmans|Eagles\s+Village|Cosner\s+Corner)/i,
      // Neighborhoods
      /\b(Downtown\s+Fredericksburg|Historic\s+District|Fall\s+Hill|Massaponax|Courthouse\s+(?:Village|Area)|Four\s+Mile\s+Fork|Bragg\s+Hill|Chancellor|Shenandoah\s+Crossing|Ferry\s+Farm)/i,
      // Medical facilities
      /\b(Mary\s+Washington\s+Hospital|Spotsylvania\s+Regional\s+Medical\s+Center|MWH|SRMC)/i,
      // Transit hubs
      /\b(FRED\s+(?:Transit\s+)?(?:Center|Hub|Station)|VRE\s+Station|Fredericksburg\s+Train\s+Station)/i,
    ];

    // Check landmarks first (most specific)
    for (const pattern of landmarks) {
      const match = text.match(pattern);
      if (match) return match[1].trim();
    }

    // Major highways and roads in FXBG area (specific names)
    const majorRoads = [
      /\b(Jefferson\s+Davis\s+(?:Highway|Hwy)|(?:US|Route)\s+1\s+(?:North|South|N|S)?|Plank\s+Road|(?:State\s+Route|VA|Route)\s+3|Lafayette\s+(?:Boulevard|Blvd)|William\s+Street|Princess\s+Anne\s+Street|Charles\s+Street|Sophia\s+Street|Sunken\s+Road|Blue\s+and\s+Gray\s+(?:Parkway|Pkwy)|Carl\s+D\.?\s+Silver\s+Parkway|Gordon\s+(?:Road|W\.?\s+Shelton\s+(?:Boulevard|Blvd))|Harrison\s+Road|Courthouse\s+Road|Mine\s+Road|Tidewater\s+Trail)/i,
    ];

    for (const pattern of majorRoads) {
      const match = text.match(pattern);
      if (match) return match[1].trim();
    }

    // Common road/street patterns in the region
    const patterns = [
      // Specific intersections (more specific = higher priority)
      /(?:at|near|on|@|intersection\s+of)\s+([A-Z][A-Za-z\s\.]+?(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Highway|Hwy|Drive|Dr|Lane|Ln|Parkway|Pkwy|Route|Rt))\s+(?:and|at|&|near|intersection\s+(?:of|with))\s+([A-Z][A-Za-z\s\.]+?(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Highway|Hwy|Drive|Dr|Lane|Ln|Parkway|Pkwy|Route|Rt))/i,

      // Interstate highways
      /(?:on|at|near|along|I-?95|I-?295|Interstate\s+(?:95|295))\s*(?:(?:North|South|East|West|N|S|E|W)(?:bound)?)?/i,

      // US Routes (with optional direction)
      /(?:on|at|near|along)?\s*(U\.?S\.?\s+(?:Route\s+)?\d+|US\s+\d+|Route\s+\d+|Rt\.?\s+\d+)\s*(?:(?:North|South|East|West|N|S|E|W)(?:bound)?)?/i,

      // State routes (VA routes common in area)
      /(?:on|at|near|along)?\s*((?:State\s+Route|VA|Virginia|Route)\s+\d+)\s*(?:(?:North|South|East|West|N|S|E|W)(?:bound)?)?/i,

      // Street addresses with house numbers
      /\b(\d{1,5}\s+(?:North|South|East|West|N|S|E|W\.?)?\s*[A-Z][A-Za-z\s\.]+?(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Highway|Hwy|Drive|Dr|Lane|Ln|Parkway|Pkwy|Circle|Cir|Court|Ct|Place|Pl|Way))/i,

      // Street names without numbers (lower priority)
      /(?:on|at|near|along)\s+([A-Z][A-Za-z\s\.]+?(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Highway|Hwy|Drive|Dr|Lane|Ln|Parkway|Pkwy))/i,

      // Mile markers on major highways
      /(?:mile\s+marker|MM|milepost)\s+(\d+(?:\.\d+)?)\s+(?:on|at|near|along)?\s*(I-?95|I-?295|US\s+\d+|Route\s+\d+)?/i,
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
   * Get intelligent default location based on source, category, and content
   * Returns { lat, lon } with best-guess location for ungeocodeable items
   */
  function getDefaultLocationForItem(source, category, text) {
    const jurisdiction = source.jurisdiction || "Regional";

    // Category and keyword-based defaults
    const categoryDefaults = {
      'police_crime': { lat: 38.3032, lon: -77.4605 },     // Police HQ / City Hall
      'legal_courts': { lat: 38.3015, lon: -77.4596 },     // Courthouse
      'government': { lat: 38.3032, lon: -77.4605 },       // City Hall
      'fire_ems': { lat: 38.3032, lon: -77.4605 },         // Fire Station area
      'traffic_transit': { lat: 38.3032, lon: -77.4605 },  // Transit hub
      'events': { lat: 38.2985, lon: -77.4689 },           // Riverfront / Downtown events area
    };

    // Check for specific keywords in text to refine location
    if (text) {
      const lowerText = text.toLowerCase();

      // Courthouse/court-related
      if (lowerText.match(/\b(court|judge|trial|hearing|lawsuit)\b/i)) {
        return { lat: 38.3015, lon: -77.4596 };  // Courthouse
      }

      // Police/crime specific locations
      if (lowerText.match(/\b(police\s+(?:station|hq|headquarters)|city\s+hall)\b/i)) {
        return { lat: 38.3032, lon: -77.4605 };  // Police HQ
      }

      // Riverfront events
      if (lowerText.match(/\b(riverfront|canal\s+path|city\s+dock|downtown)\b/i)) {
        return { lat: 38.2985, lon: -77.4689 };  // Riverfront
      }

      // Hospital/medical
      if (lowerText.match(/\b(hospital|medical|emergency\s+room|er\b|ems)\b/i)) {
        return { lat: 38.3195, lon: -77.4844 };  // Mary Washington Hospital
      }

      // University events
      if (lowerText.match(/\b(university|umw|mary\s+washington|college)\b/i)) {
        return { lat: 38.2995, lon: -77.4785 };  // UMW campus
      }

      // Transit/bus
      if (lowerText.match(/\b(fred\s+transit|bus|transit\s+center)\b/i)) {
        return { lat: 38.3032, lon: -77.4605 };  // Transit hub
      }
    }

    // Try category-based default
    if (category && categoryDefaults[category]) {
      return categoryDefaults[category];
    }

    // Fall back to jurisdiction default or source default
    const jurisdictionDefaults = {
      'Fredericksburg': { lat: 38.3032, lon: -77.4605 },
      'Stafford': { lat: 38.4220, lon: -77.4083 },
      'Spotsylvania': { lat: 38.1859, lon: -77.6526 },
      'Regional': { lat: 38.2750, lon: -77.5000 }
    };

    return source.defaultLoc || jurisdictionDefaults[jurisdiction] || CONFIG.center;
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
      const proxyUrl = `${getProxyBase()}/proxy?url=${encodeURIComponent('https://api.weather.gov')}`;
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
  const map = L.map("map", {
    zoomControl: false,
    preferCanvas: false,
    maxZoom: 20,
    minZoom: 7
  }).setView([CONFIG.center.lat, CONFIG.center.lon], CONFIG.zoom);

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 20,
      maxNativeZoom: 18,
      attribution: 'Map tiles by Esri',
      errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    }
  ).addTo(map);

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 20,
      maxNativeZoom: 18,
      opacity: 0.95,
      errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    }
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
    playClickSound('close');
    closePanel();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePanel();
  });


  // -----------------------------
  // Filters
  // -----------------------------
  const activeCategories = new Set(Object.keys(CATEGORIES));

  // Build dynamic legend (avoid legacy duplicates)
  function buildLegend() {
    const legendHost = $("legend");
    if (!legendHost) return;

    legendHost.innerHTML = "";

    // Only show non-legacy categories in the legend
    const legacyCategories = new Set(['crime', 'traffic', 'crash', 'closure', 'train', 'weather', 'camera']);

    for (const [key, def] of Object.entries(CATEGORIES)) {
      // Skip legacy categories to avoid duplicates
      if (legacyCategories.has(key)) continue;

      const item = document.createElement("div");
      item.className = "legend__item";
      item.style.cursor = "pointer";
      item.title = "Click: show alerts • Shift+Click: hide/show category";
      item.innerHTML = `<span class="legend__emoji">${def.emoji}</span> ${def.label}`;

      // Add click handler (same as filter buttons)
      item.addEventListener("click", (e) => {
        if (e.shiftKey) {
          const on = activeCategories.has(key);
          if (on) activeCategories.delete(key); else activeCategories.add(key);
          // Update filter button visual state
          document.querySelectorAll("#filters .fbtn").forEach(btn => {
            if ((btn.dataset.cat || "") === key) btn.setAttribute("aria-pressed", String(!on));
          });
          redraw();
          return;
        }
        focusCategory(key);
      });

      legendHost.appendChild(item);
    }
  }

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
  buildLegend();
  buildFilters();


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
    locks: { rss:false, nws:false, arcgis:false, virginiaCrashData:false, va511:false, openUV:false, cdc:false },
    lastByCategory: new Map()
  };

  /**
   * Round 3: Near-duplicate detection for crash items (511 + ArcGIS)
   * Suppresses items that are likely duplicates based on:
   * - Same category
   * - Similar location (within distance threshold)
   * - Similar title/summary
   * - Within time window
   */
  function isNearDuplicate(newItem) {
    const now = Date.now();
    const timeWindow = CONFIG.reliability.dedupeTimeWindowMs;
    const distanceThreshold = CONFIG.reliability.dedupeDistanceThresholdM;

    // Only apply to crash/incident categories
    const crashCategories = ['crash', 'road_closure', 'traffic'];
    if (!crashCategories.includes(newItem.category)) {
      return false; // Not a crash item, skip near-duplicate check
    }

    // Check against all existing items in the store
    for (const [_, existingItem] of store.itemsById.entries()) {
      // Skip if different category
      if (existingItem.category !== newItem.category) continue;

      // Skip if outside time window
      const existingTime = existingItem.published ? new Date(existingItem.published).getTime() : 0;
      const newTime = newItem.published ? new Date(newItem.published).getTime() : now;
      if (Math.abs(newTime - existingTime) > timeWindow) continue;

      // Check location proximity (if both have locations)
      if (newItem.loc && existingItem.loc) {
        const distance = haversineDistance(
          newItem.loc.lat, newItem.loc.lon,
          existingItem.loc.lat, existingItem.loc.lon
        );
        if (distance > distanceThreshold) continue;

        // Within distance threshold - check title similarity
        const newTitle = (newItem.title || '').toLowerCase();
        const existingTitle = (existingItem.title || '').toLowerCase();

        // Simple similarity: check if one contains the other or significant overlap
        const overlap = newTitle.includes(existingTitle.slice(0, 20)) ||
                       existingTitle.includes(newTitle.slice(0, 20));

        if (overlap || distance < 10) { // Very close = likely duplicate
          return true; // Near-duplicate detected
        }
      }
    }

    return false; // Not a near-duplicate
  }

  /**
   * Haversine distance (meters) between two lat/lon points
   */
  function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const toRad = (deg) => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

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

    // CRITICAL: Never drop items due to missing geodata - always use intelligent default fallback
    // This ensures all RSS items appear on the map even if they have no embedded coordinates
    // Use intelligent defaults based on category and content keywords
    const loc = raw.loc || getDefaultLocationForItem(source, picked.category, textForHeuristics);

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
      published: publishedDate.toISOString(),
      lat: loc.lat,
      lon: loc.lon,
      category: picked.category,
      emoji: picked.emoji,
      tone: picked.tone || source.tone || "warn",
      sourceName: source.name,
      sourceId: source.id,
      jurisdiction: source.jurisdiction || "Unknown",
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
  // Source type color mapping for visual differentiation
  const SOURCE_TYPE_COLORS = {
    'rss': '#7ef0ff',           // Cyan - RSS feeds
    'api_traffic': '#ffd86b',   // Yellow - Traffic/511 APIs
    'api_crash': '#ff6b8a',     // Red - Crash data APIs
    'api_weather': '#9d8cff',   // Purple - Weather APIs
    'api_camera': '#44f0a6',    // Green - Camera feeds
    'api_health': '#ff9a6b',    // Orange - Health/CDC APIs
    'api_uv': '#ffe66b',        // Light yellow - UV data
  };

  function getSourceTypeColor(sourceId) {
    if (!sourceId) return SOURCE_TYPE_COLORS['rss'];

    // RSS feeds
    if (sourceId.includes('fxbg-') || sourceId.includes('spotsy-') || sourceId.includes('stafford-') || sourceId.includes('caroline-') || sourceId.includes('warrenton-') || sourceId.includes('potomac-local') || sourceId === 'fxbg-free-press' || sourceId === 'nws-va-alerts') {
      return SOURCE_TYPE_COLORS['rss'];
    }
    // Traffic APIs
    if (sourceId.includes('va511-incidents') || sourceId.includes('va511-construction') || sourceId.includes('varoads')) {
      return SOURCE_TYPE_COLORS['api_traffic'];
    }
    // Camera feeds
    if (sourceId.includes('va511-cameras')) {
      return SOURCE_TYPE_COLORS['api_camera'];
    }
    // Crash data APIs
    if (sourceId.includes('crash') || sourceId.includes('arcgis')) {
      return SOURCE_TYPE_COLORS['api_crash'];
    }
    // Weather APIs
    if (sourceId.includes('nws') || sourceId.includes('weather')) {
      return SOURCE_TYPE_COLORS['api_weather'];
    }
    // Health/CDC APIs
    if (sourceId.includes('cdc') || sourceId.includes('health')) {
      return SOURCE_TYPE_COLORS['api_health'];
    }
    // UV APIs
    if (sourceId.includes('uv')) {
      return SOURCE_TYPE_COLORS['api_uv'];
    }

    return SOURCE_TYPE_COLORS['rss'];
  }

  function makeEmojiIcon(emoji, tone = "warn", sourceId = null) {
    const sourceColor = getSourceTypeColor(sourceId);
    return L.divIcon({
      className: "",
      html: `<div class="emojiMarker" data-tone="${tone}" data-source-type="${sourceId || 'unknown'}" style="--source-color: ${sourceColor}">${emoji}</div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
      popupAnchor: [0, -12]
    });
  }

  function renderPopup(item) {
    const cat = CATEGORIES[item.category]?.label || item.category;
    const safeTitle = escapeHtml(item.title);
    const safeSummary = item.summary ? escapeHtml(item.summary) : "";

    // For cameras, include a thumbnail preview of the snapshot
    const cameraPreview = (item.category === "camera" && item.media && item.media.type === "image" && item.media.src)
      ? `<div style="margin: 10px 0; border-radius: 6px; overflow: hidden; background: #1a1a1a; position: relative;">
           <img src="${escapeAttr(item.media.src)}"
                alt="${escapeAttr(item.media.alt || item.title)}"
                style="width: 100%; height: auto; display: block; cursor: pointer;"
                onerror="this.parentElement.innerHTML='<div style=\\'padding: 20px; text-align: center; color: rgba(255,255,255,0.5);\\'>📷<br><small>Snapshot unavailable</small></div>';" />
           <div style="position: absolute; bottom: 4px; right: 4px; background: rgba(0,0,0,0.7); color: white; padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: 600;">
             LIVE
           </div>
         </div>
         <div style="font-size: 11px; color: rgba(126,240,255,0.8); margin-bottom: 8px; text-align: center; font-weight: 600;">
           👆 Click marker to view full snapshot
         </div>`
      : "";

    return `
      <div style="min-width:220px; max-width:280px">
        <div style="font-weight:900; font-size:13px; margin-bottom:6px">${item.emoji} ${safeTitle}</div>
        <div style="color:rgba(255,255,255,.70); font-size:12px; margin-bottom:8px">${cat} • ${fmtTime(item.timestamp)}</div>
        ${cameraPreview}
        ${safeSummary ? `<div style="font-size:12px; line-height:1.35; color:rgba(255,255,255,.82); margin-bottom:10px">${safeSummary}</div>` : ""}
        <a href="${item.url}" target="_blank" rel="noreferrer noopener" style="color:#7ef0ff; font-weight:800; text-decoration:none">Open source ↗</a>
      </div>
    `;
  }

  function attachMarker(item) {
    const m = L.marker([item.lat, item.lon], { icon: makeEmojiIcon(item.emoji, item.tone, item.sourceId) });
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
      const isCamera = item.category === "camera";

      // Log camera image URL for debugging
      console.log(`Loading camera image: ${item.media.originalSrc || item.media.src}`);

      // Add cache-busting timestamp to force fresh snapshot
      const cacheBustingSrc = imgSrc + (imgSrc.includes('?') ? '&' : '?') + '_t=' + Date.now();

      mediaEl.innerHTML = `
        <div class="panelMedia__wrapper" style="position: relative; min-height: 200px; background: #1a1a1a; border-radius: 8px; overflow: hidden;">
          <div class="panelMedia__loading" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.6); font-size: 14px;">
            <span>📷 Loading camera snapshot...</span>
          </div>
          <img class="panelMedia__img"
               src="${cacheBustingSrc}"
               alt="${imgAlt}"
               style="display: none; width: 100%; height: auto; position: relative; z-index: 1;"
               onload="this.style.display='block'; this.parentElement.querySelector('.panelMedia__loading').style.display='none';"
               onerror="this.style.display='none'; const loading = this.parentElement.querySelector('.panelMedia__loading'); loading.innerHTML = '<div style=\\'text-align: center; padding: 20px;\\'><div style=\\'font-size: 32px; margin-bottom: 8px;\\'>📷</div><div style=\\'color: rgba(255,255,255,0.7);\\'>Camera snapshot unavailable</div><div style=\\'font-size: 12px; color: rgba(255,255,255,0.5); margin-top: 4px;\\'>The camera feed may be offline or temporarily unavailable</div></div>'; loading.style.display='flex';" />
          ${isCamera ? `<button class="panelMedia__refresh" onclick="(function() {
              const img = this.parentElement.querySelector('.panelMedia__img');
              const loading = this.parentElement.querySelector('.panelMedia__loading');
              const baseSrc = '${imgSrc}';
              img.style.display = 'none';
              loading.style.display = 'flex';
              loading.innerHTML = '<span>📷 Refreshing snapshot...</span>';
              img.src = baseSrc + (baseSrc.includes('?') ? '&' : '?') + '_t=' + Date.now();
            }).call(this)"
            style="position: absolute; top: 8px; right: 8px; background: rgba(0,0,0,0.8); color: white; border: 1px solid rgba(255,255,255,0.3); padding: 6px 12px; border-radius: 4px; font-size: 12px; font-weight: 600; cursor: pointer; z-index: 10; display: flex; align-items: center; gap: 4px;"
            title="Refresh to get latest snapshot from live camera feed">
            🔄 Refresh
          </button>` : ''}
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

    // Round 3: Track removed items to clean up seenKeys (prevent memory leak)
    const keptIds = new Set([...cams, ...trimmed].map(it => it.id));
    const removedCount = items.length - keptIds.size;

    store.itemsById.clear();
    store.markersById.clear();

    for (const it of [...cams, ...trimmed]) store.itemsById.set(it.id, it);

    // Round 3: Clean up seenKeys for removed items (prevent unbounded growth)
    // Note: seenKeys uses dedupeKey, not id, so we can't clean it precisely here
    // But refreshAll() already clears seenKeys, so this is a safety measure
    // If seenKeys grows too large between refreshes, we'll cap it here
    if (store.seenKeys.size > CONFIG.perf.maxTotalItems * 1.5) {
      console.warn(`[enforceCaps] seenKeys grew too large (${store.seenKeys.size}), clearing stale entries`);
      // In practice, refreshAll clears seenKeys regularly, so this is rare
      // We can't safely prune seenKeys without item mapping, so just log for now
    }

    if (removedCount > 0) {
      console.log(`[enforceCaps] Removed ${removedCount} old items (kept ${keptIds.size})`);
    }
  }

  /**
   * Throttled redraw to prevent render storms on mobile
   * Coalesces rapid redraw calls into a single RAF update
   */
  let redrawScheduled = false;
  function redrawThrottled() {
    if (redrawScheduled) return;
    redrawScheduled = true;
    requestAnimationFrame(() => {
      redrawScheduled = false;
      redrawImmediate();
    });
  }

  function redrawImmediate() {
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

    // Update News Flash panel if it's open
    const newsPanel = document.getElementById("newsFlashPanel");
    if (newsPanel && !newsPanel.classList.contains("newsFlashPanel--hidden")) {
      // Round 3: Skip expensive list render in degraded mode
      if (cycleStats.degradedMode && CONFIG.reliability.degradedModeSkipListRender) {
        console.log(`[DegradedMode] Skipping list render (degraded mode)`);
      } else {
        // Defer update to avoid blocking the redraw
        setTimeout(() => {
          if (typeof updateNewsFlash === 'function') {
            updateNewsFlash();
          }
        }, 100);
      }
    }
  }

  /**
   * Public redraw API - uses throttled version to prevent render storms
   * On mobile, this coalesces rapid calls into a single RAF update
   */
  function redraw() {
    redrawThrottled();
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

      // Round 3: Check source backoff before polling
      const backoffCheck = checkSourceBackoff(`rss-${source.id}`);
      if (!backoffCheck.allowed) {
        if (CONFIG.debug.rss) {
          console.log(`[RSS Backoff] Skipping ${source.id} (backoff: ${Math.round(backoffCheck.delayMs / 1000)}s remaining)`);
        }
        results.push({ source: source.id, ok: false, skipped: true, backoff: true });
        continue;
      }

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

        // Round 3: Record success to clear backoff
        recordSourceSuccess(`rss-${source.id}`);

      } catch (err) {
        // Check if this is a rate limit error (429)
        const isRateLimit = err.message && (err.message.includes('429') || err.message.includes('Too Many Requests'));
        const isEmpty = err.message && err.message.includes('Empty response');
        const isProxyError = err.message && err.message.includes('proxy');

        // Round 3: Record failure and apply backoff
        const errorType = isRateLimit ? 'rate_limit' : (isEmpty ? 'empty' : (isProxyError ? 'proxy' : 'unknown'));
        recordSourceFailure(`rss-${source.id}`, errorType);
        recordFeedError(`rss-${source.id}`);

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

    // Round 3: Check source backoff before polling
    const backoffCheck = checkSourceBackoff('nws');
    if (!backoffCheck.allowed) {
      console.log(`[NWS Backoff] Skipping (backoff: ${Math.round(backoffCheck.delayMs / 1000)}s remaining)`);
      $("weatherText").textContent = "Weather: Waiting...";
      return;
    }

    // Round 3: Use fetchWithProxies for all NWS requests to participate in cycle budgets
    const pointsUrl = `https://api.weather.gov/points/${CONFIG.nws.pointsLat},${CONFIG.nws.pointsLon}`;
    const points = await fetchWithProxies(pointsUrl, {
      expect: "json",
      headers: { "Accept": "application/geo+json" }
    });

    const forecastUrl = points.properties?.forecast;
    const forecastHourlyUrl = points.properties?.forecastHourly;

    const [forecast, hourly] = await Promise.all([
      forecastUrl ? fetchWithProxies(forecastUrl, { expect: "json" }) : Promise.resolve(null),
      forecastHourlyUrl ? fetchWithProxies(forecastHourlyUrl, { expect: "json" }) : Promise.resolve(null)
    ]);

    const now = hourly?.properties?.periods?.[0];
    const day3 = forecast?.properties?.periods?.slice(0, 6) || [];

    const currentText = now ? `${now.temperature}°${now.temperatureUnit} • ${now.shortForecast}` : "Weather: Unavailable";
    const threeDay = day3.length ? day3.map(p => `${p.name.replace("This ","").slice(0,10)} ${p.temperature}°${p.temperatureUnit}`).slice(0, 6).join(" · ") : "";
    $("weatherText").textContent = threeDay ? `${currentText} — ${threeDay}` : currentText;

    // Alerts
    try {
      // Round 3: Use fetchWithProxies to participate in cycle budgets and stale tracking
      const alerts = await fetchWithProxies(CONFIG.nws.alertsUrl, {
        expect: "json",
        headers: { "Accept": "application/geo+json" }
      });
      if (alerts) ingestNWSAlerts(alerts);
    } catch (e) {
      // Round 3: Track alerts fetch failures (but don't fail the whole NWS fetch)
      recordFeedError('nws-alerts');

      if (!store._nwsAlertsErrorLogged) {
        console.warn("NWS alerts fetch failed:", e.message || e);
        store._nwsAlertsErrorLogged = true;
      }
    }

    // Round 3: Record success to clear backoff
    recordSourceSuccess('nws');

    } catch (e) {
      if (!store._nwsErrorLogged) {
        console.warn("NWS weather fetch failed:", e.message || e);
        $("weatherText").textContent = "Weather: Unable to connect (check network)";
        store._nwsErrorLogged = true;
      }

      // Round 3: Record failure and apply backoff
      recordSourceFailure('nws', 'fetch_error');
      recordFeedError('nws');
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

    // Round 3: Check source backoff before polling cameras
    const camerasBackoffCheck = checkSourceBackoff('va511-cameras');

    // Cameras (always ok; doesn't bloat too much and is useful)
    // Use proxy to avoid CORS issues with 511virginia.org redirects
    let camerasLoaded = false;
    if (!camerasBackoffCheck.allowed) {
      console.log(`[VA511 Backoff] Skipping cameras (backoff: ${Math.round(camerasBackoffCheck.delayMs / 1000)}s remaining)`);
    } else {

    // Helper to parse JSONP response for camera endpoints
    const parseJsonpCamera = (text) => {
      if (typeof text !== 'string') return text;
      const match = text.match(/^\s*\w+\s*\(\s*({[\s\S]*})\s*\)\s*;?\s*$/);
      return match ? JSON.parse(match[1]) : JSON.parse(text);
    };

    // Try primary camera endpoint first, then fallbacks if it fails
    const cameraEndpoints = [
      { url: CONFIG.va511.camerasGeojson, format: 'json', name: 'primary' },
      { url: CONFIG.va511.camerasGeojsonFallback, format: 'json', name: 'fallback1' },
      { url: CONFIG.va511.camerasGeojsonFallback2, format: 'jsonp', name: 'fallback2' }
    ];

    for (const endpoint of cameraEndpoints) {
      if (camerasLoaded) break;

      try {
        const headers = {
          "X-Cache-TTL-MS": "120000",
          "Accept": "application/geo+json,application/json,*/*",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        };

        // Only add Referer for primary endpoint
        if (endpoint.name === 'primary') {
          headers["Referer"] = "https://511.vdot.virginia.gov/";
        }

        const response = await fetchWithProxies(endpoint.url, {
          expect: endpoint.format === 'jsonp' ? 'text' : 'json',
          headers,
          timeoutMs: 25000
        });

        // Parse JSONP if needed
        const cams = endpoint.format === 'jsonp' ? parseJsonpCamera(response) : response;

        // Validate that we got actual GeoJSON
        if (cams && (cams.type === "FeatureCollection" || Array.isArray(cams.features))) {
          console.log(`511 cameras loaded successfully from ${endpoint.name}:`, cams.features?.length || 0, "cameras");
          const result = ingestVa511Cameras(cams);
          console.log(`511 cameras ingested: ${result.added} cameras added from ${result.total} total`);
          camerasLoaded = true;

          // Record success to clear backoff
          recordSourceSuccess('va511-cameras');
        } else {
          console.warn(`[VA511 Cameras] ${endpoint.name} returned invalid GeoJSON (missing features), trying next endpoint...`);
        }

      } catch (e) {
        console.warn(`[VA511 Cameras] ${endpoint.name} failed: ${e.message}, trying next endpoint...`);
      }
    }

    // If all endpoints failed, log error and apply backoff
    if (!camerasLoaded) {
      recordSourceFailure('va511-cameras', 'fetch_error');
      recordFeedError('va511-cameras');

      if (!store._511CamerasErrorLogged) {
        console.warn("511 cameras fetch failed on all endpoints.");
        console.warn("The 511 cameras endpoints may be down or blocking requests.");
        console.warn("  → Ensure proxy server is running: node proxy-server.js");
        console.warn("  → Manual camera data will be used as fallback");
        store._511CamerasErrorLogged = true;
      }
    }

    } // End backoff check for cameras

    // Incidents (STRICT time gate)
    // Use proxy to avoid CORS issues with 511virginia.org redirects
    let i95Incidents = 0;
    let incidentsLoaded = false;

    // Round 3: Check source backoff before polling incidents
    const incidentsBackoffCheck = checkSourceBackoff('va511-incidents');
    if (!incidentsBackoffCheck.allowed) {
      console.log(`[VA511 Backoff] Skipping incidents (backoff: ${Math.round(incidentsBackoffCheck.delayMs / 1000)}s remaining)`);
    } else {

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

          // Round 3: Record success to clear backoff
          recordSourceSuccess('va511-incidents');
        } else {
          throw new Error("Invalid GeoJSON response (missing features)");
        }

      } catch (e) {
        // Try next endpoint if available
        if (endpoint.name === 'fallback') {
          // Round 3: Record failure only if all endpoints failed
          recordSourceFailure('va511-incidents', 'fetch_error');
          recordFeedError('va511-incidents');

          if (!store._511IncidentsErrorLogged) {
            console.error("All 511 incidents endpoints failed. Error:", e.message || e);
            console.error("The 511 incidents service may be down or blocking requests.");
            console.error("  → Ensure proxy server is running: node proxy-server.js");
            console.error("  → Tried endpoints:", incidentsEndpoints.map(ep => ep.url).join(', '));
            store._511IncidentsErrorLogged = true;
          }
        }
      }
    }
    } // End backoff check for incidents

    if (CONFIG.va511.includeConstructionOnMap) {
      try {
        const con = await fetchWithProxies(CONFIG.va511.constructionGeojson, {
          expect: "json",
          headers: { "X-Cache-TTL-MS": "120000" },
          timeoutMs: 15000
        });
        ingestVa511Construction(con);
      } catch (e) {
        // Round 3: Track construction fetch failures (but don't fail the whole VA511 fetch)
        recordFeedError('va511-construction');

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

      // Round 3: Track outer VA511 failures (catastrophic failure)
      recordSourceFailure('va511', 'catastrophic_error');
      recordFeedError('va511');

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

      // If we have a camera ID but no page URL, construct a 511 Virginia map URL centered on the camera
      // Using lat/lon with zoom is more reliable than camera ID as 511's URL structure varies
      let finalPageUrl = pageUrl;
      if (!finalPageUrl && lat && lon) {
        // Center the 511 map on this camera's location with high zoom
        finalPageUrl = `https://511.vdot.virginia.gov/map?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&zoom=15&layers=cameras`;
      } else if (!finalPageUrl && cameraId) {
        // Fallback: try camera ID in URL (may not work depending on 511's current API)
        finalPageUrl = `https://511.vdot.virginia.gov/map/Cameras/${cameraId}`;
      } else if (!finalPageUrl) {
        // Last resort: just link to main 511 page
        finalPageUrl = "https://www.511virginia.org/";
      }

      let media = null;

      // Always prefer snapshot images for cameras (video feeds often don't work)
      // NOTE: VDOT cameras now hosted on vdotcameras.com - proxy updated to allow direct access
      if (cleanedCamUrl) {
        // Use direct camera URL (proxy allows vdotcameras.com domain)
        media = { type: "image", src: cleanedCamUrl, originalSrc: cleanedCamUrl, alt: name };
      }

      // Debug logging for first 5 cameras to help troubleshoot
      if (added < 5) {
        console.log(`Camera ${added + 1}: "${name}"`, {
          id: cameraId,
          snapshotURL: cleanedCamUrl || 'NONE',
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

      // Round 3: Check for near-duplicates before adding
      if (isNearDuplicate(norm)) {
        if (CONFIG.debug.rss) {
          console.log(`[VA511 Dedupe] Skipping near-duplicate incident: ${norm.title}`);
        }
        continue;
      }

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

    // Round 3: Check source backoff before polling
    const backoffCheck = checkSourceBackoff('arcgis-crashes');
    if (!backoffCheck.allowed) {
      console.log(`[ArcGIS Backoff] Skipping (backoff: ${Math.round(backoffCheck.delayMs / 1000)}s remaining)`);
      return 0;
    }

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

      // Round 3: Check for near-duplicates before adding
      if (isNearDuplicate(norm)) {
        if (CONFIG.debug.rss) {
          console.log(`[ArcGIS Dedupe] Skipping near-duplicate crash: ${norm.title}`);
        }
        continue;
      }

      store.seenKeys.add(norm.dedupeKey);
      store.itemsById.set(norm.id, norm);
      added++;
      pushed++;
    }

    setLastUpdate();
    redraw();

    // Round 3: Record success to clear backoff
    recordSourceSuccess('arcgis-crashes');

    return added;
    } catch (e) {
      console.warn("ArcGIS crash refresh failed", e);

      // Round 3: Record failure and apply backoff
      recordSourceFailure('arcgis-crashes', 'fetch_error');
      recordFeedError('arcgis-crashes');

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

      // Round 3: Check source backoff before polling
      const backoffCheck = checkSourceBackoff('virginia-crash-data');
      if (!backoffCheck.allowed) {
        console.log(`[Virginia Crash Data Backoff] Skipping (backoff: ${Math.round(backoffCheck.delayMs / 1000)}s remaining)`);
        return { added: 0 };
      }

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

            // Round 3: Check for near-duplicates before adding
            if (isNearDuplicate(norm)) {
              if (CONFIG.debug.rss) {
                console.log(`[Virginia Crash Data Dedupe] Skipping near-duplicate crash: ${norm.title}`);
              }
              continue;
            }

            store.seenKeys.add(norm.dedupeKey);
            store.itemsById.set(norm.id, norm);
            added++;
            totalAdded++;
          }

          if (added > 0) {
            console.log(`[Virginia Crash Data] Details API loaded: ${added} new crashes`);
          }
        }
      } catch (e) {
        if (!store._virginiaCrashDataErrorLogged) {
          console.warn("[Virginia Crash Data] Details API failed:", e.message);
          if (e.message.includes('404')) {
            console.warn("  → The Socrata endpoint may have changed or been removed");
            console.warn("  → Visit https://data.virginia.gov to check for updated crash data endpoints");
          } else if (e.message.includes('403')) {
            console.warn("  → Access denied - the endpoint may require authentication or be blocking automated requests");
            console.warn("  → Proxy server will use stale cached data when available");
          }
          store._virginiaCrashDataErrorLogged = true;
        }
      }

      setLastUpdate();
      redraw();

      // Round 3: Record success to clear backoff
      recordSourceSuccess('virginia-crash-data');

      return { added: totalAdded };
    } catch (e) {
      console.warn("[Virginia Crash Data] Refresh failed:", e);

      // Round 3: Record failure and apply backoff
      recordSourceFailure('virginia-crash-data', 'fetch_error');
      recordFeedError('virginia-crash-data');

      return { added: 0 };
    } finally {
      store.locks.virginiaCrashData = false;
    }
  }

  // -----------------------------
  // OpenUV API - UV Index data
  // -----------------------------
  async function fetchOpenUV() {
    if (!CONFIG.openUV.enabled) return;
    if (store.locks.openUV) return;
    store.locks.openUV = true;

    // Round 3: Check source backoff before polling
    const backoffCheck = checkSourceBackoff('openuv');
    if (!backoffCheck.allowed) {
      console.log(`[OpenUV Backoff] Skipping (backoff: ${Math.round(backoffCheck.delayMs / 1000)}s remaining)`);
      store.locks.openUV = false;
      return;
    }

    try {
      const url = `${CONFIG.openUV.baseUrl}?lat=${CONFIG.openUV.lat}&lng=${CONFIG.openUV.lon}`;
      const data = await fetchWithProxies(url, {
        expect: "json",
        headers: {
          "x-access-token": CONFIG.openUV.apiKey,
          "Accept": "application/json"
        }
      });

      if (!data || !data.result) {
        console.warn("[OpenUV] No valid UV data received");
        return;
      }

      const uv = data.result;
      const uvValue = uv.uv || uv.uv_max || 0;
      const uvTime = uv.uv_time || new Date().toISOString();

      // Determine UV level and appropriate emoji/tone
      let uvLevel = "Low";
      let emoji = "☀️";
      let tone = "good";

      if (uvValue >= 11) { uvLevel = "Extreme"; emoji = "🌞"; tone = "bad"; }
      else if (uvValue >= 8) { uvLevel = "Very High"; emoji = "🌞"; tone = "bad"; }
      else if (uvValue >= 6) { uvLevel = "High"; emoji = "☀️"; tone = "warn"; }
      else if (uvValue >= 3) { uvLevel = "Moderate"; emoji = "🌤️"; tone = "warn"; }
      else { uvLevel = "Low"; emoji = "🌥️"; tone = "good"; }

      const source = {
        id: "openuv-index",
        name: "OpenUV — UV Index",
        category: "uv_index",
        emoji: emoji,
        tone: tone,
        defaultLoc: { lat: CONFIG.openUV.lat, lon: CONFIG.openUV.lon },
        maxAgeHours: 2
      };

      const raw = {
        title: `UV Index: ${uvValue.toFixed(1)} (${uvLevel})`,
        url: "https://www.openuv.io",
        guid: `openuv-${new Date(uvTime).toISOString()}`,
        published: uvTime,
        summary: `Current UV Index is ${uvValue.toFixed(1)} (${uvLevel}). ${uvValue >= 6 ? "Sun protection recommended." : "Minimal sun protection needed."}`,
        message: `UV Index: ${uvValue.toFixed(1)}\nLevel: ${uvLevel}\n\nUV Protection Recommendations:\n${uvValue >= 11 ? "• Avoid sun exposure 10 AM - 4 PM\n• Wear protective clothing\n• Use SPF 30+ sunscreen\n• Seek shade" : uvValue >= 6 ? "• Wear sunscreen SPF 30+\n• Seek shade during midday\n• Wear sunglasses and hat" : "• Minimal protection needed\n• Wear sunglasses on bright days"}`,
        loc: { lat: CONFIG.openUV.lat, lon: CONFIG.openUV.lon }
      };

      const normalized = normalize({ source, raw });
      if (normalized && !store.seenKeys.has(normalized.dedupeKey)) {
        store.seenKeys.add(normalized.dedupeKey);
        store.itemsById.set(normalized.id, normalized);
        console.log(`[OpenUV] UV Index: ${uvValue.toFixed(1)} (${uvLevel})`);
      }

      // Round 3: Record success to clear backoff
      recordSourceSuccess('openuv');

    } catch (err) {
      console.error("[OpenUV] Fetch failed:", err.message);

      // Round 3: Record failure and apply backoff
      recordSourceFailure('openuv', 'fetch_error');
      recordFeedError('openuv');
    } finally {
      store.locks.openUV = false;
    }
  }

  // -----------------------------
  // CDC API - Health surveillance data
  // -----------------------------
  async function fetchCDC() {
    if (!CONFIG.cdc.enabled) return;
    if (store.locks.cdc) return;
    store.locks.cdc = true;

    // Round 3: Check source backoff before polling
    const backoffCheck = checkSourceBackoff('cdc');
    if (!backoffCheck.allowed) {
      console.log(`[CDC Backoff] Skipping (backoff: ${Math.round(backoffCheck.delayMs / 1000)}s remaining)`);
      store.locks.cdc = false;
      return;
    }

    try {
      // Fetch CDC health surveillance data (locality-specific)
      const data = await fetchWithProxies(CONFIG.cdc.wonderApiUrl, {
        expect: "json",
        headers: {
          "Accept": "application/json"
        }
      });

      if (!data || !Array.isArray(data)) {
        console.warn("[CDC] No valid health data received");
        return;
      }

      // Filter for Virginia localities in our region (Fredericksburg, Stafford, Spotsylvania)
      const relevantLocalities = ["fredericksburg", "stafford", "spotsylvania"];
      const filtered = data.filter(row => {
        const locality = (row.locality || row.county || row.location || "").toLowerCase();
        return relevantLocalities.some(rl => locality.includes(rl));
      }).slice(0, 10);  // Limit to 10 most recent items

      console.log(`[CDC] Found ${filtered.length} relevant health alerts for region`);

      let added = 0;
      for (const row of filtered) {
        const title = row.title || row.event || row.alert || "Health Advisory";
        const description = row.description || row.message || row.summary || "Health information update";
        const timestamp = row.timestamp || row.date || row.updated || new Date().toISOString();

        const source = {
          id: "cdc-health-data",
          name: "CDC — Health Surveillance",
          category: "health",
          emoji: "🏥",
          tone: "warn",
          jurisdiction: "Regional",
          defaultLoc: { lat: 38.3032, lon: -77.4605 },
          maxAgeHours: CONFIG.cdc.maxAgeHours
        };

        const raw = {
          title: `Health Alert: ${title}`,
          url: row.url || row.link || "https://data.cdc.gov",
          guid: `cdc-${row.id || fnv1a(title + timestamp)}`,
          published: timestamp,
          summary: description.slice(0, 400),
          message: description,
          loc: null  // Will use intelligent default location
        };

        const normalized = normalize({ source, raw });
        if (normalized && !store.seenKeys.has(normalized.dedupeKey)) {
          store.seenKeys.add(normalized.dedupeKey);
          store.itemsById.set(normalized.id, normalized);
          added++;
        }
      }

      if (added > 0) {
        console.log(`[CDC] Added ${added} health alerts to map`);
      }

      // Round 3: Record success to clear backoff
      recordSourceSuccess('cdc');

    } catch (err) {
      console.error("[CDC] Fetch failed:", err.message);

      // Round 3: Record failure and apply backoff
      recordSourceFailure('cdc', 'fetch_error');
      recordFeedError('cdc');
    } finally {
      store.locks.cdc = false;
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

    // Round 3: Initialize cycle budget tracking
    cycleStats.requestCount = 0;
    cycleStats.startTime = Date.now();
    cycleStats.failureCount = 0;
    cycleStats.degradedMode = false;

    // Hard reset (prevents buildup across refreshes)
    store.itemsById.clear();
    store.markersById.clear();
    store.seenKeys.clear();
    clusters.clearLayers();

    // Load RSS feeds and other APIs first (in parallel)
    await Promise.allSettled([
      pollRSS().catch(e => console.warn("RSS refresh partial", e)),
      CONFIG.nws.enabled ? fetchNWS().catch(e => console.warn("NWS refresh partial", e)) : Promise.resolve(),
      pollVa511().catch(e => console.warn("511 refresh partial", e)),
      CONFIG.openUV.enabled ? fetchOpenUV().catch(e => console.warn("OpenUV refresh partial", e)) : Promise.resolve(),
      CONFIG.cdc.enabled ? fetchCDC().catch(e => console.warn("CDC refresh partial", e)) : Promise.resolve()
    ]);

    // Check budget before proceeding to crash data (budget enforcement)
    const budgetCheck = checkCycleBudget();
    if (budgetCheck.exceeded) {
      console.warn(`[Budget] Deferring crash data sources to next cycle (${budgetCheck.reason})`);
    } else {
      // Load Virginia Crash data LAST after all other APIs complete (sequential for better performance)
      await pollArcgisCrashes().catch(e => console.warn("ArcGIS crash refresh partial", e));
      await pollVirginiaCrashData().catch(e => console.warn("Virginia Crash Data refresh partial", e));
    }

    // Round 3: Enter degraded mode if too many failures occurred
    if (cycleStats.failureCount >= CONFIG.reliability.degradedModeFailureThreshold) {
      cycleStats.degradedMode = true;
      console.warn(`[DegradedMode] ${cycleStats.failureCount} sources failed, entering degraded mode`);
    }

    $("liveText").textContent = "Live";
    setLastUpdate();

    // Round 3: Skip expensive operations in degraded mode
    if (cycleStats.degradedMode && CONFIG.reliability.degradedModeSkipClustering) {
      console.log(`[DegradedMode] Skipping cluster rebuild (degraded mode)`);
      // Still update UI, just skip expensive clustering
      updateCategoryCounts();
    } else {
      redraw();
    }

    // Log cycle stats
    const cycleElapsed = Date.now() - cycleStats.startTime;
    console.log(`[Cycle] Completed: ${cycleStats.requestCount} requests, ${cycleStats.failureCount} failures, ${Math.round(cycleElapsed / 1000)}s elapsed`);
  }

  $("btnRefresh").addEventListener("click", refreshAll);

  // -----------------------------
  // News Flash Dashboard
  // -----------------------------
  let newsFlashFilter = "all";
  let newsFlashJurisdiction = "all";

  function updateNewsFlash() {
    const panel = $("newsFlashPanel");
    const body = $("newsFlashBody");

    // Get all items from the store
    const allItems = Array.from(store.itemsById.values());

    // Filter items based on category and jurisdiction
    let filtered = allItems.filter(item => {
      // Apply category filter
      if (newsFlashFilter !== "all" && item.category !== newsFlashFilter) return false;

      // Apply jurisdiction filter
      if (newsFlashJurisdiction !== "all" && item.jurisdiction !== newsFlashJurisdiction) return false;

      // Only show RSS/news items (not traffic incidents, crashes, etc.)
      return item.category === "news" || item.category === "alerts" ||
             item.category === "events" || item.category === "fire_ems" ||
             item.category === "traffic_transit" || item.category === "police_crime" ||
             item.category === "government";
    });

    // Sort by published date (newest first)
    filtered.sort((a, b) => {
      const dateA = new Date(a.published || 0);
      const dateB = new Date(b.published || 0);
      return dateB - dateA;
    });

    // Take top 50 items
    filtered = filtered.slice(0, 50);

    // Render items
    if (filtered.length === 0) {
      body.innerHTML = '<div class="newsFlashPanel__loading">No news items match the selected filters.</div>';
      return;
    }

    body.innerHTML = filtered.map(item => {
      const emoji = item.emoji || "📰";
      const title = escapeHtml(item.title || "Untitled");
      const summary = escapeHtml((item.summary || item.message || "No description").slice(0, 200));
      const jurisdiction = escapeHtml(item.jurisdiction || "Unknown");
      const category = escapeHtml(CATEGORIES[item.category]?.label || item.category || "News");
      const time = formatTime(item.published);

      return `
        <div class="newsItem" data-item-id="${escapeAttr(item.id)}">
          <div class="newsItem__header">
            <span class="newsItem__emoji">${emoji}</span>
            <div class="newsItem__title">${title}</div>
          </div>
          <div class="newsItem__meta">
            <span class="newsItem__jurisdiction">${jurisdiction}</span>
            <span class="newsItem__category">${category}</span>
            <span class="newsItem__time">${time}</span>
          </div>
          <div class="newsItem__summary">${summary}</div>
        </div>
      `;
    }).join('');

    // Add click handlers to news items
    body.querySelectorAll('.newsItem').forEach(el => {
      el.addEventListener('click', () => {
        const itemId = el.getAttribute('data-item-id');
        const item = store.itemsById.get(itemId);
        if (item) {
          showMarkerPopup(item);
          // Also zoom to the item on the map
          if (item.loc) {
            map.setView([item.loc.lat, item.loc.lon], 14);
          }
        }
      });
    });
  }

  // News Flash panel toggle
  $("btnNewsFlash").addEventListener("click", () => {
    const panel = $("newsFlashPanel");
    const isHidden = panel.classList.contains("newsFlashPanel--hidden");

    if (isHidden) {
      playClickSound('open');
      panel.classList.remove("newsFlashPanel--hidden");
      updateNewsFlash();
    } else {
      playClickSound('close');
      panel.classList.add("newsFlashPanel--hidden");
    }
  });

  // News Flash close button
  $("newsFlashClose").addEventListener("click", () => {
    playClickSound('close');
    $("newsFlashPanel").classList.add("newsFlashPanel--hidden");
  });

  // News Flash filter buttons
  document.querySelectorAll('.filterBtn').forEach(btn => {
    btn.addEventListener('click', () => {
      // Remove active class from all buttons
      document.querySelectorAll('.filterBtn').forEach(b => b.classList.remove('filterBtn--active'));
      // Add active class to clicked button
      btn.classList.add('filterBtn--active');
      // Update filter
      newsFlashFilter = btn.getAttribute('data-filter');
      updateNewsFlash();
    });
  });

  // News Flash jurisdiction selector
  $("newsFlashJurisdiction").addEventListener('change', (e) => {
    newsFlashJurisdiction = e.target.value;
    updateNewsFlash();
  });

  // -----------------------------
  // Radio Scanner Panel
  // -----------------------------
  $("btnRadioScanner").addEventListener("click", () => {
    const panel = $("radioPanel");
    const isHidden = panel.classList.contains("radioPanel--hidden");

    if (isHidden) {
      playClickSound('open');
      panel.classList.remove("radioPanel--hidden");
    } else {
      playClickSound('close');
      panel.classList.add("radioPanel--hidden");
    }
  });

  $("radioClose").addEventListener("click", () => {
    playClickSound('close');
    $("radioPanel").classList.add("radioPanel--hidden");
  });

  // -----------------------------
  // Radio Player Logic (HTML5 Audio)
  // -----------------------------
  const RADIO_FEEDS = [
    { id: "527", name: "Fredericksburg City & Spotsylvania County Fire & EMS", streamUrl: "https://broadcastify.cdnstream1.com/527", pageUrl: "https://www.broadcastify.com/webPlayer/527" },
    { id: "592", name: "Spotsylvania County Fire & Rescue", streamUrl: "https://broadcastify.cdnstream1.com/592", pageUrl: "https://www.broadcastify.com/webPlayer/592" },
    { id: "5250", name: "King George County Fire & EMS", streamUrl: "https://broadcastify.cdnstream1.com/5250", pageUrl: "https://www.broadcastify.com/webPlayer/5250" },
    { id: "27136", name: "Prince William County Police & Fire", streamUrl: "https://broadcastify.cdnstream1.com/27136", pageUrl: "https://www.broadcastify.com/webPlayer/27136" },
    { id: "42002", name: "Orange County Fire & EMS", streamUrl: "https://broadcastify.cdnstream1.com/42002", pageUrl: "https://www.broadcastify.com/webPlayer/42002" },
    { id: "26919", name: "Culpeper County Public Safety", streamUrl: "https://broadcastify.cdnstream1.com/26919", pageUrl: "https://www.broadcastify.com/webPlayer/26919" },
    { id: "37506", name: "Culpeper County Sheriff", streamUrl: "https://broadcastify.cdnstream1.com/37506", pageUrl: "https://www.broadcastify.com/webPlayer/37506" },
    { id: "37505", name: "Culpeper Town Police", streamUrl: "https://broadcastify.cdnstream1.com/37505", pageUrl: "https://www.broadcastify.com/webPlayer/37505" },
  ];

  // Create single shared audio instance
  const radioAudio = new Audio();
  radioAudio.preload = "none";
  radioAudio.volume = 0.8;
  radioAudio.crossOrigin = "anonymous"; // best-effort CORS

  // Radio state
  let currentStationId = null;
  let isPlaying = false;

  // Helper: Get station by ID
  function radioGetStation(id) {
    return RADIO_FEEDS.find(s => s.id === id);
  }

  // Helper: Update station UI status
  function radioUpdateStationUI(stationId, status, buttonIcon) {
    const statusEl = document.getElementById(`radioStatus-${stationId}`);
    const btnEl = document.querySelector(`[data-radio-id="${stationId}"]`);
    const rowEl = btnEl?.closest('.radioStationRow');

    if (statusEl) {
      statusEl.textContent = status;
      statusEl.className = 'radioStatus';
      if (status.includes('Playing')) statusEl.classList.add('playing');
      if (status.includes('Error')) statusEl.classList.add('error');
    }
    if (btnEl) {
      btnEl.textContent = buttonIcon;
    }
    if (rowEl) {
      if (status.includes('Playing')) {
        rowEl.classList.add('playing');
      } else {
        rowEl.classList.remove('playing');
      }
    }
  }

  // Helper: Reset all stations UI
  function radioResetAllUI() {
    RADIO_FEEDS.forEach(station => {
      radioUpdateStationUI(station.id, 'Paused', '▶');
    });
  }

  // Start a station
  async function radioStartStation(id) {
    const station = radioGetStation(id);
    if (!station) return;

    // Reset all UI first
    radioResetAllUI();

    // Update state
    currentStationId = id;
    radioAudio.src = station.streamUrl;

    // Attempt playback
    try {
      await radioAudio.play();
      // Success
      isPlaying = true;
      radioUpdateStationUI(id, 'Playing', '⏸');
      $("radioNowPlaying").textContent = station.name;
      $("radioMasterToggle").textContent = '⏸';
    } catch (err) {
      // Playback blocked or failed
      console.warn(`Radio playback failed for ${station.name}:`, err);
      isPlaying = false;
      radioUpdateStationUI(id, 'Error (Open Player)', '▶');
      $("radioNowPlaying").textContent = 'Playback blocked — use Open Player';
      $("radioMasterToggle").textContent = '▶';
    }
  }

  // Pause current station
  function radioPauseAudio() {
    radioAudio.pause();
    isPlaying = false;
    if (currentStationId) {
      radioUpdateStationUI(currentStationId, 'Paused', '▶');
    }
    $("radioMasterToggle").textContent = '▶';
  }

  // Stop playback completely
  function radioStopAudio() {
    radioAudio.pause();
    radioAudio.removeAttribute('src');
    radioAudio.load();
    currentStationId = null;
    isPlaying = false;
    radioResetAllUI();
    $("radioNowPlaying").textContent = '—';
    $("radioMasterToggle").textContent = '▶';
  }

  // Toggle station (play/pause)
  function radioToggleStation(id) {
    if (id === currentStationId && isPlaying) {
      radioPauseAudio();
    } else {
      radioStartStation(id);
    }
  }

  // Render station list
  function radioRenderStations() {
    const container = $("radioStations");
    if (!container) return;

    container.innerHTML = RADIO_FEEDS.map(station => `
      <div class="radioStationRow">
        <button class="radioStationPlayBtn" data-radio-id="${station.id}" aria-label="Play ${station.name}">▶</button>
        <div class="radioStationMeta">
          <div class="radioStationName">${station.name}</div>
          <div id="radioStatus-${station.id}" class="radioStatus">Paused</div>
        </div>
        <a href="${station.pageUrl}" target="_blank" rel="noopener noreferrer" class="radioStationOpenLink">Open Player</a>
      </div>
    `).join('');

    // Attach click handlers to play buttons
    container.querySelectorAll('.radioStationPlayBtn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-radio-id');
        radioToggleStation(id);
      });
    });
  }

  // Wire master controls
  $("radioMasterToggle").addEventListener('click', () => {
    if (!currentStationId) {
      // No station selected, start first station
      radioStartStation(RADIO_FEEDS[0].id);
    } else if (isPlaying) {
      radioPauseAudio();
    } else {
      radioStartStation(currentStationId);
    }
  });

  $("radioStop").addEventListener('click', () => {
    radioStopAudio();
  });

  $("radioVolume").addEventListener('input', (e) => {
    radioAudio.volume = parseFloat(e.target.value);
  });

  // Audio event listeners (keep UI in sync)
  radioAudio.addEventListener('pause', () => {
    if (isPlaying && currentStationId) {
      isPlaying = false;
      radioUpdateStationUI(currentStationId, 'Paused', '▶');
      $("radioMasterToggle").textContent = '▶';
    }
  });

  radioAudio.addEventListener('playing', () => {
    if (!isPlaying && currentStationId) {
      isPlaying = true;
      radioUpdateStationUI(currentStationId, 'Playing', '⏸');
      $("radioMasterToggle").textContent = '⏸';
    }
  });

  radioAudio.addEventListener('ended', () => {
    isPlaying = false;
    if (currentStationId) {
      radioUpdateStationUI(currentStationId, 'Paused', '▶');
    }
    $("radioMasterToggle").textContent = '▶';
  });

  radioAudio.addEventListener('error', () => {
    if (currentStationId) {
      isPlaying = false;
      radioUpdateStationUI(currentStationId, 'Error (Open Player)', '▶');
      $("radioNowPlaying").textContent = 'Playback blocked — use Open Player';
      $("radioMasterToggle").textContent = '▶';
    }
  });

  // Initialize radio UI
  radioRenderStations();

  // -----------------------------
  // DOCK BAR NAVIGATION SYSTEM
  // -----------------------------
  const dockState = {
    isOpen: false,
    tab: "overview"
  };

  // Grab DOM elements
  const dockPanel = $("dockPanel");
  const dockOverlay = $("dockOverlay");
  const dockPanelTitle = $("dockPanelTitle");
  const dockPanelBody = $("dockPanelBody");
  const dockPanelClose = $("dockPanelClose");
  const dockButtons = Array.from(document.querySelectorAll(".dockBtn"));
  const dockTabs = Array.from(document.querySelectorAll(".dockTab"));

  // Helper: timestamp conversion
  function toTs(v) {
    if (!v) return 0;
    const d = new Date(v);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  // Helper: get all items as array
  function getAllItemsArray() {
    return Array.from(store.itemsById.values());
  }

  // Helper: format relative time
  function formatRelativeTime(ts) {
    if (!ts) return "unknown";
    const now = Date.now();
    const diff = now - ts;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  }

  // Summarize by category
  function summarizeByCategory(items) {
    const summary = {};
    items.forEach(item => {
      const cat = item.category || item.type || item.layer || "other";
      if (!summary[cat]) {
        summary[cat] = { count: 0, latestTs: 0, sampleItems: [] };
      }
      summary[cat].count++;
      const itemTs = toTs(item.ts || item.timestamp || item.published || item.updated);
      if (itemTs > summary[cat].latestTs) {
        summary[cat].latestTs = itemTs;
      }
      if (summary[cat].sampleItems.length < 5) {
        summary[cat].sampleItems.push(item);
      }
    });
    return summary;
  }

  // Summarize by source
  function summarizeBySource(items) {
    const summary = {};
    items.forEach(item => {
      const sourceId = item.sourceId || item.feedId || item.source || item.provider || "unknown";
      if (!summary[sourceId]) {
        summary[sourceId] = { count: 0, latestTs: 0 };
      }
      summary[sourceId].count++;
      const itemTs = toTs(item.ts || item.timestamp || item.published || item.updated);
      if (itemTs > summary[sourceId].latestTs) {
        summary[sourceId].latestTs = itemTs;
      }
    });
    return summary;
  }

  // Get source status
  function getSourceStatus(sourceId) {
    // Check if source has recent errors
    const hasErrors = healthTracker.recentErrors.some(err => err.source === sourceId);
    if (hasErrors) return "error";

    // Check if source is in backoff
    const backoffEntry = sourceBackoff.get(sourceId);
    if (backoffEntry && Date.now() < backoffEntry.nextAllowedMs) {
      return "backoff";
    }

    return "ok";
  }

  // Render Overview tab
  function renderOverviewHTML() {
    const allItems = getAllItemsArray();
    const totalItems = allItems.length;
    const filteredItems = allItems.filter(item => {
      const cat = item.category || item.type || item.layer || "other";
      return activeCategories.has(cat);
    });

    const categorySummary = summarizeByCategory(allItems);
    const hotCategories = Object.entries(categorySummary)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5);

    // Find newest item
    const newestItem = allItems.length > 0
      ? allItems.reduce((newest, item) => {
          const itemTs = toTs(item.ts || item.timestamp || item.published || item.updated);
          const newestTs = toTs(newest.ts || newest.timestamp || newest.published || newest.updated);
          return itemTs > newestTs ? item : newest;
        })
      : null;

    let html = `<div class="dockCard">`;
    html += `<div class="dockRow"><div class="dockRowLeft"><div class="dockRowTitle">Total Items</div></div><div class="dockBadge">${totalItems}</div></div>`;
    if (filteredItems.length !== totalItems) {
      html += `<div class="dockRow"><div class="dockRowLeft"><div class="dockRowTitle">Filtered Items</div></div><div class="dockBadge">${filteredItems.length}</div></div>`;
    }
    html += `</div>`;

    if (hotCategories.length > 0) {
      html += `<div class="dockSectionTitle">Hot Categories</div>`;
      html += `<div class="dockCard">`;
      hotCategories.forEach(([cat, data]) => {
        const catInfo = CATEGORIES[cat] || { label: cat, emoji: "📌" };
        html += `<div class="dockRow">`;
        html += `<div class="dockRowLeft">`;
        html += `<div class="dockRowTitle">${catInfo.emoji} ${catInfo.label}</div>`;
        html += `<div class="dockRowMeta">${formatRelativeTime(data.latestTs)}</div>`;
        html += `</div>`;
        html += `<div class="dockBadge">${data.count}</div>`;
        html += `</div>`;
      });
      html += `</div>`;
    }

    if (newestItem) {
      html += `<div class="dockSectionTitle">Newest Item</div>`;
      html += `<div class="dockCard">`;
      html += `<div class="dockRow" data-item-id="${escapeAttr(newestItem.id)}" style="cursor:pointer;">`;
      html += `<div class="dockRowLeft">`;
      html += `<div class="dockRowTitle">${escapeHtml(newestItem.title || newestItem.message || "Untitled")}</div>`;
      const newestTs = toTs(newestItem.ts || newestItem.timestamp || newestItem.published || newestItem.updated);
      html += `<div class="dockRowMeta">${formatRelativeTime(newestTs)} • ${escapeHtml(newestItem.source || newestItem.feedId || "Unknown")}</div>`;
      html += `</div>`;
      html += `</div>`;
      html += `</div>`;
    }

    html += `<button class="dockBtnSmall" id="dockRefreshAll">Refresh All</button>`;
    html += `<button class="dockBtnSmall" id="dockResetFilters">Reset Filters</button>`;

    return html;
  }

  // Render Categories tab
  function renderCategoriesHTML() {
    const allItems = getAllItemsArray();
    const categorySummary = summarizeByCategory(allItems);
    const sortedCategories = Object.entries(categorySummary)
      .sort((a, b) => b[1].count - a[1].count);

    let html = `<button class="dockBtnSmall" id="dockResetFiltersTop">Reset Filters</button>`;
    html += `<div class="dockSectionTitle">Categories (${sortedCategories.length})</div>`;

    sortedCategories.forEach(([cat, data]) => {
      const catInfo = CATEGORIES[cat] || { label: cat, emoji: "📌" };
      html += `<div class="dockCard">`;
      html += `<div class="dockRow" data-category="${escapeAttr(cat)}">`;
      html += `<div class="dockRowLeft">`;
      html += `<div class="dockRowTitle">${catInfo.emoji} ${catInfo.label}</div>`;
      html += `<div class="dockRowMeta">Latest: ${formatRelativeTime(data.latestTs)}</div>`;
      html += `</div>`;
      html += `<div class="dockBadge">${data.count}</div>`;
      html += `</div>`;
      html += `</div>`;
    });

    return html;
  }

  // Render Sources tab
  function renderSourcesHTML() {
    const allItems = getAllItemsArray();
    const sourceSummary = summarizeBySource(allItems);

    // Categorize sources into RSS vs API
    const rssSources = [];
    const apiSources = [];

    Object.entries(sourceSummary).forEach(([sourceId, data]) => {
      const isRSS = CONFIG.rss.some(feed => feed.id === sourceId) || sourceId.includes("rss");
      const entry = { sourceId, ...data };
      if (isRSS) {
        rssSources.push(entry);
      } else {
        apiSources.push(entry);
      }
    });

    rssSources.sort((a, b) => b.count - a.count);
    apiSources.sort((a, b) => b.count - a.count);

    let html = "";

    if (rssSources.length > 0) {
      html += `<div class="dockSectionTitle">RSS Feeds (${rssSources.length})</div>`;
      rssSources.forEach(source => {
        const status = getSourceStatus(source.sourceId);
        const statusClass = `status-${status}`;
        const statusLabel = status.toUpperCase();
        const feed = CONFIG.rss.find(f => f.id === source.sourceId);
        const name = feed ? feed.name : source.sourceId;

        html += `<div class="dockCard">`;
        html += `<div class="dockRow">`;
        html += `<div class="dockRowLeft">`;
        html += `<div class="dockRowTitle">${escapeHtml(name)}</div>`;
        html += `<div class="dockRowMeta">Latest: ${formatRelativeTime(source.latestTs)}</div>`;
        html += `</div>`;
        html += `<div style="display:flex;gap:6px;align-items:center;">`;
        html += `<div class="dockBadge ${statusClass}">${statusLabel}</div>`;
        html += `<div class="dockBadge">${source.count}</div>`;
        html += `</div>`;
        html += `</div>`;
        html += `</div>`;
      });
    }

    if (apiSources.length > 0) {
      html += `<div class="dockSectionTitle">APIs (${apiSources.length})</div>`;
      apiSources.forEach(source => {
        const status = getSourceStatus(source.sourceId);
        const statusClass = `status-${status}`;
        const statusLabel = status.toUpperCase();

        html += `<div class="dockCard">`;
        html += `<div class="dockRow">`;
        html += `<div class="dockRowLeft">`;
        html += `<div class="dockRowTitle">${escapeHtml(source.sourceId)}</div>`;
        html += `<div class="dockRowMeta">Latest: ${formatRelativeTime(source.latestTs)}</div>`;
        html += `</div>`;
        html += `<div style="display:flex;gap:6px;align-items:center;">`;
        html += `<div class="dockBadge ${statusClass}">${statusLabel}</div>`;
        html += `<div class="dockBadge">${source.count}</div>`;
        html += `</div>`;
        html += `</div>`;
        html += `</div>`;
      });
    }

    return html;
  }

  // Render System tab
  function renderSystemHTML() {
    const health = healthTracker.computeHealth();
    const staleCount = healthTracker.staleDataCount;

    let html = `<div class="dockCard">`;
    html += `<div class="dockRow">`;
    html += `<div class="dockRowLeft"><div class="dockRowTitle">System Status</div></div>`;
    const statusClass = health === "live" ? "status-ok" : health === "partial" ? "status-backoff" : "status-error";
    html += `<div class="dockBadge ${statusClass}">${health.toUpperCase()}</div>`;
    html += `</div>`;
    html += `<div class="dockRow">`;
    html += `<div class="dockRowLeft"><div class="dockRowTitle">Stale Data Count</div></div>`;
    html += `<div class="dockBadge">${staleCount}</div>`;
    html += `</div>`;
    html += `</div>`;

    // Recent errors
    if (healthTracker.recentErrors.length > 0) {
      html += `<div class="dockSectionTitle">Recent Errors (${healthTracker.recentErrors.length})</div>`;
      const errors = healthTracker.recentErrors.slice(0, 10);
      errors.forEach(err => {
        html += `<div class="dockCard">`;
        html += `<div class="dockRow">`;
        html += `<div class="dockRowLeft">`;
        html += `<div class="dockRowTitle">${escapeHtml(err.source)}</div>`;
        html += `<div class="dockRowMeta">${formatRelativeTime(err.timestamp)} • ${escapeHtml(err.message)}</div>`;
        html += `</div>`;
        html += `</div>`;
        html += `</div>`;
      });
    }

    // Backoff schedule
    const backoffEntries = Array.from(sourceBackoff.entries()).filter(([_, entry]) => Date.now() < entry.nextAllowedMs);
    if (backoffEntries.length > 0) {
      html += `<div class="dockSectionTitle">Backoff Schedule (${backoffEntries.length})</div>`;
      backoffEntries.forEach(([sourceId, entry]) => {
        const timeUntil = Math.ceil((entry.nextAllowedMs - Date.now()) / 60000);
        html += `<div class="dockCard">`;
        html += `<div class="dockRow">`;
        html += `<div class="dockRowLeft">`;
        html += `<div class="dockRowTitle">${escapeHtml(sourceId)}</div>`;
        html += `<div class="dockRowMeta">Resume in ${timeUntil}m • ${entry.consecutiveErrors} errors</div>`;
        html += `</div>`;
        html += `</div>`;
        html += `</div>`;
      });
    }

    return html;
  }

  // Main render function for dock tabs
  function htmlForDockTab(tab) {
    switch(tab) {
      case "overview": return renderOverviewHTML();
      case "categories": return renderCategoriesHTML();
      case "sources": return renderSourcesHTML();
      case "system": return renderSystemHTML();
      default: return "<p>Unknown tab</p>";
    }
  }

  // Tab title helper
  function titleForTab(tab) {
    const titles = {
      overview: "Overview",
      categories: "Categories",
      sources: "Sources",
      system: "System"
    };
    return titles[tab] || "Dock";
  }

  // Render dock content
  function renderDock() {
    dockPanelTitle.textContent = titleForTab(dockState.tab);
    dockPanelBody.innerHTML = htmlForDockTab(dockState.tab);

    // Update active tab styling
    dockTabs.forEach(tab => {
      if (tab.dataset.dock === dockState.tab) {
        tab.classList.add("isActive");
      } else {
        tab.classList.remove("isActive");
      }
    });

    // Re-bind click handlers for rendered content
    if (dockState.tab === "overview") {
      const refreshBtn = document.getElementById("dockRefreshAll");
      if (refreshBtn) {
        refreshBtn.addEventListener("click", () => {
          closeDock();
          refreshAll();
        });
      }

      const resetBtn = document.getElementById("dockResetFilters");
      if (resetBtn) {
        resetBtn.addEventListener("click", () => {
          resetCategoryFilters();
          renderDock(); // Re-render to show updated counts
        });
      }

      // Bind newest item click
      const newestRow = dockPanelBody.querySelector('[data-item-id]');
      if (newestRow) {
        newestRow.addEventListener("click", () => {
          const itemId = newestRow.dataset.itemId;
          closeDock();
          selectItem(itemId);
        });
      }
    }

    if (dockState.tab === "categories") {
      const resetBtn = document.getElementById("dockResetFiltersTop");
      if (resetBtn) {
        resetBtn.addEventListener("click", () => {
          resetCategoryFilters();
          renderDock();
        });
      }

      // Bind category rows
      dockPanelBody.querySelectorAll('[data-category]').forEach(row => {
        row.addEventListener("click", () => {
          const cat = row.dataset.category;
          soloCategory(cat);
          closeDock();
        });
      });
    }
  }

  // Open dock
  function openDock(tab) {
    dockState.isOpen = true;
    dockState.tab = tab;
    dockPanel.classList.add("isOpen");
    dockOverlay.classList.add("isOpen");
    dockPanel.setAttribute("aria-hidden", "false");
    dockOverlay.setAttribute("aria-hidden", "false");

    // Update button active states
    dockButtons.forEach(btn => {
      if (btn.dataset.dock === tab) {
        btn.classList.add("isActive");
        btn.setAttribute("aria-pressed", "true");
      } else {
        btn.classList.remove("isActive");
        btn.setAttribute("aria-pressed", "false");
      }
    });

    renderDock();
  }

  // Close dock
  function closeDock() {
    dockState.isOpen = false;
    dockPanel.classList.remove("isOpen");
    dockOverlay.classList.remove("isOpen");
    dockPanel.setAttribute("aria-hidden", "true");
    dockOverlay.setAttribute("aria-hidden", "true");

    // Update button active states
    dockButtons.forEach(btn => {
      btn.classList.remove("isActive");
      btn.setAttribute("aria-pressed", "false");
    });
  }

  // Toggle dock
  function toggleDock(tab) {
    if (!dockState.isOpen) {
      openDock(tab);
    } else if (dockState.tab === tab) {
      closeDock();
    } else {
      setDockTab(tab);
    }
  }

  // Set dock tab (when already open)
  function setDockTab(tab) {
    dockState.tab = tab;

    // Update button active states
    dockButtons.forEach(btn => {
      if (btn.dataset.dock === tab) {
        btn.classList.add("isActive");
        btn.setAttribute("aria-pressed", "true");
      } else {
        btn.classList.remove("isActive");
        btn.setAttribute("aria-pressed", "false");
      }
    });

    renderDock();
  }

  // Filter helpers
  function soloCategory(cat) {
    activeCategories.clear();
    activeCategories.add(cat);
    redraw();
  }

  function resetCategoryFilters() {
    activeCategories.clear();
    Object.keys(CATEGORIES).forEach(cat => activeCategories.add(cat));
    redraw();
  }

  // Wire dock button clicks
  dockButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.dock;
      toggleDock(tab);
    });
  });

  // Wire dock tab clicks
  dockTabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const tabName = tab.dataset.dock;
      setDockTab(tabName);
    });
  });

  // Wire close button
  dockPanelClose.addEventListener("click", () => {
    closeDock();
  });

  // Wire overlay click
  dockOverlay.addEventListener("click", () => {
    closeDock();
  });

  // Wire escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dockState.isOpen) {
      closeDock();
    }
  });

  // -----------------------------
  // Proxy Chip UI (USB Tether Mode Support)
  // -----------------------------
  (() => {
    const center = document.querySelector('.topbar__center');
    if (!center || document.getElementById('chipProxy')) return;

    // Create chip element
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.id = 'chipProxy';
    chip.title = 'Click to configure proxy server (for USB tether mode)';

    // Add icon
    const icon = document.createElement('span');
    icon.className = 'chip__icon';
    icon.textContent = '🔌';
    chip.appendChild(icon);

    // Add text
    const text = document.createElement('span');
    text.className = 'chip__text';
    text.id = 'proxyText';
    chip.appendChild(text);

    // Update chip text based on current proxy base
    function updateProxyChipText() {
      const current = getProxyBase();
      const defaultBase = defaultProxyBase();
      if (current === defaultBase) {
        text.textContent = 'Proxy: Auto';
      } else {
        try {
          const url = new URL(current);
          text.textContent = `Proxy: ${url.host}`;
        } catch {
          text.textContent = `Proxy: ${current}`;
        }
      }
    }

    // Add click handler
    chip.addEventListener('click', () => {
      const current = getProxyBase();
      const defaultBase = defaultProxyBase();
      const isCustom = current !== defaultBase;

      const promptMsg = isCustom
        ? `Current: ${current}\n\nSet Proxy Base (blank = auto/default).\nExample: http://192.168.42.1:8000`
        : 'Set Proxy Base (blank = auto/default).\nExample: http://192.168.42.1:8000';

      const input = prompt(promptMsg, isCustom ? current : '');

      if (input !== null) {
        setProxyBase(input);
      }
    });

    // Append to topbar center
    center.appendChild(chip);

    // Initial update
    updateProxyChipText();

    console.log('[Proxy] Initialized proxy chip UI. Current base:', getProxyBase());
  })();

  // Wire header chips to dock tabs
  $("chipLive").addEventListener("click", () => {
    openDock("system");
  });

  $("chipWeather").addEventListener("click", () => {
    openDock("overview");
  });

  $("chipTraffic").addEventListener("click", () => {
    openDock("sources");
  });

  // -----------------------------
  // Boot + timers
  // -----------------------------
  refreshAll();
  setInterval(pollRSS, CONFIG.polling.rss);
  setInterval(fetchNWS, CONFIG.polling.nws);
  setInterval(pollArcgisCrashes, CONFIG.polling.arcgisCrash);
  setInterval(pollVirginiaCrashData, CONFIG.polling.virginiaCrashData);
  setInterval(pollVa511, CONFIG.polling.va511);
  setInterval(fetchOpenUV, CONFIG.polling.openUV);
  setInterval(fetchCDC, CONFIG.polling.cdc);
})();