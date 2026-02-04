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
  // Desktop vs Mobile UI Detection
  // -----------------------------
  function computeIsMobileUI() {
    // Prefer capability-based detection: small screen + coarse pointer (phones/tablets)
    const mqlCoarse = window.matchMedia && window.matchMedia("(max-width: 899px) and (pointer: coarse)").matches;
    if (mqlCoarse) return true;

    // UA fallback for iPhone/Android/iPad (some iPads report differently depending on settings)
    const ua = navigator.userAgent || "";
    const uaMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobi/i.test(ua);

    // If it's a narrow window but pointer is fine (desktop), treat as desktop
    return uaMobile && window.matchMedia && window.matchMedia("(max-width: 899px)").matches;
  }

  let IS_MOBILE_UI = computeIsMobileUI();

  // -----------------------------
  // Config
  // -----------------------------
  const CONFIG = {
    // Primary map focus (Fredericksburg metro)
    center: { lat: 38.3032, lon: -77.4605 },
    zoom: 10,

    // Region filter bbox (expanded to include all data source areas: FXBG, Stafford, Spotsy, Caroline, Warrenton, etc.)
    bbox: { minLat: 37.9, maxLat: 38.9, minLon: -78.0, maxLon: -77.0 },

    // POI-specific bbox (bounds for schools, hospitals, clinics in FXBG metro area)
    // Expanded to include full K-12 schools dataset: lat 38.1285–38.5312, lon -77.6215–-77.3425
    poiBbox: { minLat: 38.12, maxLat: 38.54, minLon: -77.63, maxLon: -77.34 },

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

    location: {
      enabledByDefault: false,
      watchOptions: {
        enableHighAccuracy: true,
        timeout: 8000,
        maximumAge: 60000
      }
    },

    cameras: {
      refreshMinMs: 15000
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

    alertRules: {
      enabled: true,
      pollingMs: 60 * 1000,
      rules: [
        {
          id: "nearby-severe",
          label: "Nearby severe incidents",
          withinMiles: 5,
          minSeverity: 2,
          types: ["crash", "traffic", "closure", "road_closure", "fire_ems", "police_crime", "alerts"],
          sound: true,
          vibrate: true
        }
      ]
    },

    // CORS proxy rotation (browser-only)
    corsProxies: [],

    // Debug flags
    debug: {
      rss: true,  // Enable RSS feed ingestion debug logging
      rssGeo: false, // Enable location extraction pipeline debug logging (shows candidate scoring)
      chips: true, // Enable chip update debug logging
      poiCoords: false, // Enable POI coordinate display in popups (for verification)
      schools: false, // Enable schools diagnostics logging
      uiSanity: false // Enable UI sanity checks for critical elements (dev only)
    },

    // FXBG PD Crime Reports configuration
    fxbgCrimeReports: {
      enabled: true,
      months: 6,                        // Fetch last 6 months of reports
      polling: 5 * 60 * 1000,           // Poll every 5 minutes
      maxAgeHours: 720                  // 30 days for map display
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
      camerasGeojsonFallback: "https://files4.iteriscdn.com/WebApps/VA/SafeTravel/data/local/icons/metadata/icons.cameras_inactive.geojsonp",
      camerasGeojsonFallback2: "",
      // Primary incidents endpoint - may return HTML error pages during outages
      incidentsGeojson: "https://www.511virginia.org/data/geojson/icons.incident.geojson",
      // Fallback to Iteris CDN if main endpoint fails (JSONP format - auto-stripped)
      incidentsGeojsonFallback: "https://files5.iteriscdn.com/WebApps/VA/SafeTravel/data/local/icons/metadata/icons.incident.geojsonp",
      constructionGeojson: "https://www.511virginia.org/data/geojson/icons.construction.geojson",
      includeConstructionOnMap: false
    },


    // OpenUV API - UV Index data for Fredericksburg area
    openUV: {
      enabled: true,
      apiKey: null,  // Configured server-side via .env
      lat: 38.3032,
      lon: -77.4605,
      baseUrl: "/api/openuv"
    },

    // CDC Data API - Health/disease surveillance data
    cdc: {
      enabled: true,
      // CDC Wonder API - locality-specific health data
      wonderApiUrl: "https://data.cdc.gov/api/v3/views/psx4-wq38/query.json",
      wonderFallbackUrl: "https://data.cdc.gov/resource/psx4-wq38.json?$limit=50",
      maxAgeHours: 168  // Cache for 7 days
    },

    // Air Quality (AQICN/WAQI API)
    air: {
      enabled: true,
      lat: 38.3032,
      lon: -77.4605,
      token: null, // Configured server-side via .env
      baseUrl: "/api/waqi",
      refreshMs: 10 * 60 * 1000  // 10 minutes
    },

    // External cameras (WetMet API)
    externalCameras: {
      enabled: true,
      cacheTtlMs: 60_000,
      includeManualSchools: false, // Set to true to use manual school entries instead of NCES data
      cameras: [
        {
          id: "wetmet_wharf_dc",
          name: "The Wharf (Washington, DC)",
          lat: 38.879342,
          lon: -77.024661,
          url: "https://api.wetmet.net/91b95fbd-61c1-4949-8a07-0e5a2f64f0f2",
          type: "iframe"
        },
        {
          id: "wetmet_prince_william_marina",
          name: "Prince William Marina",
          lat: 38.662656,
          lon: -77.253073,
          url: "https://api.wetmet.net/widgets/stream/frame.php?uid=07f60c8f2db3b479f84d337088546af4",
          type: "iframe"
        },
        {
          id: "wetmet_reston",
          name: "Reston, VA",
          lat: 38.958631,
          lon: -77.357003,
          url: "https://api.wetmet.net/5ebfb9b0-12a9-4e02-888c-3fb204ac9d04",
          type: "iframe"
        },
        {
          id: "wetmet_loudoun_station",
          name: "Loudoun Station (Loudoun County, VA)",
          lat: 38.998021,
          lon: -77.475549,
          url: "https://api.wetmet.net/c3189678-8e98-46ee-8826-c9769396d138",
          type: "iframe"
        },
        {
          id: "oxblue_gmu",
          name: "GMU Institute (OxBlue)",
          lat: 38.8319,
          lon: -77.3070,
          url: "https://app.oxblue.com/?openlink=clarkconstruction/gmuinstitute",
          type: "link"
        },
        {
          id: "hope_springs_marina",
          name: "Hope Springs Marina",
          lat: 38.1839,
          lon: -77.1860,
          url: "http://hsm.hopto.me/view/viewer_index.shtml?id=52",
          type: "link"
        },
        {
          id: "webcamgalore_spotsylvania",
          name: "Spotsylvania, VA",
          lat: 38.1859,
          lon: -77.6526,
          url: "https://www.webcamgalore.com/webcam/USA/Spotsylvania-Virginia/24944.html",
          thumb: "https://images.webcamgalore.com/webcamimages/120x90/24944.jpg",
          type: "webcamgalore"
        },
        {
          id: "webcamgalore_ashburn",
          name: "Ashburn, VA",
          lat: 39.0438,
          lon: -77.4874,
          url: "https://www.webcamgalore.com/webcam/USA/Ashburn-Virginia/18982.html",
          thumb: "https://images.webcamgalore.com/webcamimages/120x90/18982.jpg",
          type: "webcamgalore"
        },
        {
          id: "webcamgalore_dc",
          name: "Washington, DC",
          lat: 38.9072,
          lon: -77.0369,
          url: "https://www.webcamgalore.com/webcam/USA/Washington-DC-District-of-Columbia/7237.html",
          thumb: "https://images.webcamgalore.com/webcamimages/120x90/7237.jpg",
          type: "webcamgalore"
        },
        {
          id: "webcamgalore_mclean",
          name: "McLean, VA",
          lat: 38.9338,
          lon: -77.1772,
          url: "https://www.webcamgalore.com/webcam/USA/McLean-Virginia/24972.html",
          thumb: "https://images.webcamgalore.com/webcamimages/120x90/24972.jpg",
          type: "webcamgalore"
        },
        {
          id: "webcamgalore_national_harbor",
          name: "National Harbor, MD",
          lat: 38.7826,
          lon: -77.0174,
          url: "https://www.webcamgalore.com/webcam/USA/National-Harbor-Maryland/20669.html",
          thumb: "https://images.webcamgalore.com/webcamimages/120x90/20669.jpg",
          type: "webcamgalore"
        },
        {
          id: "webcamgalore_king_george",
          name: "King George, VA",
          lat: 38.2662,
          lon: -77.1850,
          url: "https://www.webcamgalore.com/webcam/USA/King-George-Virginia/14217.html",
          thumb: "https://images.webcamgalore.com/webcamimages/120x90/14217.jpg",
          type: "webcamgalore"
        },
        // WeatherBug cameras covering the region
        {
          id: "weatherbug_spotsylvania",
          name: "Spotsylvania County, VA",
          lat: 38.1859,
          lon: -77.6526,
          url: "https://www.weatherbug.com/traffic-cam/?cam=CNVAB&zip=22553",
          thumb: "https://cam.weatherbug.com/images/cams/CNVAB_thumb.jpg",
          type: "weatherbug"
        },
        {
          id: "weatherbug_richmond",
          name: "Richmond, VA",
          lat: 37.5407,
          lon: -77.4360,
          url: "https://www.weatherbug.com/traffic-cam/?zip=23219",
          thumb: "https://cam.weatherbug.com/images/cams/RCHMX_thumb.jpg",
          type: "weatherbug"
        },
        {
          id: "weatherbug_chantilly",
          name: "Chantilly, VA",
          lat: 38.8941,
          lon: -77.4311,
          url: "https://www.weatherbug.com/traffic-cam/?zip=20151",
          thumb: "https://cam.weatherbug.com/images/cams/KCANT_thumb.jpg",
          type: "weatherbug"
        },
        {
          id: "weatherbug_ashburn",
          name: "Ashburn, VA",
          lat: 39.0437,
          lon: -77.4875,
          url: "https://www.weatherbug.com/traffic-cam/?zip=20147",
          thumb: "https://cam.weatherbug.com/images/cams/KASHA_thumb.jpg",
          type: "weatherbug"
        },
        {
          id: "weatherbug_dc",
          name: "Washington, DC",
          lat: 38.9072,
          lon: -77.0369,
          url: "https://www.weatherbug.com/traffic-cam/?zip=20001",
          thumb: "https://cam.weatherbug.com/images/cams/KWADC_thumb.jpg",
          type: "weatherbug"
        },
        {
          id: "weatherbug_mclean",
          name: "McLean, VA",
          lat: 38.9338,
          lon: -77.1772,
          url: "https://www.weatherbug.com/traffic-cam/?zip=22101",
          thumb: "https://cam.weatherbug.com/images/cams/KMCLX_thumb.jpg",
          type: "weatherbug"
        },
        {
          id: "weatherbug_national_harbor",
          name: "National Harbor, MD",
          lat: 38.7826,
          lon: -77.0174,
          url: "https://www.weatherbug.com/traffic-cam/?zip=20745",
          thumb: "https://cam.weatherbug.com/images/cams/KNHMD_thumb.jpg",
          type: "weatherbug"
        },
        // Police Departments
        {
          id: "police_fxbg",
          name: "Fredericksburg Police Department",
          lat: 38.3032,
          lon: -77.4605,
          url: "https://www.fredericksburgva.gov/322/Police-Department",
          type: "police",
          address: "Fredericksburg, VA"
        },
        {
          id: "police_spotsy",
          name: "Spotsylvania Sheriff's Office",
          lat: 38.2047,
          lon: -77.6078,
          url: "https://www.spotsylvania.va.us/162/Sheriffs-Office",
          type: "police",
          address: "Spotsylvania, VA"
        },
        {
          id: "police_stafford",
          name: "Stafford Sheriff's Office",
          lat: 38.4226,
          lon: -77.4083,
          url: "https://www.staffordcountyva.gov/162/Sheriffs-Office",
          type: "police",
          address: "Stafford, VA"
        },
        // Fire & Rescue
        {
          id: "fire_fxbg",
          name: "Fredericksburg Fire Department",
          lat: 38.3016,
          lon: -77.4601,
          url: "https://www.fredericksburgva.gov/150/Fire-Department",
          type: "fire",
          address: "Fredericksburg, VA"
        },
        {
          id: "fire_spotsy",
          name: "Spotsylvania Fire & Rescue",
          lat: 38.2043,
          lon: -77.6074,
          url: "https://www.spotsylvania.va.us/163/Fire-Rescue",
          type: "fire",
          address: "Spotsylvania, VA"
        },
        {
          id: "fire_stafford",
          name: "Stafford Fire & Rescue",
          lat: 38.4228,
          lon: -77.4080,
          url: "https://www.staffordcountyva.gov/503/Fire-Rescue",
          type: "fire",
          address: "Stafford, VA"
        },
        // Shelters
        {
          id: "shelter_fxbg_salvation",
          name: "Salvation Army - Fredericksburg Corps",
          lat: 38.3036,
          lon: -77.4624,
          url: "https://fredericksburg.salvationarmy.org/",
          type: "shelter",
          address: "Fredericksburg, VA"
        },
        {
          id: "shelter_thurman_br",
          name: "Thurman Brisben Center",
          lat: 38.3002,
          lon: -77.4677,
          url: "https://thurmanbrisbencenter.org/",
          type: "shelter",
          address: "Fredericksburg, VA"
        },
        // HOSPITALS - Major hospitals in the region
        {
          id: "hospital_mary_washington",
          name: "Mary Washington Hospital",
          lat: 38.3092,
          lon: -77.4838,
          url: "https://www.marywashingtonhealthcare.com/locations/mary-washington-hospital",
          type: "hospital",
          info: "1001 Sam Perry Blvd, Fredericksburg, VA 22401 | Emergency: (540) 741-1100",
          yearFounded: 1899,
          beds: 437,
          departments: ["Emergency Medicine", "Cardiology", "Oncology", "Orthopedics", "Neurology", "Women's Services", "Pediatrics", "Surgery"],
          services: "Level II Trauma Center, Heart & Vascular Center, Cancer Center, Orthopedic & Spine Institute, Emergency Services",
          specialties: "Cardiac Care, Cancer Treatment, Advanced Imaging, Robotic Surgery, Stroke Center",
          emergencyServices: "24/7 Emergency Department",
          address: "1001 Sam Perry Blvd, Fredericksburg, VA 22401",
          phone: "(540) 741-1100"
        },
        {
          id: "hospital_stafford",
          name: "Stafford Hospital Center",
          lat: 38.4394,
          lon: -77.4483,
          url: "https://www.marywashingtonhealthcare.com/locations/stafford-hospital",
          type: "hospital",
          info: "101 Hospital Center Blvd, Stafford, VA 22554 | Emergency: (540) 741-9000",
          yearFounded: 2009,
          beds: 100,
          departments: ["Emergency Medicine", "Medical/Surgical", "Intensive Care", "Imaging", "Laboratory", "Cardiology"],
          services: "Emergency Care, Inpatient Care, Medical Imaging, Laboratory Services, Cardiac Catheterization",
          specialties: "Emergency Care, Critical Care, Diagnostic Imaging, Cardiac Services",
          emergencyServices: "24/7 Emergency Department",
          address: "101 Hospital Center Blvd, Stafford, VA 22554",
          phone: "(540) 741-9000"
        },
        {
          id: "hospital_spotsylvania",
          name: "Spotsylvania Regional Medical Center",
          lat: 38.1928,
          lon: -77.5894,
          url: "https://www.mystronghealth.com/",
          type: "hospital",
          info: "4600 Spotsylvania Pkwy, Fredericksburg, VA 22408 | Emergency: (540) 498-4000",
          yearFounded: 2010,
          beds: 130,
          departments: ["Emergency Medicine", "Surgery", "Medical/Surgical", "Intensive Care", "Maternity", "Imaging", "Rehabilitation"],
          services: "Emergency Care, Surgical Services, Maternity Care, ICU, Rehabilitation Services, Advanced Imaging",
          specialties: "Women's Services, Emergency Medicine, Surgical Care, Critical Care, Imaging & Diagnostics",
          emergencyServices: "24/7 Emergency Department",
          address: "4600 Spotsylvania Pkwy, Fredericksburg, VA 22408",
          phone: "(540) 498-4000"
        },
        {
          id: "hospital_uva_culpeper",
          name: "UVA Culpeper Hospital",
          lat: 38.4652,
          lon: -77.9986,
          url: "https://uvahealth.com/locations/uva-culpeper-hospital",
          type: "hospital",
          info: "501 Sunset Ln, Culpeper, VA 22701 | Emergency: (540) 829-4100",
          yearFounded: 1952,
          beds: 70,
          departments: ["Emergency Medicine", "Surgery", "Medical/Surgical", "Intensive Care", "Imaging", "Cardiology", "Oncology"],
          services: "Emergency Care, Surgical Services, Cancer Care, Heart & Vascular Care, Imaging Services, ICU",
          specialties: "UVA Health Network Affiliation, Cancer Care, Cardiac Services, Emergency Medicine, Advanced Surgery",
          emergencyServices: "24/7 Emergency Department",
          address: "501 Sunset Ln, Culpeper, VA 22701",
          phone: "(540) 829-4100"
        },
        {
          id: "hospital_mary_washington_fredericksburg_outpatient",
          name: "Mary Washington Healthcare Outpatient Center",
          lat: 38.2854,
          lon: -77.5163,
          url: "https://www.marywashingtonhealthcare.com/locations/fredericksburg-outpatient-center",
          type: "clinic",
          info: "2300 Fall Hill Ave, Fredericksburg, VA 22401 | (540) 741-3340",
          yearFounded: 2005,
          services: "Outpatient Surgery, Imaging Services, Lab Services, Specialty Clinics, Physical Therapy",
          specialties: "Same-Day Surgery, Advanced Imaging, Diagnostic Services, Rehabilitation",
          hours: "Monday-Friday: 7:00 AM - 5:00 PM",
          address: "2300 Fall Hill Ave, Fredericksburg, VA 22401",
          phone: "(540) 741-3340"
        },
        {
          id: "hospital_lake_of_woods_emergency",
          name: "Lake of the Woods Emergency Center",
          lat: 38.3458,
          lon: -77.7139,
          url: "https://www.marywashingtonhealthcare.com/locations/lake-of-the-woods-emergency-center",
          type: "clinic",
          info: "11617 Lake of the Woods Dr, Locust Grove, VA 22508 | Emergency: (540) 972-2800",
          yearFounded: 2015,
          services: "Emergency Care, Urgent Care, X-Ray & Imaging, Lab Services, Minor Surgery",
          specialties: "24/7 Emergency Services, Fast Track Care, Advanced Diagnostics",
          hours: "24/7 Emergency Services",
          address: "11617 Lake of the Woods Dr, Locust Grove, VA 22508",
          phone: "(540) 972-2800"
        },
        // CLINICS - Major clinics and urgent care centers
        {
          id: "clinic_patient_first_fredericksburg",
          name: "Patient First - Fredericksburg",
          lat: 38.2716,
          lon: -77.5247,
          url: "https://www.patientfirst.com/",
          type: "clinic",
          info: "2401 Cowan Blvd, Fredericksburg, VA 22401 | Urgent Care: (540) 368-7080",
          yearFounded: 2001,
          services: "Urgent Care, Primary Care, X-Ray, Lab Work, Occupational Health, Vaccinations",
          specialties: "Walk-In Care, No Appointment Needed, Extended Hours, Minor Injuries & Illnesses",
          hours: "Monday-Friday: 8:00 AM - 10:00 PM, Weekends: 8:00 AM - 8:00 PM",
          address: "2401 Cowan Blvd, Fredericksburg, VA 22401",
          phone: "(540) 368-7080"
        },
        {
          id: "clinic_patient_first_stafford",
          name: "Patient First - Stafford",
          lat: 38.4223,
          lon: -77.4297,
          url: "https://www.patientfirst.com/",
          type: "clinic",
          info: "77 Garrisonville Rd, Stafford, VA 22554 | Urgent Care: (540) 659-3800",
          yearFounded: 2003,
          services: "Urgent Care, Primary Care, X-Ray, Lab Services, Occupational Medicine, Immunizations",
          specialties: "Same-Day Care, Walk-Ins Welcome, Extended Evening Hours, Full Lab & Imaging",
          hours: "Monday-Friday: 8:00 AM - 10:00 PM, Weekends: 8:00 AM - 8:00 PM",
          address: "77 Garrisonville Rd, Stafford, VA 22554",
          phone: "(540) 659-3800"
        },
        {
          id: "clinic_patient_first_spotsylvania",
          name: "Patient First - Spotsylvania",
          lat: 38.1915,
          lon: -77.5905,
          url: "https://www.patientfirst.com/",
          type: "clinic",
          info: "4620 Southpoint Pkwy, Fredericksburg, VA 22407 | Urgent Care: (540) 786-4357",
          yearFounded: 2008,
          services: "Urgent Care, Family Medicine, Digital X-Ray, Laboratory, Workers' Comp, Travel Medicine",
          specialties: "No Wait Times, Walk-In Friendly, Full Diagnostic Services, Family Care",
          hours: "Monday-Friday: 8:00 AM - 10:00 PM, Weekends: 8:00 AM - 8:00 PM",
          address: "4620 Southpoint Pkwy, Fredericksburg, VA 22407",
          phone: "(540) 786-4357"
        },
        {
          id: "clinic_medexpress_fredericksburg",
          name: "MedExpress Urgent Care - Fredericksburg",
          lat: 38.2534,
          lon: -77.5568,
          url: "https://www.medexpress.com/",
          type: "clinic",
          info: "9900 Southpoint Centre Blvd, Fredericksburg, VA 22407 | (540) 693-9355",
          yearFounded: 2012,
          services: "Urgent Care, Occupational Health, X-Ray & Imaging, Lab Testing, Physicals, Vaccinations",
          specialties: "Extended Hours, Online Check-In, Employer Services, Sports Physicals",
          hours: "Monday-Friday: 8:00 AM - 8:00 PM, Weekends: 8:00 AM - 5:00 PM",
          address: "9900 Southpoint Centre Blvd, Fredericksburg, VA 22407",
          phone: "(540) 693-9355"
        },
        {
          id: "clinic_medexpress_stafford",
          name: "MedExpress Urgent Care - Stafford",
          lat: 38.4614,
          lon: -77.4403,
          url: "https://www.medexpress.com/",
          type: "clinic",
          info: "1248 Stafford Market Pl, Stafford, VA 22556 | (540) 288-4650",
          yearFounded: 2014,
          services: "Urgent Care, Work Health, Imaging Services, Lab Work, DOT Physicals, Flu Shots",
          specialties: "Quick Service, Online Scheduling, Workplace Wellness, Comprehensive Care",
          hours: "Monday-Friday: 8:00 AM - 8:00 PM, Weekends: 8:00 AM - 5:00 PM",
          address: "1248 Stafford Market Pl, Stafford, VA 22556",
          phone: "(540) 288-4650"
        },
        // SCHOOLS - FREDERICKSBURG
        {
          id: "school_james_monroe_hs",
          name: "James Monroe High School",
          lat: 38.2955,
          lon: -77.4743,
          url: "https://jmhs.cityschools.com/",
          type: "school",
          info: "2300 Washington Ave, Fredericksburg, VA 22401 | High School | (540) 372-1140",
          yearFounded: 1958,
          enrollment: 1450,
          grades: "9-12",
          mascot: "Yellow Jackets",
          colors: "Blue & Gold",
          sports: "Football, Basketball, Soccer, Baseball, Softball, Track & Field, Cross Country, Tennis, Golf, Wrestling, Volleyball, Swimming, Lacrosse",
          achievements: "Virginia State Football Championship (2019), Multiple Regional Titles, Academic Excellence Awards",
          programs: "Advanced Placement (AP), Dual Enrollment, Career & Technical Education, STEM Academy, Arts & Humanities",
          specialPrograms: "International Baccalaureate Prep, Engineering & Technology, Healthcare Sciences, Business & Finance",
          address: "2300 Washington Ave, Fredericksburg, VA 22401",
          phone: "(540) 372-1140"
        },
        {
          id: "school_walker_grant_ms",
          name: "Walker-Grant Middle School",
          lat: 38.3095,
          lon: -77.4645,
          url: "https://wgms.cityschools.com/",
          type: "school",
          info: "401 Wicklow Dr, Fredericksburg, VA 22405 | Middle School | (540) 372-1160",
          yearFounded: 1992,
          enrollment: 850,
          grades: "6-8",
          mascot: "Dragons",
          colors: "Green & White",
          sports: "Basketball, Soccer, Track, Cross Country, Volleyball, Wrestling",
          achievements: "SOL Excellence Awards, National Junior Honor Society, STEM Competition Winners",
          programs: "STEM Enrichment, Band & Orchestra, Visual Arts, World Languages (Spanish, French)",
          specialPrograms: "Gifted & Talented, Advanced Math & Science, Technology Integration",
          address: "401 Wicklow Dr, Fredericksburg, VA 22405",
          phone: "(540) 372-1160"
        },
        {
          id: "school_hugh_mercer_es",
          name: "Hugh Mercer Elementary",
          lat: 38.2934,
          lon: -77.4822,
          url: "https://hmes.cityschools.com/",
          type: "school",
          info: "1700 College Ave, Fredericksburg, VA 22401 | Elementary | (540) 372-1170",
          yearFounded: 1921,
          enrollment: 480,
          grades: "K-5",
          mascot: "Generals",
          colors: "Red & Blue",
          sports: "Youth Sports Programs, Physical Education",
          achievements: "Blue Ribbon School, SOL Pass Rate Excellence, Community Service Awards",
          programs: "Reading Recovery, STEAM Education, Music & Art, Library Media",
          specialPrograms: "ESL Support, Special Education Services, Before & After School Care",
          address: "1700 College Ave, Fredericksburg, VA 22401",
          phone: "(540) 372-1170"
        },
        {
          id: "school_lafayette_upper_es",
          name: "Lafayette Upper Elementary",
          lat: 38.3204,
          lon: -77.4599,
          url: "https://lues.cityschools.com/",
          type: "school",
          info: "512 Kenmore Ave, Fredericksburg, VA 22405 | Elementary | (540) 372-1180",
          yearFounded: 1994,
          enrollment: 520,
          grades: "3-5",
          mascot: "Patriots",
          colors: "Blue & Gold",
          sports: "Intramural Sports, PE Programs",
          achievements: "Virginia Index of Performance Excellence, Academic Achievement Recognition",
          programs: "Technology Integration, Science Lab, Art & Music Education, Guidance Services",
          specialPrograms: "Advanced Learner Programs, Reading Intervention, Math Enrichment",
          address: "512 Kenmore Ave, Fredericksburg, VA 22405",
          phone: "(540) 372-1180"
        },
        // SCHOOLS - STAFFORD COUNTY
        {
          id: "school_stafford_hs",
          name: "Stafford High School",
          lat: 38.4297,
          lon: -77.4481,
          url: "https://www.staffordschools.net/",
          type: "school",
          info: "33 Stafford Indians Ln, Falmouth, VA 22405 | High School | (540) 658-6000",
          yearFounded: 1960,
          enrollment: 1650,
          grades: "9-12",
          mascot: "Indians",
          colors: "Red & White",
          sports: "Football, Basketball, Baseball, Softball, Soccer, Lacrosse, Track & Field, Swimming, Wrestling, Tennis, Golf, Volleyball, Cross Country",
          achievements: "Multiple State Championships, Regional Academic Excellence, National Honor Society Chapter",
          programs: "Advanced Placement (AP), Dual Enrollment with UMW, STEM Programs, Career & Technical Education",
          specialPrograms: "Engineering Academy, Cybersecurity Program, Healthcare Sciences, Advanced Math & Science",
          address: "33 Stafford Indians Ln, Falmouth, VA 22405",
          phone: "(540) 658-6000"
        },
        {
          id: "school_north_stafford_hs",
          name: "North Stafford High School",
          lat: 38.4783,
          lon: -77.4633,
          url: "https://www.staffordschools.net/",
          type: "school",
          info: "839 Garrisonville Rd, Stafford, VA 22556 | High School | (540) 658-6100",
          yearFounded: 1995,
          enrollment: 2100,
          grades: "9-12",
          mascot: "Wolverines",
          colors: "Blue & Silver",
          sports: "Football, Basketball, Baseball, Softball, Soccer, Lacrosse, Swimming, Wrestling, Track, Cross Country, Tennis, Golf, Volleyball, Cheerleading",
          achievements: "State Championship Titles, Top Academic Rankings, National Merit Scholars",
          programs: "International Baccalaureate (IB), AP Courses, Dual Enrollment, CTE Programs, Fine Arts",
          specialPrograms: "IB Diploma Programme, Advanced Engineering, Medical Sciences, Business & IT",
          address: "839 Garrisonville Rd, Stafford, VA 22556",
          phone: "(540) 658-6100"
        },
        {
          id: "school_colonial_forge_hs",
          name: "Colonial Forge High School",
          lat: 38.4428,
          lon: -77.4975,
          url: "https://www.staffordschools.net/",
          type: "school",
          info: "550 East Rocks Rd, Stafford, VA 22554 | High School | (540) 658-6200",
          yearFounded: 2006,
          enrollment: 2250,
          grades: "9-12",
          mascot: "Eagles",
          colors: "Navy Blue & Vegas Gold",
          sports: "Football, Basketball, Soccer, Baseball, Softball, Lacrosse, Swimming, Track & Field, Wrestling, Tennis, Golf, Volleyball, Cross Country, Cheerleading",
          achievements: "State Championships in Multiple Sports, Academic Excellence Awards, Award-Winning Arts Programs",
          programs: "Advanced Placement (AP), Dual Enrollment, STEM Academy, Arts & Communications",
          specialPrograms: "Engineering & Technology, Computer Science, Healthcare Sciences, Business Academy",
          address: "550 East Rocks Rd, Stafford, VA 22554",
          phone: "(540) 658-6200"
        },
        {
          id: "school_brooke_point_hs",
          name: "Brooke Point High School",
          lat: 38.4025,
          lon: -77.3800,
          url: "https://www.staffordschools.net/",
          type: "school",
          info: "1700 Courthouse Rd, Stafford, VA 22554 | High School | (540) 658-6500",
          yearFounded: 2010,
          enrollment: 2400,
          grades: "9-12",
          mascot: "Black-Hawks",
          colors: "Black & Columbia Blue",
          sports: "Football, Basketball, Soccer, Baseball, Softball, Lacrosse, Track & Field, Swimming, Wrestling, Tennis, Golf, Volleyball, Cross Country",
          achievements: "Regional Championships, SOL Excellence, Growing Athletic & Academic Programs",
          programs: "AP Courses, Dual Enrollment, Career & Technical Education, STEM Focus",
          specialPrograms: "Cyber Security, Engineering, Advanced Sciences, Business & Finance",
          address: "1700 Courthouse Rd, Stafford, VA 22554",
          phone: "(540) 658-6500"
        },
        {
          id: "school_mountain_view_hs",
          name: "Mountain View High School",
          lat: 38.3914,
          lon: -77.5558,
          url: "https://www.staffordschools.net/",
          type: "school",
          info: "2135 Mountain View Rd, Stafford, VA 22556 | High School | (540) 658-6800",
          yearFounded: 2015,
          enrollment: 1850,
          grades: "9-12",
          mascot: "Wildcats",
          colors: "Purple & Silver",
          sports: "Football, Basketball, Soccer, Baseball, Softball, Lacrosse, Track & Field, Swimming, Volleyball, Tennis, Cross Country",
          achievements: "Newest School in District, Rapidly Growing Programs, Modern Facilities",
          programs: "Advanced Placement (AP), Dual Enrollment, STEM Programs, Arts Education",
          specialPrograms: "Technology Integration, Engineering, Science Research, Career Pathways",
          address: "2135 Mountain View Rd, Stafford, VA 22556",
          phone: "(540) 658-6800"
        },
        {
          id: "school_park_ridge_es",
          name: "Park Ridge Elementary",
          lat: 38.4628,
          lon: -77.4556,
          url: "https://www.staffordschools.net/",
          type: "school",
          info: "350 Garrisonville Rd, Stafford, VA 22554 | Elementary | (540) 658-6300",
          yearFounded: 2002,
          enrollment: 680,
          grades: "K-5",
          mascot: "Panthers",
          colors: "Blue & Gold",
          sports: "Youth Sports Programs, Physical Education",
          achievements: "SOL Excellence, Community Partnership Awards, Technology Integration Recognition",
          programs: "STEAM Education, Music & Arts, Library Media, Physical Education",
          specialPrograms: "Gifted Programs, Special Education, ESL Services, Extended Day Programs",
          address: "350 Garrisonville Rd, Stafford, VA 22554",
          phone: "(540) 658-6300"
        },
        // SCHOOLS - SPOTSYLVANIA COUNTY
        {
          id: "school_chancellor_hs",
          name: "Chancellor High School",
          lat: 38.2858,
          lon: -77.5833,
          url: "https://www.spotsylvania.k12.va.us/",
          type: "school",
          info: "6300 Harrison Rd, Fredericksburg, VA 22407 | High School | (540) 898-8700",
          yearFounded: 2004,
          enrollment: 1750,
          grades: "9-12",
          mascot: "Chargers",
          colors: "Navy Blue & Silver",
          sports: "Football, Basketball, Soccer, Baseball, Softball, Lacrosse, Track & Field, Cross Country, Wrestling, Tennis, Golf, Volleyball, Swimming",
          achievements: "Academic Excellence Awards, Regional Athletic Championships, Award-Winning Band Program",
          programs: "Advanced Placement (AP), Dual Enrollment, STEM Programs, Career & Technical Education, Arts",
          specialPrograms: "Engineering & Technology, Computer Science, Healthcare Sciences, Business Programs",
          address: "6300 Harrison Rd, Fredericksburg, VA 22407",
          phone: "(540) 898-8700"
        },
        {
          id: "school_courtland_hs",
          name: "Courtland High School",
          lat: 38.1775,
          lon: -77.5531,
          url: "https://www.spotsylvania.k12.va.us/",
          type: "school",
          info: "6901 Smith Station Rd, Spotsylvania, VA 22553 | High School | (540) 898-8800",
          yearFounded: 2001,
          enrollment: 1900,
          grades: "9-12",
          mascot: "Cougars",
          colors: "Purple & Gold",
          sports: "Football, Basketball, Soccer, Baseball, Softball, Lacrosse, Track & Field, Cross Country, Wrestling, Tennis, Golf, Volleyball, Cheerleading",
          achievements: "State Championships, SOL Excellence, National Honor Society Recognition",
          programs: "AP Courses, Dual Enrollment, STEM Academy, Career & Technical Education, Fine Arts",
          specialPrograms: "Advanced Sciences, Engineering Programs, Medical Sciences, IT & Cybersecurity",
          address: "6901 Smith Station Rd, Spotsylvania, VA 22553",
          phone: "(540) 898-8800"
        },
        {
          id: "school_massaponax_hs",
          name: "Massaponax High School",
          lat: 38.3217,
          lon: -77.5164,
          url: "https://www.spotsylvania.k12.va.us/",
          type: "school",
          info: "8201 Jefferson Davis Hwy, Fredericksburg, VA 22407 | High School | (540) 898-8900",
          yearFounded: 1978,
          enrollment: 1550,
          grades: "9-12",
          mascot: "Panthers",
          colors: "Black & Vegas Gold",
          sports: "Football, Basketball, Baseball, Softball, Soccer, Lacrosse, Track & Field, Wrestling, Cross Country, Tennis, Golf, Volleyball",
          achievements: "Multiple State Titles, Academic Achievement Awards, Distinguished Athletic Programs",
          programs: "Advanced Placement (AP), Dual Enrollment, CTE Programs, JROTC, Arts Programs",
          specialPrograms: "Military Science (JROTC), Engineering, Healthcare Sciences, Business Academy",
          address: "8201 Jefferson Davis Hwy, Fredericksburg, VA 22407",
          phone: "(540) 898-8900"
        },
        {
          id: "school_riverbend_hs",
          name: "Riverbend High School",
          lat: 38.2194,
          lon: -77.6267,
          url: "https://www.spotsylvania.k12.va.us/",
          type: "school",
          info: "11801 Scotts Hill Rd, Fredericksburg, VA 22407 | High School | (540) 898-9000",
          yearFounded: 2008,
          enrollment: 2050,
          grades: "9-12",
          mascot: "Bears",
          colors: "Columbia Blue & Black",
          sports: "Football, Basketball, Soccer, Baseball, Softball, Lacrosse, Track & Field, Swimming, Wrestling, Tennis, Golf, Volleyball, Cross Country",
          achievements: "State Championships, Academic Excellence Recognition, Growing Athletic Programs",
          programs: "Advanced Placement (AP), Dual Enrollment, STEM Focus, Career & Technical Education",
          specialPrograms: "Engineering & Technology, Advanced Sciences, Computer Programming, Healthcare",
          address: "11801 Scotts Hill Rd, Fredericksburg, VA 22407",
          phone: "(540) 898-9000"
        },
        {
          id: "school_spotsylvania_hs",
          name: "Spotsylvania High School",
          lat: 38.1989,
          lon: -77.6681,
          url: "https://www.spotsylvania.k12.va.us/",
          type: "school",
          info: "8020 Courthouse Rd, Spotsylvania, VA 22553 | High School | (540) 898-9100",
          yearFounded: 1968,
          enrollment: 1450,
          grades: "9-12",
          mascot: "Knights",
          colors: "Red & White",
          sports: "Football, Basketball, Soccer, Baseball, Softball, Track & Field, Cross Country, Wrestling, Tennis, Golf, Volleyball",
          achievements: "Longstanding Traditions, Regional Championships, Academic Achievement",
          programs: "Advanced Placement (AP), Dual Enrollment, Career & Technical Education, Arts Programs",
          specialPrograms: "Engineering, Computer Science, Agricultural Sciences, Business & Finance",
          address: "8020 Courthouse Rd, Spotsylvania, VA 22553",
          phone: "(540) 898-9100"
        },
        // SCHOOLS - CULPEPER COUNTY
        {
          id: "school_culpeper_county_hs",
          name: "Culpeper County High School",
          lat: 38.4625,
          lon: -77.9833,
          url: "https://www.culpeperschools.org/",
          type: "school",
          info: "14240 Achievement Dr, Culpeper, VA 22701 | High School | (540) 829-6700",
          yearFounded: 2013,
          enrollment: 1800,
          grades: "9-12",
          mascot: "Blue Devils",
          colors: "Blue & White",
          sports: "Football, Basketball, Soccer, Baseball, Softball, Track & Field, Cross Country, Wrestling, Tennis, Golf, Volleyball",
          achievements: "Modern Facility, Regional Championships, Academic Excellence Programs",
          programs: "Advanced Placement (AP), Dual Enrollment, Career & Technical Education, STEM Programs",
          specialPrograms: "Engineering & Technology, Healthcare Sciences, Agricultural Sciences, Business Academy",
          address: "14240 Achievement Dr, Culpeper, VA 22701",
          phone: "(540) 829-6700"
        },
        {
          id: "school_eastern_view_hs",
          name: "Eastern View High School",
          lat: 38.4281,
          lon: -77.8928,
          url: "https://www.culpeperschools.org/",
          type: "school",
          info: "16332 Cyclone Way, Culpeper, VA 22701 | High School | (540) 829-6800",
          yearFounded: 2008,
          enrollment: 1600,
          grades: "9-12",
          mascot: "Cyclones",
          colors: "Green & Gold",
          sports: "Football, Basketball, Soccer, Baseball, Softball, Track & Field, Cross Country, Wrestling, Tennis, Volleyball, Golf",
          achievements: "Growing Athletic Programs, Academic Recognition, State-of-the-Art Facilities",
          programs: "AP Courses, Dual Enrollment, Career & Technical Education, Fine Arts Programs",
          specialPrograms: "Advanced STEM, Computer Science, Healthcare Programs, Agricultural Education",
          address: "16332 Cyclone Way, Culpeper, VA 22701",
          phone: "(540) 829-6800"
        },
        {
          id: "school_culpeper_ms",
          name: "Culpeper Middle School",
          lat: 38.4697,
          lon: -77.9958,
          url: "https://www.culpeperschools.org/",
          type: "school",
          info: "450 Radio Ln, Culpeper, VA 22701 | Middle School | (540) 829-6600",
          yearFounded: 1998,
          enrollment: 950,
          grades: "6-8",
          mascot: "Mustangs",
          colors: "Purple & Gold",
          sports: "Basketball, Soccer, Track, Cross Country, Volleyball, Wrestling",
          achievements: "SOL Excellence, Positive Behavior Programs, Academic Achievement Recognition",
          programs: "Pre-AP Courses, STEM Education, Band & Orchestra, Art Programs, World Languages",
          specialPrograms: "Gifted & Talented, Advanced Math & Science, Technology Integration",
          address: "450 Radio Ln, Culpeper, VA 22701",
          phone: "(540) 829-6600"
        },
        // SCHOOLS - CAROLINE COUNTY
        {
          id: "school_caroline_hs",
          name: "Caroline High School",
          lat: 38.0567,
          lon: -77.4103,
          url: "https://www.ccps.us/",
          type: "school",
          info: "19191 Rogers Clark Blvd, Milford, VA 22514 | High School | (804) 633-5194",
          yearFounded: 1959,
          enrollment: 950,
          grades: "9-12",
          mascot: "Cavaliers",
          colors: "Orange & Black",
          sports: "Football, Basketball, Soccer, Baseball, Softball, Track & Field, Cross Country, Wrestling, Volleyball",
          achievements: "Regional Championships, Academic Excellence, Strong Community Support",
          programs: "Advanced Placement (AP), Dual Enrollment, Career & Technical Education, Arts Programs",
          specialPrograms: "Agricultural Sciences, Engineering & Technology, Healthcare Sciences, Business",
          address: "19191 Rogers Clark Blvd, Milford, VA 22514",
          phone: "(804) 633-5194"
        },
        {
          id: "school_caroline_ms",
          name: "Caroline Middle School",
          lat: 38.0519,
          lon: -77.4150,
          url: "https://www.ccps.us/",
          type: "school",
          info: "19219 Rogers Clark Blvd, Milford, VA 22514 | Middle School | (804) 633-5306",
          yearFounded: 1992,
          enrollment: 650,
          grades: "6-8",
          mascot: "Crusaders",
          colors: "Blue & Gold",
          sports: "Basketball, Soccer, Track, Volleyball, Wrestling",
          achievements: "SOL Achievement, Character Education Programs, Community Involvement",
          programs: "STEM Education, Band & Music, Art Programs, Physical Education, Technology",
          specialPrograms: "Advanced Academics, Special Education Services, ESL Programs",
          address: "19219 Rogers Clark Blvd, Milford, VA 22514",
          phone: "(804) 633-5306"
        },
        {
          id: "school_dawn_elementary",
          name: "Dawn Elementary",
          lat: 38.1378,
          lon: -77.3417,
          url: "https://www.ccps.us/",
          type: "school",
          info: "24121 Rogers Clark Blvd, Ruther Glen, VA 22546 | Elementary | (804) 633-5252",
          yearFounded: 2001,
          enrollment: 550,
          grades: "K-5",
          mascot: "Dolphins",
          colors: "Teal & Navy",
          sports: "Youth Sports Programs, Physical Education",
          achievements: "SOL Excellence, Positive School Climate, Parent Engagement Awards",
          programs: "STEAM Education, Reading Programs, Music & Art, Library Media, PE",
          specialPrograms: "Gifted Programs, Reading Recovery, Special Education, Technology Integration",
          address: "24121 Rogers Clark Blvd, Ruther Glen, VA 22546",
          phone: "(804) 633-5252"
        },
        // SCHOOLS - KING GEORGE COUNTY
        {
          id: "school_king_george_hs",
          name: "King George High School",
          lat: 38.2781,
          lon: -77.1847,
          url: "https://www.kgcs.k12.va.us/",
          type: "school",
          info: "6901 Courthouse Ln, King George, VA 22485 | High School | (540) 775-3598",
          yearFounded: 1971,
          enrollment: 1100,
          grades: "9-12",
          mascot: "Foxes",
          colors: "Orange & Black",
          sports: "Football, Basketball, Soccer, Baseball, Softball, Track & Field, Cross Country, Wrestling, Tennis, Volleyball, Golf",
          achievements: "Regional Athletic Success, Academic Excellence, Strong Arts Programs",
          programs: "Advanced Placement (AP), Dual Enrollment, Career & Technical Education, Arts & Music",
          specialPrograms: "STEM Programs, Engineering, Healthcare Sciences, Agricultural Education",
          address: "6901 Courthouse Ln, King George, VA 22485",
          phone: "(540) 775-3598"
        },
        {
          id: "school_king_george_ms",
          name: "King George Middle School",
          lat: 38.2736,
          lon: -77.1800,
          url: "https://www.kgcs.k12.va.us/",
          type: "school",
          info: "6798 Kings Hwy, King George, VA 22485 | Middle School | (540) 775-7846",
          yearFounded: 1988,
          enrollment: 750,
          grades: "6-8",
          mascot: "Falcons",
          colors: "Blue & White",
          sports: "Basketball, Soccer, Track, Cross Country, Volleyball, Wrestling",
          achievements: "SOL Achievement Awards, Character Education Recognition, Community Service",
          programs: "Pre-AP Courses, STEM Education, Band & Chorus, Art Programs, Technology",
          specialPrograms: "Advanced Academics, Gifted Programs, Special Education Services",
          address: "6798 Kings Hwy, King George, VA 22485",
          phone: "(540) 775-7846"
        },
        {
          id: "school_king_george_es",
          name: "King George Elementary",
          lat: 38.2764,
          lon: -77.1842,
          url: "https://www.kgcs.k12.va.us/",
          type: "school",
          info: "8941 Kings Hwy, King George, VA 22485 | Elementary | (540) 775-7934",
          yearFounded: 1995,
          enrollment: 620,
          grades: "K-5",
          mascot: "Eagles",
          colors: "Green & Gold",
          sports: "Youth Sports Programs, Physical Education",
          achievements: "SOL Excellence, Positive School Culture, Family Engagement Programs",
          programs: "STEAM Education, Reading Programs, Music & Art, Library Media",
          specialPrograms: "Gifted Services, Reading Intervention, Special Education, Extended Day",
          address: "8941 Kings Hwy, King George, VA 22485",
          phone: "(540) 775-7934"
        },
        // SCHOOLS - ORANGE COUNTY
        {
          id: "school_orange_county_hs",
          name: "Orange County High School",
          lat: 38.2425,
          lon: -78.1103,
          url: "https://www.ocss-va.org/",
          type: "school",
          info: "200 Porters Rd, Orange, VA 22960 | High School | (540) 661-4550",
          yearFounded: 1959,
          enrollment: 1050,
          grades: "9-12",
          mascot: "Hornets",
          colors: "Black & Gold",
          sports: "Football, Basketball, Soccer, Baseball, Softball, Track & Field, Cross Country, Wrestling, Tennis, Volleyball",
          achievements: "Regional Championships, Academic Achievement, Strong Community Traditions",
          programs: "Advanced Placement (AP), Dual Enrollment, Career & Technical Education, Fine Arts",
          specialPrograms: "Agricultural Sciences, Engineering & Technology, Healthcare, Business Programs",
          address: "200 Porters Rd, Orange, VA 22960",
          phone: "(540) 661-4550"
        },
        {
          id: "school_locust_grove_ms",
          name: "Locust Grove Middle School",
          lat: 38.3272,
          lon: -77.7761,
          url: "https://www.ocss-va.org/",
          type: "school",
          info: "3500 Germanna Hwy, Locust Grove, VA 22508 | Middle School | (540) 661-4590",
          yearFounded: 2003,
          enrollment: 700,
          grades: "6-8",
          mascot: "Lions",
          colors: "Purple & Gold",
          sports: "Basketball, Soccer, Track, Volleyball, Wrestling, Cross Country",
          achievements: "SOL Excellence, STEM Competition Success, Character Education Programs",
          programs: "Pre-AP Courses, STEM Education, Band & Orchestra, Art Programs, Technology Integration",
          specialPrograms: "Gifted & Talented, Advanced Math & Science, Special Education Services",
          address: "3500 Germanna Hwy, Locust Grove, VA 22508",
          phone: "(540) 661-4590"
        },
        {
          id: "school_orange_es",
          name: "Orange Elementary",
          lat: 38.2453,
          lon: -78.1117,
          url: "https://www.ocss-va.org/",
          type: "school",
          info: "405 Byrd St, Orange, VA 22960 | Elementary | (540) 661-4570",
          yearFounded: 1985,
          enrollment: 450,
          grades: "K-5",
          mascot: "Tigers",
          colors: "Orange & Black",
          sports: "Youth Sports Programs, Physical Education",
          achievements: "SOL Achievement, Positive Behavior Programs, Community Support",
          programs: "STEAM Education, Reading Programs, Music & Art, Library Media, PE",
          specialPrograms: "Gifted Programs, Reading Intervention, Special Education, ESL Services",
          address: "405 Byrd St, Orange, VA 22960",
          phone: "(540) 661-4570"
        },
        {
          id: "school_gordon_barbour_es",
          name: "Gordon-Barbour Elementary",
          lat: 38.3242,
          lon: -77.7811,
          url: "https://www.ocss-va.org/",
          type: "school",
          info: "3529 Germanna Hwy, Locust Grove, VA 22508 | Elementary | (540) 661-4580",
          yearFounded: 2005,
          enrollment: 520,
          grades: "K-5",
          mascot: "Wildcats",
          colors: "Blue & Gold",
          sports: "Youth Sports Programs, Physical Education",
          achievements: "SOL Excellence, Technology Integration Awards, Parent Partnership Programs",
          programs: "STEAM Education, Reading Programs, Music & Art, Library Media, Technology",
          specialPrograms: "Gifted Services, Reading Recovery, Special Education, Extended Day Programs",
          address: "3529 Germanna Hwy, Locust Grove, VA 22508",
          phone: "(540) 661-4580"
        },
        // UNIVERSITIES / COMMUNITY COLLEGES - FXBG Metro Area
        {
          id: "school_umw",
          name: "University of Mary Washington",
          lat: 38.3013039,
          lon: -77.47447,
          url: "https://www.umw.edu/",
          type: "school",
          info: "1301 College Ave, Fredericksburg, VA 22401 | University | (540) 654-1000",
          yearFounded: 1908,
          enrollment: 4500,
          grades: "University",
          mascot: "Eagles",
          colors: "Navy Blue & Silver",
          sports: "NCAA Division III - Baseball, Basketball, Cross Country, Equestrian, Field Hockey, Golf, Lacrosse, Soccer, Softball, Swimming, Tennis, Track & Field, Volleyball",
          achievements: "Top-ranked Public Liberal Arts University, Historic Campus, Strong Arts & Sciences Programs",
          programs: "Liberal Arts & Sciences, Business, Education, Computer Science, Data Science, Historic Preservation",
          specialPrograms: "Honors Program, Undergraduate Research, Study Abroad, Pre-Law, Pre-Med",
          address: "1301 College Ave, Fredericksburg, VA 22401",
          phone: "(540) 654-1000"
        },
        {
          id: "school_germanna_fxbg",
          name: "Germanna Community College — Fredericksburg Area Campus",
          lat: 38.3012220,
          lon: -77.5124009,
          url: "https://www.germanna.edu/",
          type: "school",
          info: "10000 Germanna Point Dr, Fredericksburg, VA 22408 | Community College | (540) 891-3000",
          yearFounded: 2007,
          enrollment: 8000,
          grades: "Community College",
          mascot: "Grizzlies",
          colors: "Green & Gold",
          sports: "N/A",
          achievements: "Fastest Growing CC in Virginia, Transfer Agreements with UMW & VCU, Workforce Development",
          programs: "Associate Degrees, Transfer Programs, Workforce Credentials, Dual Enrollment, Adult Education",
          specialPrograms: "Nursing, IT & Cybersecurity, Business Administration, Health Sciences, STEM Transfer",
          address: "10000 Germanna Point Dr, Fredericksburg, VA 22408",
          phone: "(540) 891-3000"
        }
      ]
    },

    // Schools from NCES EDGE (authoritative geocoded dataset)
    // Built by: npm run build:schools
    schoolsNces: {
      enabled: true,
      url: "/data/schools_fxbg.json",
      cacheTtlMs: 6 * 60 * 60 * 1000  // 6 hours
    },

    colleges: {
      enabled: true,
      url: "/data/colleges_fxbg.json",
      cacheTtlMs: 6 * 60 * 60 * 1000  // 6 hours
    },

    // GIS Overlays (Fredericksburg OpenData + VDOT)
    gisOverlays: {
      enabled: true,
      // QQMS GIS Performance Config
      perf: {
        viewportMode: true,                                   // Only load features in current viewport
        debounceMs: 450,                                      // Debounce map move/zoom refresh
        maxFeaturesSoft: IS_MOBILE_UI ? 5000 : 12000,        // Soft limit (warn user)
        maxFeaturesHard: IS_MOBILE_UI ? 9000 : 25000,        // Hard limit (refuse load)
        cacheTtlMs: 20 * 60 * 1000,                          // Cache TTL: 20 minutes
        maxCacheEntries: 40,                                  // Max cache entries (LRU eviction)
        bboxRounding: 3                                       // Round bbox to 3 decimals for cache keys
      },
      overlays: [
        // FXBG (Fredericksburg City)
        { id:"fred_routes",   name:"FRED Bus Routes", group:"FXBG", type:"arcgis", url:"https://maps.fredericksburgva.gov/arcgis/rest/services/OpenData/OpenData/MapServer/7",
          style:{ color:"#00d1ff", weight:4, dashArray:"8 6", fillOpacity:0.0 } },
        { id:"fred_trails",   name:"Trails",          group:"FXBG", type:"arcgis", url:"https://maps.fredericksburgva.gov/arcgis/rest/services/OpenData/OpenData/MapServer/9",
          style:{ color:"#7CFF6B", weight:3, dashArray:"2 8", fillOpacity:0.0 } },
        { id:"fred_rail",     name:"Railroad",        group:"FXBG", type:"arcgis", url:"https://maps.fredericksburgva.gov/arcgis/rest/services/OpenData/OpenData/MapServer/8",
          style:{ color:"#ffb300", weight:4, dashArray:null, fillOpacity:0.0 } },
        { id:"fred_parks",    name:"Parks",           group:"FXBG", type:"arcgis", url:"https://maps.fredericksburgva.gov/arcgis/rest/services/OpenData/OpenData/MapServer/20",
          style:{ color:"#00ff9d", weight:2, dashArray:null, fillOpacity:0.08 } },
        { id:"fred_wards",    name:"Council Wards",   group:"FXBG", type:"arcgis", url:"https://maps.fredericksburgva.gov/arcgis/rest/services/OpenData/OpenData/MapServer/21",
          style:{ color:"#a78bfa", weight:3, dashArray:"10 8", fillOpacity:0.06 } },
        { id:"fred_zoning",   name:"Zoning",          group:"FXBG", type:"arcgis", url:"https://maps.fredericksburgva.gov/arcgis/rest/services/OpenData/OpenData/MapServer/22",
          style:{ color:"#ff4d6d", weight:2, dashArray:null, fillOpacity:0.05 } },

        // STAFFORD County
        { id:"staff_parcels", name:"Parcels", group:"STAFFORD", type:"arcgis",
          url:"https://services1.arcgis.com/qKiA6JuCrE2l72iL/ArcGIS/rest/services/Parcels/FeatureServer/0",
          style:{ color:"#60a5fa", weight:1, dashArray:null, fillOpacity:0.03 },
          minZoom: 15, heavy: true },
        { id:"staff_zoning", name:"Zoning", group:"STAFFORD", type:"arcgis",
          url:"https://services1.arcgis.com/qKiA6JuCrE2l72iL/ArcGIS/rest/services/Zoning/FeatureServer/0",
          style:{ color:"#2563eb", weight:1, dashArray:null, fillOpacity:0.03 } },
        { id:"staff_structures", name:"Structures (Buildings)", group:"STAFFORD", type:"arcgis",
          url:"https://services1.arcgis.com/qKiA6JuCrE2l72iL/ArcGIS/rest/services/Structures/FeatureServer/0",
          style:{ color:"#7dd3fc", weight:2, dashArray:null, fillOpacity:0.05 },
          minZoom: 16, heavy: true },

        // SPOTSYLVANIA County
        { id:"spotsy_parcels", name:"Parcels", group:"SPOTSYLVANIA", type:"arcgis",
          url:"https://gis.spotsylvania.va.us/arcgis/rest/services/Subdivisions/Subdivisions/FeatureServer/6",
          style:{ color:"#f59e0b", weight:1, dashArray:null, fillOpacity:0.03 },
          minZoom: 15, heavy: true },
        { id:"spotsy_zoning", name:"Zoning", group:"SPOTSYLVANIA", type:"arcgis",
          url:"https://gis.spotsylvania.va.us/arcgis/rest/services/GeoHub/GeoHub/FeatureServer/39",
          style:{ color:"#ea580c", weight:1, dashArray:null, fillOpacity:0.03 } },
        { id:"spotsy_roads", name:"Roads", group:"SPOTSYLVANIA", type:"arcgis",
          url:"https://gis.spotsylvania.va.us/arcgis/rest/services/GeoHub/GeoHub/MapServer/7",
          style:{ color:"#fbbf24", weight:2, dashArray:"4 4", fillOpacity:0.0 } },
        { id:"spotsy_addresses", name:"Address Points", group:"SPOTSYLVANIA", type:"arcgis",
          url:"https://gis.spotsylvania.va.us/arcgis/rest/services/GeoHub/GeoHub/FeatureServer/0",
          style:{ color:"#fb923c", weight:1, dashArray:null, fillOpacity:0.02 } },
        { id:"spotsy_emergency", name:"Emergency Response Facilities", group:"SPOTSYLVANIA", type:"arcgis",
          url:"https://gis.spotsylvania.va.us/arcgis/rest/services/GeoHub/GeoHub/MapServer/3",
          style:{ color:"#dc2626", weight:3, dashArray:null, fillOpacity:0.08 } },

        // KING GEORGE County
        { id:"kg_parcels", name:"Parcels", group:"KING GEORGE", type:"arcgis",
          url:"https://services2.arcgis.com/S8zMJrpz61FbvL5t/arcgis/rest/services/Parcels/FeatureServer/0",
          style:{ color:"#34d399", weight:1, dashArray:null, fillOpacity:0.03 },
          minZoom: 15, heavy: true },
        { id:"kg_zoning", name:"Zoning", group:"KING GEORGE", type:"arcgis",
          url:"https://services2.arcgis.com/S8zMJrpz61FbvL5t/arcgis/rest/services/Zoning/FeatureServer/0",
          style:{ color:"#10b981", weight:1, dashArray:null, fillOpacity:0.03 } },
        { id:"kg_water_towers", name:"Water Towers", group:"KING GEORGE", type:"arcgis",
          url:"https://services2.arcgis.com/S8zMJrpz61FbvL5t/arcgis/rest/services/Water_Towers/FeatureServer/0",
          style:{ color:"#06b6d4", weight:3, dashArray:null, fillOpacity:0.08 } },

        // CAROLINE County
        { id:"caroline_parcels", name:"Parcels", group:"CAROLINE", type:"arcgis",
          url:"https://parcelviewer.geodecisions.com/arcgis/rest/services/Caroline_CivQuest/caroline/MapServer/0",
          style:{ color:"#a78bfa", weight:1, dashArray:null, fillOpacity:0.03 } },
        { id:"caroline_zoning", name:"Zoning", group:"CAROLINE", type:"arcgis",
          url:"https://parcelviewer.geodecisions.com/arcgis/rest/services/Caroline_CivQuest/caroline/MapServer/45",
          style:{ color:"#8b5cf6", weight:1, dashArray:null, fillOpacity:0.03 } },
        { id:"caroline_roads", name:"Roads", group:"CAROLINE", type:"arcgis",
          url:"https://parcelviewer.geodecisions.com/arcgis/rest/services/Caroline/Public/MapServer/16",
          style:{ color:"#c4b5fd", weight:2, dashArray:"4 4", fillOpacity:0.0 } },
        { id:"caroline_addresses", name:"Addresses", group:"CAROLINE", type:"arcgis",
          url:"https://parcelviewer.geodecisions.com/arcgis/rest/services/Caroline/Public/MapServer/23",
          style:{ color:"#d8b4fe", weight:1, dashArray:null, fillOpacity:0.02 } },
        { id:"caroline_fire", name:"Fire Stations", group:"CAROLINE", type:"arcgis",
          url:"https://parcelviewer.geodecisions.com/arcgis/rest/services/Caroline/Public/MapServer/69",
          style:{ color:"#dc2626", weight:3, dashArray:null, fillOpacity:0.08 } },
        { id:"caroline_schools", name:"Schools", group:"CAROLINE", type:"arcgis",
          url:"https://parcelviewer.geodecisions.com/arcgis/rest/services/Caroline/Public/MapServer/72",
          style:{ color:"#7c3aed", weight:3, dashArray:null, fillOpacity:0.08 } },

        // CULPEPER County
        { id:"culpeper_parcels", name:"Parcels", group:"CULPEPER", type:"arcgis",
          url:"https://www.webgis.net/arcgis/rest/services/VA/CulpeperWebGIS_Pro/MapServer/202",
          style:{ color:"#fb7185", weight:1, dashArray:null, fillOpacity:0.03 } },
        { id:"culpeper_zoning", name:"Zoning", group:"CULPEPER", type:"arcgis",
          url:"https://www.webgis.net/arcgis/rest/services/VA/CulpeperWebGIS_Pro/MapServer/215",
          style:{ color:"#e11d48", weight:1, dashArray:null, fillOpacity:0.03 } },

        // Regional (VDOT)
        { id:"vdot_districts",name:"VDOT Districts",  group:"REGIONAL", type:"arcgis", url:"https://services.arcgis.com/p5v98VHDX9Atv3l7/arcgis/rest/services/VDOTAdministrativeBoundaries/FeatureServer/2",
          style:{ color:"#38bdf8", weight:2, dashArray:"6 6", fillOpacity:0.03 } }
      ]
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
    government:               { label: "Government / Meetings", emoji: "🏛️" },
    legal_courts:             { label: "Legal / Courts", emoji: "⚖️" },
    health:                   { label: "Health / Safety", emoji: "🏥" },
    uv_index:                 { label: "UV Index", emoji: "☀️" },
    hospital:                 { label: "Hospitals", emoji: "🏥" },
    clinic:                   { label: "Clinics", emoji: "⚕️" },
    shelter:                  { label: "Shelters", emoji: "🛟" },
    school:                   { label: "Schools", emoji: "🏫" },
    college:                  { label: "Colleges/Universities", emoji: "🎓" },
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
  // Crime Reports UI State & Persistence
  // -----------------------------
  const CRIME_UI_DEFAULTS = {
    enabled: false,
    windowDays: 30,
    appliedWindowDays: 30,
    lastAppliedAt: null,
    sort: "newest",
    menuAutoOpen: true
  };

  function loadCrimeUI() {
    try {
      const enabledRaw = localStorage.getItem("fxbg.crimeOverlayEnabled");
      const daysRaw = localStorage.getItem("fxbg.crimeOverlayDays");
      const appliedRaw = localStorage.getItem("fxbg.lastAppliedCrimeFilter");
      const legacy = localStorage.getItem("fxbg.crimeUI");

      const enabled = enabledRaw === null ? null : enabledRaw === "true";
      const windowDays = daysRaw ? Number(daysRaw) : null;
      const applied = appliedRaw ? safeJsonParse(appliedRaw, null, "crime applied filter") : null;

      if (enabled !== null || Number.isFinite(windowDays) || applied) {
        return {
          ...CRIME_UI_DEFAULTS,
          enabled: enabled !== null ? enabled : CRIME_UI_DEFAULTS.enabled,
          windowDays: Number.isFinite(windowDays) ? windowDays : CRIME_UI_DEFAULTS.windowDays,
          appliedWindowDays: Number.isFinite(applied?.days) ? applied.days : (Number.isFinite(windowDays) ? windowDays : CRIME_UI_DEFAULTS.windowDays),
          lastAppliedAt: applied?.ts || CRIME_UI_DEFAULTS.lastAppliedAt
        };
      }

      if (legacy) {
        const parsed = safeJsonParse(legacy, null, "crime UI");
        if (parsed && typeof parsed === "object") {
          return {
            ...CRIME_UI_DEFAULTS,
            ...parsed,
            appliedWindowDays: parsed.windowDays || CRIME_UI_DEFAULTS.appliedWindowDays
          };
        }
      }
    } catch (err) {
      console.warn("[Crime UI] Failed to load from localStorage:", err);
    }
    return { ...CRIME_UI_DEFAULTS };
  }

  function saveCrimeUI(state) {
    try {
      localStorage.setItem("fxbg.crimeOverlayEnabled", String(Boolean(state.enabled)));
      localStorage.setItem("fxbg.crimeOverlayDays", String(state.appliedWindowDays || state.windowDays || CRIME_UI_DEFAULTS.windowDays));
      localStorage.setItem("fxbg.lastAppliedCrimeFilter", JSON.stringify({
        days: state.appliedWindowDays || state.windowDays || CRIME_UI_DEFAULTS.windowDays,
        ts: state.lastAppliedAt || new Date().toISOString()
      }));
      localStorage.setItem("fxbg.crimeUI", JSON.stringify({
        enabled: state.enabled,
        windowDays: state.windowDays,
        sort: state.sort,
        menuAutoOpen: state.menuAutoOpen
      }));
    } catch (err) {
      console.warn("[Crime UI] Failed to save to localStorage:", err);
    }
  }

  // Crime emoji mapping
  const CRIME_EMOJI_MAP = {
    theft: "👜",
    larceny_from_vehicle: "🧤",
    vehicle_theft: "🚗",
    burglary: "🚪",
    robbery: "🦹",
    assault: "🥊",
    shots_fired: "🔫",
    drugs: "💊",
    fraud: "🧾",
    vandalism: "🧱",
    trespass: "🚷",
    missing_person: "🧍",
    weapon: "⚔️",
    sex_offense: "🚫",
    default: "🚓"
  };

  function normalizeOffenseKey(offenseCategoryRaw, description) {
    const text = (offenseCategoryRaw || description || "").toLowerCase();

    if (text.includes("larceny") && text.includes("vehicle")) return "larceny_from_vehicle";
    if (text.includes("vehicle") && text.includes("theft")) return "vehicle_theft";
    if (text.includes("burglary")) return "burglary";
    if (text.includes("robbery")) return "robbery";
    if (text.includes("assault")) return "assault";
    if (text.includes("shots") || text.includes("firearm") || text.includes("gunfire")) return "shots_fired";
    if (text.includes("drug") || text.includes("narcotic")) return "drugs";
    if (text.includes("fraud") || text.includes("forgery")) return "fraud";
    if (text.includes("vandal") || text.includes("damage")) return "vandalism";
    if (text.includes("trespass")) return "trespass";
    if (text.includes("missing")) return "missing_person";
    if (text.includes("weapon")) return "weapon";
    if (text.includes("sex") || text.includes("sexual")) return "sex_offense";
    if (text.includes("theft") || text.includes("larceny")) return "theft";

    return "default";
  }

  function crimeEmojiFor(incident) {
    const key = normalizeOffenseKey(incident.offenseCategory, incident.description);
    return CRIME_EMOJI_MAP[key] || CRIME_EMOJI_MAP.default;
  }

  // -----------------------------
  // Utilities
  // -----------------------------
  const $ = (id) => document.getElementById(id);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Schools debug mode: enabled via CONFIG.debug.schools or ?debugSchools URL parameter
  const DEBUG_SCHOOLS = !!(CONFIG?.debug?.schools) || new URLSearchParams(location.search).has('debugSchools');

  function safeJsonParse(raw, fallback = null, context = "json") {
    if (raw === null || raw === undefined) return fallback;
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.warn(`[safeJsonParse] Failed to parse ${context}:`, err);
      return fallback;
    }
  }

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

  // Make Leaflet control draggable (for legend, etc.)
  function makeLeafletControlDraggable(el, map, storageKey) {
    if (!el || !map) return;

    // Prevent map interactions on the control
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);

    // Add a drag handle at the top
    const dragHandle = document.createElement('div');
    dragHandle.className = 'legendDragHandle';
    el.insertBefore(dragHandle, el.firstChild);

    // Set up draggable state
    el.classList.add('legendDraggable');
    el.style.position = 'fixed';
    el.style.touchAction = 'none';
    el.style.userSelect = 'none';

    // Restore position from localStorage
    if (storageKey) {
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) {
          const pos = safeJsonParse(saved, null, "legend position");
          if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
            el.style.left = pos.left + 'px';
            el.style.top = pos.top + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
          }
        }
      } catch (e) {
        console.warn('Failed to restore legend position:', e);
      }
    }

    let dragging = false;
    let startX = 0, startY = 0, origX = 0, origY = 0;

    const onDown = (e) => {
      // Only drag when clicking on the drag handle
      if (!e.target.closest('.legendDragHandle')) return;

      dragging = true;
      map.dragging.disable(); // Prevent map panning

      const rect = el.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      startX = e.clientX || (e.touches && e.touches[0].clientX);
      startY = e.clientY || (e.touches && e.touches[0].clientY);

      // Switch to left/top positioning
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.left = origX + 'px';
      el.style.top = origY + 'px';

      e.preventDefault();
      e.stopPropagation();
    };

    const onMove = (e) => {
      if (!dragging) return;

      const clientX = e.clientX || (e.touches && e.touches[0].clientX);
      const clientY = e.clientY || (e.touches && e.touches[0].clientY);

      const dx = clientX - startX;
      const dy = clientY - startY;
      const x = Math.max(10, Math.min(window.innerWidth - el.offsetWidth - 10, origX + dx));
      const y = Math.max(10, Math.min(window.innerHeight - el.offsetHeight - 10, origY + dy));

      el.style.left = x + 'px';
      el.style.top = y + 'px';

      e.preventDefault();
    };

    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      map.dragging.enable(); // Re-enable map panning

      // Save position to localStorage
      if (storageKey) {
        try {
          const pos = {
            left: parseInt(el.style.left, 10),
            top: parseInt(el.style.top, 10)
          };
          localStorage.setItem(storageKey, JSON.stringify(pos));
        } catch (e) {
          console.warn('Failed to save legend position:', e);
        }
      }
    };

    // Mouse events
    dragHandle.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    // Touch events
    dragHandle.addEventListener('touchstart', onDown, { passive: false });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
    window.addEventListener('touchcancel', onUp);
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

  /**
   * Standardize coordinate keys on an item object.
   * Ensures every item has: lat (number), lon (number), lng (number) where lng === lon
   * @param {Object} item - The item to normalize (mutated in place)
   * @returns {Object} The same item with standardized coordinates
   */
  function ensureLatLon(item) {
    if (!item) return item;
    // Normalize lat
    const lat = Number(item.lat ?? item.latitude ?? item.LAT ?? item.y);
    // Normalize lon (prefer lon, then lng, then other variants)
    const lon = Number(item.lon ?? item.lng ?? item.longitude ?? item.LON ?? item.x);
    if (Number.isFinite(lat)) item.lat = lat;
    if (Number.isFinite(lon)) {
      item.lon = lon;
      item.lng = lon; // Ensure lng === lon for API compatibility
    }
    return item;
  }

  // Returns the appropriate bbox for an item: poiBbox for POIs, otherwise the default bbox
  function getBboxForItem(item) {
    if (item?.meta?.isPoi) {
      return CONFIG.poiBbox;
    }
    return CONFIG.bbox;
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

  function getCameraEmoji(item) {
    // Helper to determine appropriate emoji for camera sources and other marker types
    // Check if this is a hospital, clinic, or school
    const type = item?.type || "";
    if (type === "hospital") return "🏥";
    if (type === "clinic") return "⚕️";
    if (type === "school") return "🏫";
    if (type === "police") return "🚓";
    if (type === "fire") return "🔥";
    if (type === "shelter") return "🛟";

    // preserve existing traffic cameras
    const src = item?.source?.id || item?.sourceId || "";
    const name = (item?.source?.name || item?.sourceName || "").toLowerCase();
    const url = (item?.source?.url || item?.url || "").toLowerCase();

    // VA 511 traffic cameras
    if (String(src).includes("va511") || name.includes("511") || url.includes("511virginia") || url.includes("iteriscdn")) {
      return "📷"; // keep traffic camera emoji
    }

    // WeatherBug cameras
    if (String(src).includes("weatherbug") || url.includes("weatherbug.com")) return "🌦️";

    // WetMet / marina / weather cams
    if (String(src).includes("wetmet") || url.includes("wetmet.net")) return "🌦️";
    if (name.includes("marina") || url.includes("marina")) return "⚓";
    if (name.includes("wharf") || url.includes("wharf")) return "🛟";

    // WebcamGalore
    if (String(src).includes("webcamgalore") || url.includes("webcamgalore.com")) return "📹";

    // OxBlue / Hope Springs - Use WeatherBug emoji for GMU Institute and Hope Springs Marina
    if (String(src).includes("oxblue_gmu") || (String(src).includes("oxblue") && url.includes("gmuinstitute"))) return "🌦️";
    if (String(src).includes("hope_springs") || name.toLowerCase().includes("hope springs")) return "🌦️";
    if (String(src).includes("oxblue") || url.includes("oxblue.com")) return "🏗️";

    // default for other external cams
    return "🛰️";
  }

  // Helper: dedupe header IDs for desktop (fix duplicate ID issue)
  function dedupeHeaderIdsForDesktop() {
    if (IS_MOBILE_UI) return;
    const mobileHeader = document.getElementById("mobileHeader");
    if (!mobileHeader) return;

    const idsToRename = [
      "chipLive", "liveText",
      "chipWeather", "weatherText",
      "chipTraffic", "trafficText",
      "chipNet", "netText",
      "chipAir", "airDot", "airText",
      "btnCrime", "btnReport", "btnNewsFlash", "btnRadioScanner", "btnRefresh",
      "lastUpdate"
    ];

    for (const id of idsToRename) {
      const el = mobileHeader.querySelector(`[id="${id}"]`);
      if (el) {
        el.id = id + "Mobile";
        if (CONFIG.debug.chips) console.log(`[Chip Dedupe] Renamed ${id} to ${id}Mobile in mobile header`);
      }
    }
  }

  // Helper: get chip element from active header (desktop or mobile)
  function getChipElement(id) {
    if (IS_MOBILE_UI) {
      // On mobile, look for mobile-suffixed IDs first, then fallback to regular ID
      const mobileEl = document.getElementById(id + "Mobile");
      if (mobileEl) return mobileEl;
    }
    // On desktop or fallback, use regular ID (should be in desktop header)
    return document.getElementById(id);
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

      // Update main Live chip UI
      liveChip.className = `chip ${health.color}`;
      liveText.textContent = health.status;
      liveChip.title = health.title;

      // Update floating health badge
      const healthBadgeDot = document.getElementById('healthBadgeDot');
      const healthBadgeText = document.getElementById('healthBadgeText');
      if (healthBadgeDot && healthBadgeText) {
        // Set badge dot color based on health status
        const statusKey = String(health.status || '').toLowerCase();
        healthBadgeDot.className = 'healthBadge__dot';
        if (statusKey === 'live') {
          healthBadgeDot.classList.add('healthBadge__dot--ok');
          healthBadgeText.textContent = `Feeds: OK`;
        } else if (statusKey === 'partial') {
          healthBadgeDot.classList.add('healthBadge__dot--warn');
          healthBadgeText.textContent = `Feeds: ${this.recentErrors.size} issue(s)`;
        } else {
          healthBadgeDot.classList.add('healthBadge__dot--error');
          healthBadgeText.textContent = `Feeds: ${this.recentErrors.size} error(s)`;
        }
      }

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

    const PROXY_ORIGIN_OVERRIDE_KEY = "CM_PROXY_ORIGIN";
    const tryLocalProxy = () => {
      try {
        const u = new URL(url, location.href);
        // Only proxy absolute http(s) URLs (skip blob:, data:, etc.)
        if (!/^https?:$/.test(u.protocol)) return null;

        // Determine base origin for proxy
        let baseOrigin = location.origin;

        // Check for proxy override (for Termux/file:// scenarios)
        try {
          const override = localStorage.getItem(PROXY_ORIGIN_OVERRIDE_KEY);
          if (override && /^https?:\/\//i.test(override)) {
            baseOrigin = override.replace(/\/+$/, ''); // Remove trailing slashes
          } else if (location.origin === "null" || location.protocol === "file:") {
            // Fallback for file:// protocol (common in Termux/local dev)
            baseOrigin = "http://localhost:8000";
          }
        } catch (e) {
          // localStorage might not be available - use default
        }

        return `${baseOrigin}/proxy?url=${encodeURIComponent(u.toString())}`;
      } catch {
        return null;
      }
    };

    const skipProxy = !!(opts && opts.skipProxy);
    const local = skipProxy ? null : tryLocalProxy();
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

        // If caller provided an AbortSignal, wire it to our internal controller
        if (opts.signal) {
          const externalSignal = opts.signal;
          // If external signal is already aborted, abort our controller immediately
          if (externalSignal.aborted) {
            controller.abort(externalSignal.reason || "External abort");
          } else {
            // Listen for external abort and propagate to our controller
            externalSignal.addEventListener('abort', () => {
              controller.abort(externalSignal.reason || "External abort");
            }, { once: true });
          }
        }

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
  const LOCATION_CONFIDENCE = {
    override: 100,
    gazetteer: 95,
    address: 90,
    intersection: 80,
    place: 70,
    road: 55,
    town: 40,
    fallback: 10
  };

  const JURISDICTION_CENTROIDS = {
    Fredericksburg: { lat: 38.3032, lon: -77.4605 },
    Stafford: { lat: 38.4220, lon: -77.4083 },
    Spotsylvania: { lat: 38.1859, lon: -77.6526 },
    Caroline: { lat: 38.0501, lon: -77.3500 },
    "King George": { lat: 38.2671, lon: -77.1844 },
    Orange: { lat: 38.2450, lon: -78.1100 },
    Culpeper: { lat: 38.4730, lon: -77.9967 },
    Regional: { lat: 38.2750, lon: -77.5000 }
  };

  const CATEGORY_CENTROID_OFFSETS = {
    police_crime: { lat: 0.004, lon: -0.004 },
    legal_courts: { lat: 0.003, lon: 0.003 },
    government: { lat: 0.002, lon: -0.002 },
    fire_ems: { lat: 0.003, lon: -0.003 },
    traffic_transit: { lat: -0.003, lon: 0.003 },
    events: { lat: -0.004, lon: -0.002 }
  };

  const KNOWN_LOCATION_OVERRIDES = (() => {
    const cams = CONFIG.externalCameras?.cameras || [];
    return cams
      .filter((cam) => cam && ["school", "hospital", "clinic"].includes(cam.type))
      .map((cam) => {
        const lat = Number(cam.lat);
        const lon = Number(cam.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        const tokens = [cam.name, cam.address].filter(Boolean).map((value) => value.toLowerCase());
        return { lat, lon, tokens, label: cam.name || cam.address || "known location" };
      })
      .filter(Boolean);
  })();

  function findKnownLocationFromText(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    for (const entry of KNOWN_LOCATION_OVERRIDES) {
      for (const token of entry.tokens) {
        if (token && lower.includes(token)) {
          return { lat: entry.lat, lon: entry.lon, label: entry.label };
        }
      }
    }
    return null;
  }

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

  function getLocationConfidenceForCandidate(type) {
    if (!type) return 50;
    return LOCATION_CONFIDENCE[type] ?? 50;
  }

  function applyDeterministicJitter(base, seed) {
    const seedText = seed || "rss-fallback";
    const hash = parseInt(fnv1a(seedText), 16);
    const angleHash = parseInt(fnv1a(`${seedText}-angle`), 16);
    const distanceMeters = 50 + (hash % 151); // 50–200m
    const angleRad = ((angleHash % 360) * Math.PI) / 180;
    const metersLat = distanceMeters * Math.cos(angleRad);
    const metersLon = distanceMeters * Math.sin(angleRad);
    const lat = base.lat + (metersLat / 111320);
    const lon = base.lon + (metersLon / (111320 * Math.cos((base.lat * Math.PI) / 180)));
    return { lat, lon };
  }

  /**
   * Get fallback location based on jurisdiction centroid + category offset + deterministic jitter.
   * Returns { lat, lon } with best-guess location for ungeocodeable items.
   */
  function getFallbackLocationForItem({ source, category, seed }) {
    const jurisdiction = source.jurisdiction || "Regional";
    const base = JURISDICTION_CENTROIDS[jurisdiction] || source.defaultLoc || CONFIG.center;
    const offset = CATEGORY_CENTROID_OFFSETS[category] || { lat: 0, lon: 0 };
    const centroid = { lat: base.lat + offset.lat, lon: base.lon + offset.lon };
    return applyDeterministicJitter(centroid, seed);
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
      if (CONFIG.debug.rssGeo) {
        console.log(`[Geocode] Cache hit for "${locationString}" in ${jurisdiction}: ${cached.lat}, ${cached.lon}`);
      }
      return { lat: cached.lat, lon: cached.lon, aoi: cached.aoi || null };
    }

    try {
      const response = await fetch(`/api/geocode?q=${encodeURIComponent(locationString)}&j=${encodeURIComponent(jurisdiction || "")}`);
      if (!response.ok) {
        if (CONFIG.debug.rssGeo) {
          console.warn(`[Geocode] Server responded with ${response.status} for "${locationString}"`);
        }
        return null;
      }

      const payload = await response.json();
      if (!payload.ok) {
        if (CONFIG.debug.rssGeo) {
          console.warn(`[Geocode] Server error for "${locationString}": ${payload.error}`);
        }
        return null;
      }

      const lat = Number(payload.lat);
      const lon = Number(payload.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return null;
      }

      if (payload.aoi === "outside" && LOCAL_JURISDICTIONS.has(String(jurisdiction || "").toLowerCase())) {
        if (CONFIG.debug.rssGeo) {
          console.warn(`[Geocode] AOI outside for "${locationString}" (${jurisdiction}) -> ${lat}, ${lon}`);
        }
      }

      geocodeCache.set(cacheKey, { lat, lon, aoi: payload.aoi || null, timestamp: Date.now() });
      return { lat, lon, aoi: payload.aoi || null };
    } catch (error) {
      if (CONFIG.debug.rssGeo) {
        console.warn(`[Geocode] Error geocoding "${locationString}":`, error.message);
      }
      return null;
    }
  }


  // -----------------------------
  // Location Extraction Pipeline (Module 1 v2)
  // Robust location candidate extraction, scoring, and geocoding
  // -----------------------------

  /**
   * Clean text for location extraction: strip HTML, collapse whitespace, decode entities
   */
  function cleanTextForExtraction(text) {
    if (!text) return '';
    let clean = stripHtml(text);
    // Decode common HTML entities
    clean = clean.replace(/&amp;/g, '&')
                 .replace(/&lt;/g, '<')
                 .replace(/&gt;/g, '>')
                 .replace(/&quot;/g, '"')
                 .replace(/&#39;/g, "'")
                 .replace(/&nbsp;/g, ' ');
    // Collapse whitespace
    clean = clean.replace(/\s+/g, ' ').trim();
    return clean;
  }

  /**
   * Normalize a phrase for deduplication (lowercase, collapse whitespace, strip punctuation at ends)
   */
  function normalizeLocationPhrase(phrase) {
    if (!phrase) return '';
    return phrase.toLowerCase()
                 .replace(/\s+/g, ' ')
                 .replace(/^[,.\s]+|[,.\s]+$/g, '')
                 .trim();
  }

  /**
   * Street type abbreviations and their full forms for pattern matching
   */
  const STREET_TYPES = [
    'Street', 'St', 'Avenue', 'Ave', 'Road', 'Rd', 'Boulevard', 'Blvd',
    'Drive', 'Dr', 'Lane', 'Ln', 'Court', 'Ct', 'Circle', 'Cir',
    'Place', 'Pl', 'Parkway', 'Pkwy', 'Way', 'Highway', 'Hwy',
    'Route', 'Rt', 'Trail', 'Trl', 'Terrace', 'Ter', 'Path'
  ];
  const STREET_TYPE_PATTERN = STREET_TYPES.join('|');

  /**
   * Place/landmark suffixes for named place extraction
   */
  const PLACE_SUFFIXES = [
    'Apartments', 'Apartment', 'Complex', 'Plaza', 'Mall', 'Center', 'Centre',
    'Park', 'Hospital', 'Medical Center', 'School', 'High School', 'Elementary',
    'Middle School', 'Academy', 'University', 'College', 'Church', 'Library',
    'Station', 'Bridge', 'Trail', 'Commons', 'Village', 'Square', 'Tower',
    'Towers', 'Gardens', 'Estate', 'Estates', 'Manor', 'Crossing', 'Point',
    'Landing', 'Inn', 'Hotel', 'Motel', 'Resort', 'Lodge'
  ];
  const PLACE_SUFFIX_PATTERN = PLACE_SUFFIXES.join('|');

  /**
   * Local area towns and localities for the Fredericksburg region
   */
  const LOCAL_TOWNS = [
    'Fredericksburg', 'Spotsylvania', 'Stafford', 'Falmouth', 'Massaponax',
    'Chancellor', 'Four Mile Fork', 'Thornburg', 'Lake Anna', 'Locust Grove',
    'Orange', 'Culpeper', 'King George', 'Caroline', 'Dahlgren', 'Colonial Beach',
    'Woodbridge', 'Dumfries', 'Quantico', 'Triangle', 'Aquia', 'Garrisonville',
    'Hartwood', 'Brokenburg', 'Salem Church', 'Ladysmith', 'Milford', 'Bowling Green'
  ];

  /**
   * Places gazetteer for known locations with exact coordinates
   * Can be extended at runtime via store.placesGazetteer
   */
  const BUILTIN_PLACES_GAZETTEER = [
    // Government & Civic
    { name: 'City Hall', aliases: ['fredericksburg city hall', 'city hall'], lat: 38.3032, lon: -77.4605 },
    { name: 'Police Headquarters', aliases: ['police station', 'police hq', 'police headquarters', 'fxbg police'], lat: 38.3032, lon: -77.4605 },
    { name: 'Circuit Courthouse', aliases: ['courthouse', 'circuit court', 'general district court'], lat: 38.3015, lon: -77.4596 },
    // Medical
    { name: 'Mary Washington Hospital', aliases: ['mary washington hospital', 'mwh', 'mw hospital'], lat: 38.3195, lon: -77.4844 },
    { name: 'Spotsylvania Regional Medical Center', aliases: ['spotsylvania regional', 'srmc', 'regional medical center'], lat: 38.2139, lon: -77.5171 },
    { name: 'Stafford Hospital', aliases: ['stafford hospital'], lat: 38.4531, lon: -77.4242 },
    // Education
    { name: 'University of Mary Washington', aliases: ['university of mary washington', 'umw', 'mary washington university'], lat: 38.2995, lon: -77.4785 },
    { name: 'Germanna Community College', aliases: ['germanna community college', 'germanna', 'gcc'], lat: 38.2583, lon: -77.5068 },
    // Parks & Recreation
    { name: 'Riverfront Park', aliases: ['riverfront park', 'city dock'], lat: 38.2985, lon: -77.4689 },
    { name: 'Old Mill Park', aliases: ['old mill park'], lat: 38.2933, lon: -77.4678 },
    { name: 'Alum Spring Park', aliases: ['alum spring park', 'alum springs'], lat: 38.2889, lon: -77.4561 },
    { name: 'Motts Run Reservoir', aliases: ['motts run reservoir', 'motts run'], lat: 38.3156, lon: -77.5333 },
    // Shopping & Commercial
    { name: 'Central Park', aliases: ['central park shopping', 'central park fredericksburg'], lat: 38.2578, lon: -77.5081 },
    { name: 'Spotsylvania Towne Centre', aliases: ['spotsylvania towne centre', 'towne centre', 'spotsylvania mall'], lat: 38.1932, lon: -77.5867 },
    { name: 'Celebrate Virginia', aliases: ['celebrate virginia', 'celebrate va'], lat: 38.2711, lon: -77.4622 },
    // Transit
    { name: 'FRED Transit Center', aliases: ['fred transit', 'transit center', 'bus station'], lat: 38.3032, lon: -77.4605 },
    { name: 'Fredericksburg VRE Station', aliases: ['vre station', 'train station', 'amtrak station'], lat: 38.2961, lon: -77.4548 },
    // Landmarks
    { name: 'Chatham Manor', aliases: ['chatham manor', 'chatham'], lat: 38.3027, lon: -77.4433 },
    { name: 'Ferry Farm', aliases: ['ferry farm', 'george washington boyhood home'], lat: 38.2969, lon: -77.4356 },
    { name: 'Fredericksburg Battlefield', aliases: ['fredericksburg battlefield', 'sunken road', 'maryes heights'], lat: 38.2978, lon: -77.4661 },
  ];

  /**
   * Get the full places gazetteer (built-in + runtime additions)
   */
  function getPlacesGazetteer() {
    const runtime = (typeof store !== 'undefined' && store.placesGazetteer) || [];
    return [...BUILTIN_PLACES_GAZETTEER, ...runtime];
  }

  /**
   * Collect location candidates from text
   * @param {string} text - The text to extract locations from
   * @param {string} jurisdictionHint - Jurisdiction context (e.g., 'Fredericksburg', 'Stafford')
   * @returns {Array} Array of candidate objects { phrase, rawPhrase, type, confidenceBase }
   */
  function collectLocationCandidates(text, jurisdictionHint) {
    const clean = cleanTextForExtraction(text);
    if (!clean) return [];

    const candidates = [];
    const seen = new Set();

    /**
     * Add a candidate if not already seen (dedup by normalized phrase)
     */
    function addCandidate(phrase, rawPhrase, type, confidenceBase) {
      if (!phrase) return;
      const normalized = normalizeLocationPhrase(phrase);
      if (!normalized || normalized.length < 3) return;
      if (seen.has(normalized)) return;
      seen.add(normalized);
      candidates.push({ phrase: phrase.trim(), rawPhrase: (rawPhrase || phrase).trim(), type, confidenceBase });
    }

    // === (0) GAZETTEER MATCHES (highest priority - exact known places) ===
    const gazetteer = getPlacesGazetteer();
    const lowerClean = clean.toLowerCase();
    for (const place of gazetteer) {
      for (const alias of place.aliases) {
        if (lowerClean.includes(alias)) {
          // Found a gazetteer match - add with coordinates embedded
          addCandidate(place.name, alias, 'gazetteer', 100);
          // Store lat/lon reference for later (attach to candidate)
          const lastCandidate = candidates[candidates.length - 1];
          if (lastCandidate) {
            lastCandidate.gazetteerLat = place.lat;
            lastCandidate.gazetteerLon = place.lon;
          }
        }
      }
    }

    // === (1) FULL STREET ADDRESS patterns (highest priority after gazetteer) ===
    // Matches: "123 Main St", "1234 Jefferson Davis Hwy", "100 N Main Street, Apt 5"
    const streetAddressPattern = new RegExp(
      '\\b(\\d{1,5})\\s+' +                                    // House number
      '(?:(N|S|E|W|North|South|East|West)\\.?\\s+)?' +         // Optional direction
      '([A-Z][A-Za-z\\s\\.\']+?)\\s*' +                        // Street name
      '(?:' + STREET_TYPE_PATTERN + ')' +                      // Street type
      '(?:\\s*[,.]?\\s*(?:Apt|Suite|Unit|#|Ste)?\\.?\\s*[\\dA-Za-z-]+)?' +  // Optional unit
      '(?:\\s*[,.]?\\s*([A-Z][A-Za-z\\s]+))?'  +               // Optional city
      '(?:\\s*[,.]?\\s*(VA|Virginia))?'  +                     // Optional state
      '(?:\\s*[,.]?\\s*(\\d{5}(?:-\\d{4})?))?',                // Optional ZIP
      'gi'
    );

    let match;
    while ((match = streetAddressPattern.exec(clean)) !== null) {
      const fullMatch = match[0].trim();
      // Clean up trailing commas and extra whitespace
      const cleaned = fullMatch.replace(/[,.\s]+$/, '').trim();
      if (cleaned.length >= 8) { // Minimum reasonable address length
        addCandidate(cleaned, fullMatch, 'address', 90);
      }
    }

    // === (2) INTERSECTION patterns ===
    // Matches: "Main St and Lafayette Blvd", "Route 3 & William St", "at the intersection of X and Y"
    const intersectionPatterns = [
      // "intersection of X and Y"
      new RegExp(
        '(?:intersection\\s+of|corner\\s+of)\\s+' +
        '([A-Z][A-Za-z\\s\\.\']+?(?:' + STREET_TYPE_PATTERN + '))\\s*' +
        '(?:and|&|at|with|/)\\s*' +
        '([A-Z][A-Za-z\\s\\.\']+?(?:' + STREET_TYPE_PATTERN + '))',
        'gi'
      ),
      // "X St and Y Blvd" or "X St & Y Blvd"
      new RegExp(
        '([A-Z][A-Za-z\\s\\.\']+?(?:' + STREET_TYPE_PATTERN + '))\\s*' +
        '(?:and|&|at|/)\\s*' +
        '([A-Z][A-Za-z\\s\\.\']+?(?:' + STREET_TYPE_PATTERN + '))',
        'gi'
      ),
      // "at X St near Y Rd"
      new RegExp(
        '(?:at|near|on)\\s+' +
        '([A-Z][A-Za-z\\s\\.\']+?(?:' + STREET_TYPE_PATTERN + '))\\s+' +
        '(?:near|by|at)\\s+' +
        '([A-Z][A-Za-z\\s\\.\']+?(?:' + STREET_TYPE_PATTERN + '))',
        'gi'
      )
    ];

    for (const pattern of intersectionPatterns) {
      while ((match = pattern.exec(clean)) !== null) {
        const street1 = match[1]?.trim();
        const street2 = match[2]?.trim();
        if (street1 && street2 && street1.length >= 4 && street2.length >= 4) {
          const intersectionPhrase = `${street1} & ${street2}`;
          addCandidate(intersectionPhrase, match[0], 'intersection', 80);
        }
      }
    }

    // === (3) ROAD/HIGHWAY SEGMENTS ===
    // Matches: "Route 1", "US-1", "I-95", "Jefferson Davis Highway", "near Exit 130"
    const roadPatterns = [
      // Interstate highways
      /\b(I-?95|I-?295|I-?64|I-?66|Interstate\s+(?:95|295|64|66))\s*(?:(North|South|East|West|N|S|E|W)(?:bound)?)?/gi,
      // US Routes
      /\b(U\.?S\.?\s*(?:Route\s*)?\d+|US-?\d+)\s*(?:(North|South|East|West|N|S|E|W)(?:bound)?)?/gi,
      // State routes
      /\b((?:State\s+Route|VA|Virginia|Route|Rt\.?)\s*\d+)\s*(?:(North|South|East|West|N|S|E|W)(?:bound)?)?/gi,
      // Named highways
      /\b(Jefferson\s+Davis\s+(?:Highway|Hwy)|Plank\s+Road|Blue\s+(?:and|&)\s+Gray\s+(?:Parkway|Pkwy)|Carl\s+D\.?\s+Silver\s+(?:Parkway|Pkwy)|Tidewater\s+Trail|Kings\s+Highway)/gi,
      // Exit references
      /\b(?:near\s+)?(?:Exit|exit)\s+(\d+[A-Za-z]?)\s*(?:(?:on|off|of)\s+(I-?95|I-?295|Route\s+\d+))?/gi
    ];

    for (const pattern of roadPatterns) {
      while ((match = pattern.exec(clean)) !== null) {
        const roadPhrase = match[0].trim();
        if (roadPhrase.length >= 3) {
          addCandidate(roadPhrase, roadPhrase, 'road', 60);
        }
      }
    }

    // === (4) NEIGHBORHOODS / COMPLEXES / NAMED PLACES ===
    // Matches: "Greenbrier Apartments", "Central Park", "Mary Washington Hospital"
    // Look for preposition + ProperNounPhrase pattern
    const placePrepositions = '(?:at|near|in|by|around|outside|inside|behind|across\\s+from|between|on)';

    // Pattern for named places with suffixes
    const namedPlacePattern = new RegExp(
      placePrepositions + '\\s+' +
      '((?:[A-Z][A-Za-z\']+\\s+)+(?:' + PLACE_SUFFIX_PATTERN + '))',
      'g'
    );

    while ((match = namedPlacePattern.exec(clean)) !== null) {
      const place = match[1]?.trim();
      if (place && place.length >= 5) {
        addCandidate(place, match[0], 'place', 70);
      }
    }

    // Also look for standalone named places (capitalized sequences with known suffixes)
    const standaloneNamedPlace = new RegExp(
      '\\b((?:[A-Z][A-Za-z\']+\\s+){1,4}(?:' + PLACE_SUFFIX_PATTERN + '))\\b',
      'g'
    );

    while ((match = standaloneNamedPlace.exec(clean)) !== null) {
      const place = match[1]?.trim();
      if (place && place.length >= 8) {
        addCandidate(place, place, 'place', 65);
      }
    }

    // === (5) TOWN / LOCALITY references ===
    // Matches known local towns in the Fredericksburg region
    for (const town of LOCAL_TOWNS) {
      const townPattern = new RegExp('\\b' + town + '\\b', 'gi');
      if (townPattern.test(clean)) {
        addCandidate(town, town, 'town', 40);
      }
    }

    // === (6) Generic street name patterns (lower confidence) ===
    // Matches: "on Main Street", "near Lafayette Boulevard"
    const genericStreetPattern = new RegExp(
      '(?:on|at|near|along)\\s+' +
      '([A-Z][A-Za-z\\s\\.\']+?(?:' + STREET_TYPE_PATTERN + '))',
      'gi'
    );

    while ((match = genericStreetPattern.exec(clean)) !== null) {
      const street = match[1]?.trim();
      if (street && street.length >= 6 && !/^(the|a|an)\s/i.test(street)) {
        addCandidate(street, match[0], 'road', 50);
      }
    }

    // === (7) Block-level references ===
    // Matches: "100 block of Main St", "on the 1200 block of Jefferson Davis Hwy"
    const blockPattern = new RegExp(
      '(\\d{1,4})\\s*block\\s+(?:of\\s+)?' +
      '([A-Z][A-Za-z\\s\\.\']+?(?:' + STREET_TYPE_PATTERN + '))',
      'gi'
    );

    while ((match = blockPattern.exec(clean)) !== null) {
      const blockNum = match[1];
      const street = match[2]?.trim();
      if (street && blockNum) {
        const blockPhrase = `${blockNum} block of ${street}`;
        // Convert to approximate address for geocoding
        const approxAddress = `${blockNum}0 ${street}`;
        addCandidate(approxAddress, blockPhrase, 'address', 75);
      }
    }

    return candidates;
  }

  /**
   * Score and select the best location candidate
   * @param {Array} candidates - Array of candidate objects from collectLocationCandidates
   * @param {string} jurisdictionHint - Jurisdiction context
   * @returns {Object|null} Best candidate or null if no valid candidates
   */
  function pickBestCandidate(candidates, jurisdictionHint) {
    if (!candidates || candidates.length === 0) return null;

    // Scoring weights by type
    const typeScores = {
      'gazetteer': 100,   // Exact known places (highest)
      'address': 90,      // Full street addresses
      'intersection': 80, // Intersections
      'place': 70,        // Named places
      'road': 60,         // Road/highway segments
      'town': 40          // Town names only
    };

    // Vague term penalties
    const vagueTerms = [
      'downtown', 'area', 'vicinity', 'nearby', 'region', 'countywide',
      'citywide', 'neighborhood', 'sector', 'district', 'zone'
    ];

    // Score each candidate
    const scored = candidates.map(candidate => {
      let score = candidate.confidenceBase || typeScores[candidate.type] || 50;

      const lowerPhrase = candidate.phrase.toLowerCase();

      // Bonus: Contains street number
      if (/^\d{1,5}\s/.test(candidate.phrase)) {
        score += 15;
      }

      // Bonus: Contains city/town name
      const hasTown = LOCAL_TOWNS.some(town => lowerPhrase.includes(town.toLowerCase()));
      if (hasTown) {
        score += 10;
      }

      // Bonus: Contains state (VA/Virginia)
      if (/\bva\b|virginia/i.test(candidate.phrase)) {
        score += 8;
      }

      // Bonus: Contains ZIP code
      if (/\b\d{5}(?:-\d{4})?\b/.test(candidate.phrase)) {
        score += 5;
      }

      // Penalty: Vague terms
      for (const vague of vagueTerms) {
        if (lowerPhrase.includes(vague)) {
          score -= 20;
          break;
        }
      }

      // Penalty: Very short phrases
      if (candidate.phrase.length < 10) {
        score -= 10;
      }

      // Penalty: Contains only a town name (no street/address)
      if (candidate.type === 'town' && !hasTown) {
        score -= 5;
      }

      // Bonus for matching jurisdiction hint
      if (jurisdictionHint && lowerPhrase.includes(jurisdictionHint.toLowerCase())) {
        score += 5;
      }

      return { ...candidate, score };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Debug logging for top candidates
    if (CONFIG.debug.rssGeo && scored.length > 0) {
      console.log(`[Location] Top ${Math.min(3, scored.length)} candidates:`);
      scored.slice(0, 3).forEach((c, i) => {
        console.log(`  ${i + 1}. [${c.type}] "${c.phrase}" (score: ${c.score})`);
      });
    }

    // Return best candidate if score is positive
    const best = scored[0];
    if (best && best.score > 0) {
      return best;
    }

    return null;
  }

  /**
   * Enrich a candidate phrase with jurisdiction context for better geocoding
   * @param {string} phrase - The location phrase
   * @param {string} jurisdictionHint - Jurisdiction context
   * @returns {string} Enriched phrase suitable for geocoding
   */
  function enrichCandidatePhrase(phrase, jurisdictionHint) {
    if (!phrase) return phrase;

    // Already has state - return as-is
    if (/\bva\b|virginia/i.test(phrase)) {
      return phrase;
    }

    // Already has ZIP code - return as-is
    if (/\b\d{5}(?:-\d{4})?\b/.test(phrase)) {
      return phrase;
    }

    // Map jurisdiction hints to geocoding-friendly context
    const jurisdictionContext = {
      'Fredericksburg': 'Fredericksburg, VA',
      'Stafford': 'Stafford County, VA',
      'Spotsylvania': 'Spotsylvania County, VA',
      'Caroline': 'Caroline County, VA',
      'King George': 'King George County, VA',
      'Orange': 'Orange County, VA',
      'Culpeper': 'Culpeper County, VA',
      'Regional': 'Fredericksburg, VA'
    };

    const context = jurisdictionContext[jurisdictionHint] || 'Fredericksburg, VA';

    // For intersections, format properly
    if (/&|and|\//i.test(phrase)) {
      // Clean up intersection format
      const cleanIntersection = phrase
        .replace(/\s+(?:and|&|\/)\s+/gi, ' & ')
        .replace(/\s+/g, ' ')
        .trim();
      return `${cleanIntersection}, ${context}`;
    }

    // For regular addresses/places
    return `${phrase.replace(/[,.\s]+$/, '')}, ${context}`;
  }

  /**
   * Resolve the best lat/lon for an RSS item using the extraction pipeline
   * @param {Object} item - Raw RSS item with title, summary/message
   * @param {Object} source - RSS source configuration
   * @returns {Promise<Object>} Object with { lat, lon, locationText, locationMethod }
   */
  async function resolveBestLatLonForRssItem(item, source) {
    const result = {
      lat: null,
      lon: null,
      locationText: null,
      locationMethod: null,
      locationConfidence: null,
      chosenCandidate: null,
      flag: null
    };

    // Build search text from title and description
    const textToSearch = `${item.title || ''} ${item.summary || item.message || ''}`;
    const jurisdictionHint = source.jurisdiction || 'Regional';

    // Step 1: Collect all location candidates
    const candidates = collectLocationCandidates(textToSearch, jurisdictionHint);

    if (CONFIG.debug.rssGeo) {
      console.log(`[Location] "${item.title?.slice(0, 50)}..." - Found ${candidates.length} candidates`);
    }

    // Step 2: Check for gazetteer matches first (they have exact coordinates)
    const gazetteerCandidates = candidates.filter(c => c.type === 'gazetteer' && c.gazetteerLat && c.gazetteerLon);
    if (gazetteerCandidates.length > 0) {
      const best = gazetteerCandidates[0]; // First gazetteer match wins
      result.lat = best.gazetteerLat;
      result.lon = best.gazetteerLon;
      result.locationText = best.phrase;
      result.locationMethod = 'gazetteer';
      result.locationConfidence = LOCATION_CONFIDENCE.gazetteer;
      result.chosenCandidate = { phrase: best.phrase, type: best.type };

      if (CONFIG.debug.rssGeo) {
        console.log(`[Location] Gazetteer match: "${best.phrase}" -> ${result.lat}, ${result.lon}`);
      }
      return result;
    }

    // Step 3: Try known location overrides (from external cameras config)
    const knownLocation = findKnownLocationFromText(textToSearch);
    if (knownLocation) {
      result.lat = knownLocation.lat;
      result.lon = knownLocation.lon;
      result.locationText = knownLocation.label || 'known location';
      result.locationMethod = 'override';
      result.locationConfidence = LOCATION_CONFIDENCE.override;

      if (CONFIG.debug.rssGeo) {
        console.log(`[Location] Known location override -> ${result.lat}, ${result.lon}`);
      }
      return result;
    }

    // Step 4: Pick best candidate and geocode
    const best = pickBestCandidate(candidates, jurisdictionHint);

    if (best) {
      // Enrich with jurisdiction context
      const enrichedPhrase = enrichCandidatePhrase(best.phrase, jurisdictionHint);
      const baseConfidence = getLocationConfidenceForCandidate(best.type);
      result.chosenCandidate = { phrase: best.rawPhrase, type: best.type };

      if (CONFIG.debug.rssGeo) {
        console.log(`[Location] Best candidate: [${best.type}] "${best.phrase}" (score: ${best.score})`);
        console.log(`[Location] Enriched for geocoding: "${enrichedPhrase}"`);
      }

      // Geocode the enriched phrase
      const geocoded = await geocodeLocation(enrichedPhrase, jurisdictionHint);

      if (geocoded) {
        result.lat = geocoded.lat;
        result.lon = geocoded.lon;
        result.locationText = best.rawPhrase;
        result.locationMethod = 'extract+geocode';
        result.locationConfidence = baseConfidence;

        if (geocoded.aoi === "outside" && LOCAL_JURISDICTIONS.has(String(jurisdictionHint || "").toLowerCase()) && baseConfidence >= 80) {
          result.locationConfidence = Math.max(0, baseConfidence - 20);
          result.flag = "outside_aoi";
        }

        if (CONFIG.debug.rssGeo) {
          console.log(`[Location] Geocoded "${enrichedPhrase}" -> ${result.lat}, ${result.lon}`);
        }
        return result;
      } else {
        if (CONFIG.debug.rssGeo) {
          console.log(`[Location] Geocoding failed for "${enrichedPhrase}"`);
        }
      }
    }

    // Step 5: Fallback - no valid location found
    if (CONFIG.debug.rssGeo) {
      const reason = candidates.length === 0 ? 'no candidates found' : 'geocoding failed';
      console.log(`[Location] Fallback: ${reason} for "${item.title?.slice(0, 50)}..."`);
    }

    // Use intelligent category/content-based default
    const fallbackSeed = `${source.id}|${item.guid || item.url || item.title || ""}|${item.published || ""}`;
    const fallbackLoc = getFallbackLocationForItem({ source, category: source.category, seed: fallbackSeed });
    result.lat = fallbackLoc.lat;
    result.lon = fallbackLoc.lon;
    result.locationText = null;
    result.locationMethod = 'fallback';
    result.locationConfidence = LOCATION_CONFIDENCE.fallback;

    return result;
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
  const map = L.map("map", {
    zoomControl: false,
    preferCanvas: false,
    maxZoom: 20,
    minZoom: 7
  }).setView([CONFIG.center.lat, CONFIG.center.lon], CONFIG.zoom);

  // CARTO Dark Matter tiles (primary) - modern CDN endpoint with retina support
  const cartoLayer = L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    {
      maxZoom: 20,
      subdomains: ['a', 'b', 'c', 'd'],
      attribution: '© OpenStreetMap contributors, tiles © CARTO',
      errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    }
  );

  // ESRI Dark tiles (fallback if CARTO fails)
  const esriBaseLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 20,
      maxNativeZoom: 18,
      attribution: 'Map tiles by Esri',
      errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    }
  );

  const esriRefLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 20,
      maxNativeZoom: 18,
      opacity: 0.95,
      errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    }
  );

  // OSM Standard tiles (for comparison/debugging)
  const osmLayer = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 20,
      attribution: '© OpenStreetMap contributors'
    }
  );

  // Try CARTO first, fallback to ESRI on error
  cartoLayer.on('tileerror', function() {
    if (!map.hasLayer(esriBaseLayer)) {
      console.log('[Map] CARTO tiles failed, switching to ESRI fallback');
      map.removeLayer(cartoLayer);
      esriBaseLayer.addTo(map);
      esriRefLayer.addTo(map);
    }
  });

  cartoLayer.addTo(map);

  // Basemap layer control for easy switching
  const baseLayers = {
    "Dark (CARTO)": cartoLayer,
    "Dark (Esri)": esriBaseLayer,
    "Standard (OSM)": osmLayer
  };

  // Helper to determine control position based on viewport
  function getControlPosition() {
    return window.matchMedia("(max-width: 768px)").matches ? "bottomright" : "topright";
  }

  // Create basemap control with responsive positioning
  let layersControl = L.control.layers(baseLayers, null, {
    position: getControlPosition(),
    collapsed: true
  }).addTo(map);

  // Update control position on viewport resize
  let resizeTimeout = null;
  window.addEventListener("resize", function() {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(function() {
      const newPos = getControlPosition();
      if (layersControl.getPosition() !== newPos) {
        layersControl.remove();
        layersControl = L.control.layers(baseLayers, null, {
          position: newPos,
          collapsed: true
        }).addTo(map);
      }
    }, 150);
  });

  // Reference marker at downtown Fredericksburg for basemap alignment sanity check
  const refIcon = L.divIcon({
    className: "refMarker",
    html: `<div style="font-size:18px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.7));">🎯</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });
  L.marker([38.3032, -77.4605], { icon: refIcon, interactive: true })
    .addTo(map)
    .bindPopup("Reference: Downtown Fredericksburg (sanity check)");

  L.control.zoom({ position: "bottomright" }).addTo(map);

  const clusters = L.markerClusterGroup({
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    maxClusterRadius: 46
  });
  map.addLayer(clusters);

  const reportsLayer = L.layerGroup().addTo(map);

  // -----------------------------
  // Location Awareness
  // -----------------------------
  const LOCATION_STORAGE_KEY = "fxbg.lastLocation";
  const LOCATION_STALE_MS = 6 * 60 * 60 * 1000;
  const LOCATION_ENABLED_KEY = "fxbg.locationEnabled";
  let userLocationMarker = null;
  let userLocationCircle = null;
  let locationWatchId = null;
  let currentUserLocation = null;

  function readLocationEnabled() {
    try {
      const stored = localStorage.getItem(LOCATION_ENABLED_KEY);
      if (stored === null) return CONFIG.location.enabledByDefault;
      return stored === "true";
    } catch {
      return CONFIG.location.enabledByDefault;
    }
  }

  function persistLocationEnabled(enabled) {
    try {
      localStorage.setItem(LOCATION_ENABLED_KEY, String(enabled));
    } catch {}
  }

  function readStoredLocation() {
    try {
      const raw = localStorage.getItem(LOCATION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = safeJsonParse(raw, null, "last location");
      if (!parsed || !Number.isFinite(parsed.lat) || !Number.isFinite(parsed.lng)) return null;
      if (parsed.ts && Date.now() - parsed.ts > LOCATION_STALE_MS) return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function saveStoredLocation(loc) {
    try {
      localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify({
        lat: loc.lat,
        lng: loc.lng,
        accuracy: loc.accuracy,
        zoom: loc.zoom,
        ts: Date.now()
      }));
    } catch (err) {
      console.warn("[Location] Failed to save location:", err);
    }
  }

  function updateUserLocationMarker(lat, lng, accuracy) {
    const icon = L.divIcon({ className: "userLocationMarker" });
    if (!userLocationMarker) {
      userLocationMarker = L.marker([lat, lng], { icon }).addTo(map);
      userLocationMarker.bindTooltip("You are here");
    } else {
      userLocationMarker.setLatLng([lat, lng]);
    }

    if (Number.isFinite(accuracy) && accuracy > 0) {
      if (!userLocationCircle) {
        userLocationCircle = L.circle([lat, lng], {
          radius: accuracy,
          color: "#4fd1ff",
          weight: 1,
          opacity: 0.5,
          fillColor: "#4fd1ff",
          fillOpacity: 0.08
        }).addTo(map);
      } else {
        userLocationCircle.setLatLng([lat, lng]);
        userLocationCircle.setRadius(accuracy);
      }
    }
  }

  function applyUserLocation({ lat, lng, accuracy, zoom, persist = true, animate = true } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const nextZoom = Number.isFinite(zoom) ? zoom : 15;
    map.setView([lat, lng], nextZoom, { animate });
    updateUserLocationMarker(lat, lng, accuracy);
    currentUserLocation = { lat, lng, accuracy, ts: Date.now() };
    if (persist) {
      saveStoredLocation({ lat, lng, accuracy, zoom: nextZoom });
    }
    updateNearestPanel();
    evaluateAlertRules();
  }

  function locateUser({ animate = true } = {}) {
    if (!navigator.geolocation) {
      console.warn("[Location] Geolocation unavailable.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords = pos.coords || {};
        applyUserLocation({
          lat: coords.latitude,
          lng: coords.longitude,
          accuracy: coords.accuracy,
          zoom: map.getZoom() || 15,
          animate
        });
      },
      (err) => {
        console.warn("[Location] Geolocation failed:", err?.message || err);
      },
      CONFIG.location.watchOptions
    );
  }

  function clearUserLocation() {
    if (userLocationMarker) {
      try { map.removeLayer(userLocationMarker); } catch {}
      userLocationMarker = null;
    }
    if (userLocationCircle) {
      try { map.removeLayer(userLocationCircle); } catch {}
      userLocationCircle = null;
    }
    currentUserLocation = null;
    updateNearestPanel();
  }

  function startLocationWatch() {
    if (!navigator.geolocation || locationWatchId !== null) return;
    locationWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const coords = pos.coords || {};
        applyUserLocation({
          lat: coords.latitude,
          lng: coords.longitude,
          accuracy: coords.accuracy,
          zoom: map.getZoom() || 15,
          animate: false
        });
      },
      (err) => {
        console.warn("[Location] Watch failed:", err?.message || err);
      },
      CONFIG.location.watchOptions
    );
  }

  function stopLocationWatch() {
    if (locationWatchId !== null && navigator.geolocation?.clearWatch) {
      navigator.geolocation.clearWatch(locationWatchId);
    }
    locationWatchId = null;
  }

  let locationEnabled = readLocationEnabled();
  function setLocationEnabled(enabled) {
    locationEnabled = Boolean(enabled);
    persistLocationEnabled(locationEnabled);
    if (locationEnabled) {
      const storedLocation = readStoredLocation();
      if (storedLocation) {
        applyUserLocation({ ...storedLocation, persist: false, animate: false, zoom: storedLocation.zoom });
      }
      locateUser({ animate: true });
      startLocationWatch();
    } else {
      stopLocationWatch();
      clearUserLocation();
    }
    updateLocationToggleUI();
  }

  const storedLocation = readStoredLocation();
  if (storedLocation && locationEnabled) {
    applyUserLocation({ ...storedLocation, persist: false, animate: false, zoom: storedLocation.zoom });
  }
  if (locationEnabled) {
    locateUser({ animate: true });
    startLocationWatch();
  }

  const LocateControl = L.Control.extend({
    onAdd() {
      const container = L.DomUtil.create("div", "locateControl leaflet-bar");
      const button = L.DomUtil.create("button", "", container);
      button.type = "button";
      button.title = "Locate me";
      button.setAttribute("aria-label", "Locate me");
      button.textContent = "📍";
      L.DomEvent.disableClickPropagation(container);
      button.addEventListener("click", (e) => {
        e.preventDefault();
        if (!locationEnabled) {
          setLocationEnabled(true);
        }
        locateUser({ animate: true });
      });
      return container;
    }
  });

  // Use same responsive positioning as basemap control
  let locateControl = new LocateControl({ position: getControlPosition() }).addTo(map);

  // Update locate control position on viewport resize
  let locateResizeTimeout = null;
  window.addEventListener("resize", function() {
    clearTimeout(locateResizeTimeout);
    locateResizeTimeout = setTimeout(function() {
      const newPos = getControlPosition();
      if (locateControl.getPosition() !== newPos) {
        locateControl.remove();
        locateControl = new LocateControl({ position: newPos }).addTo(map);
      }
    }, 160); // Slightly different delay to avoid race conditions
  });

  // -----------------------------
  // GIS Overlays (ArcGIS layers) - QQMS GIS Safeguards
  // -----------------------------
  /**
   * QQMS GIS SAFEGUARDS:
   * - Viewport-only loading: only fetch features visible in current map bounds
   * - Feature count checks: query count before fetching, enforce soft/hard limits
   * - Zoom gates: heavy layers (parcels, structures) require minimum zoom level
   * - Chunked rendering: add features in batches to prevent UI freezing
   * - Request cancellation: abort in-flight requests when overlays disabled
   * - Bounded caching: cache per viewport with TTL and LRU eviction
   */

  /**
   * Get rounded bounding box from map for cache key stability
   */
  function getMapBbox() {
    const bounds = map.getBounds();
    const decimals = CONFIG.gisOverlays.perf.bboxRounding;
    const factor = Math.pow(10, decimals);
    return {
      xmin: Math.floor(bounds.getWest() * factor) / factor,
      ymin: Math.floor(bounds.getSouth() * factor) / factor,
      xmax: Math.ceil(bounds.getEast() * factor) / factor,
      ymax: Math.ceil(bounds.getNorth() * factor) / factor
    };
  }

  /**
   * Build ArcGIS REST API query URL with viewport and parameters
   */
  function buildArcgisQueryUrl(layerUrl, options = {}) {
    const {
      bbox = null,          // {xmin, ymin, xmax, ymax}
      outFields = '*',      // comma-separated field list
      returnCountOnly = false,
      resultOffset = 0,
      resultRecordCount = 2000
    } = options;

    const params = new URLSearchParams({
      where: '1=1',
      f: 'geojson',
      outSR: '4326',
      returnGeometry: returnCountOnly ? 'false' : 'true',
      outFields: outFields
    });

    if (bbox) {
      params.set('geometry', `${bbox.xmin},${bbox.ymin},${bbox.xmax},${bbox.ymax}`);
      params.set('geometryType', 'esriGeometryEnvelope');
      params.set('inSR', '4326');
      params.set('spatialRel', 'esriSpatialRelIntersects');
    }

    if (returnCountOnly) {
      params.set('returnCountOnly', 'true');
    } else {
      params.set('resultOffset', resultOffset.toString());
      params.set('resultRecordCount', resultRecordCount.toString());
    }

    return `${layerUrl}/query?${params.toString()}`;
  }

  /**
   * Fetch feature count for a layer in the given bbox
   */
  async function fetchArcgisCount(layerUrl, bbox, signal) {
    const url = buildArcgisQueryUrl(layerUrl, { bbox, returnCountOnly: true });
    try {
      const result = await fetchWithProxies(url, {
        expect: 'json',
        signal,
        headers: {
          'Accept': 'application/geo+json,application/json,*/*',
          'Referer': layerUrl.includes('fredericksburgva.gov')
            ? 'https://maps.fredericksburgva.gov/'
            : 'https://www.virginiaroads.org/'
        },
        timeoutMs: 15000
      });
      return result?.count ?? result?.properties?.count ?? 0;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      console.warn(`[GIS] Count query failed for ${layerUrl}:`, e);
      return 0;
    }
  }

  /**
   * Fetch features from a layer within the viewport, with pagination
   * Stops when maxFeatures is reached
   */
  async function fetchArcgisViewportGeojson(layerUrl, bbox, outFields, maxFeatures, signal) {
    const allFeatures = [];
    let offset = 0;
    const pageSize = 2000;
    const maxIterations = Math.ceil(maxFeatures / pageSize);

    for (let i = 0; i < maxIterations; i++) {
      if (signal?.aborted) {
        console.log(`[GIS] Request aborted for ${layerUrl}`);
        break;
      }

      const url = buildArcgisQueryUrl(layerUrl, {
        bbox,
        outFields,
        resultOffset: offset,
        resultRecordCount: pageSize
      });

      try {
        const geojson = await fetchWithProxies(url, {
          expect: 'json',
          signal,
          headers: {
            'Accept': 'application/geo+json,application/json,*/*',
            'Referer': layerUrl.includes('fredericksburgva.gov')
              ? 'https://maps.fredericksburgva.gov/'
              : 'https://www.virginiaroads.org/'
          },
          timeoutMs: 25000
        });

        const features = geojson?.features || [];
        if (features.length === 0) break;

        allFeatures.push(...features);

        // Stop if we've reached the cap
        if (allFeatures.length >= maxFeatures) {
          console.log(`[GIS] Reached feature cap (${maxFeatures}) for ${layerUrl}`);
          break;
        }

        // If we got less than pageSize, we've reached the end
        if (features.length < pageSize) break;

        offset += pageSize;
      } catch (e) {
        if (e.name === 'AbortError') {
          console.log(`[GIS] Request aborted for ${layerUrl}`);
          throw e;
        }
        console.error(`[GIS] Failed to fetch ${layerUrl} at offset ${offset}:`, e);
        break;
      }
    }

    return {
      type: 'FeatureCollection',
      features: allFeatures.slice(0, maxFeatures) // Ensure hard cap
    };
  }

  /**
   * Add features to layer in chunks to prevent UI freezing
   */
  async function addFeaturesChunked(leafletLayer, features, overlayName) {
    const batchSize = IS_MOBILE_UI ? 250 : 600;
    const totalBatches = Math.ceil(features.length / batchSize);

    console.log(`[GIS] Adding ${features.length} features in ${totalBatches} batches for ${overlayName}`);

    for (let i = 0; i < totalBatches; i++) {
      const start = i * batchSize;
      const end = Math.min(start + batchSize, features.length);
      const batch = features.slice(start, end);

      const batchCollection = {
        type: 'FeatureCollection',
        features: batch
      };

      // Add batch to layer
      leafletLayer.addData(batchCollection);

      // Yield to browser between batches
      if (i < totalBatches - 1) {
        await new Promise(resolve => {
          if (typeof requestIdleCallback !== 'undefined') {
            requestIdleCallback(resolve, { timeout: 100 });
          } else {
            setTimeout(resolve, 0);
          }
        });
      }
    }

    console.log(`[GIS] Finished adding all features for ${overlayName}`);
  }

  async function enableOverlay(overlayId) {
    if (!CONFIG.gisOverlays.enabled) return;
    if (store.gis.enabled.has(overlayId)) return; // Already enabled

    const overlay = CONFIG.gisOverlays.overlays.find(o => o.id === overlayId);
    if (!overlay) return;

    // Safeguard: check if URL is valid
    if (!overlay.url || overlay.url.startsWith("TODO_")) {
      console.warn(`[GIS] Overlay ${overlayId} has invalid or placeholder URL, skipping.`);
      return;
    }

    // Zoom gate: enforce minimum zoom for heavy layers
    const currentZoom = map.getZoom();
    if (overlay.minZoom && currentZoom < overlay.minZoom) {
      const msg = `[GIS] ${overlay.name} requires zoom level ${overlay.minZoom} or higher (current: ${currentZoom}). Please zoom in.`;
      console.warn(msg);
      // Silently skip - don't block UI with alerts
      return;
    }

    // Abort any existing request for this overlay
    if (store.gis.requests.has(overlayId)) {
      const existing = store.gis.requests.get(overlayId);
      existing.controller.abort("Refreshing overlay");
      store.gis.requests.delete(overlayId);
    }

    const controller = new AbortController();
    const signal = controller.signal;

    try {
      // Get viewport bbox
      const bbox = getMapBbox();
      const bboxStr = `${bbox.xmin.toFixed(3)},${bbox.ymin.toFixed(3)},${bbox.xmax.toFixed(3)},${bbox.ymax.toFixed(3)}`;

      // Build cache key: overlayId|z=zoom|b=bbox
      const cacheKey = `${overlayId}|z=${currentZoom}|b=${bboxStr}`;

      // Check cache first
      const cached = store.gis.cache.get(cacheKey);
      const cacheAge = cached ? Date.now() - (cached.timestamp || 0) : Infinity;
      const cacheTtl = CONFIG.gisOverlays.perf.cacheTtlMs;

      let geojson;
      let fromCache = false;

      if (cached && cacheAge < cacheTtl) {
        geojson = cached.geojson;
        fromCache = true;
        console.log(`[GIS] Using cached data for ${overlay.name} (age: ${Math.round(cacheAge/1000)}s)`);
      } else {
        console.log(`[GIS] Fetching ${overlay.name} for viewport (zoom ${currentZoom})...`);

        // Track this request for cancellation
        store.gis.requests.set(overlayId, { controller, cacheKey });

        // Query feature count first
        const count = await fetchArcgisCount(overlay.url, bbox, signal);
        console.log(`[GIS] ${overlay.name}: ${count} features in viewport`);

        const perf = CONFIG.gisOverlays.perf;

        // Hard limit: refuse if too many features
        if (count > perf.maxFeaturesHard) {
          const msg = `[GIS] ${overlay.name}: ${count} features exceeds hard limit (${perf.maxFeaturesHard}). Please zoom in further.`;
          console.warn(msg);
          // Silently skip - don't block UI with alerts
          store.gis.requests.delete(overlayId);
          return;
        }

        // Soft limit: warn but proceed with capped load
        let loadLimit = count;
        if (count > perf.maxFeaturesSoft) {
          const msg = `[GIS] ${overlay.name}: ${count} features exceeds soft limit (${perf.maxFeaturesSoft}). Loading first ${perf.maxFeaturesSoft} features.`;
          console.warn(msg);
          loadLimit = perf.maxFeaturesSoft;
          // Proceed silently - don't block UI with alerts
        }

        // Fetch features with viewport query
        geojson = await fetchArcgisViewportGeojson(
          overlay.url,
          bbox,
          '*', // outFields
          loadLimit,
          signal
        );

        console.log(`[GIS] Loaded ${geojson.features.length} features for ${overlay.name}`);

        // Cache the result with TTL
        store.gis.cache.set(cacheKey, { geojson, timestamp: Date.now() });

        // Enforce cache size limit (LRU eviction)
        if (store.gis.cache.size > perf.maxCacheEntries) {
          const entries = Array.from(store.gis.cache.entries());
          entries.sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0));
          const toDelete = entries.slice(0, store.gis.cache.size - perf.maxCacheEntries);
          toDelete.forEach(([key]) => store.gis.cache.delete(key));
          console.log(`[GIS] Evicted ${toDelete.length} old cache entries`);
        }

        // Clean up request tracking
        store.gis.requests.delete(overlayId);
      }

      // Get style from overlay config
      const st = overlay?.style || { color:"#22c55e", weight:2, dashArray:null, fillOpacity:0.05 };

      // Create empty Leaflet layer with Canvas renderer for better performance
      const leafletLayer = L.geoJSON(null, {
        renderer: L.canvas({ padding: 0.5 }),
        style: (feature) => {
          const geomType = feature.geometry?.type;
          if (geomType === 'Polygon' || geomType === 'MultiPolygon') {
            return {
              color: st.color,
              weight: st.weight ?? 2,
              opacity: 0.7,
              fillColor: st.color,
              fillOpacity: st.fillOpacity ?? 0.05,
              dashArray: st.dashArray || null
            };
          } else if (geomType === 'LineString' || geomType === 'MultiLineString') {
            return {
              color: st.color,
              weight: st.weight ?? 3,
              opacity: 0.8,
              dashArray: st.dashArray || null
            };
          }
          return {};
        },
        pointToLayer: (feature, latlng) => {
          return L.circleMarker(latlng, {
            radius: 4,
            color: st.color,
            weight: 2,
            opacity: 0.9,
            fillColor: st.color,
            fillOpacity: 0.6
          });
        },
        onEachFeature: (feature, layer) => {
          // Add popup with feature properties
          if (feature.properties) {
            const props = feature.properties;
            let popupContent = `<div style="max-width:200px;"><strong>${overlay.name}</strong><br>`;
            const keys = Object.keys(props).slice(0, 5); // Show first 5 properties
            for (const key of keys) {
              if (props[key] != null && key !== 'OBJECTID' && key !== 'SHAPE') {
                popupContent += `<small>${key}: ${props[key]}</small><br>`;
              }
            }
            popupContent += `</div>`;
            layer.bindPopup(popupContent);
          }
        }
      });

      // Add to map immediately so UI feels responsive
      leafletLayer.addTo(map);
      store.gis.layers.set(overlayId, leafletLayer);
      store.gis.enabled.add(overlayId);
      updateOverlayLegendUI();

      // Add features in chunks to prevent UI freezing
      if (geojson.features.length > 0) {
        await addFeaturesChunked(leafletLayer, geojson.features, overlay.name);
      }

    } catch (e) {
      if (e.name === 'AbortError') {
        console.log(`[GIS] Overlay ${overlayId} request was aborted`);
      } else {
        console.error(`[GIS] Failed to enable overlay ${overlayId}:`, e);
      }
      store.gis.requests.delete(overlayId);
    }
  }

  function disableOverlay(overlayId) {
    // Cancel any in-flight request
    if (store.gis.requests.has(overlayId)) {
      const req = store.gis.requests.get(overlayId);
      req.controller.abort("Overlay disabled");
      store.gis.requests.delete(overlayId);
      console.log(`[GIS] Aborted in-flight request for ${overlayId}`);
    }

    // Remove layer from map
    const layer = store.gis.layers.get(overlayId);
    if (layer) {
      map.removeLayer(layer);
      store.gis.layers.delete(overlayId);
    }

    store.gis.enabled.delete(overlayId);
    updateOverlayLegendUI();
  }

  // -----------------------------
  // GIS Overlay Legend Control
  // -----------------------------
  let overlayLegendControl = null;

  function ensureOverlayLegendControl() {
    if (!map || overlayLegendControl) return;
    overlayLegendControl = L.control({ position: "bottomright" });
    overlayLegendControl.onAdd = function() {
      const div = L.DomUtil.create("div", "overlay-legend");
      // prevent map drag when interacting
      L.DomEvent.disableClickPropagation(div);
      return div;
    };
    overlayLegendControl.addTo(map);
    updateOverlayLegendUI(); // initial render

    // Make legend draggable on both desktop and mobile
    const legendEl = overlayLegendControl.getContainer();
    if (legendEl) {
      makeLeafletControlDraggable(legendEl, map, "fxbgLegendPos");
    }
  }

  function updateOverlayLegendUI() {
    try {
      if (!overlayLegendControl) return;
      const el = overlayLegendControl.getContainer();
      if (!el) return;

      const enabledIds = Array.from(store.gis?.enabled || []);
      if (!enabledIds.length) {
        el.style.display = "none";
        el.innerHTML = "";
        return;
      }

      el.style.display = "block";
      const overlays = (CONFIG.gisOverlays?.overlays || [])
        .filter(o => enabledIds.includes(o.id));

      const rows = overlays.map(o => {
        const c = o?.style?.color || "#22c55e";
        return `
          <div class="legend-row">
            <span class="swatch" style="background:${c}; border-color:${c};"></span>
            <span class="legend-label">${escapeHtml(o.name)}</span>
          </div>
        `;
      }).join("");

      el.innerHTML = `
        <div class="legend-title">Map Overlays</div>
        ${rows}
      `;
    } catch (e) {
      console.warn("Legend update failed:", e);
    }
  }

  // -----------------------------
  // GIS Overlay Viewport Refresh (debounced)
  // -----------------------------
  let gisRefreshTimeout = null;
  let gisRefreshInProgress = false;
  let lastGisRefreshZoom = null;

  async function refreshEnabledOverlays() {
    // Guard against concurrent refreshes
    if (gisRefreshInProgress) {
      console.log(`[GIS] Refresh already in progress, skipping`);
      return;
    }

    const enabledIds = Array.from(store.gis.enabled);
    if (enabledIds.length === 0) return;

    gisRefreshInProgress = true;
    try {
      console.log(`[GIS] Refreshing ${enabledIds.length} enabled overlays for new viewport`);

      // Temporarily clear enabled set and layers to force refresh
      const idsToRefresh = [...enabledIds];
      for (const id of idsToRefresh) {
        disableOverlay(id);
      }

      // Re-enable with new viewport
      for (const id of idsToRefresh) {
        await enableOverlay(id);
      }
    } finally {
      gisRefreshInProgress = false;
    }
  }

  function scheduleGisRefresh() {
    if (!CONFIG.gisOverlays.enabled) return;

    const enabledIds = Array.from(store.gis.enabled);
    if (enabledIds.length === 0) return;

    // Check if any enabled overlay is heavy or if viewportMode is on
    const shouldRefresh = enabledIds.some(id => {
      const overlay = CONFIG.gisOverlays.overlays.find(o => o.id === id);
      return overlay?.heavy || CONFIG.gisOverlays.perf.viewportMode;
    });

    if (!shouldRefresh) return;

    // Only refresh on significant zoom changes (not on pan/moveend)
    const currentZoom = map.getZoom();
    if (lastGisRefreshZoom !== null && Math.abs(currentZoom - lastGisRefreshZoom) < 1) {
      // Zoom hasn't changed significantly, skip refresh
      return;
    }

    // Debounce the refresh
    if (gisRefreshTimeout) {
      clearTimeout(gisRefreshTimeout);
    }

    gisRefreshTimeout = setTimeout(() => {
      lastGisRefreshZoom = map.getZoom();
      refreshEnabledOverlays();
    }, CONFIG.gisOverlays.perf.debounceMs);
  }

  // Wire up map events for viewport refresh
  // NOTE: Only refresh on zoom changes, not on pan (moveend removed to prevent UI freezing)
  map.on('zoomend', scheduleGisRefresh);

  // -----------------------------
  // Panel UI
  // -----------------------------
  const panel = $("panel");
  const panelHandle = $("panelHandle");
  const panelClose = $("panelClose");
  makeDraggable(panel, panelHandle);

  // ========================================
  // MOBILE UX UTILITIES
  // ========================================

  // Utility: detect mobile landscape layout
  const isMobileUI = () =>
    window.matchMedia?.("(max-width: 980px)")?.matches &&
    window.matchMedia?.("(orientation: landscape)")?.matches;

  // Keep CSS chrome heights in sync with actual header size (mobile wrap/safe-area/collapse).
  function getSafeAreaTopInsetPx() {
    const root = document.documentElement;
    const body = document.body;
    if (!root || !body) return 0;
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;top:0;left:0;height:0;padding-top:env(safe-area-inset-top);visibility:hidden;";
    body.appendChild(probe);
    const paddingTop = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    probe.remove();
    return paddingTop;
  }

  function computeVisibleHeaderHeight() {
    if (IS_MOBILE_UI) {
      const mobileHeader = document.getElementById("mobileHeader");
      if (!mobileHeader || mobileHeader.classList.contains("mobileHeader--collapsed")) return 0;
      return mobileHeader.offsetHeight || 0;
    }
    const desktopHeader = document.getElementById("desktopHeader");
    return desktopHeader?.offsetHeight || 0;
  }

  function updateChromeHeights() {
    const root = document.documentElement;
    if (!root) return;
    const safeAreaTop = getSafeAreaTopInsetPx();
    const top = computeVisibleHeaderHeight() + safeAreaTop;
    root.style.setProperty("--topH", `${Math.max(0, Math.round(top))}px`);
  }

  // Mobile header collapse helper (for NewsFlash/Radio panels)
  function setMobileHeaderCollapsed(collapsed) {
    if (!IS_MOBILE_UI) return;
    const el = document.getElementById("mobileHeader");
    if (!el) return;
    el.classList.toggle("mobileHeader--collapsed", !!collapsed);
    updateChromeHeights();
  }

  // Helper to restore header if no blocking panels are open
  function restoreHeaderIfNoBlockingPanels() {
    const newsPanel = $("newsFlashPanel");
    const radioPanel = $("radioPanel");
    const crimePanel = $("crimePanel");
    const reportPanel = $("reportPanel");
    const diagnosticsDrawer = $("diagnosticsDrawer");
    const newsHidden = newsPanel?.classList.contains("newsFlashPanel--hidden") ?? true;
    const radioHidden = radioPanel?.classList.contains("radioPanel--hidden") ?? true;
    const crimeHidden = crimePanel?.classList.contains("crimePanel--hidden") ?? true;
    const reportHidden = reportPanel?.classList.contains("reportPanel--hidden") ?? true;
    const diagnosticsHidden = diagnosticsDrawer?.classList.contains("diagnosticsDrawer--hidden") ?? true;
    const dockOpen = dockState?.isOpen ?? false;

    // If both panels are hidden AND dock is closed, restore the header
    if (newsHidden && radioHidden && crimeHidden && reportHidden && diagnosticsHidden && !dockOpen) {
      setMobileHeaderCollapsed(false);
    }
  }

  // Ensure panel close button is always visible and tappable
  function ensurePanelCloseVisible(panelEl) {
    if (!panelEl) return;
    if (!isMobileUI()) return;

    // Ensure panel scroll is at top so header/close is visible
    const scroller = panelEl.querySelector(".panel__body, .content, .drawerBody") || panelEl;
    try {
      scroller.scrollTop = 0;
    } catch(e) {}

    // Add a class to panel to apply mobile safe styling if needed
    panelEl.classList.add("mobileSafe");
  }

  function openPanel() {
    panel.classList.remove("panel--collapsed");
    panelHandle.setAttribute("aria-expanded", "true");
    ensurePanelCloseVisible(panel);
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

  // Panel swipe-down to close (mobile touch only)
  (() => {
    let startY = 0;
    let isDragging = false;

    panelHandle.addEventListener("pointerdown", (e) => {
      // Only handle touch/pen inputs (not mouse on desktop)
      if (e.pointerType === "mouse") return;
      // Only if panel is open
      if (panel.classList.contains("panel--collapsed")) return;

      startY = e.clientY;
      isDragging = true;
    });

    window.addEventListener("pointermove", (e) => {
      if (!isDragging) return;

      const deltaY = e.clientY - startY;
      // If swiped down more than 60px, close the panel
      if (deltaY > 60) {
        isDragging = false;
        closePanel();
      }
    });

    window.addEventListener("pointerup", () => {
      isDragging = false;
    });

    window.addEventListener("pointercancel", () => {
      isDragging = false;
    });
  })();


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
    if (!host) return;

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
    locks: { rss:false, nws:false, arcgis:false, virginiaCrashData:false, va511:false, openUV:false, cdc:false, air:false, crime:false },
    lastByCategory: new Map(),
    lastFetch: { externalCameras: 0, schoolsNces: 0, colleges: 0 },
    cameraPins: new Set(),
    cameraRefresh: new Map(),
    alerts: {
      active: new Map(),
      lastCheck: 0,
      soundEnabled: true,
      vibrationEnabled: false
    },
    gis: {
      enabled: new Set(),
      layers: new Map(),
      cache: new Map(),
      requests: new Map()  // Track in-flight requests for cancellation: overlayId -> { controller, cacheKey }
    },
    air: { aqi: null, timestamp: null },  // Air quality data cache
    openUV: { value: null, status: "unknown", displayText: null, timestamp: null },
    weather: { baseText: "Weather: Loading…" },
    crime: null,  // Will be initialized with loadCrimeUI()
    _crimeBootInitialized: false,  // Tracks if initial 30-day crime filter has been applied
    reports: {
      items: [],
      layer: null,
      markers: new Map(),
      enabled: true,
      lastFetch: 0,
      draftLocation: null,
      pickMode: false,
      pickMarker: null
    },
    diagnostics: {
      rss: {}  // Keyed by source.id: { ok, httpStatus, itemsParsed, itemsIngested, error, timestamp }
    }
  };

  const CAMERA_PINS_KEY = "fxbg.cameraPins";
  const ALERT_PREFS_KEY = "fxbg.alertPrefs";

  function loadCameraPins() {
    try {
      const raw = localStorage.getItem(CAMERA_PINS_KEY);
      if (!raw) return;
      const parsed = safeJsonParse(raw, [], "camera pins");
      if (Array.isArray(parsed)) {
        parsed.forEach(id => store.cameraPins.add(id));
      }
    } catch {}
  }

  function saveCameraPins() {
    try {
      localStorage.setItem(CAMERA_PINS_KEY, JSON.stringify(Array.from(store.cameraPins)));
    } catch {}
  }

  function loadAlertPrefs() {
    try {
      const raw = localStorage.getItem(ALERT_PREFS_KEY);
      if (!raw) return;
      const parsed = safeJsonParse(raw, null, "alert prefs");
      if (parsed && typeof parsed === "object") {
        store.alerts.soundEnabled = Boolean(parsed.soundEnabled);
        store.alerts.vibrationEnabled = Boolean(parsed.vibrationEnabled);
      }
    } catch {}
  }

  function saveAlertPrefs() {
    try {
      localStorage.setItem(ALERT_PREFS_KEY, JSON.stringify({
        soundEnabled: store.alerts.soundEnabled,
        vibrationEnabled: store.alerts.vibrationEnabled
      }));
    } catch {}
  }

  function ensureEventSchema(item) {
    const event = { ...item };
    event.source = event.source || event.sourceId || event.sourceName || event.feedId || "unknown";
    event.type = event.type || event.category || "other";
    event.title = event.title || event.name || "Untitled";
    event.desc = event.desc || event.message || event.summary || "";
    event.timeStart = event.timeStart || event.timestamp || event.published || event.updated || null;
    event.timeEnd = event.timeEnd || null;
    event.lat = Number.isFinite(event.lat) ? event.lat : null;
    event.lon = Number.isFinite(event.lon) ? event.lon : (Number.isFinite(event.lng) ? event.lng : null);
    event.confidence = Number.isFinite(event.confidence)
      ? event.confidence
      : (Number.isFinite(event.locationConfidence) ? event.locationConfidence : null);
    if (!Number.isFinite(event.severity)) {
      event.severity = event.tone === "bad" ? 3 : event.tone === "warn" ? 2 : 1;
    }
    if (!Array.isArray(event.links)) {
      event.links = event.url ? [{ label: "Source", url: event.url }] : [];
    }
    return event;
  }

  function registerEvent(item) {
    const event = ensureEventSchema(item);
    store.itemsById.set(event.id, event);
    return event;
  }

  loadCameraPins();
  loadAlertPrefs();

  const CAMERA_REFRESH_MIN_MS = CONFIG.cameras.refreshMinMs;
  const CAMERA_PIN_MAX = 9;

  function isCameraPinned(id) {
    return store.cameraPins.has(id);
  }

  function toggleCameraPin(id) {
    if (!id) return;
    if (store.cameraPins.has(id)) {
      store.cameraPins.delete(id);
    } else {
      if (store.cameraPins.size >= CAMERA_PIN_MAX) {
        console.warn(`[Watchboard] Max pinned cameras reached (${CAMERA_PIN_MAX}). Unpin one to add another.`);
        return;
      }
      store.cameraPins.add(id);
    }
    saveCameraPins();
    updateWatchboardPanel();
  }

  function canRefreshCamera(id) {
    const last = store.cameraRefresh.get(id) || 0;
    const now = Date.now();
    const delta = now - last;
    if (delta >= CAMERA_REFRESH_MIN_MS) {
      return { allowed: true, waitMs: 0 };
    }
    return { allowed: false, waitMs: CAMERA_REFRESH_MIN_MS - delta };
  }

  function markCameraRefresh(id) {
    store.cameraRefresh.set(id, Date.now());
  }

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
    const crashCategories = ['crash', 'road_closure', 'closure', 'traffic'];
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
      if (newItem.lat && newItem.lon && existingItem.lat && existingItem.lon) {
        const distance = haversineDistance(
          newItem.lat, newItem.lon,
          existingItem.lat, existingItem.lon
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

  function formatDistanceMiles(meters) {
    if (!Number.isFinite(meters)) return "—";
    const miles = meters / 1609.34;
    if (miles < 0.1) return "<0.1 mi";
    return `${miles.toFixed(1)} mi`;
  }

  function findNearest(items, userLoc) {
    if (!userLoc || !items || items.length === 0) return null;
    let best = null;
    items.forEach(item => {
      if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) return;
      const distance = haversineDistance(userLoc.lat, userLoc.lng, item.lat, item.lon);
      if (!best || distance < best.distance) {
        best = { item, distance };
      }
    });
    return best;
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

    const publishedDate = toDate(raw.published);
    const maxAge = source.maxAgeHours ?? CONFIG.freshness.rssMaxAgeHours;
    const fallbackSeed = `${source.id}|${raw.guid || raw.url || raw.title || ""}|${publishedDate ? publishedDate.toISOString() : ""}`;
    const fallbackLoc = getFallbackLocationForItem({ source, category: picked.category, seed: fallbackSeed });

    // CRITICAL: Never drop items due to missing geodata - always use deterministic fallback
    let loc = raw.loc || fallbackLoc;
    let locationMethod = raw.locationMethod || (raw.loc ? "override" : "fallback");
    let locationConfidence = Number.isFinite(raw.locationConfidence) ? raw.locationConfidence : null;
    if (locationMethod === "fallback") {
      loc = fallbackLoc;
      locationConfidence = LOCATION_CONFIDENCE.fallback;
    } else if (!Number.isFinite(locationConfidence) && locationMethod in LOCATION_CONFIDENCE) {
      locationConfidence = LOCATION_CONFIDENCE[locationMethod];
    }

    const locationText = raw.locationText || null;

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
      lng: loc.lon, // Ensure lng === lon for API compatibility
      // Location extraction metadata (Module 1 v2)
      locationText,
      locationMethod,
      locationConfidence,
      chosenCandidate: raw.chosenCandidate || null,
      flag: raw.flag || null,
      category: picked.category,
      emoji: picked.emoji,
      tone: picked.tone || source.tone || "warn",
      sourceName: source.name,
      sourceId: source.id,
      sourceType: source.type || "unknown",
      jurisdiction: source.jurisdiction || "Regional",
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

    const locationInfo = item.sourceType === "rss"
      ? `<div style="font-size:11px; color:rgba(255,255,255,0.78); margin-top:8px; padding-top:6px; border-top:1px solid rgba(255,255,255,0.08);">
           <div>📍 ${item.locationText ? escapeHtml(item.locationText) : "Unknown location"}</div>
           <div style="margin-top:2px;">Method: ${escapeHtml(item.locationMethod || "unknown")}${Number.isFinite(item.locationConfidence) ? ` (${Math.round(item.locationConfidence)}%)` : ""}</div>
         </div>`
      : "";

    // Location debug info (only shown when rssGeo debug is enabled)
    const locationDebug = CONFIG.debug.rssGeo && item.locationMethod
      ? `<div style="font-size:10px; color:rgba(126,240,255,0.6); margin-top:6px; padding-top:6px; border-top:1px solid rgba(255,255,255,0.08);">
           📍 ${escapeHtml(item.locationMethod)}${item.locationText ? `: "${escapeHtml(item.locationText)}"` : ""}<br>
           ${item.chosenCandidate ? `Candidate: "${escapeHtml(item.chosenCandidate.phrase)}" [${escapeHtml(item.chosenCandidate.type)}]<br>` : ""}
           <span style="font-family:monospace">${item.lat?.toFixed(4)}, ${(item.lon ?? item.lng)?.toFixed(4)}</span>
         </div>`
      : "";

    return `
      <div style="min-width:220px; max-width:280px">
        <div style="font-weight:900; font-size:13px; margin-bottom:6px">${item.emoji} ${safeTitle}</div>
        <div style="color:rgba(255,255,255,.70); font-size:12px; margin-bottom:8px">${cat} • ${fmtTime(item.timestamp)}</div>
        ${cameraPreview}
        ${safeSummary ? `<div style="font-size:12px; line-height:1.35; color:rgba(255,255,255,.82); margin-bottom:10px">${safeSummary}</div>` : ""}
        ${locationInfo}
        <a href="${item.url}" target="_blank" rel="noreferrer noopener" style="color:#7ef0ff; font-weight:800; text-decoration:none">Open source ↗</a>
        ${locationDebug}
      </div>
    `;
  }

  function attachMarker(item) {
    // Use fallback pattern: prefer lon, fall back to lng for API compatibility
    const lng = item.lon ?? item.lng;
    const m = L.marker([item.lat, lng], { icon: makeEmojiIcon(item.emoji, item.tone, item.sourceId) });
    m.on("click", () => selectItem(item.id));
    m.bindPopup(renderPopup(item), { closeButton: false });
    clusters.addLayer(m);
    store.markersById.set(item.id, m);
  }

  function formatProxyError(response) {
    if (!response) return "unknown error";
    const proxyError = response.headers?.get?.("X-Proxy-Error");
    const upstreamStatus = response.headers?.get?.("X-Proxy-Upstream-Status");
    const upstreamHost = response.headers?.get?.("X-Proxy-Upstream-Host");
    let message = proxyError ? `proxy ${proxyError}` : `http ${response.status}`;
    if (upstreamStatus) message += ` (upstream ${upstreamStatus})`;
    if (upstreamHost) message += ` @ ${upstreamHost}`;
    return message;
  }

  function buildProxyUrl(url) {
    try {
      const u = new URL(url, location.href);
      if (!/^https?:$/.test(u.protocol)) return null;

      let baseOrigin = location.origin;
      const PROXY_ORIGIN_OVERRIDE_KEY = "CM_PROXY_ORIGIN";
      try {
        const override = localStorage.getItem(PROXY_ORIGIN_OVERRIDE_KEY);
        if (override && /^https?:\/\//i.test(override)) {
          baseOrigin = override.replace(/\/+$/, '');
        } else if (location.origin === "null" || location.protocol === "file:") {
          baseOrigin = "http://localhost:8000";
        }
      } catch {}

      return `${baseOrigin}/proxy?url=${encodeURIComponent(u.toString())}`;
    } catch {
      return null;
    }
  }

  async function loadCameraSnapshot({ imgEl, statusEl, item, force = false }) {
    if (!imgEl || !item?.media?.src) return;
    const check = canRefreshCamera(item.id);
    if (!check.allowed && !force) {
      if (statusEl) {
        statusEl.textContent = `Rate limit: wait ${Math.ceil(check.waitMs / 1000)}s`;
      }
      return;
    }
    markCameraRefresh(item.id);
    if (statusEl) statusEl.textContent = "Loading snapshot…";
    try {
      const cacheBustedUrl = item.media.src + (item.media.src.includes("?") ? "&" : "?") + "_t=" + Date.now();
      const proxiedUrl = buildProxyUrl(cacheBustedUrl);
      const candidates = proxiedUrl ? [proxiedUrl, cacheBustedUrl] : [cacheBustedUrl];
      let response = null;
      let lastErr = null;

      for (const url of candidates) {
        try {
          response = await fetch(url, { cache: "no-store" });
          if (!response.ok) {
            throw new Error(formatProxyError(response));
          }
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          response = null;
        }
      }

      if (!response) {
        throw lastErr || new Error("network error");
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      if (imgEl.dataset.objectUrl) {
        try { URL.revokeObjectURL(imgEl.dataset.objectUrl); } catch {}
      }
      imgEl.dataset.objectUrl = objectUrl;
      imgEl.src = objectUrl;
      imgEl.style.display = "block";
      if (statusEl) {
        statusEl.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      }
    } catch (err) {
      imgEl.style.display = "none";
      if (statusEl) {
        statusEl.textContent = `Snapshot unavailable • ${err.message || "error"}`;
      }
    }
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
      const imgAlt = escapeAttr(item.media.alt || item.title || "Traffic camera snapshot");
      const imgSrc = escapeAttr(item.media.src);
      const isCamera = item.category === "camera";

      if (isCamera) {
        mediaEl.innerHTML = `
          <div class="panelMedia__wrapper" style="position: relative; min-height: 220px; background: #1a1a1a; border-radius: 8px; overflow: hidden;">
            <div class="panelMedia__status" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.7); font-size: 13px; text-align:center; padding: 12px;">
              Loading snapshot…
            </div>
            <img class="panelMedia__img"
                 alt="${imgAlt}"
                 style="display: none; width: 100%; height: auto; position: relative; z-index: 1;" />
          </div>
          <div style="display:flex; gap:8px; margin-top: 10px;">
            <button class="panelMedia__refreshBtn watchboardBtn" type="button">Refresh</button>
            <button class="panelMedia__pinBtn watchboardBtn" type="button">Pin</button>
          </div>
        `;
        setupCameraPanelMedia(item);
      } else {
        const cacheBustingSrc = imgSrc + (imgSrc.includes('?') ? '&' : '?') + '_t=' + Date.now();
        mediaEl.innerHTML = `
          <div class="panelMedia__wrapper" style="position: relative; min-height: 200px; background: #1a1a1a; border-radius: 8px; overflow: hidden;">
            <div class="panelMedia__loading" style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.6); font-size: 14px;">
              <span>🖼️ Loading image...</span>
            </div>
            <img class="panelMedia__img"
                 src="${cacheBustingSrc}"
                 alt="${imgAlt}"
                 style="display: none; width: 100%; height: auto; position: relative; z-index: 1;"
                 onload="this.style.display='block'; this.parentElement.querySelector('.panelMedia__loading').style.display='none';"
                 onerror="this.style.display='none'; const loading = this.parentElement.querySelector('.panelMedia__loading'); loading.innerHTML = '<div style=\\'text-align: center; padding: 20px;\\'><div style=\\'font-size: 32px; margin-bottom: 8px;\\'>🖼️</div><div style=\\'color: rgba(255,255,255,0.7);\\'>Image unavailable</div></div>'; loading.style.display='flex';" />
          </div>
        `;
      }
    } else if (item.media && item.media.type === "iframe" && item.media.src) {
      mediaEl.style.display = "block";
      const iframeSrc = escapeAttr(item.media.src);
      const iframeTitle = escapeAttr(item.media.alt || item.title || "External camera");
      const sourceUrl = escapeAttr(item.url || item.media.src);
      mediaEl.innerHTML = `
        <div style="margin-bottom: 8px;">
          <iframe src="${iframeSrc}"
                  style="width:100%;height:260px;border:0;border-radius:6px;background:#000;display:block;"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                  loading="lazy"
                  title="${iframeTitle}"></iframe>
        </div>
        <div style="text-align:center;">
          <a href="${sourceUrl}" target="_blank" rel="noopener noreferrer"
             style="display:inline-block;padding:8px 16px;background:rgba(255,255,255,0.1);color:white;text-decoration:none;border-radius:4px;font-size:13px;font-weight:600;"
             onmouseover="this.style.background='rgba(255,255,255,0.2)'"
             onmouseout="this.style.background='rgba(255,255,255,0.1)'">
            🔗 Open Camera Source
          </a>
        </div>
      `;
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

  function updatePinButtonState(button, itemId) {
    if (!button || !itemId) return;
    button.textContent = isCameraPinned(itemId) ? "Unpin" : "Pin";
  }

  function setupCameraPanelMedia(item) {
    const mediaEl = $("panelMedia");
    const imgEl = mediaEl.querySelector(".panelMedia__img");
    const statusEl = mediaEl.querySelector(".panelMedia__status");
    const refreshBtn = mediaEl.querySelector(".panelMedia__refreshBtn");
    const pinBtn = mediaEl.querySelector(".panelMedia__pinBtn");

    updatePinButtonState(pinBtn, item.id);

    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        loadCameraSnapshot({ imgEl, statusEl, item, force: true });
      });
    }

    if (pinBtn) {
      pinBtn.addEventListener("click", () => {
        toggleCameraPin(item.id);
        updatePinButtonState(pinBtn, item.id);
      });
    }

    loadCameraSnapshot({ imgEl, statusEl, item, force: true });
  }

  function enforceCaps() {
    // Keep newest CONFIG.perf.maxTotalItems items (excluding cameras, which are stable and light)
    const items = Array.from(store.itemsById.values());
    const stableSources = new Set([
      "va511-cameras",
      "external-cameras",
      "wetmet",
      "webcamgalore",
      "weatherbug",
      "oxblue",
      "hope-springs",
      "hospitals",
      "police",
      "fire",
      "shelters",
      "schools",
      "clinics",
      "colleges"
    ]);
    const cams = items.filter(i => stableSources.has(i.sourceId));
    const others = items.filter(i => !stableSources.has(i.sourceId));

    others.sort((a,b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const trimmed = others.slice(0, CONFIG.perf.maxTotalItems);

    // Round 3: Track removed items to clean up seenKeys (prevent memory leak)
    const keptIds = new Set([...cams, ...trimmed].map(it => it.id));
    const removedCount = items.length - keptIds.size;

    store.itemsById.clear();
    store.markersById.clear();

    for (const it of [...cams, ...trimmed]) registerEvent(it);

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
    let filtered = { category: 0, bbox: 0, crime: 0 };

    for (const item of store.itemsById.values()) {
      if (!activeCategories.has(item.category)) {
        filtered.category++;
        continue;
      }
      if (!inBbox(item.lat, item.lon, getBboxForItem(item))) {
        filtered.bbox++;
        continue;
      }
      if (item.sourceId === "fxbg-crime-reports" && !isCrimeItemVisible(item)) {
        filtered.crime++;
        continue;
      }
      attachMarker(item);
      markerCount++;
    }

    console.log(`Redraw complete: ${markerCount} markers visible (${store.itemsById.size} total items, ${filtered.category} filtered by category, ${filtered.bbox} outside bbox, ${filtered.crime} crime hidden)`);

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

    // Location Extraction Pipeline (Module 1 v2)
    // Resolve locations for items that don't have embedded coordinates
    for (const item of out) {
      // Skip if item already has location from GeoRSS
      if (item.loc) {
        // Store location method for transparency
        item.locationMethod = 'override';
        item.locationText = 'GeoRSS';
        item.locationConfidence = LOCATION_CONFIDENCE.override;
        continue;
      }

      // Use the new robust location extraction pipeline
      const resolved = await resolveBestLatLonForRssItem(item, source);

      if (resolved.lat && resolved.lon) {
        item.loc = { lat: resolved.lat, lon: resolved.lon };
        item.locationText = resolved.locationText;
        item.locationMethod = resolved.locationMethod;
        item.locationConfidence = resolved.locationConfidence;
        item.chosenCandidate = resolved.chosenCandidate || null;
        item.flag = resolved.flag || null;

        if (CONFIG.debug.rss && resolved.locationMethod !== 'fallback') {
          console.log(`[Location] Resolved "${item.title?.slice(0, 50)}..." via ${resolved.locationMethod}: ${resolved.lat.toFixed(4)}, ${resolved.lon.toFixed(4)}${resolved.locationText ? ` ("${resolved.locationText}")` : ''}`);
        }
      }
    }

    return out;
  }

  async function pollRSS(forceRefresh = false) {
    if (store.locks.rss) return { skipped:true };
    store.locks.rss = true;
    const results = [];
    let anySucceeded = false;
    let totalAdded = 0;

    for (const source of CONFIG.rss) {
      await sleep((CONFIG.polling && CONFIG.polling.rssStaggerMs) || 300);

      // Round 3: Check source backoff before polling (skip if forceRefresh)
      const backoffCheck = checkSourceBackoff(`rss-${source.id}`);
      if (!forceRefresh && !backoffCheck.allowed) {
        if (CONFIG.debug.rss) {
          console.log(`[RSS Backoff] Skipping ${source.id} (backoff: ${Math.round(backoffCheck.delayMs / 1000)}s remaining)`);
        }
        const diagEntry = {
          ok: false,
          skipped: true,
          backoff: true,
          httpStatus: null,
          itemsParsed: 0,
          itemsIngested: 0,
          error: `Backoff: ${Math.round(backoffCheck.delayMs / 1000)}s remaining`,
          timestamp: Date.now()
        };
        store.diagnostics.rss[source.id] = diagEntry;
        results.push({ source: source.id, ok: false, skipped: true, backoff: true });
        continue;
      }

      try {
        const items = await fetchRSS(source);
        const itemsParsed = items.length;
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
          registerEvent(norm);
          added++;
          totalAdded++;
        }

        if (CONFIG.debug.rss) {
          console.log(`[RSS Ingest] ${source.id}: Added ${added} new items, skipped ${skippedFilter} (filtered), ${skippedDupe} (duplicates)`);
        }

        // Store diagnostics for this source
        store.diagnostics.rss[source.id] = {
          ok: true,
          skipped: false,
          backoff: false,
          httpStatus: 200,
          itemsParsed: itemsParsed,
          itemsIngested: added,
          error: null,
          timestamp: Date.now()
        };

        results.push({ source: source.id, ok: true, added });
        anySucceeded = true;

        // Round 3: Record success to clear backoff
        recordSourceSuccess(`rss-${source.id}`);

      } catch (err) {
        // Check if this is a rate limit error (429)
        const isRateLimit = err.message && (err.message.includes('429') || err.message.includes('Too Many Requests'));
        const isEmpty = err.message && err.message.includes('Empty response');
        const isProxyError = err.message && err.message.includes('proxy');
        const isForbidden = err.message && err.message.includes('403');

        // Extract HTTP status from error message if available
        let httpStatus = null;
        const statusMatch = err.message && err.message.match(/(\d{3})/);
        if (statusMatch) {
          httpStatus = parseInt(statusMatch[1], 10);
        } else if (isRateLimit) {
          httpStatus = 429;
        } else if (isForbidden) {
          httpStatus = 403;
        }

        // Round 3: Record failure and apply backoff
        const errorType = isRateLimit ? 'rate_limit' : (isEmpty ? 'empty' : (isProxyError ? 'proxy' : 'unknown'));
        recordSourceFailure(`rss-${source.id}`, errorType);
        recordFeedError(`rss-${source.id}`);

        // Store diagnostics for this source
        store.diagnostics.rss[source.id] = {
          ok: false,
          skipped: false,
          backoff: false,
          httpStatus: httpStatus,
          itemsParsed: 0,
          itemsIngested: 0,
          error: err.message || String(err),
          timestamp: Date.now()
        };

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

    // Log RSS diagnostics summary
    const okCount = Object.values(store.diagnostics.rss).filter(d => d.ok).length;
    const failCount = Object.values(store.diagnostics.rss).filter(d => !d.ok && !d.skipped).length;
    const skipCount = Object.values(store.diagnostics.rss).filter(d => d.skipped).length;
    console.log(`[RSS Audit] Sources: ${okCount} ok / ${failCount} failed / ${skipCount} skipped`);

    // Log failed sources with reasons
    const failedSources = Object.entries(store.diagnostics.rss).filter(([_, d]) => !d.ok && !d.skipped);
    if (failedSources.length > 0) {
      console.log(`[RSS Audit] Failed sources:`);
      for (const [sourceId, diag] of failedSources) {
        const statusStr = diag.httpStatus ? ` (HTTP ${diag.httpStatus})` : '';
        console.log(`  - ${sourceId}${statusStr}: ${diag.error}`);
      }
    }

    if (CONFIG.debug.rss) {
      console.log(`[RSS Poll] Complete: ${totalAdded} new items from ${results.filter(r => r.ok).length}/${CONFIG.rss.length} feeds`);
    }

    setLastUpdate();
    renderDiagnosticsRSSGeoSummary();
    redraw();
    store.locks.rss = false;
    return { results, diagnostics: store.diagnostics.rss };
  }

  function purgeRssItemsFromStore() {
    const rssItems = Array.from(store.itemsById.values()).filter(item => item.sourceType === "rss");
    for (const item of rssItems) {
      if (item?.dedupeKey) {
        store.seenKeys.delete(item.dedupeKey);
      }
      store.itemsById.delete(item.id);
    }
  }

  // -----------------------------
  // NWS: current + 3 day + alerts
  // -----------------------------
  function updateWeatherChipText(nextBaseText) {
    if (typeof nextBaseText === "string") {
      store.weather.baseText = nextBaseText;
    }
    const baseText = store.weather.baseText || "Weather: Loading…";
    const uvSuffix = store.openUV.displayText ? ` • ${store.openUV.displayText}` : "";
    const weatherTextEl = getChipElement("weatherText");
    if (weatherTextEl) {
      const weatherText = `${baseText}${uvSuffix}`;
      weatherTextEl.textContent = weatherText;
      if (CONFIG.debug.chips) console.log(`[Chip Update] Weather: ${weatherText}`);
    }
  }

  async function fetchNWS() {
    if (store.locks.nws) return;
    store.locks.nws = true;
    try {

    if (!CONFIG.nws.enabled) {
      updateWeatherChipText("Weather: Disabled");
      return;
    }

    // Round 3: Check source backoff before polling
    const backoffCheck = checkSourceBackoff('nws');
    if (!backoffCheck.allowed) {
      console.log(`[NWS Backoff] Skipping (backoff: ${Math.round(backoffCheck.delayMs / 1000)}s remaining)`);
      updateWeatherChipText("Weather: Waiting...");
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
    const weatherText = threeDay ? `${currentText} — ${threeDay}` : currentText;
    updateWeatherChipText(weatherText);

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
        updateWeatherChipText("Weather: Unable to connect (check network)");
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
      registerEvent(norm);
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
      return match ? safeJsonParse(match[1], null, "va511 camera jsonp") : safeJsonParse(text, null, "va511 camera json");
    };

    // Try primary camera endpoint first, then fallbacks if it fails
    // NOTE: Iteris CDN endpoints use JSONP format (*.geojsonp files with callback wrapper)
    const cameraEndpoints = [
      { url: CONFIG.va511.camerasGeojson, format: 'json', name: 'primary' },
      { url: CONFIG.va511.camerasGeojsonFallback, format: 'jsonp', name: 'fallback1' },  // Iteris CDN uses JSONP
      { url: CONFIG.va511.camerasGeojsonFallback2, format: 'jsonp', name: 'fallback2' }
    ];

    for (const endpoint of cameraEndpoints) {
      if (camerasLoaded) break;

      // For Iteris CDN fallback, try both https and http variants
      const fallbackVariants = [];
      if ((endpoint.name === 'fallback1' || endpoint.name === 'fallback2') && endpoint.url.includes('iteriscdn.com')) {
        // Try https first (already in config), then http as fallback
        fallbackVariants.push(endpoint.url);
        if (endpoint.url.startsWith('https://')) {
          fallbackVariants.push(endpoint.url.replace('https://', 'http://'));
        }
      } else if (endpoint.url) {
        fallbackVariants.push(endpoint.url);
      }

      for (const urlVariant of fallbackVariants) {
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

          const response = await fetchWithProxies(urlVariant, {
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
          console.warn(`[VA511 Cameras] ${endpoint.name} returned invalid GeoJSON (missing features), trying next variant/endpoint...`);
        }

        } catch (e) {
          console.warn(`[VA511 Cameras] ${endpoint.name} (${urlVariant}) failed: ${e.message}, trying next variant/endpoint...`);
        }
      } // End urlVariant loop
    } // End endpoint loop

    // If all endpoints failed, log error and apply backoff, then load manual fallback cameras
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

      // Load manual fallback cameras for FXBG metro area
      const manualCamerasLoaded = loadManualFallbackCameras();
      if (manualCamerasLoaded > 0) {
        console.log(`[VA511 Fallback] Loaded ${manualCamerasLoaded} manual fallback cameras`);
        setCameraStatus('STALE', manualCamerasLoaded);
      } else {
        setCameraStatus('ERROR', 0);
      }
    } else {
      // Cameras loaded successfully from API
      const cameraCount = Array.from(store.itemsById.values()).filter(item => item.sourceId === 'va511-cameras').length;
      setCameraStatus('OK', cameraCount);
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
      return match ? safeJsonParse(match[1], null, "va511 incidents jsonp") : safeJsonParse(text, null, "va511 incidents json");
    };

    // Try primary endpoint first, then fallback if it fails
    const incidentsEndpoints = [
      { url: CONFIG.va511.incidentsGeojson, format: 'json', name: 'primary' },
      { url: CONFIG.va511.incidentsGeojsonFallback, format: 'jsonp', name: 'fallback' }
    ];

    for (const endpoint of incidentsEndpoints) {
      if (incidentsLoaded) break;

      // For Iteris CDN fallback, try both https and http variants
      const fallbackVariants = [];
      if (endpoint.name === 'fallback' && endpoint.url.includes('iteriscdn.com')) {
        // Try https first (already in config), then http as fallback
        fallbackVariants.push(endpoint.url);
        if (endpoint.url.startsWith('https://')) {
          fallbackVariants.push(endpoint.url.replace('https://', 'http://'));
        }
      } else {
        fallbackVariants.push(endpoint.url);
      }

      for (const urlVariant of fallbackVariants) {
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

          const response = await fetchWithProxies(urlVariant, {
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
          // Try next URL variant or next endpoint if available
          console.warn(`[VA511 Incidents] ${endpoint.name} (${urlVariant}) failed: ${e.message}, trying next variant/endpoint...`);
          if (endpoint.name === 'fallback' && urlVariant === fallbackVariants[fallbackVariants.length - 1]) {
            // Last variant of fallback endpoint failed - record failure
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
      } // End urlVariant loop
    } // End endpoint loop
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

      // Return null to indicate total failure (different from 0 which means "NORMAL")
      setI95Indicator(null);
      return { i95Incidents: null };
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
      // NOTE: Camera snapshots routed through proxy to avoid 403 from anti-hotlink referrer rules
      // vdotcameras.com and snapshot.vdotcameras.com block direct hotlinking
      if (cleanedCamUrl) {
        // Route through proxy to avoid 403 anti-hotlink blocking
        const proxiedCamUrl = `/proxy?url=${encodeURIComponent(cleanedCamUrl)}`;
        media = { type: "image", src: proxiedCamUrl, originalSrc: cleanedCamUrl, alt: name };
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
        lng: lon, // Ensure lng === lon for API compatibility
        emoji: getCameraEmoji({ sourceId: "va511-cameras", sourceName: "511 Virginia", url: finalPageUrl }),
        tone: "good",
        media,
        dedupeKey: key,
        message: (p.longDescription || p.description || p.status || "").toString().trim() || "Traffic camera feed.",
        panelHtml: ""
      };

      registerEvent(item);
      added++;
    }

    return { added, total: feats.length };
  }

  // Ingest external cameras (WetMet API)
  function ingestExternalCameras() {
    if (!CONFIG.externalCameras.enabled) return { added: 0, total: 0 };

    const cameras = CONFIG.externalCameras.cameras || [];
    let added = 0;

    for (const cam of cameras) {
      const lat = Number(cam.lat);
      const lon = Number(cam.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const key = `ext_cam::${cam.id}::${lat.toFixed(5)},${lon.toFixed(5)}`;
      if (store.seenKeys.has(key)) continue;
      store.seenKeys.add(key);

      // Build media based on type
      let media = null;
      let panelHtml = "";
      let category = "camera";
      let summary = "External camera feed.";
      let message = "External camera feed.";

      if (cam.type === "hospital") {
        // Hospital marker
        category = "hospital";
        summary = cam.info || "Hospital";
        message = cam.info || "Hospital";

        // Build comprehensive hospital info
        let hospitalDetails = `<div style="padding:12px;background:rgba(20,20,20,0.95);border-radius:8px;">
            <h3 style="margin:0 0 12px 0;color:#FFD700;font-size:18px;font-weight:bold;text-shadow:1px 1px 2px rgba(0,0,0,0.8);">🏥 ${escapeHtml(cam.name)}</h3>`;

        if (cam.yearFounded) {
          hospitalDetails += `<p style="margin:0 0 8px 0;color:#7FFF00;font-size:13px;"><strong style="color:#00E5FF;">📅 Founded:</strong> ${escapeHtml(cam.yearFounded.toString())}</p>`;
        }

        if (cam.beds) {
          hospitalDetails += `<p style="margin:0 0 8px 0;color:#7FFF00;font-size:13px;"><strong style="color:#00E5FF;">🛏️ Beds:</strong> ${escapeHtml(cam.beds.toString())} beds</p>`;
        }

        if (cam.emergencyServices) {
          hospitalDetails += `<p style="margin:0 0 8px 0;color:#FF6B6B;font-size:13px;font-weight:bold;"><strong style="color:#FFD700;">🚑 Emergency:</strong> ${escapeHtml(cam.emergencyServices)}</p>`;
        }

        if (cam.departments && cam.departments.length > 0) {
          hospitalDetails += `<p style="margin:0 0 8px 0;color:#7FFF00;font-size:13px;"><strong style="color:#00E5FF;">🏨 Departments (${cam.departments.length}):</strong> ${escapeHtml(cam.departments.join(", "))}</p>`;
        }

        if (cam.specialties) {
          hospitalDetails += `<p style="margin:0 0 8px 0;color:#7FFF00;font-size:13px;"><strong style="color:#00E5FF;">⭐ Specialties:</strong> ${escapeHtml(cam.specialties)}</p>`;
        }

        if (cam.services) {
          hospitalDetails += `<p style="margin:0 0 8px 0;color:#7FFF00;font-size:13px;"><strong style="color:#00E5FF;">🔬 Services:</strong> ${escapeHtml(cam.services)}</p>`;
        }

        if (cam.address) {
          hospitalDetails += `<p style="margin:0 0 8px 0;color:#FFFFFF;font-size:13px;"><strong style="color:#00E5FF;">📍 Address:</strong> ${escapeHtml(cam.address)}</p>`;
        }

        if (cam.phone) {
          hospitalDetails += `<p style="margin:0 0 12px 0;color:#FFFFFF;font-size:13px;"><strong style="color:#00E5FF;">📞 Phone:</strong> ${escapeHtml(cam.phone)}</p>`;
        }

        hospitalDetails += `<a href="${escapeAttr(cam.url)}" target="_blank" rel="noopener noreferrer" class="linkBtn" style="background:#FFD700;color:#000;font-weight:bold;padding:8px 16px;border-radius:6px;text-decoration:none;display:inline-block;">
              Visit Website ↗
            </a>
          </div>`;

        panelHtml = hospitalDetails;
      } else if (cam.type === "clinic") {
        // Clinic marker
        category = "clinic";
        summary = cam.info || "Clinic / Urgent Care";
        message = cam.info || "Clinic / Urgent Care";

        // Build comprehensive clinic info
        let clinicDetails = `<div style="padding:12px;background:rgba(20,20,20,0.95);border-radius:8px;">
            <h3 style="margin:0 0 12px 0;color:#FFD700;font-size:18px;font-weight:bold;text-shadow:1px 1px 2px rgba(0,0,0,0.8);">⚕️ ${escapeHtml(cam.name)}</h3>`;

        if (cam.yearFounded) {
          clinicDetails += `<p style="margin:0 0 8px 0;color:#7FFF00;font-size:13px;"><strong style="color:#00E5FF;">📅 Founded:</strong> ${escapeHtml(cam.yearFounded.toString())}</p>`;
        }

        if (cam.hours) {
          clinicDetails += `<p style="margin:0 0 8px 0;color:#7FFF00;font-size:13px;"><strong style="color:#00E5FF;">🕐 Hours:</strong> ${escapeHtml(cam.hours)}</p>`;
        }

        if (cam.services) {
          clinicDetails += `<p style="margin:0 0 8px 0;color:#7FFF00;font-size:13px;"><strong style="color:#00E5FF;">🔬 Services:</strong> ${escapeHtml(cam.services)}</p>`;
        }

        if (cam.specialties) {
          clinicDetails += `<p style="margin:0 0 8px 0;color:#7FFF00;font-size:13px;"><strong style="color:#00E5FF;">⭐ Specialties:</strong> ${escapeHtml(cam.specialties)}</p>`;
        }

        if (cam.address) {
          clinicDetails += `<p style="margin:0 0 8px 0;color:#FFFFFF;font-size:13px;"><strong style="color:#00E5FF;">📍 Address:</strong> ${escapeHtml(cam.address)}</p>`;
        }

        if (cam.phone) {
          clinicDetails += `<p style="margin:0 0 12px 0;color:#FFFFFF;font-size:13px;"><strong style="color:#00E5FF;">📞 Phone:</strong> ${escapeHtml(cam.phone)}</p>`;
        }

        clinicDetails += `<a href="${escapeAttr(cam.url)}" target="_blank" rel="noopener noreferrer" class="linkBtn" style="background:#FFD700;color:#000;font-weight:bold;padding:8px 16px;border-radius:6px;text-decoration:none;display:inline-block;">
              Visit Website ↗
            </a>
          </div>`;

        panelHtml = clinicDetails;
      } else if (cam.type === "police" || cam.type === "fire" || cam.type === "shelter") {
        category = cam.type === "police" ? "police_crime" : cam.type === "fire" ? "fire_ems" : "shelter";
        summary = cam.address || cam.info || cam.name;
        message = cam.address || cam.info || cam.name;
        panelHtml = `
          <div style="padding:12px;background:rgba(20,20,20,0.95);border-radius:8px;">
            <h3 style="margin:0 0 12px 0;color:#FFD700;font-size:18px;font-weight:bold;text-shadow:1px 1px 2px rgba(0,0,0,0.8);">
              ${cam.type === "police" ? "🚓" : cam.type === "fire" ? "🔥" : "🛟"} ${escapeHtml(cam.name)}
            </h3>
            ${cam.address ? `<p style="margin:0 0 10px 0;color:#FFFFFF;font-size:13px;"><strong style="color:#00E5FF;">📍 Address:</strong> ${escapeHtml(cam.address)}</p>` : ""}
            <a href="${escapeAttr(cam.url)}" target="_blank" rel="noopener noreferrer" class="linkBtn" style="background:#FFD700;color:#000;font-weight:bold;padding:8px 16px;border-radius:6px;text-decoration:none;display:inline-block;">
              Visit Website ↗
            </a>
          </div>`;
      } else if (cam.type === "school") {
        // Skip manual schools if NCES schools are preferred (default)
        if (!CONFIG.externalCameras.includeManualSchools) {
          store.seenKeys.delete(key);  // Remove from seen so it can be re-added if config changes
          continue;
        }
        // School marker
        category = "school";
        summary = cam.info || "School";
        message = cam.info || "School";

        // Build comprehensive school info
        let schoolDetails = `<div style="padding:12px;background:rgba(20,20,20,0.95);border-radius:8px;">
            <h3 style="margin:0 0 12px 0;color:#FFD700;font-size:18px;font-weight:bold;text-shadow:1px 1px 2px rgba(0,0,0,0.8);">🏫 ${escapeHtml(cam.name)}</h3>`;

        if (cam.yearFounded) {
          schoolDetails += `<p style="margin:0 0 8px 0;color:#7FFF00;font-size:13px;"><strong style="color:#00E5FF;">📅 Founded:</strong> ${escapeHtml(cam.yearFounded.toString())}</p>`;
        }

        if (cam.grades) {
          schoolDetails += `<p style="margin:0 0 8px 0;color:#7FFF00;font-size:13px;"><strong style="color:#00E5FF;">📚 Grades:</strong> ${escapeHtml(cam.grades)}</p>`;
        }

        if (cam.enrollment) {
          schoolDetails += `<p style="margin:0 0 8px 0;color:#7FFF00;font-size:13px;"><strong style="color:#00E5FF;">👥 Enrollment:</strong> ${escapeHtml(cam.enrollment.toString())} students</p>`;
        }

        if (cam.mascot) {
          schoolDetails += `<p style="margin:0 0 8px 0;color:#7FFF00;font-size:13px;"><strong style="color:#00E5FF;">🦅 Mascot:</strong> ${escapeHtml(cam.mascot)}</p>`;
        }

        if (cam.colors) {
          schoolDetails += `<p style="margin:0 0 8px 0;color:#7FFF00;font-size:13px;"><strong style="color:#00E5FF;">🎨 Colors:</strong> ${escapeHtml(cam.colors)}</p>`;
        }

        if (cam.sports) {
          schoolDetails += `<p style="margin:0 0 8px 0;color:#7FFF00;font-size:13px;"><strong style="color:#00E5FF;">🏆 Sports:</strong> ${escapeHtml(cam.sports)}</p>`;
        }

        if (cam.achievements) {
          schoolDetails += `<p style="margin:0 0 8px 0;color:#FFD700;font-size:13px;font-weight:bold;"><strong style="color:#00E5FF;">🌟 Achievements:</strong> ${escapeHtml(cam.achievements)}</p>`;
        }

        if (cam.programs) {
          schoolDetails += `<p style="margin:0 0 8px 0;color:#7FFF00;font-size:13px;"><strong style="color:#00E5FF;">📖 Programs:</strong> ${escapeHtml(cam.programs)}</p>`;
        }

        if (cam.specialPrograms) {
          schoolDetails += `<p style="margin:0 0 8px 0;color:#7FFF00;font-size:13px;"><strong style="color:#00E5FF;">✨ Special Programs:</strong> ${escapeHtml(cam.specialPrograms)}</p>`;
        }

        if (cam.address) {
          schoolDetails += `<p style="margin:0 0 8px 0;color:#FFFFFF;font-size:13px;"><strong style="color:#00E5FF;">📍 Address:</strong> ${escapeHtml(cam.address)}</p>`;
        }

        if (cam.phone) {
          schoolDetails += `<p style="margin:0 0 12px 0;color:#FFFFFF;font-size:13px;"><strong style="color:#00E5FF;">📞 Phone:</strong> ${escapeHtml(cam.phone)}</p>`;
        }

        schoolDetails += `<a href="${escapeAttr(cam.url)}" target="_blank" rel="noopener noreferrer" class="linkBtn" style="background:#FFD700;color:#000;font-weight:bold;padding:8px 16px;border-radius:6px;text-decoration:none;display:inline-block;">
              Visit Website ↗
            </a>
          </div>`;

        panelHtml = schoolDetails;
      } else if (cam.type === "iframe") {
        media = { type: "iframe", src: cam.url, alt: cam.name };
      } else if (cam.type === "image") {
        media = { type: "image", src: cam.url, alt: cam.name };
      } else if (cam.type === "link") {
        // For link type (OxBlue, Hope Springs), just show a button
        panelHtml = `
          <p>${escapeHtml(cam.name)} - External camera feed</p>
          <a href="${escapeAttr(cam.url)}" target="_blank" rel="noopener noreferrer" class="linkBtn">
            Open Live Cam ↗
          </a>
        `;
      } else if (cam.type === "webcamgalore") {
        // WebcamGalore cameras: use snapshot as media (consistent with traffic cameras)
        if (cam.thumb) {
          media = { type: "image", src: cam.thumb, alt: cam.name };
        }
        panelHtml = `
          <p style="margin-bottom:10px;color:rgba(255,255,255,0.88);font-size:13px;">${escapeHtml(cam.name)} webcam</p>
        `;
      } else if (cam.type === "weatherbug") {
        // WeatherBug cameras: use thumbnail as snapshot (consistent with traffic cameras)
        if (cam.thumb) {
          media = { type: "image", src: cam.thumb, alt: cam.name };
        }
        panelHtml = `
          <p style="margin-bottom:10px;color:rgba(255,255,255,0.88);font-size:13px;">${escapeHtml(cam.name)} WeatherBug camera</p>
        `;
      }

      // Determine source name based on type
      let sourceName = "External Cameras";
      let sourceId = "external-cameras";
      if (cam.type === "hospital") {
        sourceName = "Hospitals";
        sourceId = "hospitals";
      } else if (cam.type === "clinic") {
        sourceName = "Clinics";
        sourceId = "clinics";
      } else if (cam.type === "police") {
        sourceName = "Police";
        sourceId = "police";
      } else if (cam.type === "fire") {
        sourceName = "Fire & Rescue";
        sourceId = "fire";
      } else if (cam.type === "shelter") {
        sourceName = "Shelters";
        sourceId = "shelters";
      } else if (cam.type === "school") {
        sourceName = "Schools";
        sourceId = "schools";
      } else if (cam.type === "iframe" || cam.type === "image") {
        sourceName = "WetMet Cameras";
        sourceId = "wetmet";
      } else if (cam.type === "webcamgalore") {
        sourceName = "WebcamGalore";
        sourceId = "webcamgalore";
      } else if (cam.type === "weatherbug") {
        sourceName = "WeatherBug Cameras";
        sourceId = "weatherbug";
      } else if (cam.id.includes("oxblue")) {
        sourceName = "OxBlue";
        sourceId = "oxblue";
      } else if (cam.id.includes("hope_springs")) {
        sourceName = "Hope Springs Marina";
        sourceId = "hope-springs";
      }

      // Determine if this is a POI (school, hospital, clinic)
      const isPoi = cam.type === "hospital" || cam.type === "clinic" || cam.type === "school" || cam.type === "police" || cam.type === "fire" || cam.type === "shelter";

      const item = {
        id: key,
        category,
        title: cam.name,
        summary,
        sourceName,
        sourceId,
        url: cam.url,
        timestamp: new Date().toISOString(),
        lat,
        lon,
        lng: lon, // Ensure lng === lon for API compatibility
        emoji: getCameraEmoji({ sourceId, sourceName: cam.name, url: cam.url, type: cam.type }),
        tone: "good",
        media,
        dedupeKey: key,
        message,
        panelHtml,
        source: { id: sourceId, name: sourceName, category, url: cam.url },
        meta: isPoi ? { isPoi: true, poiType: cam.type } : undefined
      };

      registerEvent(item);
      added++;
    }

    return { added, total: cameras.length };
  }

  // Poll external cameras (lightweight - only injects markers, doesn't fetch remote content)
  async function pollExternalCameras() {
    if (!CONFIG.externalCameras.enabled) return;

    const now = Date.now();
    const ttl = CONFIG.externalCameras.cacheTtlMs || 60_000;

    // Check if we need to refresh
    if (store.lastFetch.externalCameras && (now - store.lastFetch.externalCameras) < ttl) {
      return; // Still fresh, skip
    }

    try {
      const result = ingestExternalCameras();
      store.lastFetch.externalCameras = now;
      console.log(`[ExternalCameras] Loaded ${result.added} external camera markers`);
    } catch (e) {
      console.error("[ExternalCameras] Failed to load:", e);
    }
  }

  /**
   * Normalize school coordinates from various possible field names.
   * Handles lat/lon, latitude/longitude, LAT/LON, y/x, and lng variants.
   * Detects and corrects swapped coordinates (when lat looks like longitude and vice versa).
   * Returns [lat, lng] for Leaflet or null if out of bounds.
   */
  function getSchoolLatLng(s) {
    const lat = Number(s.lat ?? s.latitude ?? s.LAT ?? s.y);
    const lon = Number(s.lon ?? s.lng ?? s.longitude ?? s.LON ?? s.x);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return null;
    }

    // Detect swapped coords: if lat looks like a Virginia longitude (<0) and lon looks like latitude (>0)
    let a = lat, b = lon;
    if (a < 0 && b > 0) {
      const tmp = a;
      a = b;
      b = tmp;
      if (DEBUG_SCHOOLS) {
        console.warn(`[Schools] Swapped coordinates detected for school: lat=${lat}, lon=${lon} -> corrected to [${a}, ${b}]`);
      }
    }

    // Guardrail bounds for FXBG metro region (slightly expanded for safety)
    const inBounds = (a >= 37.0 && a <= 39.5 && b >= -78.5 && b <= -76.0);
    if (!inBounds) {
      return null;
    }

    return [a, b]; // Leaflet expects [lat, lng]
  }

  /**
   * Ingest schools from NCES EDGE dataset (authoritative coordinates)
   * Data format: { schools: [{ ncesId, name, lat, lon, address, grades, ... }] }
   */
  function ingestSchoolsNces(data) {
    const schools = Array.isArray(data) ? data : (data?.schools || []);
    let added = 0;
    let skippedInvalid = 0;
    let skippedOutOfBounds = 0;

    // Debug: log first 10 schools with raw fields and computed coordinates
    if (DEBUG_SCHOOLS) {
      console.log("[Schools] DEBUG_SCHOOLS enabled - logging first 10 schools:");
      schools.slice(0, 10).forEach((s, i) => {
        const ll = getSchoolLatLng(s);
        console.log(`[Schools] ${i + 1}. "${s.name}"`, {
          raw: { lat: s.lat, lon: s.lon, latitude: s.latitude, longitude: s.longitude, lng: s.lng, x: s.x, y: s.y },
          computed: ll ? `[${ll[0]}, ${ll[1]}]` : "null (out of bounds or invalid)"
        });
      });
    }

    for (const school of schools) {
      // Use normalized helper for coordinate extraction
      const ll = getSchoolLatLng(school);
      if (!ll) {
        // Determine if invalid coords or out of bounds for logging
        const rawLat = Number(school.lat ?? school.latitude ?? school.LAT ?? school.y);
        const rawLon = Number(school.lon ?? school.lng ?? school.longitude ?? school.LON ?? school.x);
        if (!Number.isFinite(rawLat) || !Number.isFinite(rawLon)) {
          skippedInvalid++;
        } else {
          skippedOutOfBounds++;
          // Log warning with raw record for schools outside CONFIG.poiBbox
          console.warn(`[Schools] Skipped out-of-bounds school:`, {
            id: school.ncesId || school.id || 'unknown',
            name: school.name,
            lat: rawLat,
            lon: rawLon
          });
        }
        continue;
      }

      const [lat, lon] = ll;
      const ncesId = school.ncesId || '';
      const key = `school_nces::${ncesId || school.name}::${lat.toFixed(5)},${lon.toFixed(5)}`;
      if (store.seenKeys.has(key)) continue;
      store.seenKeys.add(key);

      // Build school info panel
      let schoolDetails = `<div style="padding:12px;background:rgba(20,20,20,0.95);border-radius:8px;">
          <h3 style="margin:0 0 12px 0;color:#FFD700;font-size:18px;font-weight:bold;text-shadow:1px 1px 2px rgba(0,0,0,0.8);">🏫 ${escapeHtml(school.name)}</h3>`;

      if (school.grades) {
        schoolDetails += `<p style="margin:0 0 8px 0;color:#7FFF00;font-size:13px;"><strong style="color:#00E5FF;">📚 Grades:</strong> ${escapeHtml(school.grades)}</p>`;
      }

      if (school.address) {
        schoolDetails += `<p style="margin:0 0 8px 0;color:#FFFFFF;font-size:13px;"><strong style="color:#00E5FF;">📍 Address:</strong> ${escapeHtml(school.address)}</p>`;
      }

      if (school.county) {
        schoolDetails += `<p style="margin:0 0 8px 0;color:#FFFFFF;font-size:13px;"><strong style="color:#00E5FF;">🏛️ District:</strong> ${escapeHtml(school.county)}</p>`;
      }

      if (school.phone) {
        schoolDetails += `<p style="margin:0 0 8px 0;color:#FFFFFF;font-size:13px;"><strong style="color:#00E5FF;">📞 Phone:</strong> ${escapeHtml(school.phone)}</p>`;
      }

      // Debug mode: show name, lat/lon, address for verification (enabled via DEBUG_SCHOOLS or poiCoords)
      if (DEBUG_SCHOOLS || CONFIG.debug.poiCoords) {
        schoolDetails += `<div style="margin-top:10px;padding:8px;background:rgba(255,215,0,0.1);border:1px dashed #FFD700;border-radius:4px;">`;
        schoolDetails += `<p style="margin:0 0 4px 0;color:#FFD700;font-size:11px;font-weight:bold;">🔧 DEBUG INFO</p>`;
        schoolDetails += `<p style="margin:0 0 4px 0;color:#888;font-size:11px;font-family:monospace;"><strong>Name:</strong> ${escapeHtml(school.name)}</p>`;
        schoolDetails += `<p style="margin:0 0 4px 0;color:#888;font-size:11px;font-family:monospace;"><strong>Lat/Lon:</strong> ${lat.toFixed(6)}, ${lon.toFixed(6)}</p>`;
        if (school.address) {
          schoolDetails += `<p style="margin:0 0 4px 0;color:#888;font-size:11px;font-family:monospace;"><strong>Address:</strong> ${escapeHtml(school.address)}</p>`;
        }
        schoolDetails += `<button onclick="navigator.clipboard.writeText('${lat.toFixed(6)}, ${lon.toFixed(6)}')" style="font-size:10px;padding:4px 8px;background:#444;color:#fff;border:none;border-radius:4px;cursor:pointer;">Copy coords</button>`;
        schoolDetails += `</div>`;
      }

      schoolDetails += `</div>`;

      const summary = [school.grades, school.address].filter(Boolean).join(' | ') || 'School';

      const item = {
        id: key,
        category: "school",
        title: school.name,
        summary: summary,
        sourceName: "Schools (NCES)",
        sourceId: "schools-nces",
        timestamp: new Date().toISOString(),
        lat,
        lon,
        lng: lon, // Ensure lng === lon for API compatibility
        emoji: "🏫",
        tone: "good",
        dedupeKey: key,
        message: summary,
        panelHtml: schoolDetails,
        source: { id: "schools-nces", name: "Schools (NCES)", category: "school" },
        meta: { isPoi: true, poiType: "school", nces: true }
      };

      registerEvent(item);
      added++;
    }

    // Always log summary (for console verification)
    console.log(`[Schools] loaded=${schools.length} added=${added} skipped=${skippedInvalid + skippedOutOfBounds}`);

    // Extended debug diagnostics
    if (DEBUG_SCHOOLS) {
      console.log("[Schools] Detailed diagnostics:", {
        totalInFile: schools.length,
        markersAdded: added,
        skippedInvalidCoords: skippedInvalid,
        skippedOutOfBounds: skippedOutOfBounds
      });
    }

    return { added, total: schools.length, skippedInvalid, skippedOutOfBounds };
  }

  /**
   * Poll NCES schools data (fetches JSON once per boot or TTL)
   */
  async function pollSchoolsNces() {
    if (!CONFIG.schoolsNces?.enabled) return;

    const now = Date.now();
    const ttl = CONFIG.schoolsNces.cacheTtlMs || (6 * 60 * 60 * 1000);

    // Check if we need to refresh
    if (store.lastFetch.schoolsNces && (now - store.lastFetch.schoolsNces) < ttl) {
      return; // Still fresh, skip
    }

    try {
      const url = CONFIG.schoolsNces.url;
      console.log(`[SchoolsNCES] Fetching ${url}...`);

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const result = ingestSchoolsNces(data);
      store.lastFetch.schoolsNces = now;
      console.log(`[SchoolsNCES] Loaded ${result.added} schools from NCES dataset (${result.total} total in file)`);

      // Visual debug: draw bbox rectangle around schools region
      if (DEBUG_SCHOOLS && typeof map !== 'undefined') {
        const bbox = CONFIG.poiBbox;
        const bounds = [[bbox.minLat, bbox.minLon], [bbox.maxLat, bbox.maxLon]];
        L.rectangle(bounds, {
          color: '#FFD700',
          weight: 2,
          fill: false,
          dashArray: '8, 4',
          opacity: 0.7
        }).addTo(map).bindPopup('Schools POI Bounding Box (DEBUG)');
        console.log('[Schools] Debug bbox rectangle added to map:', bounds);
      }
    } catch (e) {
      console.warn("[SchoolsNCES] Failed to load:", e.message);
      // Not critical - app works without this data
    }
  }

  function ingestColleges(data) {
    const colleges = Array.isArray(data) ? data : (data?.colleges || []);
    let added = 0;

    const defaultUrls = {
      umw: "https://www.umw.edu/",
      germanna_fxbg: "https://www.germanna.edu/"
    };

    for (const college of colleges) {
      const lat = Number(college.lat ?? college.latitude ?? college.LAT);
      const lon = Number(college.lng ?? college.lon ?? college.longitude ?? college.LON);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const key = `college::${college.id || college.name}::${lat.toFixed(5)},${lon.toFixed(5)}`;
      if (store.seenKeys.has(key)) continue;
      store.seenKeys.add(key);

      const summaryParts = [college.kind, college.city].filter(Boolean);
      const summary = summaryParts.join(" | ") || "College/University";
      const url = college.url || defaultUrls[college.id] || "https://www.umw.edu/";

      let collegeDetails = `<div style="padding:12px;background:rgba(20,20,20,0.95);border-radius:8px;">
          <h3 style="margin:0 0 12px 0;color:#FFD700;font-size:18px;font-weight:bold;text-shadow:1px 1px 2px rgba(0,0,0,0.8);">🎓 ${escapeHtml(college.name)}</h3>`;

      if (college.kind) {
        collegeDetails += `<p style="margin:0 0 8px 0;color:#7FFF00;font-size:13px;"><strong style="color:#00E5FF;">🏫 Type:</strong> ${escapeHtml(college.kind)}</p>`;
      }

      if (college.city) {
        collegeDetails += `<p style="margin:0 0 8px 0;color:#FFFFFF;font-size:13px;"><strong style="color:#00E5FF;">📍 City:</strong> ${escapeHtml(college.city)}</p>`;
      }

      collegeDetails += `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" class="linkBtn" style="background:#FFD700;color:#000;font-weight:bold;padding:8px 16px;border-radius:6px;text-decoration:none;display:inline-block;">
            Visit Website ↗
          </a>
        </div>`;

      const item = {
        id: key,
        category: "college",
        title: college.name,
        summary,
        sourceName: "Colleges/Universities",
        sourceId: "colleges",
        url,
        timestamp: new Date().toISOString(),
        lat,
        lon,
        lng: lon, // Ensure lng === lon for API compatibility
        emoji: "🎓",
        tone: "good",
        dedupeKey: key,
        message: summary,
        panelHtml: collegeDetails,
        source: { id: "colleges", name: "Colleges/Universities", category: "college" },
        meta: { isPoi: true, poiType: "college" }
      };

      registerEvent(item);
      added++;
    }

    return { added, total: colleges.length };
  }

  async function pollColleges() {
    if (!CONFIG.colleges?.enabled) return;

    const now = Date.now();
    const ttl = CONFIG.colleges.cacheTtlMs || (6 * 60 * 60 * 1000);

    if (store.lastFetch.colleges && (now - store.lastFetch.colleges) < ttl) {
      return;
    }

    try {
      const url = CONFIG.colleges.url;
      console.log(`[Colleges] Fetching ${url}...`);

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const result = ingestColleges(data);
      store.lastFetch.colleges = now;
      console.log(`[Colleges] Loaded ${result.added} colleges/universities (${result.total} total in file)`);
    } catch (e) {
      console.warn("[Colleges] Failed to load:", e.message);
    }
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
      registerEvent(norm);
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
      registerEvent(norm);
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
      registerEvent(norm);
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
            registerEvent(norm);
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
  async function fetchJsonWithStatus(url, opts = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("Timeout"), opts.timeoutMs || 15000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: opts.headers
      });
      const text = await response.text();
      const data = safeJsonParse(text, null, `json ${url}`);
      return { ok: response.ok, status: response.status, data };
    } catch (err) {
      return { ok: false, status: 0, error: err.message || String(err), data: null };
    } finally {
      clearTimeout(timeout);
    }
  }

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
      const url = `${CONFIG.openUV.baseUrl}?lat=${CONFIG.openUV.lat}&lon=${CONFIG.openUV.lon}`;
      const response = await fetchJsonWithStatus(url, {
        headers: { "Accept": "application/json" }
      });

      if (response.status === 503 && response.data?.disabled) {
        store.openUV.status = "disabled";
        store.openUV.displayText = "UV: N/A";
        store.openUV.timestamp = Date.now();
        updateWeatherChipText();
        if (!store._openUVDisabledLogged) {
          console.warn(`[OpenUV] Disabled: ${response.data?.reason || "missing API key"}`);
          store._openUVDisabledLogged = true;
        }
        return;
      }

      const data = response.data;
      if (!response.ok || !data || !data.result) {
        console.warn("[OpenUV] No valid UV data received");
        recordSourceFailure('openuv', 'invalid_data');
        recordFeedError('openuv');
        store.openUV.status = "error";
        store.openUV.displayText = "UV: N/A";
        updateWeatherChipText();
        return;
      }

      const uv = data.result;
      const uvValue = typeof uv.uv === "number" ? uv.uv : (typeof uv.uv_max === "number" ? uv.uv_max : 0);
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
        registerEvent(normalized);
        console.log(`[OpenUV] UV Index: ${uvValue.toFixed(1)} (${uvLevel})`);
      }

      store.openUV.value = uvValue;
      store.openUV.status = "ok";
      store.openUV.displayText = `UV ${uvValue.toFixed(1)}`;
      store.openUV.timestamp = Date.now();
      updateWeatherChipText();

      // Round 3: Record success to clear backoff
      recordSourceSuccess('openuv');

    } catch (err) {
      console.error("[OpenUV] Fetch failed:", err.message);

      // Round 3: Record failure and apply backoff
      recordSourceFailure('openuv', 'fetch_error');
      recordFeedError('openuv');
      store.openUV.status = "error";
      store.openUV.displayText = "UV: N/A";
      updateWeatherChipText();
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
      // Try primary endpoint first, fallback to secondary if 403
      let data;
      try {
        data = await fetchWithProxies(CONFIG.cdc.wonderApiUrl, {
          expect: "json",
          headers: {
            "Accept": "application/json"
          }
        });
      } catch (primaryErr) {
        if (primaryErr.message?.includes("403") || primaryErr.message?.includes("Forbidden")) {
          console.warn("[CDC] Primary endpoint returned 403, trying fallback...");
          data = await fetchWithProxies(CONFIG.cdc.wonderFallbackUrl, {
            expect: "json",
            headers: {
              "Accept": "application/json"
            }
          });
        } else {
          throw primaryErr;
        }
      }

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
          registerEvent(normalized);
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
  // Camera status indicator
  // -----------------------------
  function setCameraStatus(status, count = 0) {
    const textEl = getChipElement("camerasText");
    const dotEl = getChipElement("camerasDot");

    let displayText = "Cameras: …";
    let dotColor = "#888";

    switch (status) {
      case 'OK':
        displayText = `Cameras: OK (${count})`;
        dotColor = "#00e400"; // Green
        break;
      case 'STALE':
        displayText = `Cameras: STALE (${count})`;
        dotColor = "#ffaa00"; // Orange
        break;
      case 'ERROR':
        displayText = "Cameras: ERROR";
        dotColor = "#ff4444"; // Red
        break;
      default:
        displayText = "Cameras: …";
        dotColor = "#888";
    }

    if (textEl) {
      textEl.textContent = displayText;
      if (CONFIG.debug.chips) console.log(`[Chip Update] ${displayText}`);
    }
    if (dotEl) {
      dotEl.style.backgroundColor = dotColor;
    }
  }

  // Manual fallback cameras for FXBG metro area (used when VA511 endpoints are unavailable)
  const MANUAL_FALLBACK_CAMERAS = [
    { name: "I-95 at Falmouth", lat: 38.3245, lon: -77.4565, description: "I-95 northbound at Falmouth/US-1" },
    { name: "I-95 at Rappahannock River", lat: 38.2945, lon: -77.4605, description: "I-95 crossing Rappahannock River" },
    { name: "I-95 at Route 3", lat: 38.3032, lon: -77.4785, description: "I-95 at Route 3 interchange" },
    { name: "I-95 at Massaponax", lat: 38.2456, lon: -77.4678, description: "I-95 at Massaponax/Route 608" },
    { name: "Route 1 at Central Park", lat: 38.2912, lon: -77.5234, description: "US-1 at Central Park Blvd" },
    { name: "Route 3 at Salem Church", lat: 38.3089, lon: -77.5012, description: "Route 3 at Salem Church Rd" },
    { name: "Route 17 at Warrenton Rd", lat: 38.3234, lon: -77.4523, description: "Route 17 at Warrenton Rd" },
    { name: "I-95 at Courthouse Rd", lat: 38.3678, lon: -77.4512, description: "I-95 at Courthouse Rd exit" },
    { name: "I-95 at Garrisonville", lat: 38.4123, lon: -77.4345, description: "I-95 at Garrisonville Rd" },
    { name: "Route 1 at Fredericksburg", lat: 38.3015, lon: -77.4605, description: "US-1 in downtown Fredericksburg" }
  ];

  function loadManualFallbackCameras() {
    let added = 0;

    for (const cam of MANUAL_FALLBACK_CAMERAS) {
      const lat = Number(cam.lat);
      const lon = Number(cam.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const key = `va511_cam_fallback::${cam.name}::${lat.toFixed(5)},${lon.toFixed(5)}`;
      if (store.seenKeys.has(key)) continue;
      store.seenKeys.add(key);

      const item = {
        id: key,
        category: "camera",
        title: cam.name,
        summary: cam.description || "Traffic camera (fallback data)",
        sourceName: "511 Virginia (Manual Fallback)",
        sourceId: "va511-cameras",
        url: `https://511.vdot.virginia.gov/map?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&zoom=15&layers=cameras`,
        timestamp: new Date().toISOString(),
        lat,
        lon,
        emoji: "📷",
        tone: "neutral",
        media: null, // No live images available for manual fallback
        dedupeKey: key,
        message: cam.description || "Traffic camera feed unavailable - location marked for reference.",
        panelHtml: `<p style="color:#ffaa00;font-size:12px;">⚠️ Live feed unavailable. Camera location shown for reference only.</p>`
      };

      registerEvent(item);
      added++;
    }

    return added;
  }

  // -----------------------------
  // I‑95 indicator
  // -----------------------------
  function setI95Indicator(i95Incidents) {
    const el = getChipElement("trafficText");
    let status = "NO DATA";
    if (typeof i95Incidents === "number") {
      if (i95Incidents === 0) status = "NORMAL";
      else if (i95Incidents <= 2) status = `SLOWING (${i95Incidents})`;
      else status = `HEAVY (${i95Incidents})`;
    }
    if (el) {
      el.textContent = `I‑95: ${status}`;
      if (CONFIG.debug.chips) console.log(`[Chip Update] I-95: ${status} (${i95Incidents} incidents)`);
    }
  }

  // -----------------------------
  // Air Quality (AQICN/WAQI)
  // -----------------------------
  async function fetchAirQuality() {
    if (!CONFIG.air.enabled) return;
    if (store.locks.air) return;
    store.locks.air = true;

    try {
      const airTextEl = getChipElement("airText");
      const airDotEl = getChipElement("airDot");
      if (airTextEl) airTextEl.textContent = "AQI: Loading…";
      if (airDotEl) airDotEl.style.backgroundColor = "#888";

      const url = `${CONFIG.air.baseUrl}?lat=${CONFIG.air.lat}&lon=${CONFIG.air.lon}`;
      const response = await fetchJsonWithStatus(url, { headers: { "Accept": "application/json" } });

      if (response.status === 503 && response.data?.disabled) {
        if (!store._airDisabledLogged) {
          console.warn(`[Air Quality] Disabled: ${response.data?.reason || "missing token"}`);
          store._airDisabledLogged = true;
        }
        if (airTextEl) airTextEl.textContent = "AQI: N/A";
        if (airDotEl) airDotEl.style.backgroundColor = "#888";
        return;
      }

      const data = response.data;

      if (response.ok && data && data.status === "ok" && data.data && typeof data.data.aqi === "number") {
        const aqi = data.data.aqi;
        store.air.aqi = aqi;
        store.air.timestamp = Date.now();

        // Update chip text
        if (airTextEl) {
          airTextEl.textContent = `AQI: ${aqi}`;
          if (CONFIG.debug.chips) console.log(`[Chip Update] AQI: ${aqi}`);
        }

        // Update dot color based on AQI ranges
        if (airDotEl) {
          let color;
          if (aqi <= 50) color = "#00e400";  // Good (green)
          else if (aqi <= 100) color = "#ffff00";  // Moderate (yellow)
          else if (aqi <= 150) color = "#ff7e00";  // Unhealthy for Sensitive Groups (orange)
          else if (aqi <= 200) color = "#ff0000";  // Unhealthy (red)
          else if (aqi <= 300) color = "#99004c";  // Very Unhealthy (purple)
          else color = "#7e0023";  // Hazardous (maroon)

          airDotEl.style.backgroundColor = color;
        }

        console.log(`[Air Quality] AQI: ${aqi}`);
      } else {
        console.warn("[Air Quality] No valid AQI data received");
        if (airTextEl) airTextEl.textContent = "AQI: N/A";
        if (airDotEl) airDotEl.style.backgroundColor = "#888";
        recordSourceFailure('air', 'invalid_data');
        recordFeedError('air');
      }
    } catch (err) {
      console.error("[Air Quality] Fetch failed:", err.message);
      const airTextEl = getChipElement("airText");
      const airDotEl = getChipElement("airDot");
      if (airTextEl) airTextEl.textContent = "AQI: N/A";
      if (airDotEl) airDotEl.style.backgroundColor = "#888";
    } finally {
      store.locks.air = false;
    }
  }

  // -----------------------------
  // Crime Reports (FXBG PD)
  // -----------------------------

  function getCrimeWindowDays(usePending = false) {
    if (!store.crime) return CRIME_UI_DEFAULTS.windowDays;
    const days = usePending ? store.crime.windowDays : store.crime.appliedWindowDays;
    return Number.isFinite(days) ? days : CRIME_UI_DEFAULTS.windowDays;
  }

  function getCrimeCutoff(days) {
    return Date.now() - days * 86400000;
  }

  function isCrimeItemInWindow(item, days) {
    const ts = new Date(item?.timestamp || item?.published || 0).getTime();
    if (Number.isNaN(ts)) return false;
    return ts >= getCrimeCutoff(days);
  }

  function isCrimeItemVisible(item, days = getCrimeWindowDays()) {
    if (!store.crime?.enabled) return false;
    return isCrimeItemInWindow(item, days);
  }

  /**
   * Apply crime overlay visibility based on enabled state and time window
   */
  function applyCrimeOverlayVisibility() {
    if (!store.crime) return;

    const days = getCrimeWindowDays();

    for (const id of store.crime.ids) {
      const item = store.itemsById.get(id);
      if (!item) continue;

      const shouldShow = isCrimeItemVisible(item, days)
        && activeCategories.has(item.category)
        && inBbox(item.lat, item.lon, getBboxForItem(item));

      const hadMarker = store.markersById.has(id);
      if (shouldShow) {
        if (!hadMarker) {
          attachMarker(item);
        }
        const marker = store.markersById.get(id);
        if (marker && !store.crime.markersOnMap.has(id)) {
          if (hadMarker) {
            clusters.addLayer(marker);
          }
          store.crime.markersOnMap.add(id);
        }
      } else if (hadMarker) {
        const marker = store.markersById.get(id);
        clusters.removeLayer(marker);
        store.crime.markersOnMap.delete(id);
      }
    }
  }

  /**
   * Poll FXBG PD Crime Reports API
   */
  async function pollFxbgCrimeReports() {
    if (!CONFIG.fxbgCrimeReports.enabled) return;
    if (store.locks.crime) return;

    store.locks.crime = true;

    try {
      const months = CONFIG.fxbgCrimeReports.months;
      const url = `/api/fxbg/crime-reports/incidents?months=${months}`;

      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`[Crime Reports] API returned ${res.status}`);
        return;
      }

      const json = await res.json();
      if (!json.ok || !json.incidents) {
        console.warn("[Crime Reports] Invalid API response");
        return;
      }

      const incidents = json.incidents;
      console.log(`[Crime Reports] Loaded ${incidents.length} incidents`);

      // Process incidents and create markers
      for (const incident of incidents) {
        if (!incident.latitude || !incident.longitude) continue;

        const id = `crime:${incident.id}`;
        const emoji = crimeEmojiFor(incident);

        const item = {
          id,
          category: "police_crime",
          sourceId: "fxbg-crime-reports",
          sourceName: "FXBG PD Crime Reports",
          title: `[CRIME REPORT] ${incident.offenseType} — ${incident.locationRaw}`,
          summary: incident.description || `${incident.offenseType} reported at ${incident.locationRaw}`,
          timestamp: incident.incidentDateISO,
          published: incident.incidentDateISO,
          lat: incident.latitude,
          lon: incident.longitude,
          emoji,
          tone: "warn",
          meta: incident
        };

        // Upsert to store (always store item so it's available when user expands window)
        registerEvent(item);
        store.crime.ids.add(id);

        // At boot, only attach markers for items within the 30-day boot window
        // After boot, applyCrimeOverlayVisibility() will handle marker creation
        const isInBootWindow = isCrimeItemInWindow(item, CRIME_UI_DEFAULTS.windowDays);

        // Attach marker only if:
        // 1. No marker exists yet AND
        // 2. Either boot is complete (user expanded window) OR item is in boot window
        if (!store.markersById.has(id)) {
          if (store._crimeBootInitialized || isInBootWindow) {
            attachMarker(item);
          }
        }
      }

      // Count items in boot window for logging
      const bootWindowDays = CRIME_UI_DEFAULTS.windowDays;
      let bootWindowCount = 0;
      for (const id of store.crime.ids) {
        const item = store.itemsById.get(id);
        if (item && isCrimeItemInWindow(item, bootWindowDays)) {
          bootWindowCount++;
        }
      }

      // Mark boot as initialized after first successful poll
      if (!store._crimeBootInitialized) {
        store._crimeBootInitialized = true;
        console.info(`[Crime Reports] Crime boot window: ${bootWindowDays} days — ${bootWindowCount} incidents visible`);
      }

      // Apply visibility based on current settings
      applyCrimeOverlayVisibility();
      updateCrimeIncidentsList();

      console.log(`[Crime Reports] Total crime items in store: ${store.crime.ids.size} (${bootWindowCount} in ${bootWindowDays}-day window)`);

    } catch (err) {
      console.error("[Crime Reports] Poll error:", err);
    } finally {
      store.locks.crime = false;
    }
  }

  /**
   * Update CRIME button active state (visual indicator)
   */
  function updateCrimeButtonActiveState() {
    const btnCrime = $("btnCrime") || $("btnCrimeMobile");
    if (!btnCrime || !store.crime) return;

    if (store.crime.enabled) {
      btnCrime.classList.add("active");
      btnCrime.setAttribute("aria-pressed", "true");
    } else {
      btnCrime.classList.remove("active");
      btnCrime.setAttribute("aria-pressed", "false");
    }
  }

  /**
   * Toggle Crime overlay ON/OFF
   */
  function toggleCrimeOverlay(fromUser = true) {
    if (!store.crime) return;

    store.crime.pendingEnabled = !store.crime.enabled;
    store.crime.windowDays = store.crime.appliedWindowDays;
    applyCrimeOverlaySettings(fromUser);

    console.log(`[Crime Overlay] ${store.crime.enabled ? "Enabled" : "Disabled"}`);
  }

  /**
   * Open Crime Reports menu panel
   */
  function openCrimeMenuPanel() {
    const panel = $("crimePanel");
    if (!panel) {
      console.warn("[Crime Panel] Panel element not found");
      return;
    }

    playClickSound('open');
    panel.classList.remove("crimePanel--hidden");
    updateCrimeMenuPanel();
    setMobileHeaderCollapsed(true);
  }

  /**
   * Close Crime Reports menu panel
   */
  function closeCrimeMenuPanel() {
    const panel = $("crimePanel");
    if (!panel) return;

    playClickSound('close');
    panel.classList.add("crimePanel--hidden");
    restoreHeaderIfNoBlockingPanels();
  }

  /**
   * Update Crime Reports menu panel content
   */
  function updateCrimeMenuPanel() {
    if (!store.crime) return;

    // Update enable toggle
    const enableToggle = $("crimeEnableToggle");
    if (enableToggle) {
      enableToggle.checked = store.crime.pendingEnabled;
    }

    // Update window days dropdown
    const windowDropdown = $("crimeWindowDays");
    if (windowDropdown) {
      const standardOptions = ["7", "30", "90", "180", "365"];
      const targetValue = String(store.crime.windowDays);
      if (standardOptions.includes(targetValue)) {
        windowDropdown.value = targetValue;
      } else {
        windowDropdown.value = "custom";
      }
      const customRow = $("crimeCustomRow");
      const customInput = $("crimeWindowCustom");
      if (customRow) {
        customRow.style.display = windowDropdown.value === "custom" ? "flex" : "none";
      }
      if (customInput && windowDropdown.value === "custom") {
        customInput.value = String(store.crime.windowDays);
      }
    }

    // Update sort toggle
    const sortNewest = $("crimeSortNewest");
    const sortOldest = $("crimeSortOldest");
    if (sortNewest && sortOldest) {
      if (store.crime.sort === "newest") {
        sortNewest.classList.add("filterBtn--active");
        sortOldest.classList.remove("filterBtn--active");
      } else {
        sortNewest.classList.remove("filterBtn--active");
        sortOldest.classList.add("filterBtn--active");
      }
    }

    // Update menu auto-open toggle
    const menuAutoOpenToggle = $("crimeMenuAutoOpen");
    if (menuAutoOpenToggle) {
      menuAutoOpenToggle.checked = store.crime.menuAutoOpen;
    }

    updateCrimeAppliedLabel();

    // Update incidents list
    updateCrimeIncidentsList();
  }

  function updateCrimeAppliedLabel() {
    const label = $("crimeAppliedLabel");
    if (!label || !store.crime) return;
    const days = store.crime.appliedWindowDays || CRIME_UI_DEFAULTS.windowDays;
    label.textContent = `Applied: Last ${days} days`;
  }

  function applyCrimeOverlaySettings(fromUser = true) {
    if (!store.crime) return;

    store.crime.enabled = store.crime.pendingEnabled;
    store.crime.appliedWindowDays = store.crime.windowDays;
    store.crime.lastAppliedAt = new Date().toISOString();
    store.crime.pendingEnabled = store.crime.enabled;

    saveCrimeUI({
      enabled: store.crime.enabled,
      windowDays: store.crime.windowDays,
      appliedWindowDays: store.crime.appliedWindowDays,
      lastAppliedAt: store.crime.lastAppliedAt,
      sort: store.crime.sort,
      menuAutoOpen: store.crime.menuAutoOpen
    });

    applyCrimeOverlayVisibility();
    updateCrimeButtonActiveState();
    updateCrimeAppliedLabel();
    updateCrimeIncidentsList();

    if (store.crime.enabled && store.crime.menuAutoOpen && fromUser) {
      openCrimeMenuPanel();
    }
  }

  /**
   * Update Crime Reports incidents list in panel
   */
  function updateCrimeIncidentsList({ windowDays } = {}) {
    const listEl = $("crimeIncidentsList");
    if (!listEl || !store.crime) return;

    const days = Number.isFinite(windowDays) ? windowDays : getCrimeWindowDays(true);
    const cutoff = getCrimeCutoff(days);

    const incidents = Array.from(store.crime.ids)
      .map(id => store.itemsById.get(id))
      .filter(Boolean)
      .filter(item => {
        const ts = new Date(item.timestamp || item.published || 0).getTime();
        return !isNaN(ts) && ts >= cutoff;
      })
      .sort((a, b) => {
        const aTime = new Date(a.timestamp || a.published || 0).getTime();
        const bTime = new Date(b.timestamp || b.published || 0).getTime();
        return store.crime.sort === "newest" ? bTime - aTime : aTime - bTime;
      })
      .slice(0, 50);

    if (incidents.length === 0) {
      listEl.innerHTML = `<div class="crime-list-empty">No crime reports in selected time window.</div>`;
      return;
    }

    const html = incidents.map(item => {
      const date = new Date(item.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const offenseType = item.meta?.offenseType || "Crime Report";
      const location = item.meta?.locationRaw || "Unknown location";

      return `
        <div class="crime-list-item" data-id="${escapeAttr(item.id)}">
          <div class="crime-list-item__emoji">${escapeHtml(item.emoji)}</div>
          <div class="crime-list-item__content">
            <div class="crime-list-item__title">${escapeHtml(offenseType)}</div>
            <div class="crime-list-item__meta">
              <span>${escapeHtml(date)}</span>
              <span>•</span>
              <span>${escapeHtml(location)}</span>
            </div>
          </div>
        </div>
      `;
    }).join("");

    listEl.innerHTML = html;

    // Attach click listeners
    document.querySelectorAll(".crime-list-item").forEach(el => {
      el.addEventListener("click", () => {
        const id = el.getAttribute("data-id");
        if (id) {
          // Ensure overlay is enabled
          if (!store.crime.enabled) {
            store.crime.pendingEnabled = true;
            applyCrimeOverlaySettings(false);
          }

          // Select and zoom to item
          selectItem(id);
          closeCrimeMenuPanel();
        }
      });
    });
  }

  // -----------------------------
  // Controls
  // -----------------------------
  // -----------------------------
  // Reports (Field Notes / Incidents)
  // -----------------------------

  const REPORT_TYPES = [
    "Suspicious",
    "Hazard",
    "Medical",
    "Traffic",
    "Fire",
    "Other"
  ];

  const REPORT_TYPE_EMOJI = {
    Suspicious: "🕵️",
    Hazard: "⚠️",
    Medical: "🩺",
    Traffic: "🚧",
    Fire: "🔥",
    Other: "📝"
  };

  function reportEmojiFor(type, severity) {
    const base = REPORT_TYPE_EMOJI[type] || REPORT_TYPE_EMOJI.Other;
    if (severity >= 5) return "🚨";
    if (severity >= 4 && type === "Medical") return "🚑";
    if (severity >= 4 && type === "Fire") return "🔥";
    if (severity >= 4 && type === "Traffic") return "🚧";
    if (severity >= 4) return "🚨";
    return base;
  }

  function formatReportLocation(loc) {
    if (!loc) return "No location selected.";
    const accuracy = loc.accuracy ? ` ±${Math.round(loc.accuracy)}m` : "";
    return `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}${accuracy}`;
  }

  function setReportStatus(message, tone = "muted") {
    const status = $("reportStatus");
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function updateReportLocationUI() {
    const label = $("reportLocationValue");
    if (label) {
      label.textContent = formatReportLocation(store.reports?.draftLocation || null);
    }
  }

  function setReportLocation(loc, { fromPick = false } = {}) {
    if (!store.reports) return;
    store.reports.draftLocation = loc;
    if (store.reports.pickMarker) {
      store.reports.pickMarker.remove();
      store.reports.pickMarker = null;
    }
    if (loc) {
      const icon = L.divIcon({
        className: "reportPickMarker",
        html: `<span>📍</span>`
      });
      store.reports.pickMarker = L.marker([loc.lat, loc.lng], { icon }).addTo(map);
      if (fromPick) {
        map.panTo([loc.lat, loc.lng]);
      }
    }
    updateReportLocationUI();
  }

  function updateReportSeverityLabel() {
    const input = $("reportSeverity");
    const label = $("reportSeverityLabel");
    if (!input || !label) return;
    const value = Number(input.value || 3);
    const emoji = value >= 4 ? "🚨" : value >= 3 ? "⚠️" : "✅";
    label.textContent = `${emoji} ${value}`;
  }

  function buildReportPopup(item) {
    const date = new Date(item.ts || item.timestamp || Date.now()).toLocaleString();
    const note = item.note ? escapeHtml(item.note) : "—";
    const photoHtml = item.photo?.url
      ? `<div class="reportPopupPhoto"><img src="${escapeAttr(item.photo.url)}" alt="Report photo"/></div>`
      : "";
    return `
      <div class="reportPopup">
        <div class="reportPopup__title">${escapeHtml(item.type || "Report")} • Severity ${item.severity || 3}</div>
        <div class="reportPopup__meta">${escapeHtml(date)}</div>
        <div class="reportPopup__note">${note}</div>
        ${photoHtml}
      </div>
    `;
  }

  function addReportMarker(item) {
    const emoji = reportEmojiFor(item.type, Number(item.severity || 3));
    const icon = L.divIcon({
      className: "reportMarker",
      html: `<span>${emoji}</span>`
    });
    const marker = L.marker([item.lat, item.lng], { icon });
    marker.bindPopup(buildReportPopup(item), { maxWidth: 240 });
    return marker;
  }

  function renderReportsLayer() {
    if (!store.reports || !store.reports.layer) return;
    store.reports.layer.clearLayers();
    store.reports.markers.clear();
    if (!store.reports.enabled) return;

    for (const item of store.reports.items) {
      if (!Number.isFinite(item.lat) || !Number.isFinite(item.lng)) continue;
      const marker = addReportMarker(item);
      store.reports.layer.addLayer(marker);
      store.reports.markers.set(item.id, marker);
    }
  }

  async function fetchReports({ sinceDays = 90 } = {}) {
    if (!store.reports) return;
    try {
      const params = new URLSearchParams();
      if (sinceDays) params.set("sinceDays", String(sinceDays));
      const res = await fetch(`/api/reports?${params.toString()}`);
      if (!res.ok) {
        setReportStatus("Reports feed unavailable.", "warn");
        return;
      }
      const data = await res.json();
      if (!data.ok || !Array.isArray(data.items)) {
        setReportStatus("Reports feed unavailable.", "warn");
        return;
      }
      store.reports.items = data.items;
      store.reports.lastFetch = Date.now();
      renderReportsLayer();
    } catch (err) {
      console.warn("[Reports] Fetch failed:", err);
    }
  }

  function addReportItem(item) {
    if (!store.reports) return;
    const existing = store.reports.items.findIndex((entry) => entry.id === item.id);
    if (existing >= 0) {
      store.reports.items[existing] = item;
    } else {
      store.reports.items.unshift(item);
    }
    renderReportsLayer();
  }

  async function submitReport() {
    if (!store.reports) return;
    const type = $("reportType")?.value || "Other";
    const severity = Number($("reportSeverity")?.value || 3);
    const note = $("reportNote")?.value?.trim() || "";
    const loc = store.reports.draftLocation;

    if (!loc) {
      setReportStatus("Select a location before submitting.", "warn");
      return;
    }

    if (note.length > 2000) {
      setReportStatus("Notes are too long (max 2000 characters).", "warn");
      return;
    }

    const photoInput = $("reportPhoto");
    const photoFile = photoInput?.files?.[0] || null;
    if (photoFile && photoFile.size > 5 * 1024 * 1024) {
      setReportStatus("Photo is too large (max 5MB).", "warn");
      return;
    }

    const tempId = `local-${Date.now()}`;
    const tempItem = {
      id: tempId,
      ts: new Date().toISOString(),
      lat: loc.lat,
      lng: loc.lng,
      accuracy: loc.accuracy,
      type,
      severity,
      note
    };
    addReportItem(tempItem);

    try {
      let res;
      if (photoFile) {
        const form = new FormData();
        form.append("type", type);
        form.append("severity", String(severity));
        form.append("note", note);
        form.append("lat", String(loc.lat));
        form.append("lng", String(loc.lng));
        if (loc.accuracy) form.append("accuracy", String(loc.accuracy));
        form.append("photo", photoFile);
        res = await fetch("/api/reports", { method: "POST", body: form });
      } else {
        res = await fetch("/api/reports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type,
            severity,
            note,
            lat: loc.lat,
            lng: loc.lng,
            accuracy: loc.accuracy
          })
        });
      }

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "submit_failed");
      }

      store.reports.items = store.reports.items.filter(item => item.id !== tempId);
      addReportItem(data.item);
      setReportStatus("Report submitted.", "ok");

      if ($("reportNote")) $("reportNote").value = "";
      if ($("reportPhoto")) $("reportPhoto").value = "";
      if ($("reportPhotoPreviewWrap")) $("reportPhotoPreviewWrap").style.display = "none";
    } catch (err) {
      store.reports.items = store.reports.items.filter(item => item.id !== tempId);
      renderReportsLayer();
      setReportStatus("Report failed to submit. Try again.", "warn");
      console.warn("[Reports] Submit failed:", err);
    }
  }

  function setLastUpdate() {
    const el = getChipElement("lastUpdate");
    if (el) el.textContent = fmtTime(new Date());
  }

  // Ensure chips have valid states (not stuck at "Loading...")
  function ensureChipsHaveState() {
    const weatherTextEl = getChipElement("weatherText");
    if (weatherTextEl && weatherTextEl.textContent === "Weather: Loading…") {
      weatherTextEl.textContent = "Weather: Unavailable";
      console.warn("[ChipFallback] Weather chip stuck at Loading, set to Unavailable");
    }

    const trafficTextEl = getChipElement("trafficText");
    if (trafficTextEl && trafficTextEl.textContent === "I‑95: Loading…") {
      trafficTextEl.textContent = "I‑95: NO DATA";
      console.warn("[ChipFallback] Traffic chip stuck at Loading, set to NO DATA");
    }

    const airTextEl = getChipElement("airText");
    if (airTextEl && airTextEl.textContent === "AQI: …") {
      airTextEl.textContent = "AQI: N/A";
      console.warn("[ChipFallback] AQI chip stuck at Loading, set to N/A");
    }
  }

  async function refreshAll() {
    const liveTextEl = getChipElement("liveText");
    if (liveTextEl) liveTextEl.textContent = "Refreshing…";

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
    if (store.crime) {
      store.crime.ids.clear();
      store.crime.markersOnMap.clear();
    }

    // Set fallback timeout to ensure chips update even if all fetches hang
    const fallbackTimeout = setTimeout(() => {
      console.warn("[RefreshAll] Fallback timeout reached (30s) - ensuring chip states are set");
      ensureChipsHaveState();
    }, 30000); // 30 second fallback

    // Load RSS feeds and other APIs first (in parallel)
    await Promise.allSettled([
      pollRSS().catch(e => console.warn("RSS refresh partial", e)),
      CONFIG.nws.enabled ? fetchNWS().catch(e => console.warn("NWS refresh partial", e)) : Promise.resolve(),
      pollVa511().catch(e => console.warn("511 refresh partial", e)),
      CONFIG.openUV.enabled ? fetchOpenUV().catch(e => console.warn("OpenUV refresh partial", e)) : Promise.resolve(),
      CONFIG.cdc.enabled ? fetchCDC().catch(e => console.warn("CDC refresh partial", e)) : Promise.resolve(),
      CONFIG.air.enabled ? fetchAirQuality().catch(e => console.warn("Air quality refresh partial", e)) : Promise.resolve(),
      CONFIG.externalCameras.enabled ? pollExternalCameras().catch(e => console.warn("External cameras refresh partial", e)) : Promise.resolve(),
      CONFIG.schoolsNces?.enabled ? pollSchoolsNces().catch(e => console.warn("NCES Schools refresh partial", e)) : Promise.resolve(),
      CONFIG.colleges?.enabled ? pollColleges().catch(e => console.warn("Colleges refresh partial", e)) : Promise.resolve(),
      CONFIG.fxbgCrimeReports.enabled ? pollFxbgCrimeReports().catch(e => console.warn("Crime Reports refresh partial", e)) : Promise.resolve()
    ]);

    clearTimeout(fallbackTimeout); // Clear timeout since promises completed

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

    // Ensure chips have valid fallback states (not stuck at "Loading...")
    ensureChipsHaveState();

    if (liveTextEl) liveTextEl.textContent = "Live";
    setLastUpdate();
    updateNearestPanel();
    evaluateAlertRules();
    updateWatchboardPanel();

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

  // btnRefresh event listener will be attached in attachHeaderEventListeners()

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

    // Base set: all RSS-sourced items (not hardcoded category allowlist)
    const rssItems = allItems.filter(item => item.sourceType === "rss");
    const totalRssCount = rssItems.length;

    // Apply category filter if not "all"
    let filtered = rssItems.filter(item => {
      if (newsFlashFilter !== "all" && item.category !== newsFlashFilter) return false;
      return true;
    });

    // Apply jurisdiction filter if not "all"
    // Use normalization: treat "Regional" as a fallback that also matches items with missing/unknown jurisdiction
    filtered = filtered.filter(item => {
      if (newsFlashJurisdiction === "all") return true;
      const itemJurisdiction = item.jurisdiction || "Regional";
      if (newsFlashJurisdiction === "Regional") {
        // Regional matches exact "Regional" or fallback cases
        return itemJurisdiction === "Regional" || itemJurisdiction === "Unknown";
      }
      return itemJurisdiction === newsFlashJurisdiction;
    });

    // Sort by published date (newest first)
    filtered.sort((a, b) => {
      const dateA = new Date(a.published || 0);
      const dateB = new Date(b.published || 0);
      return dateB - dateA;
    });

    // Take top 50 items
    const displayCount = Math.min(filtered.length, 50);
    filtered = filtered.slice(0, 50);

    // Render items
    if (filtered.length === 0) {
      body.innerHTML = `<div class="newsFlashPanel__count">Showing 0 of ${totalRssCount} RSS items</div><div class="newsFlashPanel__loading">No news items match the selected filters.</div>`;
      return;
    }

    body.innerHTML = `<div class="newsFlashPanel__count">Showing ${displayCount} of ${totalRssCount} RSS items</div>` + filtered.map(item => {
      const emoji = item.emoji || "📰";
      const title = escapeHtml(item.title || "Untitled");
      const summary = escapeHtml((item.summary || item.message || "No description").slice(0, 200));
      const jurisdiction = escapeHtml(item.jurisdiction || "Unknown");
      const category = escapeHtml(CATEGORIES[item.category]?.label || item.category || "News");
      const time = fmtTime(item.published);

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
          // Close the news flash panel
          playClickSound('close');
          $("newsFlashPanel").classList.add("newsFlashPanel--hidden");
          restoreHeaderIfNoBlockingPanels(); // Restore header if no other panels are open
          // Select the item to show in the side panel
          selectItem(itemId);
          // Also zoom to the item on the map
          if (item.lat && item.lon) {
            map.setView([item.lat, item.lon], 14);
          }
        }
      });
    });
  }

  // News Flash panel toggle - moved to attachHeaderEventListeners()

  // News Flash close button
  $("newsFlashClose").addEventListener("click", () => {
    playClickSound('close');
    $("newsFlashPanel").classList.add("newsFlashPanel--hidden");
    restoreHeaderIfNoBlockingPanels(); // Restore header if no other panels are open
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
  // Health Badge - Click to show diagnostics
  // -----------------------------
  const diagnosticsDrawer = $("diagnosticsDrawer");
  const diagnosticsOverlay = $("diagnosticsOverlay");
  const diagnosticsSummary = $("diagnosticsSummary");
  const diagnosticsUpstreams = $("diagnosticsUpstreams");
  const diagnosticsUpstreamTests = $("diagnosticsUpstreamTests");
  const diagnosticsCache = $("diagnosticsCache");
  const diagnosticsRequiredBanner = $("diagnosticsRequiredBanner");
  const diagnosticsBannerTitle = $("diagnosticsBannerTitle");
  const diagnosticsRequiredText = $("diagnosticsRequiredText");
  const diagnosticsRefresh = $("diagnosticsRefresh");
  const diagnosticsCopy = $("diagnosticsCopy");
  const diagnosticsTestUpstreams = $("diagnosticsTestUpstreams");
  const diagnosticsRSSSummary = $("diagnosticsRSSSummary");
  const diagnosticsRSSList = $("diagnosticsRSSList");
  const diagnosticsRefreshRSS = $("diagnosticsRefreshRSS");
  const diagnosticsRegeocodeRSS = $("diagnosticsRegeocodeRSS");
  const diagnosticsRSSGeoSummary = $("diagnosticsRSSGeoSummary");
  const diagnosticsRSSGeoList = $("diagnosticsRSSGeoList");

  let lastDiagnosticsPayload = null;
  let lastHealthPayload = null;

  function setDiagnosticsDrawerOpen(isOpen) {
    if (!diagnosticsDrawer || !diagnosticsOverlay) return;
    diagnosticsDrawer.classList.toggle("diagnosticsDrawer--hidden", !isOpen);
    diagnosticsOverlay.classList.toggle("diagnosticsOverlay--hidden", !isOpen);
    diagnosticsOverlay.setAttribute("aria-hidden", (!isOpen).toString());

    if (isOpen) {
      setMobileHeaderCollapsed(true);
    } else {
      restoreHeaderIfNoBlockingPanels();
    }
  }

  function formatDurationShort(ms) {
    if (!Number.isFinite(ms)) return "—";
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  async function fetchDiagnosticsJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("Diagnostics timeout"), 15000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      const text = await response.text();
      const data = safeJsonParse(text, null, `diagnostics ${url}`);
      return { ok: response.ok, status: response.status, data };
    } catch (err) {
      return { ok: false, status: 0, error: err.message || String(err), data: null };
    } finally {
      clearTimeout(timeout);
    }
  }

  function renderDiagnosticsSummary(healthData, crimeStatus) {
    if (!diagnosticsSummary) return;
    const localHealth = healthTracker.computeHealth();
    const serverStatus = healthData?.status || "unknown";
    const uptimeSec = healthData?.uptimeSec ?? (healthData?.uptimeMs ? Math.floor(healthData.uptimeMs / 1000) : null);
    const upstreams = Array.isArray(healthData?.upstreams) ? healthData.upstreams : [];

    // Format uptime
    let uptimeStr = "—";
    if (uptimeSec !== null) {
      const hours = Math.floor(uptimeSec / 3600);
      const mins = Math.floor((uptimeSec % 3600) / 60);
      uptimeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    }

    // Crime reports info
    const crimeLastUpdated = crimeStatus?.lastUpdated ? new Date(crimeStatus.lastUpdated).toLocaleString() : "Never";
    const crimeCount = crimeStatus?.incidentsCount ?? "—";
    const crimeIsStale = crimeStatus?.isStale ?? true;
    const crimeBadgeClass = crimeStatus?.lastRefreshOk === false ? "diagnosticsBadge--error" : crimeIsStale ? "diagnosticsBadge--warn" : "diagnosticsBadge--ok";
    const crimeBadgeText = crimeStatus?.lastRefreshOk === false ? "ERROR" : crimeIsStale ? "STALE" : "OK";

    const hasStale = upstreams.some(upstream => upstream.stale);
    const hasCached = upstreams.some(upstream => upstream.cacheHit);
    const dataBadgeText = healthData?.degraded ? "STALE" : hasStale ? "STALE" : hasCached ? "CACHED" : "FRESH";
    const dataBadgeClass = dataBadgeText === "FRESH" ? "diagnosticsBadge--ok" : dataBadgeText === "CACHED" ? "diagnosticsBadge--warn" : "diagnosticsBadge--error";
    const dataDetail = healthData?.degraded ? "Degraded mode" : dataBadgeText === "FRESH" ? "Live upstream data" : dataBadgeText === "CACHED" ? "Cached responses" : "Stale cache in use";

    // Optional keys
    const optKeys = healthData?.optionalKeys || {};
    const optKeysWarning = [];
    if (optKeys.OPENUV_API_KEY === false) optKeysWarning.push("UV");
    if (optKeys.WAQI_TOKEN === false) optKeysWarning.push("AQI");
    const optKeysStr = optKeysWarning.length > 0 ? `Missing: ${optKeysWarning.join(", ")}` : "All configured";

    diagnosticsSummary.innerHTML = `
      <div class="diagnosticsRow">
        <div>
          <div class="diagnosticsRow__title">Client Health</div>
          <div>${localHealth.title}</div>
        </div>
        <div class="diagnosticsBadge ${localHealth.status === "LIVE" ? "diagnosticsBadge--ok" : localHealth.status === "PARTIAL" ? "diagnosticsBadge--warn" : "diagnosticsBadge--error"}">
          ${localHealth.status}
        </div>
      </div>
      <div class="diagnosticsRow">
        <div>
          <div class="diagnosticsRow__title">Server Status</div>
          <div>${serverStatus}</div>
        </div>
        <div class="diagnosticsBadge ${serverStatus === "ok" ? "diagnosticsBadge--ok" : "diagnosticsBadge--warn"}">
          ${serverStatus.toUpperCase()}
        </div>
      </div>
      <div class="diagnosticsRow">
        <div>
          <div class="diagnosticsRow__title">Server Uptime</div>
          <div>${uptimeStr}</div>
        </div>
        <div class="diagnosticsBadge diagnosticsBadge--ok">LIVE</div>
      </div>
      <div class="diagnosticsRow">
        <div>
          <div class="diagnosticsRow__title">Data Freshness</div>
          <div>${dataDetail}</div>
        </div>
        <div class="diagnosticsBadge ${dataBadgeClass}">${dataBadgeText}</div>
      </div>
      <div class="diagnosticsRow">
        <div>
          <div class="diagnosticsRow__title">Crime Reports</div>
          <div>Last: ${crimeLastUpdated} (${crimeCount} incidents)</div>
        </div>
        <div class="diagnosticsBadge ${crimeBadgeClass}">${crimeBadgeText}</div>
      </div>
      <div class="diagnosticsRow">
        <div>
          <div class="diagnosticsRow__title">Optional API Keys</div>
          <div style="font-size:11px;color:${optKeysWarning.length > 0 ? 'var(--warn)' : 'var(--muted2)'};">${optKeysStr}</div>
        </div>
        <div class="diagnosticsBadge ${optKeysWarning.length > 0 ? "diagnosticsBadge--warn" : "diagnosticsBadge--ok"}">
          ${optKeysWarning.length > 0 ? "WARN" : "OK"}
        </div>
      </div>
    `;
  }

  function renderDiagnosticsUpstreams(upstreams) {
    if (!diagnosticsUpstreams) return;
    if (!Array.isArray(upstreams)) {
      diagnosticsUpstreams.textContent = "Unable to load upstream diagnostics.";
      return;
    }

    diagnosticsUpstreams.innerHTML = upstreams.map(upstream => {
      const status = (upstream.status || (upstream.ok ? "ok" : "error")).toLowerCase();
      const stateLabel = upstream.stale
        ? "STALE"
        : upstream.cacheHit
          ? "CACHED"
          : upstream.ok
            ? "OK"
            : status === "stale"
              ? "STALE"
              : "ERROR";
      const badgeClass = stateLabel === "OK"
        ? "diagnosticsBadge--ok"
        : stateLabel === "CACHED"
          ? "diagnosticsBadge--warn"
          : stateLabel === "STALE"
            ? "diagnosticsBadge--stale"
            : "diagnosticsBadge--error";
      const latency = Number.isFinite(upstream.ms) ? `${upstream.ms}ms` : Number.isFinite(upstream.lastElapsedMs) ? `${upstream.lastElapsedMs}ms` : "—";
      const contentType = upstream.contentType ? ` • ${escapeHtml(upstream.contentType)}` : "";
      const errorHint = upstream.errorCode || upstream.message ? ` • ${escapeHtml(upstream.errorCode || upstream.message)}` : "";
      const requiredLabel = upstream.required ? " • Required" : "";
      const lastSuccess = upstream.lastSuccess || upstream.lastOkAt ? ` • Last OK ${new Date(upstream.lastSuccess || upstream.lastOkAt).toLocaleTimeString()}` : "";
      const lastAttempt = upstream.lastAttemptAt ? ` • Last Attempt ${new Date(upstream.lastAttemptAt).toLocaleTimeString()}` : "";
      return `
        <div class="diagnosticsRow">
          <div>
            <div class="diagnosticsRow__title">${escapeHtml(upstream.name || "Unknown")}</div>
            <div>${escapeHtml(upstream.url || "")}${requiredLabel}</div>
            <div style="font-size:11px;color:var(--muted2);margin-top:4px;">${latency}${contentType}${errorHint}${lastSuccess}${lastAttempt}</div>
          </div>
          <div style="text-align:right;">
            <div class="diagnosticsBadge ${badgeClass}">${stateLabel}</div>
          </div>
        </div>
      `;
    }).join("");
  }

  function renderDiagnosticsCache(cacheStats) {
    if (!diagnosticsCache) return;
    if (!cacheStats) {
      diagnosticsCache.textContent = "Unable to load cache stats.";
      return;
    }

    const stats = cacheStats.cache || cacheStats;
    diagnosticsCache.innerHTML = `
      <div class="diagnosticsRow">
        <div>
          <div class="diagnosticsRow__title">Entries</div>
          <div>${stats.entries ?? "—"}</div>
        </div>
        <div class="diagnosticsBadge diagnosticsBadge--ok">${stats.entries ?? 0}</div>
      </div>
      <div class="diagnosticsRow">
        <div>
          <div class="diagnosticsRow__title">Cache Size</div>
          <div>${stats.bytes ? `${Math.round(stats.bytes / 1024 / 1024)} MB` : "—"}</div>
        </div>
        <div class="diagnosticsBadge diagnosticsBadge--ok">${stats.maxEntries ?? "—"} max</div>
      </div>
      <div class="diagnosticsRow">
        <div>
          <div class="diagnosticsRow__title">Max Bytes</div>
          <div>${stats.maxBytes ? `${Math.round(stats.maxBytes / 1024 / 1024)} MB` : "—"}</div>
        </div>
        <div class="diagnosticsBadge diagnosticsBadge--ok">CAP</div>
      </div>
    `;
  }

  function renderDiagnosticsUpstreamTests(testData) {
    if (!diagnosticsUpstreamTests) return;
    if (!testData || !Array.isArray(testData.upstreams)) {
      diagnosticsUpstreamTests.textContent = "Unable to load upstream test results.";
      return;
    }

    diagnosticsUpstreamTests.innerHTML = testData.upstreams.map(upstream => {
      const badgeClass = upstream.ok ? "diagnosticsBadge--ok" : "diagnosticsBadge--error";
      const latency = Number.isFinite(upstream.elapsedMs) ? `${upstream.elapsedMs}ms` : "—";
      const notes = upstream.notes ? ` • ${escapeHtml(upstream.notes)}` : "";
      const recommendation = upstream.recommendation ? ` • ${escapeHtml(upstream.recommendation)}` : "";
      return `
        <div class="diagnosticsRow">
          <div>
            <div class="diagnosticsRow__title">${escapeHtml(upstream.name || "Unknown")}</div>
            <div>${escapeHtml(upstream.url || "")}</div>
            <div style="font-size:11px;color:var(--muted2);margin-top:4px;">${latency}${notes}${recommendation}</div>
          </div>
          <div style="text-align:right;">
            <div class="diagnosticsBadge ${badgeClass}">${upstream.ok ? "OK" : "FAIL"}</div>
          </div>
        </div>
      `;
    }).join("");
  }

  function renderDiagnosticsRSS() {
    if (!diagnosticsRSSSummary || !diagnosticsRSSList) return;

    const rssData = store.diagnostics?.rss || {};
    const entries = Object.entries(rssData);

    if (entries.length === 0) {
      diagnosticsRSSSummary.innerHTML = `
        <div class="diagnosticsRow">
          <div>
            <div class="diagnosticsRow__title">Status</div>
            <div>No RSS data yet - refresh to poll feeds</div>
          </div>
          <div class="diagnosticsBadge diagnosticsBadge--warn">PENDING</div>
        </div>
      `;
      diagnosticsRSSList.textContent = "—";
      return;
    }

    const okCount = entries.filter(([_, d]) => d.ok).length;
    const failCount = entries.filter(([_, d]) => !d.ok && !d.skipped).length;
    const skipCount = entries.filter(([_, d]) => d.skipped).length;
    const totalParsed = entries.reduce((sum, [_, d]) => sum + (d.itemsParsed || 0), 0);
    const totalIngested = entries.reduce((sum, [_, d]) => sum + (d.itemsIngested || 0), 0);

    const summaryBadgeClass = failCount === 0 ? "diagnosticsBadge--ok" : failCount < okCount ? "diagnosticsBadge--warn" : "diagnosticsBadge--error";
    const summaryBadgeText = failCount === 0 ? "ALL OK" : `${failCount} FAILED`;

    diagnosticsRSSSummary.innerHTML = `
      <div class="diagnosticsRow">
        <div>
          <div class="diagnosticsRow__title">RSS Sources</div>
          <div>${okCount} ok / ${failCount} failed${skipCount > 0 ? ` / ${skipCount} skipped` : ''}</div>
        </div>
        <div class="diagnosticsBadge ${summaryBadgeClass}">${summaryBadgeText}</div>
      </div>
      <div class="diagnosticsRow">
        <div>
          <div class="diagnosticsRow__title">Items</div>
          <div>${totalParsed} parsed / ${totalIngested} ingested</div>
        </div>
        <div class="diagnosticsBadge diagnosticsBadge--ok">${totalIngested}</div>
      </div>
    `;

    // Build detailed list of failed/problematic sources first, then successful ones
    const failedSources = entries.filter(([_, d]) => !d.ok && !d.skipped);
    const skippedSources = entries.filter(([_, d]) => d.skipped);
    const okSources = entries.filter(([_, d]) => d.ok);

    let listHtml = "";

    // Failed sources (show first with details)
    if (failedSources.length > 0) {
      listHtml += `<div style="margin-bottom:8px;color:var(--bad);font-weight:500;">Failed Sources:</div>`;
      for (const [sourceId, diag] of failedSources) {
        const source = CONFIG.rss.find(s => s.id === sourceId);
        const sourceName = source?.name || sourceId;
        const statusStr = diag.httpStatus ? `HTTP ${diag.httpStatus}` : 'Error';
        const errorShort = (diag.error || 'Unknown error').slice(0, 60);
        const ago = diag.timestamp ? formatDurationShort(Date.now() - diag.timestamp) + ' ago' : '';
        listHtml += `
          <div class="diagnosticsRow" style="border-left:3px solid var(--bad);padding-left:8px;margin-bottom:4px;">
            <div>
              <div class="diagnosticsRow__title">${escapeHtml(sourceName)}</div>
              <div style="font-size:11px;color:var(--muted2);">${escapeHtml(errorShort)}</div>
              <div style="font-size:10px;color:var(--muted2);">${ago}</div>
            </div>
            <div class="diagnosticsBadge diagnosticsBadge--error">${statusStr}</div>
          </div>
        `;
      }
    }

    // Skipped sources (backoff)
    if (skippedSources.length > 0) {
      listHtml += `<div style="margin:8px 0;color:var(--warn);font-weight:500;">Skipped (backoff):</div>`;
      for (const [sourceId, diag] of skippedSources) {
        const source = CONFIG.rss.find(s => s.id === sourceId);
        const sourceName = source?.name || sourceId;
        listHtml += `
          <div class="diagnosticsRow" style="border-left:3px solid var(--warn);padding-left:8px;margin-bottom:4px;">
            <div>
              <div class="diagnosticsRow__title">${escapeHtml(sourceName)}</div>
              <div style="font-size:11px;color:var(--muted2);">${escapeHtml(diag.error || 'Backoff active')}</div>
            </div>
            <div class="diagnosticsBadge diagnosticsBadge--warn">SKIP</div>
          </div>
        `;
      }
    }

    // Successful sources (collapsed summary)
    if (okSources.length > 0) {
      listHtml += `<div style="margin:8px 0;color:var(--ok);font-weight:500;">OK Sources (${okSources.length}):</div>`;
      for (const [sourceId, diag] of okSources) {
        const source = CONFIG.rss.find(s => s.id === sourceId);
        const sourceName = source?.name || sourceId;
        listHtml += `
          <div class="diagnosticsRow" style="border-left:3px solid var(--ok);padding-left:8px;margin-bottom:2px;">
            <div>
              <div class="diagnosticsRow__title" style="font-size:12px;">${escapeHtml(sourceName)}</div>
            </div>
            <div style="font-size:11px;color:var(--muted2);">${diag.itemsParsed}/${diag.itemsIngested}</div>
          </div>
        `;
      }
    }

    diagnosticsRSSList.innerHTML = listHtml || "No RSS diagnostics data available.";
  }

  function renderDiagnosticsRSSGeoSummary() {
    const rssItems = Array.from(store.itemsById.values()).filter(item => item.sourceType === "rss");
    const total = rssItems.length;
    const methodCounts = { override: 0, gazetteer: 0, "extract+geocode": 0, fallback: 0, unknown: 0 };
    const confidenceBands = { high: 0, mid: 0, low: 0, veryLow: 0 };
    const unresolved = [];

    for (const item of rssItems) {
      const method = item.locationMethod || "unknown";
      if (method in methodCounts) {
        methodCounts[method]++;
      } else {
        methodCounts.unknown++;
      }

      const confidence = Number.isFinite(item.locationConfidence) ? item.locationConfidence : 0;
      if (confidence >= 80) {
        confidenceBands.high++;
      } else if (confidence >= 60) {
        confidenceBands.mid++;
      } else if (confidence >= 40) {
        confidenceBands.low++;
      } else {
        confidenceBands.veryLow++;
      }

      if (method === "fallback") {
        unresolved.push(item);
      }
    }

    unresolved.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const topUnresolved = unresolved.slice(0, 10);

    const summaryHtml = `
      <div class="diagnosticsRow">
        <div>
          <div class="diagnosticsRow__title">Total RSS items</div>
          <div>${total}</div>
        </div>
        <div class="diagnosticsBadge diagnosticsBadge--ok">${total}</div>
      </div>
      <div class="diagnosticsRow">
        <div>
          <div class="diagnosticsRow__title">Methods</div>
          <div>override ${methodCounts.override} • gazetteer ${methodCounts.gazetteer} • extract ${methodCounts["extract+geocode"]} • fallback ${methodCounts.fallback}</div>
        </div>
        <div class="diagnosticsBadge ${methodCounts.fallback > 0 ? "diagnosticsBadge--warn" : "diagnosticsBadge--ok"}">${methodCounts.fallback}</div>
      </div>
      <div class="diagnosticsRow">
        <div>
          <div class="diagnosticsRow__title">Confidence</div>
          <div>≥80: ${confidenceBands.high} • 60-79: ${confidenceBands.mid} • 40-59: ${confidenceBands.low} • &lt;40: ${confidenceBands.veryLow}</div>
        </div>
        <div class="diagnosticsBadge diagnosticsBadge--ok">${confidenceBands.high}</div>
      </div>
    `;

    const listHtml = topUnresolved.length
      ? `<div style="margin-bottom:6px;color:var(--warn);font-weight:500;">Top unresolved (fallback)</div>` +
        topUnresolved.map((item, index) => `
          <div class="diagnosticsRow" style="border-left:3px solid var(--warn);padding-left:8px;margin-bottom:4px;">
            <div>
              <div class="diagnosticsRow__title" style="font-size:12px;">${index + 1}. ${escapeHtml(item.title || "(untitled)")}</div>
              <div style="font-size:10px;color:var(--muted2);">${escapeHtml(item.sourceName || item.sourceId || "")}</div>
            </div>
            <div class="diagnosticsBadge diagnosticsBadge--warn">FALLBACK</div>
          </div>
        `).join("")
      : `<div style="color:var(--ok);font-weight:500;">No fallback items detected.</div>`;

    if (!diagnosticsRSSGeoSummary || !diagnosticsRSSGeoList) {
      console.log("[RSS Geo Summary]", {
        total,
        methodCounts,
        confidenceBands,
        unresolved: topUnresolved.map(item => item.title)
      });
      return;
    }

    diagnosticsRSSGeoSummary.innerHTML = summaryHtml;
    diagnosticsRSSGeoList.innerHTML = listHtml;
  }

  // Store last known data for offline fallback
  let lastKnownDiagnostics = null;

  async function refreshDiagnosticsDrawer() {
    if (!diagnosticsDrawer) return;
    if (diagnosticsSummary) diagnosticsSummary.textContent = "Loading…";
    if (diagnosticsUpstreams) diagnosticsUpstreams.textContent = "Loading…";
    if (diagnosticsUpstreamTests) diagnosticsUpstreamTests.textContent = "Run “Test Upstreams” to see results.";
    if (diagnosticsCache) diagnosticsCache.textContent = "Loading…";
    if (diagnosticsRSSGeoSummary) diagnosticsRSSGeoSummary.textContent = "Loading…";
    if (diagnosticsRSSGeoList) diagnosticsRSSGeoList.textContent = "Loading…";

    // Fetch from new endpoints (with fallback to legacy)
    const [healthRes, upstreamRes, cacheRes, crimeStatusRes] = await Promise.all([
      fetchDiagnosticsJson("/api/health").then(r => r.ok ? r : fetchDiagnosticsJson("/health")),
      fetchDiagnosticsJson("/api/diag/upstreams"),
      fetchDiagnosticsJson("/cache/stats"),
      fetchDiagnosticsJson("/api/fxbg/crime-reports/status")
    ]);

    // Graceful degradation: if all fetches failed, show last known data
    const allFailed = !healthRes.ok && !upstreamRes.ok && !cacheRes.ok;
    if (allFailed && lastKnownDiagnostics) {
      if (diagnosticsSummary) {
        diagnosticsSummary.innerHTML = `
          <div class="diagnosticsRow">
            <div>
              <div class="diagnosticsRow__title">Server Status</div>
              <div style="color:var(--warn);">Offline - showing last known data</div>
            </div>
            <div class="diagnosticsBadge diagnosticsBadge--error">OFFLINE</div>
          </div>
        `;
      }
      renderDiagnosticsUpstreams(lastKnownDiagnostics.upstreams?.upstreams || null);
      renderDiagnosticsCache(lastKnownDiagnostics.cache || null);
      renderDiagnosticsRSS();
      renderDiagnosticsRSSGeoSummary();
      return;
    }

    renderDiagnosticsSummary(healthRes.data || null, crimeStatusRes.data || null);
    const upstreamList = healthRes.data?.upstreams || upstreamRes.data?.upstreams || null;
    renderDiagnosticsUpstreams(upstreamList);
    renderDiagnosticsCache(cacheRes.data || null);
    renderDiagnosticsRSS();
    renderDiagnosticsRSSGeoSummary();

    lastDiagnosticsPayload = {
      fetchedAt: new Date().toISOString(),
      health: healthRes.data || null,
      upstreams: upstreamRes.data || null,
      cache: cacheRes.data || null,
      crimeStatus: crimeStatusRes.data || null
    };

    // Store for offline fallback
    if (healthRes.ok || upstreamRes.ok) {
      lastKnownDiagnostics = lastDiagnosticsPayload;
    }

    if (healthRes.ok) {
      lastHealthPayload = healthRes.data;
    }

    if (diagnosticsRequiredBanner && diagnosticsRequiredText) {
      const upstreamFailures = (healthRes.data?.upstreams || upstreamRes.data?.upstreams || [])
        .filter(upstream => upstream.required && (upstream.stale || upstream.ok === false || String(upstream.status).toLowerCase() !== "ok"));
      if (healthRes.data?.degraded || upstreamFailures.length > 0) {
        if (diagnosticsBannerTitle) {
          diagnosticsBannerTitle.textContent = "Degraded mode: showing cached data";
        }
        diagnosticsRequiredText.textContent = upstreamFailures.length > 0
          ? upstreamFailures.map(upstream => upstream.name).join(", ")
          : "Upstream connectivity issues detected.";
        diagnosticsRequiredBanner.classList.remove("diagnosticsBanner--hidden");
      } else {
        diagnosticsRequiredBanner.classList.add("diagnosticsBanner--hidden");
        diagnosticsRequiredText.textContent = "";
        if (diagnosticsBannerTitle) {
          diagnosticsBannerTitle.textContent = "Required upstreams failing";
        }
      }
    }
  }

  let lastTestRunAt = 0;

  async function runUpstreamTests() {
    if (!diagnosticsUpstreamTests) return;
    const now = Date.now();
    if (now - lastTestRunAt < 10000) {
      diagnosticsUpstreamTests.textContent = "Please wait a few seconds before rerunning tests.";
      return;
    }
    lastTestRunAt = now;
    diagnosticsUpstreamTests.textContent = "Running upstream tests…";

    const testRes = await fetchDiagnosticsJson("/api/health/test-upstreams?quick=1");
    if (!testRes.ok) {
      diagnosticsUpstreamTests.textContent = "Upstream tests failed. Check connectivity and retry.";
      return;
    }

    renderDiagnosticsUpstreamTests(testRes.data);
  }

  // Auto-refresh diagnostics drawer every 30 seconds when open
  setInterval(() => {
    if (diagnosticsDrawer && !diagnosticsDrawer.classList.contains("diagnosticsDrawer--hidden")) {
      refreshDiagnosticsDrawer().catch(err => {
        console.warn("[Diagnostics] Auto-refresh failed:", err);
      });
    }
  }, 30000);

  const healthBadge = $("healthBadge");
  if (healthBadge) {
    healthBadge.addEventListener("click", async () => {
      // Open the System tab in the dock
      const systemTab = document.querySelector('[data-dock="system"]');
      if (systemTab) {
        systemTab.click();
      }

      setDiagnosticsDrawerOpen(true);
      refreshDiagnosticsDrawer().catch(err => {
        console.warn("[Diagnostics] Drawer update failed:", err);
      });

    });
  }

  const diagnosticsClose = $("diagnosticsClose");
  if (diagnosticsClose) {
    diagnosticsClose.addEventListener("click", () => {
      setDiagnosticsDrawerOpen(false);
    });
  }
  if (diagnosticsRefresh) {
    diagnosticsRefresh.addEventListener("click", () => {
      refreshDiagnosticsDrawer().catch(err => {
        console.warn("[Diagnostics] Drawer refresh failed:", err);
      });
    });
  }
  if (diagnosticsTestUpstreams) {
    diagnosticsTestUpstreams.addEventListener("click", () => {
      runUpstreamTests().catch(err => {
        console.warn("[Diagnostics] Upstream test failed:", err);
      });
    });
  }
  if (diagnosticsRefreshRSS) {
    diagnosticsRefreshRSS.addEventListener("click", async () => {
      diagnosticsRefreshRSS.disabled = true;
      diagnosticsRefreshRSS.textContent = "Refreshing…";
      try {
        await pollRSS(true);  // Force refresh, bypass backoff
        renderDiagnosticsRSS();
        renderDiagnosticsRSSGeoSummary();
        redraw();
      } catch (err) {
        console.warn("[Diagnostics] RSS refresh failed:", err);
      } finally {
        diagnosticsRefreshRSS.disabled = false;
        diagnosticsRefreshRSS.textContent = "Refresh RSS";
      }
    });
  }
  if (diagnosticsRegeocodeRSS) {
    diagnosticsRegeocodeRSS.addEventListener("click", async () => {
      diagnosticsRegeocodeRSS.disabled = true;
      diagnosticsRegeocodeRSS.textContent = "Re-geocoding…";
      try {
        purgeRssItemsFromStore();
        await pollRSS(true);
        renderDiagnosticsRSS();
        renderDiagnosticsRSSGeoSummary();
        redraw();
      } catch (err) {
        console.warn("[Diagnostics] RSS re-geocode failed:", err);
      } finally {
        diagnosticsRegeocodeRSS.disabled = false;
        diagnosticsRegeocodeRSS.textContent = "Re-geocode RSS";
      }
    });
  }
  if (diagnosticsCopy) {
    diagnosticsCopy.addEventListener("click", async () => {
      if (!lastHealthPayload) return;
      const text = JSON.stringify(lastHealthPayload, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        diagnosticsCopy.textContent = "Copied!";
        setTimeout(() => {
          diagnosticsCopy.textContent = "Copy report";
        }, 1500);
      } catch (err) {
        console.warn("[Diagnostics] Clipboard copy failed:", err);
      }
    });
  }
  if (diagnosticsOverlay) {
    diagnosticsOverlay.addEventListener("click", () => {
      setDiagnosticsDrawerOpen(false);
    });
  }

  // -----------------------------
  // Radio Scanner Panel
  // -----------------------------
  // btnRadioScanner event listener moved to attachHeaderEventListeners()

  $("radioClose").addEventListener("click", () => {
    playClickSound('close');
    $("radioPanel").classList.add("radioPanel--hidden");
    restoreHeaderIfNoBlockingPanels(); // Restore header if no other panels are open
  });

  // -----------------------------
  // Crime Reports Panel Event Listeners
  // -----------------------------
  $("crimeClose").addEventListener("click", closeCrimeMenuPanel);

  // Enable toggle
  $("crimeEnableToggle").addEventListener("change", (e) => {
    if (!store.crime) return;
    store.crime.pendingEnabled = e.target.checked;
  });

  // Window days dropdown
  $("crimeWindowDays").addEventListener("change", (e) => {
    if (!store.crime) return;
    const value = e.target.value;
    const customRow = $("crimeCustomRow");
    const customInput = $("crimeWindowCustom");
    if (value === "custom") {
      if (customRow) customRow.style.display = "flex";
      store.crime.windowDays = parseInt(customInput?.value || "30", 10);
    } else {
      if (customRow) customRow.style.display = "none";
      store.crime.windowDays = parseInt(value, 10);
      if (customInput) customInput.value = String(store.crime.windowDays);
    }
    updateCrimeAppliedLabel();
    updateCrimeIncidentsList({ windowDays: store.crime.windowDays });
  });

  const crimeCustomInput = $("crimeWindowCustom");
  if (crimeCustomInput) {
    crimeCustomInput.addEventListener("change", (e) => {
      if (!store.crime) return;
      const value = parseInt(e.target.value, 10);
      if (Number.isFinite(value) && value > 0) {
        store.crime.windowDays = value;
        updateCrimeAppliedLabel();
        updateCrimeIncidentsList({ windowDays: store.crime.windowDays });
      }
    });
  }

  // Sort toggles
  $("crimeSortNewest").addEventListener("click", () => {
    if (!store.crime) return;
    store.crime.sort = "newest";
    saveCrimeUI({
      enabled: store.crime.enabled,
      windowDays: store.crime.windowDays,
      appliedWindowDays: store.crime.appliedWindowDays,
      lastAppliedAt: store.crime.lastAppliedAt,
      sort: store.crime.sort,
      menuAutoOpen: store.crime.menuAutoOpen
    });
    updateCrimeMenuPanel();
  });

  $("crimeSortOldest").addEventListener("click", () => {
    if (!store.crime) return;
    store.crime.sort = "oldest";
    saveCrimeUI({
      enabled: store.crime.enabled,
      windowDays: store.crime.windowDays,
      appliedWindowDays: store.crime.appliedWindowDays,
      lastAppliedAt: store.crime.lastAppliedAt,
      sort: store.crime.sort,
      menuAutoOpen: store.crime.menuAutoOpen
    });
    updateCrimeMenuPanel();
  });

  // Menu auto-open toggle
  $("crimeMenuAutoOpen").addEventListener("change", (e) => {
    if (!store.crime) return;
    store.crime.menuAutoOpen = e.target.checked;
    saveCrimeUI({
      enabled: store.crime.enabled,
      windowDays: store.crime.windowDays,
      appliedWindowDays: store.crime.appliedWindowDays,
      lastAppliedAt: store.crime.lastAppliedAt,
      sort: store.crime.sort,
      menuAutoOpen: store.crime.menuAutoOpen
    });
  });

  const crimeApplyBtn = $("crimeApply");
  if (crimeApplyBtn) {
    crimeApplyBtn.addEventListener("click", () => {
      applyCrimeOverlaySettings(true);
    });
  }

  // Refresh button
  $("crimeRefresh").addEventListener("click", async () => {
    // DEBUG: Log when click occurs
    console.log("[DEBUG Crime Refresh] Click detected at", new Date().toISOString());
    try {
      const months = CONFIG.fxbgCrimeReports.months;
      const res = await fetch(`/api/fxbg/crime-reports/refresh?months=${months}`);
      // DEBUG: Log response status
      console.log("[DEBUG Crime Refresh] Response status:", res.status, res.statusText);
      // DEBUG: Log response body
      const json = await res.json();
      console.log("[DEBUG Crime Refresh] Response body:", JSON.stringify(json, null, 2));
      if (res.ok && json.ok) {
        console.log("[Crime Reports] Refresh initiated");
        // Wait a bit then reload incidents
        // DEBUG: Log when incidents poll starts
        console.log("[DEBUG Crime Refresh] Starting incidents poll in 2s...");
        setTimeout(async () => {
          console.log("[DEBUG Crime Refresh] Polling incidents NOW");
          await pollFxbgCrimeReports();
          // DEBUG: Log how many items are now in store
          const crimeItems = store.items.filter(it => it.sourceId === "fxbg-crime-reports");
          console.log("[DEBUG Crime Refresh] Crime items in store after poll:", crimeItems.length);
          updateCrimeMenuPanel();
        }, 2000);
      } else {
        // DEBUG: Log when refresh failed
        console.warn("[DEBUG Crime Refresh] Refresh returned ok=false or HTTP error:", json.message || json.error);
      }
    } catch (err) {
      console.error("[Crime Reports] Refresh error:", err);
    }
  });

  // -----------------------------
  // Reports Panel Event Listeners
  // -----------------------------
  $("reportClose").addEventListener("click", () => {
    playClickSound('close');
    $("reportPanel").classList.add("reportPanel--hidden");
    if (store.reports) {
      store.reports.pickMode = false;
      const pickBtn = $("reportPickLocation");
      if (pickBtn) pickBtn.textContent = "Pick on map";
    }
    restoreHeaderIfNoBlockingPanels();
  });

  const reportSeverityInput = $("reportSeverity");
  if (reportSeverityInput) {
    reportSeverityInput.addEventListener("input", updateReportSeverityLabel);
  }

  const reportUseLocation = $("reportUseLocation");
  if (reportUseLocation) {
    reportUseLocation.addEventListener("click", () => {
      if (!navigator.geolocation) {
        setReportStatus("Geolocation unavailable.", "warn");
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const coords = pos.coords || {};
          setReportLocation({
            lat: coords.latitude,
            lng: coords.longitude,
            accuracy: coords.accuracy
          });
          map.panTo([coords.latitude, coords.longitude]);
          setReportStatus("Location updated from device.", "ok");
        },
        () => {
          setReportStatus("Unable to fetch device location.", "warn");
        },
        {
          enableHighAccuracy: true,
          timeout: 8000,
          maximumAge: 60000
        }
      );
    });
  }

  const reportPickLocation = $("reportPickLocation");
  if (reportPickLocation) {
    reportPickLocation.addEventListener("click", () => {
      if (!store.reports) return;
      store.reports.pickMode = !store.reports.pickMode;
      reportPickLocation.textContent = store.reports.pickMode ? "Tap map…" : "Pick on map";
      setReportStatus(store.reports.pickMode ? "Tap map to set location." : "Pick mode canceled.", "muted");
    });
  }

  const reportClearLocation = $("reportClearLocation");
  if (reportClearLocation) {
    reportClearLocation.addEventListener("click", () => {
      setReportLocation(null);
      setReportStatus("Location cleared.", "muted");
    });
  }

  const reportPhotoInput = $("reportPhoto");
  if (reportPhotoInput) {
    reportPhotoInput.addEventListener("change", () => {
      const file = reportPhotoInput.files?.[0];
      const previewWrap = $("reportPhotoPreviewWrap");
      const previewImg = $("reportPhotoPreview");
      if (!previewWrap || !previewImg) return;
      if (!file) {
        previewWrap.style.display = "none";
        previewImg.src = "";
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        setReportStatus("Photo is too large (max 5MB).", "warn");
        reportPhotoInput.value = "";
        previewWrap.style.display = "none";
        return;
      }
      previewImg.src = URL.createObjectURL(file);
      previewWrap.style.display = "block";
    });
  }

  const reportLayerToggle = $("reportLayerToggle");
  if (reportLayerToggle) {
    reportLayerToggle.addEventListener("change", () => {
      if (!store.reports) return;
      store.reports.enabled = reportLayerToggle.checked;
      renderReportsLayer();
    });
  }

  const reportExportCsv = $("reportExportCsv");
  if (reportExportCsv) {
    reportExportCsv.addEventListener("click", () => {
      window.location.href = "/api/reports/export.csv";
    });
  }
  const reportExportGeojson = $("reportExportGeojson");
  if (reportExportGeojson) {
    reportExportGeojson.addEventListener("click", () => {
      window.location.href = "/api/reports/export.geojson";
    });
  }

  const reportSubmit = $("reportSubmit");
  if (reportSubmit) {
    reportSubmit.addEventListener("click", () => {
      submitReport();
    });
  }

  map.on("click", (event) => {
    if (!store.reports || !store.reports.pickMode) return;
    setReportLocation({
      lat: event.latlng.lat,
      lng: event.latlng.lng
    }, { fromPick: true });
    store.reports.pickMode = false;
    if (reportPickLocation) reportPickLocation.textContent = "Pick on map";
    setReportStatus("Location set from map.", "ok");
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
    // Event objects are the canonical data model for map + panels.
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

  function getUserLocation() {
    return currentUserLocation;
  }

  function getCameraItems() {
    return getAllItemsArray().filter(item => item.category === "camera");
  }

  function getPoiItemsByType(type) {
    return getAllItemsArray().filter(item => item.meta?.poiType === type);
  }

  function renderNearestRow(targetEl, nearest, fallbackText) {
    if (!targetEl) return;
    if (!nearest) {
      targetEl.innerHTML = `<div class="dockMetaText">${fallbackText}</div>`;
      return;
    }
    const title = escapeHtml(nearest.item.title || nearest.item.name || "Unknown");
    const distance = formatDistanceMiles(nearest.distance);
    targetEl.innerHTML = `
      <div class="nearestItemTitle">${title}</div>
      <div class="nearestItemMeta">${distance} • ${escapeHtml(nearest.item.sourceName || nearest.item.source || "Unknown source")}</div>
    `;
  }

  function updateNearestPanel() {
    const panel = document.getElementById("dockPanelBody");
    if (!panel) return;
    const toggleEl = panel.querySelector("#locationToggle");
    if (toggleEl) {
      toggleEl.classList.toggle("isOn", locationEnabled);
    }
    const statusEl = panel.querySelector("#locationStatus");
    if (!locationEnabled) {
      if (statusEl) statusEl.textContent = "Location disabled.";
      ["#nearestCamera", "#nearestHospital", "#nearestPolice", "#nearestFire", "#nearestShelter", "#nearestRoute"].forEach(selector => {
        const el = panel.querySelector(selector);
        if (el) el.innerHTML = `<div class="dockMetaText">Enable location to calculate distance.</div>`;
      });
      return;
    }
    const userLoc = getUserLocation();
    if (!userLoc) {
      if (statusEl) statusEl.textContent = "Awaiting location fix…";
      ["#nearestCamera", "#nearestHospital", "#nearestPolice", "#nearestFire", "#nearestShelter", "#nearestRoute"].forEach(selector => {
        const el = panel.querySelector(selector);
        if (el) el.innerHTML = `<div class="dockMetaText">Awaiting GPS lock…</div>`;
      });
      return;
    }
    if (statusEl) {
      statusEl.textContent = `Lat ${userLoc.lat.toFixed(4)}, Lon ${userLoc.lng.toFixed(4)} • ±${Math.round(userLoc.accuracy || 0)}m`;
    }

    const nearestCamera = findNearest(getCameraItems(), userLoc);
    renderNearestRow(panel.querySelector("#nearestCamera"), nearestCamera, "No camera locations available.");

    const nearestHospital = findNearest(getPoiItemsByType("hospital"), userLoc);
    renderNearestRow(panel.querySelector("#nearestHospital"), nearestHospital, "No hospital POIs loaded.");

    const nearestPolice = findNearest(getPoiItemsByType("police"), userLoc);
    renderNearestRow(panel.querySelector("#nearestPolice"), nearestPolice, "No police POIs loaded.");

    const nearestFire = findNearest(getPoiItemsByType("fire"), userLoc);
    renderNearestRow(panel.querySelector("#nearestFire"), nearestFire, "No fire/EMS POIs loaded.");

    const nearestShelter = findNearest(getPoiItemsByType("shelter"), userLoc);
    renderNearestRow(panel.querySelector("#nearestShelter"), nearestShelter, "No shelter POIs loaded.");

    const roadClosures = getAllItemsArray().filter(item => item.category === "road_closure" || item.category === "closure");
    const trafficItems = getAllItemsArray().filter(item => item.category === "traffic" || item.category === "crash");
    const nearestClosure = findNearest(roadClosures, userLoc);
    const nearestOpen = findNearest(trafficItems, userLoc);
    const routeEl = panel.querySelector("#nearestRoute");
    if (routeEl) {
      if (nearestOpen && (!nearestClosure || nearestOpen.distance <= nearestClosure.distance)) {
        routeEl.innerHTML = `
          <div class="nearestItemTitle">${escapeHtml(nearestOpen.item.title || "Open route")}</div>
          <div class="nearestItemMeta">${formatDistanceMiles(nearestOpen.distance)} • No closure flagged</div>
        `;
      } else if (nearestClosure) {
        routeEl.innerHTML = `
          <div class="nearestItemTitle">${escapeHtml(nearestClosure.item.title || "Road closure")}</div>
          <div class="nearestItemMeta">${formatDistanceMiles(nearestClosure.distance)} • Closure reported</div>
        `;
      } else {
        routeEl.innerHTML = `<div class="dockMetaText">No route status items available.</div>`;
      }
    }
  }

  function updateLocationToggleUI() {
    const toggleEl = document.getElementById("locationToggle");
    if (!toggleEl) return;
    toggleEl.classList.toggle("isOn", locationEnabled);
  }

  function getEventSeverity(event) {
    if (Number.isFinite(event.severity)) return event.severity;
    if (event.tone === "bad") return 3;
    if (event.tone === "warn") return 2;
    return 1;
  }

  function eventMatchesRule(event, rule, userLoc) {
    if (!event) return false;
    const eventType = event.type || event.category;
    if (rule.types && rule.types.length && !rule.types.includes(eventType)) {
      return false;
    }
    if (Number.isFinite(rule.minSeverity) && getEventSeverity(event) < rule.minSeverity) {
      return false;
    }
    if (Number.isFinite(rule.withinMiles)) {
      if (!userLoc || !Number.isFinite(event.lat) || !Number.isFinite(event.lon)) {
        return false;
      }
      const distance = haversineDistance(userLoc.lat, userLoc.lng, event.lat, event.lon);
      if ((distance / 1609.34) > rule.withinMiles) {
        return false;
      }
    }
    return true;
  }

  function playAlertSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.value = 0.08;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      setTimeout(() => {
        osc.stop();
        ctx.close();
      }, 200);
    } catch {}
  }

  function evaluateAlertRules() {
    if (!CONFIG.alertRules?.enabled) return;
    const userLoc = getUserLocation();
    const matches = new Map();
    CONFIG.alertRules.rules.forEach(rule => {
      getAllItemsArray().forEach(event => {
        if (eventMatchesRule(event, rule, userLoc)) {
          const entry = matches.get(event.id) || { event, rules: [] };
          entry.rules.push(rule);
          matches.set(event.id, entry);
        }
      });
    });

    const previousIds = new Set(store.alerts.active.keys());
    store.alerts.active.clear();
    matches.forEach((entry, id) => store.alerts.active.set(id, entry));

    const newIds = Array.from(matches.keys()).filter(id => !previousIds.has(id));
    if (newIds.length > 0) {
      const shouldSound = store.alerts.soundEnabled && matches.get(newIds[0])?.rules?.some(r => r.sound);
      const shouldVibrate = store.alerts.vibrationEnabled && matches.get(newIds[0])?.rules?.some(r => r.vibrate);
      if (shouldSound) playAlertSound();
      if (shouldVibrate && navigator.vibrate) {
        navigator.vibrate([120, 60, 120]);
      }
    }
    store.alerts.lastCheck = Date.now();
    updateAlertsPanel();
  }

  function updateAlertsPanel() {
    if (dockState.isOpen && dockState.tab === "alerts") {
      renderDock();
    }
  }

  function updateWatchboardPanel() {
    if (dockState.isOpen && dockState.tab === "watchboard") {
      renderDock();
    }
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

  // Update category counts in dock (lightweight UI refresh for degraded mode)
  function updateCategoryCounts() {
    try {
      // Lightweight UI refresh when degraded mode skips redraw()
      // If dock is open, re-render it so the categories list reflects current store content
      if (typeof dockState !== "undefined" && dockState && dockState.isOpen) {
        renderDock();
      }
      // If a panel list exists and is open, keep it stable (no full redraw)
      // (Only do minimal DOM updates if you have a known lightweight hook; otherwise no-op.)
    } catch (e) {
      console.warn("updateCategoryCounts failed:", e);
    }
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
    const hasErrors = healthTracker.recentErrors.has(sourceId);
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

  function renderNearestHTML() {
    return `
      <div class="dockCard">
        <div class="dockToggleRow">
          <div class="dockToggleLabel">Use my location</div>
          <button class="toggleSwitch" id="locationToggle" type="button" aria-pressed="false"></button>
        </div>
        <div class="dockMetaText" id="locationStatus">Location disabled.</div>
      </div>

      <div class="dockSectionTitle">Nearest Camera</div>
      <div class="nearestItem" id="nearestCamera"></div>

      <div class="dockSectionTitle">Nearest Hospitals / Police / Fire / Shelters</div>
      <div class="nearestList">
        <div class="nearestItem" id="nearestHospital"></div>
        <div class="nearestItem" id="nearestPolice"></div>
        <div class="nearestItem" id="nearestFire"></div>
        <div class="nearestItem" id="nearestShelter"></div>
      </div>

      <div class="dockSectionTitle">Nearest Open Route</div>
      <div class="nearestItem" id="nearestRoute"></div>
    `;
  }

  function renderWatchboardHTML() {
    const pinned = Array.from(store.cameraPins)
      .map(id => store.itemsById.get(id))
      .filter(item => item && item.category === "camera");

    let html = `
      <div class="dockCard">
        <div class="dockRowLeft">
          <div class="dockRowTitle">Pinned Cameras</div>
          <div class="dockRowMeta">Pin cameras from the details panel to populate the watchboard.</div>
        </div>
        <div class="dockBadge">${pinned.length}</div>
      </div>
    `;

    if (pinned.length === 0) {
      html += `<div class="dockMetaText">No pinned cameras yet.</div>`;
      return html;
    }

    html += `<div class="watchboardGrid">`;
    pinned.forEach(cam => {
      html += `
        <div class="watchboardCard" data-camera-id="${escapeAttr(cam.id)}">
          <div class="watchboardHeader">${escapeHtml(cam.title || "Camera")}</div>
          <div class="watchboardMedia">
            <div class="watchboardStatus">Loading snapshot…</div>
            <img alt="${escapeAttr(cam.title || "Camera snapshot")}" style="display:none;" />
          </div>
          <div class="watchboardActions">
            <button class="watchboardBtn" data-action="refresh" type="button">Refresh</button>
            <button class="watchboardBtn" data-action="unpin" type="button">Unpin</button>
          </div>
        </div>
      `;
    });
    html += `</div>`;
    return html;
  }

  function renderAlertsHTML() {
    let html = `
      <div class="alertRuleCard">
        <div class="alertRuleTitle">Alert Rules</div>
        <div class="dockMetaText">Rules evaluate Event objects and trigger when conditions match.</div>
        <div class="dockToggleRow">
          <div class="dockToggleLabel">Sound</div>
          <button class="toggleSwitch" id="alertSoundToggle" type="button"></button>
        </div>
        <div class="dockToggleRow">
          <div class="dockToggleLabel">Vibration</div>
          <button class="toggleSwitch" id="alertVibrationToggle" type="button"></button>
        </div>
      </div>
    `;

    CONFIG.alertRules.rules.forEach(rule => {
      html += `
        <div class="alertRuleCard">
          <div class="alertRuleTitle">${escapeHtml(rule.label)}</div>
          <div class="dockMetaText">Within ${rule.withinMiles} mi • Severity ≥ ${rule.minSeverity}</div>
          <div class="dockMetaText">Types: ${rule.types.join(", ")}</div>
        </div>
      `;
    });

    const entries = Array.from(store.alerts.active.values());
    html += `<div class="dockSectionTitle">Hot Alerts (${entries.length})</div>`;
    if (entries.length === 0) {
      html += `<div class="dockMetaText">No alerts matched current rules.</div>`;
      return html;
    }

    html += `<div class="alertList">`;
    entries.slice(0, 20).forEach(({ event, rules }) => {
      html += `
        <div class="alertItem" data-item-id="${escapeAttr(event.id)}">
          <div class="alertItemTitle">${escapeHtml(event.title || "Alert")}</div>
          <div class="alertItemMeta">${escapeHtml((rules || []).map(r => r.label).join(" • "))}</div>
          <div class="alertItemMeta">${formatRelativeTime(toTs(event.timeStart || event.timestamp))}</div>
        </div>
      `;
    });
    html += `</div>`;
    return html;
  }

  function initializeWatchboardPanel() {
    const panel = dockPanelBody;
    if (!panel) return;
    panel.querySelectorAll(".watchboardCard").forEach(card => {
      const cameraId = card.dataset.cameraId;
      const item = store.itemsById.get(cameraId);
      if (!item) return;
      const imgEl = card.querySelector("img");
      const statusEl = card.querySelector(".watchboardStatus");
      const refreshBtn = card.querySelector('[data-action="refresh"]');
      const unpinBtn = card.querySelector('[data-action="unpin"]');

      if (refreshBtn) {
        refreshBtn.addEventListener("click", () => {
          loadCameraSnapshot({ imgEl, statusEl, item, force: true });
        });
      }

      if (unpinBtn) {
        unpinBtn.addEventListener("click", () => {
          toggleCameraPin(cameraId);
        });
      }

      if (!item.media?.src) {
        if (statusEl) statusEl.textContent = "No snapshot available.";
        return;
      }
      loadCameraSnapshot({ imgEl, statusEl, item, force: false });
    });
  }

  function initializeAlertsPanel() {
    const panel = dockPanelBody;
    if (!panel) return;
    const soundToggle = panel.querySelector("#alertSoundToggle");
    const vibrationToggle = panel.querySelector("#alertVibrationToggle");
    if (soundToggle) {
      soundToggle.classList.toggle("isOn", store.alerts.soundEnabled);
      soundToggle.addEventListener("click", () => {
        store.alerts.soundEnabled = !store.alerts.soundEnabled;
        saveAlertPrefs();
        soundToggle.classList.toggle("isOn", store.alerts.soundEnabled);
      });
    }
    if (vibrationToggle) {
      vibrationToggle.classList.toggle("isOn", store.alerts.vibrationEnabled);
      vibrationToggle.addEventListener("click", () => {
        store.alerts.vibrationEnabled = !store.alerts.vibrationEnabled;
        saveAlertPrefs();
        vibrationToggle.classList.toggle("isOn", store.alerts.vibrationEnabled);
      });
    }

    panel.querySelectorAll(".alertItem").forEach(row => {
      row.addEventListener("click", () => {
        const id = row.dataset.itemId;
        if (id) {
          closeDock();
          selectItem(id);
        }
      });
    });
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
    const statusClass = health.status.toLowerCase() === "live" ? "status-ok" : health.status.toLowerCase() === "partial" ? "status-backoff" : "status-error";
    html += `<div class="dockBadge ${statusClass}">${health.status.toUpperCase()}</div>`;
    html += `</div>`;
    html += `<div class="dockRow">`;
    html += `<div class="dockRowLeft"><div class="dockRowTitle">Stale Data Count</div></div>`;
    html += `<div class="dockBadge">${staleCount}</div>`;
    html += `</div>`;

    // Air Quality status
    if (CONFIG.air.enabled && store.air.aqi !== null) {
      html += `<div class="dockRow">`;
      html += `<div class="dockRowLeft">`;
      html += `<div class="dockRowTitle">Air Quality (AQI)</div>`;
      if (store.air.timestamp) {
        html += `<div class="dockRowMeta">${formatRelativeTime(store.air.timestamp)}</div>`;
      }
      html += `</div>`;
      html += `<div class="dockBadge">${store.air.aqi}</div>`;
      html += `</div>`;
    }

    html += `</div>`;

    // Recent errors
    if (healthTracker.recentErrors.size > 0) {
      html += `<div class="dockSectionTitle">Recent Errors (${healthTracker.recentErrors.size})</div>`;
      const errorEntries = Array.from(healthTracker.recentErrors.entries()).slice(0, 10);
      errorEntries.forEach(([feedId, data]) => {
        html += `<div class="dockCard">`;
        html += `<div class="dockRow">`;
        html += `<div class="dockRowLeft">`;
        html += `<div class="dockRowTitle">${escapeHtml(feedId)}</div>`;
        html += `<div class="dockRowMeta">${formatRelativeTime(data.firstSeen)} • ${data.count} error(s)</div>`;
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

    // GIS Overlays (grouped by municipality)
    if (CONFIG.gisOverlays.enabled) {
      html += `<div class="dockSectionTitle">Map Overlays</div>`;

      // Group overlays by municipality
      const groups = {};
      CONFIG.gisOverlays.overlays.forEach(overlay => {
        const group = overlay.group || "OTHER";
        if (!groups[group]) groups[group] = [];
        groups[group].push(overlay);
      });

      // Get collapsed state from localStorage
      let collapsedGroups = {};
      try {
        const stored = localStorage.getItem("fxbg_overlay_groups_collapsed");
        if (stored) {
          collapsedGroups = safeJsonParse(stored, {}, "overlay group state");
        }
      } catch(e) {}

      // Render each group as an accordion
      Object.keys(groups).forEach(groupName => {
        const overlays = groups[groupName];
        const isCollapsed = collapsedGroups[groupName] === true;

        html += `<div class="overlayGroup ${isCollapsed ? 'collapsed' : ''}" data-group="${escapeAttr(groupName)}">`;
        html += `<div class="overlayGroup__toggle" data-group="${escapeAttr(groupName)}">`;
        html += `<span class="overlayGroup__toggleTitle">${escapeHtml(groupName)} (${overlays.length})</span>`;
        html += `<span class="overlayGroup__toggleIcon">▼</span>`;
        html += `</div>`;
        html += `<div class="overlayGroup__body">`;

        overlays.forEach(overlay => {
          const isEnabled = store.gis.enabled.has(overlay.id);
          html += `<div class="dockRow">`;
          html += `<label>`;
          html += `<input type="checkbox" data-overlay-id="${escapeAttr(overlay.id)}" ${isEnabled ? 'checked' : ''}>`;
          html += `<span>${escapeHtml(overlay.name)}</span>`;
          html += `</label>`;
          html += `</div>`;
        });

        html += `</div>`; // overlayGroup__body
        html += `</div>`; // overlayGroup
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
      case "nearest": return renderNearestHTML();
      case "watchboard": return renderWatchboardHTML();
      case "alerts": return renderAlertsHTML();
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
      nearest: "Nearest",
      watchboard: "Watchboard",
      alerts: "Hot Alerts",
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

    if (dockState.tab === "system") {
      // Bind GIS overlay toggles
      dockPanelBody.querySelectorAll('input[data-overlay-id]').forEach(checkbox => {
        checkbox.addEventListener("change", async (e) => {
          const overlayId = e.target.dataset.overlayId;
          if (e.target.checked) {
            await enableOverlay(overlayId);
          } else {
            disableOverlay(overlayId);
          }
        });
      });

      // Bind accordion toggle handlers
      dockPanelBody.querySelectorAll('.overlayGroup__toggle').forEach(toggle => {
        toggle.addEventListener("click", (e) => {
          const groupName = toggle.dataset.group;
          const groupEl = toggle.closest('.overlayGroup');

          // Toggle collapsed class
          groupEl.classList.toggle('collapsed');

          // Save collapsed state to localStorage
          try {
            let collapsedGroups = {};
            const stored = localStorage.getItem("fxbg_overlay_groups_collapsed");
            if (stored) {
              collapsedGroups = safeJsonParse(stored, {}, "overlay group state");
            }

            collapsedGroups[groupName] = groupEl.classList.contains('collapsed');
            localStorage.setItem("fxbg_overlay_groups_collapsed", JSON.stringify(collapsedGroups));
          } catch(e) {
            console.warn("Failed to save accordion state:", e);
          }
        });
      });
    }

    if (dockState.tab === "nearest") {
      const toggle = document.getElementById("locationToggle");
      if (toggle) {
        toggle.addEventListener("click", () => {
          setLocationEnabled(!locationEnabled);
          toggle.classList.toggle("isOn", locationEnabled);
          updateNearestPanel();
        });
      }
      updateNearestPanel();
    }

    if (dockState.tab === "watchboard") {
      initializeWatchboardPanel();
    }

    if (dockState.tab === "alerts") {
      initializeAlertsPanel();
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

    // Collapse mobile header when opening dock (prevents header from blocking dock panel)
    setMobileHeaderCollapsed(true);

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
    ensurePanelCloseVisible(dockPanel);
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

    // Restore mobile header if no other panels are blocking
    restoreHeaderIfNoBlockingPanels();
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

  // Wire header chips to dock tabs - moved to attachHeaderEventListeners()

  // -----------------------------
  // Mobile Landscape Orientation Handling
  // -----------------------------
  const mqlPortrait = window.matchMedia?.("(orientation: portrait)");
  function updateOrientationUI(){
    const isPortrait = mqlPortrait ? mqlPortrait.matches : (window.innerHeight > window.innerWidth);
    const isMobileish = window.matchMedia?.("(max-width: 980px)")?.matches ?? (window.innerWidth <= 980);
    const allowPortrait = !!window.__CM_ALLOW_PORTRAIT;
    document.body.classList.toggle("force-landscape", isMobileish && isPortrait && !allowPortrait);
  }

  // Update on load, resize, and orientation change
  updateOrientationUI();
  window.addEventListener("resize", updateOrientationUI);
  if (mqlPortrait && typeof mqlPortrait.addEventListener === 'function') {
    mqlPortrait.addEventListener("change", updateOrientationUI);
  }

  // Fullscreen attempt button
  const btnTryFullscreen = document.getElementById("btnTryFullscreen");
  if (btnTryFullscreen) {
    btnTryFullscreen.addEventListener("click", async () => {
      try{
        if (document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        }
        if (screen.orientation && screen.orientation.lock) {
          await screen.orientation.lock("landscape").catch(() => {
            // Screen orientation lock may fail - that's okay
          });
        }
      }catch(e){
        // Fullscreen request may fail - that's okay
      }
      updateOrientationUI();
    });
  }

  // Continue Anyway button
  const btnContinuePortrait = document.getElementById("btnContinuePortrait");
  if (btnContinuePortrait) {
    btnContinuePortrait.addEventListener("click", () => {
      window.__CM_ALLOW_PORTRAIT = true;
      updateOrientationUI();
    });
  }

  // -----------------------------
  // Mobile Landscape UX Helpers
  // -----------------------------

  // Detect mobile landscape mode
  const mqlMobileLandscape = window.matchMedia('(orientation: landscape) and (max-height: 520px), (max-width: 980px) and (orientation: landscape)');

  function updateMobileLandscapeMode() {
    const isMobileLandscape = mqlMobileLandscape.matches;

    if (isMobileLandscape) {
      document.body.classList.add('mobileCompact');
    } else {
      document.body.classList.remove('mobileCompact');
    }
  }

  // Update on load and when media query changes
  updateMobileLandscapeMode();
  if (mqlMobileLandscape && typeof mqlMobileLandscape.addEventListener === 'function') {
    mqlMobileLandscape.addEventListener('change', updateMobileLandscapeMode);
  }

  // Enhance openDock for mobile landscape
  const originalOpenDock = openDock;
  openDock = function(tab) {
    originalOpenDock(tab);

    // On mobile landscape: scroll panel body to top for better UX
    if (mqlMobileLandscape.matches && dockPanelBody) {
      setTimeout(() => {
        dockPanelBody.scrollTop = 0;
      }, 50);
    }
  };

  // Enhance setDockTab for mobile landscape
  const originalSetDockTab = setDockTab;
  setDockTab = function(tab) {
    originalSetDockTab(tab);

    // On mobile landscape: scroll panel body to top when switching tabs
    if (mqlMobileLandscape.matches && dockPanelBody) {
      setTimeout(() => {
        dockPanelBody.scrollTop = 0;
      }, 50);
    }
  };

  // -----------------------------
  // PART C: Draggable Legend (touch + mouse)
  // -----------------------------
  function findLegendEl(){
    return document.querySelector("#mapLegend")
      || document.querySelector(".mapLegend")
      || document.querySelector("#legend")
      || document.querySelector(".legend")
      || document.querySelector(".overlay-legend")
      || document.querySelector(".leaflet-control-layers"); // last resort
  }

  function loadLegendPos(){
    return safeJsonParse(localStorage.getItem("fxbgLegendPos") || "null", null, "legend position");
  }
  function saveLegendPos(pos){
    try { localStorage.setItem("fxbgLegendPos", JSON.stringify(pos)); } catch(e){}
  }

  function clampLegend(el, left, top){
    const margin = 8;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // clamp using element size (rect.width/height)
    let x = Math.max(margin, Math.min(left, vw - rect.width - margin));
    let y = Math.max(margin, Math.min(top,  vh - rect.height - margin));
    return { left: x, top: y };
  }

  function enableLegendDrag(el){
    if(!el) return;

    // Make it fixed + draggable
    el.classList.add("legendDraggable");

    // Insert a handle if not present
    let handle = el.querySelector(".legendDragHandle");
    if(!handle){
      handle = document.createElement("div");
      handle.className = "legendDragHandle";
      handle.title = "Drag legend";
      el.insertBefore(handle, el.firstChild);
    }

    // Apply saved position
    const saved = loadLegendPos();
    if(saved && typeof saved.left === "number" && typeof saved.top === "number"){
      const clamped = clampLegend(el, saved.left, saved.top);
      el.style.left = clamped.left + "px";
      el.style.top  = clamped.top  + "px";
      el.style.right = "auto";
      el.style.bottom = "auto";
    } else {
      // Default: top-left-ish but not under header
      el.style.left = "10px";
      el.style.top = "90px";
      el.style.right = "auto";
      el.style.bottom = "auto";
    }

    let dragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    const onDown = (e) => {
      // only start drag from handle
      const isHandle = e.target.closest(".legendDragHandle");
      if(!isHandle) return;

      dragging = true;
      const pt = (e.touches && e.touches[0]) ? e.touches[0] : e;
      const rect = el.getBoundingClientRect();
      startX = pt.clientX;
      startY = pt.clientY;
      startLeft = rect.left;
      startTop  = rect.top;

      e.preventDefault();
      e.stopPropagation();
    };

    const onMove = (e) => {
      if(!dragging) return;
      const pt = (e.touches && e.touches[0]) ? e.touches[0] : e;
      const dx = pt.clientX - startX;
      const dy = pt.clientY - startY;

      const targetLeft = startLeft + dx;
      const targetTop  = startTop + dy;
      const clamped = clampLegend(el, targetLeft, targetTop);

      el.style.left = clamped.left + "px";
      el.style.top  = clamped.top  + "px";
      el.style.right = "auto";
      el.style.bottom = "auto";

      e.preventDefault();
      e.stopPropagation();
    };

    const onUp = (e) => {
      if(!dragging) return;
      dragging = false;
      const rect = el.getBoundingClientRect();
      saveLegendPos({ left: rect.left, top: rect.top });
      e.preventDefault?.();
      e.stopPropagation?.();
    };

    // Avoid double-binding
    if(el.dataset.dragBound === "1") return;
    el.dataset.dragBound = "1";

    handle.addEventListener("touchstart", onDown, { passive: false });
    handle.addEventListener("mousedown", onDown);

    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("mousemove", onMove);

    window.addEventListener("touchend", onUp);
    window.addEventListener("mouseup", onUp);

    // Re-clamp on resize/orientation change
    window.addEventListener("resize", () => {
      if(!el) return;
      const rect = el.getBoundingClientRect();
      const clamped = clampLegend(el, rect.left, rect.top);
      el.style.left = clamped.left + "px";
      el.style.top  = clamped.top  + "px";
    });
  }

  function tryEnableLegendDrag(){
    const el = findLegendEl();
    if(el) enableLegendDrag(el);
  }

  // Try to enable legend drag on load and after a delay (in case legend appears late)
  setTimeout(() => {
    tryEnableLegendDrag();
    // If legend appears later (layer toggles), poll lightly without heavy loops:
    let attempts = 0;
    const t = setInterval(() => {
      attempts++;
      tryEnableLegendDrag();
      if(findLegendEl() || attempts > 20) clearInterval(t); // ~10 seconds max
    }, 500);
  }, 1000);

  // -----------------------------
  // PART C: Dock Expand/Collapse State Management
  // -----------------------------
  function setDockExpanded(isExpanded){
    document.body.classList.toggle("dockExpanded", !!isExpanded);
    const bb = document.querySelector(".bottombar");
    if(bb) bb.classList.toggle("isCollapsed", !isExpanded);
  }

  // Enhance openDock to set expanded state
  const originalOpenDockForExpand = openDock;
  openDock = function(tab) {
    originalOpenDockForExpand(tab);
    setDockExpanded(true);
  };

  // Enhance closeDock to set collapsed state
  const originalCloseDockForExpand = closeDock;
  closeDock = function() {
    originalCloseDockForExpand();
    setDockExpanded(false);
  };

  // -----------------------------
  // Desktop vs Mobile Header Initialization
  // -----------------------------
  function initDesktopHeader() {
    if (IS_MOBILE_UI) return; // Keep mobile header as-is

    const desktopHeader = document.getElementById("desktopHeader");
    if (!desktopHeader) return;

    // Render old desktop header layout (3-column grid)
    desktopHeader.innerHTML = `
      <div class="topbar__left">
        <div class="brand">
          <div class="brand__mark">🧠</div>
          <div class="brand__text">
            <div class="brand__title">CITY MANAGER</div>
            <div class="brand__sub">FXBG • Stafford • Spotsylvania</div>
          </div>
        </div>
      </div>

      <div class="topbar__center">
        <div class="chip chip--live" id="chipLive">
          <span class="dot"></span>
          <span id="liveText">Live</span>
        </div>

        <div class="chip" id="chipWeather" title="Current conditions + 3 day forecast">
          <span class="chip__icon">🌤️</span>
          <span class="chip__text" id="weatherText">Weather: Loading…</span>
        </div>

        <div class="chip" id="chipTraffic" title="I‑95 traffic indicator (derived from 511 incidents near FXBG metro)">
          <span class="chip__icon">🛣️</span>
          <span class="chip__text" id="trafficText">I‑95: Loading…</span>
        </div>

        <div class="chip" id="chipAir" title="Air Quality Index">
          <span class="dot" id="airDot"></span>
          <span id="airText">AQI: …</span>
        </div>
      </div>

      <div class="topbar__right">
        <button class="btn crime-btn" id="btnCrime" title="FXBG PD Crime Reports" aria-pressed="false">
          <span class="btn__icon">🚓</span>
          <span class="btn__label">Crime</span>
        </button>
        <button class="btn" id="btnReport" title="Field Notes / Incidents">
          <span class="btn__icon">📝</span>
          <span class="btn__label">Report</span>
        </button>
        <button class="btn" id="btnNewsFlash" title="Regional News Flash Dashboard">
          <span class="btn__icon">📰</span>
          <span class="btn__label">News Flash</span>
        </button>
        <button class="btn" id="btnRadioScanner" title="Radio Scanner">
          <span class="btn__icon">📻</span>
          <span class="btn__label">Radio</span>
        </button>
        <button class="btn" id="btnRefresh" title="Refresh now">
          <span class="btn__icon">🔄</span>
          <span class="btn__label">Refresh</span>
        </button>
        <div class="mini">
          <div class="mini__label">Last update</div>
          <div class="mini__value" id="lastUpdate">—</div>
        </div>
      </div>
    `;
  }

  // Attach header event listeners (chips and buttons)
  // Must be called AFTER initDesktopHeader() and dedupeHeaderIdsForDesktop()
  let __headerListenersAttached = false;

  function attachHeaderEventListeners() {
    // Guard against duplicate listener attachment
    if (__headerListenersAttached) return;
    __headerListenersAttached = true;

    // Refresh button
    const btnRefresh = $("btnRefresh");
    if (btnRefresh) {
      btnRefresh.addEventListener("click", refreshAll);
    }

    // Crime Reports button
    const btnCrime = IS_MOBILE_UI
      ? (document.getElementById("btnCrimeMobile") || document.getElementById("btnCrime"))
      : document.getElementById("btnCrime");
    if (btnCrime) {
      let pressTimer = null;
      let suppressNextClick = false;

      // Single click: toggle overlay
      btnCrime.addEventListener("click", (e) => {
        if (suppressNextClick) {
          suppressNextClick = false;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        openCrimeMenuPanel();
      });

      // Right-click (desktop): open menu without toggling
      btnCrime.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openCrimeMenuPanel();
      });

      // Long-press (mobile): open menu without toggling
      btnCrime.addEventListener("pointerdown", (e) => {
        pressTimer = setTimeout(() => {
          openCrimeMenuPanel();
          suppressNextClick = true;
          pressTimer = null;
        }, 550); // 550ms for long-press
      });

      btnCrime.addEventListener("pointerup", () => {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      });

      btnCrime.addEventListener("pointercancel", () => {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      });

      btnCrime.addEventListener("pointermove", () => {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      });
    }

    // Report button
    const btnReport = IS_MOBILE_UI
      ? (document.getElementById("btnReportMobile") || document.getElementById("btnReport"))
      : document.getElementById("btnReport");
    if (btnReport) {
      btnReport.addEventListener("click", () => {
        const panel = $("reportPanel");
        if (!panel) return;
        const isHidden = panel.classList.contains("reportPanel--hidden");
        if (isHidden) {
          playClickSound('open');
          panel.classList.remove("reportPanel--hidden");
          setMobileHeaderCollapsed(true);
        } else {
          playClickSound('close');
          panel.classList.add("reportPanel--hidden");
          restoreHeaderIfNoBlockingPanels();
        }
      });
    }

    // News Flash button
    const btnNewsFlash = IS_MOBILE_UI
      ? (document.getElementById("btnNewsFlashMobile") || document.getElementById("btnNewsFlash"))
      : document.getElementById("btnNewsFlash");
    if (btnNewsFlash) {
      btnNewsFlash.addEventListener("click", () => {
        const panel = $("newsFlashPanel");
        const isHidden = panel.classList.contains("newsFlashPanel--hidden");

        if (isHidden) {
          playClickSound('open');
          panel.classList.remove("newsFlashPanel--hidden");
          updateNewsFlash();
          ensurePanelCloseVisible(panel);
          setMobileHeaderCollapsed(true); // Collapse mobile header when opening
        } else {
          playClickSound('close');
          panel.classList.add("newsFlashPanel--hidden");
          restoreHeaderIfNoBlockingPanels(); // Restore header if no other panels are open
        }
      });
    }

    // Radio Scanner button
    const btnRadioScanner = IS_MOBILE_UI
      ? (document.getElementById("btnRadioScannerMobile") || document.getElementById("btnRadioScanner"))
      : document.getElementById("btnRadioScanner");
    if (btnRadioScanner) {
      btnRadioScanner.addEventListener("click", () => {
        const panel = $("radioPanel");
        const isHidden = panel.classList.contains("radioPanel--hidden");

        if (isHidden) {
          playClickSound('open');
          panel.classList.remove("radioPanel--hidden");
          ensurePanelCloseVisible(panel);
          setMobileHeaderCollapsed(true); // Collapse mobile header when opening
        } else {
          playClickSound('close');
          panel.classList.add("radioPanel--hidden");
          restoreHeaderIfNoBlockingPanels(); // Restore header if no other panels are open
        }
      });
    }

    // Header chips to dock tabs
    const chipLive = $("chipLive");
    if (chipLive) {
      chipLive.addEventListener("click", () => {
        openDock("system");
      });
    }

    const chipWeather = $("chipWeather");
    if (chipWeather) {
      chipWeather.addEventListener("click", () => {
        openDock("overview");
      });
    }

    const chipTraffic = $("chipTraffic");
    if (chipTraffic) {
      chipTraffic.addEventListener("click", () => {
        openDock("sources");
      });
    }
  }

  // -----------------------------
  // UI Sync Helper (handles resize/orientation changes)
  // -----------------------------
  let __uiSyncTimer = null;
  let __mobileListenersAttached = false;
  let __chromeHeightTimer = null;

  function runUiSanityCheck(context = "check") {
    if (!CONFIG?.debug?.uiSanity) return;

    try {
      const missing = [];
      const baseRequired = ["map", "panel", "panelHandle"];
      const panelRequired = ["crimePanel", "reportPanel", "newsFlashPanel", "radioPanel", "diagnosticsDrawer"];
      const buttonPairs = [
        { base: "btnCrime", mobile: "btnCrimeMobile" },
        { base: "btnReport", mobile: "btnReportMobile" },
        { base: "btnNewsFlash", mobile: "btnNewsFlashMobile" },
        { base: "btnRadioScanner", mobile: "btnRadioScannerMobile" },
        { base: "btnRefresh", mobile: "btnRefreshMobile" }
      ];

      for (const id of baseRequired) {
        if (!document.getElementById(id)) missing.push(`#${id}`);
      }

      for (const id of panelRequired) {
        if (!document.getElementById(id)) missing.push(`#${id}`);
      }

      for (const pair of buttonPairs) {
        if (IS_MOBILE_UI) {
          if (!document.getElementById(pair.mobile) && !document.getElementById(pair.base)) {
            missing.push(`#${pair.mobile} or #${pair.base}`);
          }
        } else if (!document.getElementById(pair.base)) {
          missing.push(`#${pair.base}`);
        }
      }

      const escapeId = (id) => {
        if (window.CSS && typeof CSS.escape === "function") return CSS.escape(id);
        return id.replace(/([ #;?%&,.+*~\\':"!^$\\[\\]()<=>|@])/g, "\\$1");
      };

      const idsToCheck = new Set([
        ...baseRequired,
        ...panelRequired,
        ...buttonPairs.flatMap((pair) => [pair.base, pair.mobile])
      ]);

      const duplicates = [];
      for (const id of idsToCheck) {
        const count = document.querySelectorAll(`#${escapeId(id)}`).length;
        if (count > 1) duplicates.push(`${id}(${count})`);
      }

      const warnings = [];
      if (missing.length) {
        warnings.push(`Missing elements (${IS_MOBILE_UI ? "mobile" : "desktop"}): ${missing.join(", ")}`);
      }
      if (duplicates.length) {
        warnings.push(`Duplicate IDs detected: ${duplicates.join(", ")}`);
      }

      if (warnings.length) {
        console.warn(`[UI Sanity] ${context}: ${warnings.join(" | ")}`);
      }
    } catch (error) {
      console.warn(`[UI Sanity] ${context}: ${error?.message || error}`);
    }
  }

  function syncUiMode() {
    const next = computeIsMobileUI();
    const changed = next !== IS_MOBILE_UI;
    IS_MOBILE_UI = next;

    // Force CSS to match JS-selected UI mode (prevents ghost desktop header overlay on some mobile browsers)
    const root = document.documentElement;
    root.classList.toggle("ui-mobile", IS_MOBILE_UI);
    root.classList.toggle("ui-desktop", !IS_MOBILE_UI);

    const desktopHeader = document.getElementById("desktopHeader");

    if (IS_MOBILE_UI) {
      // IMPORTANT: prevent duplicate IDs from desktop header interfering with mobile getElementById lookups
      if (desktopHeader) desktopHeader.innerHTML = "";
      // Mobile mode: attach event listeners to mobile header elements (only once or when switching from desktop)
      if (!__mobileListenersAttached || changed) {
        __headerListenersAttached = false; // Reset guard to allow re-attachment
        attachHeaderEventListeners();
        __mobileListenersAttached = true;
      }
      updateChromeHeights();
      runUiSanityCheck("syncUiMode");
      return;
    }

    // Desktop mode: ensure IDs are deduped BEFORE building desktop header, then attach listeners
    // (initDesktopHeader recreates HTML, clearing old listeners, so we always re-attach)
    __mobileListenersAttached = false; // Reset flag when leaving mobile mode
    dedupeHeaderIdsForDesktop();
    initDesktopHeader();
    __headerListenersAttached = false; // Reset guard since initDesktopHeader() recreated HTML
    attachHeaderEventListeners();
    updateChromeHeights();
    runUiSanityCheck("syncUiMode");
  }

  function scheduleSyncUiMode() {
    clearTimeout(__uiSyncTimer);
    __uiSyncTimer = setTimeout(syncUiMode, 150);
  }

  function scheduleChromeHeightUpdate() {
    clearTimeout(__chromeHeightTimer);
    __chromeHeightTimer = setTimeout(updateChromeHeights, 150);
  }

  window.addEventListener("resize", () => {
    scheduleSyncUiMode();
    scheduleChromeHeightUpdate();
  });
  window.addEventListener("orientationchange", () => {
    scheduleSyncUiMode();
    scheduleChromeHeightUpdate();
  });

  // -----------------------------
  // Boot + timers
  // -----------------------------

  // Initialize Crime Reports state from localStorage
  const crimeUI = loadCrimeUI();
  store.crime = {
    enabled: crimeUI.enabled,
    windowDays: crimeUI.windowDays,
    appliedWindowDays: crimeUI.appliedWindowDays,
    lastAppliedAt: crimeUI.lastAppliedAt,
    pendingEnabled: crimeUI.enabled,
    sort: crimeUI.sort,
    menuAutoOpen: crimeUI.menuAutoOpen,
    ids: new Set(),
    markersOnMap: new Set()
  };
  store.reports.layer = reportsLayer;
  updateReportSeverityLabel();
  updateReportLocationUI();
  const reportLayerToggleBoot = $("reportLayerToggle");
  if (reportLayerToggleBoot) {
    reportLayerToggleBoot.checked = store.reports.enabled;
  }
  fetchReports({ sinceDays: 90 });

  syncUiMode();
  updateChromeHeights();
  updateCrimeButtonActiveState();
  ensureOverlayLegendControl();
  runUiSanityCheck("boot");

  // Set a short timeout to ensure chips update even if refreshAll hangs
  setTimeout(ensureChipsHaveState, 10000); // 10 seconds after boot

  refreshAll();
  if (CONFIG.alertRules?.enabled) {
    setInterval(evaluateAlertRules, CONFIG.alertRules.pollingMs);
  }
  setInterval(pollRSS, CONFIG.polling.rss);
  setInterval(fetchNWS, CONFIG.polling.nws);
  setInterval(pollArcgisCrashes, CONFIG.polling.arcgisCrash);
  setInterval(pollVirginiaCrashData, CONFIG.polling.virginiaCrashData);
  setInterval(pollVa511, CONFIG.polling.va511);
  setInterval(fetchOpenUV, CONFIG.polling.openUV);
  setInterval(fetchCDC, CONFIG.polling.cdc);
  setInterval(fetchAirQuality, CONFIG.air.refreshMs);
  setInterval(pollFxbgCrimeReports, CONFIG.fxbgCrimeReports.polling);
  setInterval(() => fetchReports({ sinceDays: 90 }), 60 * 1000);
})();
