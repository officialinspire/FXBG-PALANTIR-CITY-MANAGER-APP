# CITY MANAGER — FXBG-PALANTIR (v15)

Real-time situational awareness dashboard for Fredericksburg, VA metro area.

## 🚀 Quick Start

**CRITICAL: The proxy server MUST be running for markers/waypoints to load!**

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Create a `.env` file in the repo root:
```bash
# Required
LOG_DIR=logs

# Optional (for UV index and air quality data)
OPENUV_API_KEY=your-openuv-key
WAQI_TOKEN=your-waqi-token
```

Or copy the example: `cp .env.example .env`

### 3. Run Doctor Check
```bash
npm run doctor
```
This verifies your environment is correctly configured.

### 4. Start the Server
```bash
npm run dev    # Starts on port 8000
# or
npm start      # Uses PORT from .env or default 8000
```

### Android (Termux) Quick Start
```bash
pkg install nodejs
npm install
./scripts/up.sh
```

`./scripts/up.sh` now detects Android/Termux and uses an Android-safe global env path when needed. Open `http://127.0.0.1:8000` from the same device browser.

### 5. Open in Browser
```
http://localhost:8000
```

The proxy server handles all external API requests (RSS feeds, 511 Virginia traffic, NWS weather, ArcGIS crash data) to bypass CORS restrictions.

### Verify Endpoints (curl)
```bash
# Health check
curl -s "http://localhost:8000/api/health" | head -c 800

# Crime reports status
curl -s "http://localhost:8000/api/fxbg/crime-reports/status"

# Refresh crime reports
curl -s "http://localhost:8000/api/fxbg/crime-reports/refresh?months=6" | head -c 1000

# Force refresh (bypass cache)
curl -s "http://localhost:8000/api/fxbg/crime-reports/refresh?months=6&force=1" | head -c 1000

# Upstreams health
curl -s "http://localhost:8000/api/health/upstreams"
```

## 🔧 Recent Fixes (v15)

### Latest Fixes (v15)
- ✅ **511 Virginia incidents endpoint** - Added fallback to Iteris CDN with JSONP parsing
- ✅ **Virginia crash data API** - Improved error handling for 404/403 responses with helpful guidance
- ✅ **Better API error diagnostics** - Added specific troubleshooting steps for different error types
- ✅ **Endpoint resilience** - Multiple endpoint fallbacks for critical data sources
- ✅ **Improved logging** - Clear debugging information for API endpoint issues

### Previous Fixes (v14)
- ✅ **Improved RSS feed reliability** - Enhanced error handling and better User-Agent headers
- ✅ **Fixed 511 Virginia incidents endpoint** - Updated headers to avoid HTML responses
- ✅ **Better proxy server logging** - Detailed logging for empty responses and errors
- ✅ **Enhanced User-Agent handling** - Realistic browser headers to avoid blocking
- ✅ **Smarter Referer headers** - Automatic Referer setting for specific endpoints
- ✅ **Increased timeouts** - Extended from 12s to 15s for slow endpoints
- ✅ **Better error messages** - Clear guidance when proxy server isn't running

### Previous Fixes (v12)
- ✅ **Markers/Waypoints now load correctly** - Fixed data ingestion and display
- ✅ **511 API errors resolved** - Improved error handling with better logging
- ✅ **Footer buttons show data** - RSS feeds and API info now display properly
- ✅ **Better error messages** - Console warnings are now more helpful
- ✅ **Fallback sample data** - Demo markers appear when APIs are unavailable (for testing)

### What Was Fixed in v15
1. **511 Virginia incidents returning HTML** - Added fallback endpoint (Iteris CDN) with JSONP support
2. **Virginia crash data 404 errors** - Removed problematic date filter, improved error messages
3. **API error diagnostics** - Context-specific troubleshooting guidance for 404/403/network errors
4. **Endpoint resilience** - Automatic failover between primary and fallback endpoints

### How It's Fixed (v15)
1. **Dual-endpoint strategy for 511 Virginia** - Try primary endpoint first, fall back to Iteris CDN
2. **JSONP parsing support** - Handle both JSON and JSONP response formats
3. **Smarter Socrata queries** - Removed date filters that cause 404s, use ID-based ordering
4. **Enhanced error messages** - Specific guidance for 404 (endpoint changed), 403 (auth required)

## 📡 Data Sources

The app pulls live data from:

- **RSS Feeds**: FXBG Police, Transit alerts, Local news
- **511 Virginia**: Traffic cameras, incidents, construction
- **NWS**: Weather forecasts and alerts
- **ArcGIS**: Crash data from Virginia roads

## 🎯 Features

- Interactive map with emoji markers for different event types
- Real-time traffic indicator for I-95
- Weather forecast display
- Filter by category (click footer legend items)
- Detailed panel view for each marker
- Auto-refresh every few minutes

## Timeline + Offline Features

### Timeline Panel
View unified event stream from Reports, Crime, and System sources:
- Click **Timeline** button (⏱️) in header
- Filter by time range (1h to 30d) and event types
- Click events to center map on location
- Shows freshness: LIVE / CACHED / PENDING

### Quick Actions (Field Operations)
Fast logging buttons at top of Timeline:
- **+ Report**: Open full report form
- **⚠️ Hazard**: Quick hazard marker (severity 3)
- **🆘 Help**: Request assistance (severity 4)
- **✅ Check-in**: Log location check-in
- **🎯 Start / 🏁 End**: Mission tracking

All actions work offline and sync when connected.


### UI Modes (Field vs Dispatch)
- Use the **Field | Dispatch** pill in the top bar to switch layouts.
- Mode is persisted per-device in localStorage key `fxbg.uiMode`.
- **Field mode** (mobile-first): timeline opens as a bottom sheet by default, quick actions are larger/always visible, and operational panels use full-width overlays.
- **Dispatch mode** (desktop ops): timeline is docked left by default, detail panel stays right-aligned, and timeline filters use a denser row.

### Active Mission Header + Timer
- Starting a mission from Quick Actions pins an **Active Mission** header at the top.
- The header shows mission name, elapsed timer, and an **End** button.
- Active mission state persists in IndexedDB (`meta.activeMission`) and localStorage (`fxbg.activeMission`) so timer survives reloads.
- Ending a mission logs a `mission_end` action event (including duration and optional summary), then clears the pinned header.

### Offline Mode
App functions without internet:
- Timeline loads from local cache
- Quick Actions store to device
- Shows "OFFLINE" or "HUB UNREACHABLE" status
- Auto-syncs pending items when reconnected

### Sync Pack (Data Sharing)
Share timeline data between devices:
- **Export Sync Pack**: Download JSON with events+reports
- **Import Sync Pack**: Merge data from another device
- Useful for field teams without constant connectivity

### Keyboard Shortcuts
- `T` - Toggle Timeline panel
- (See existing shortcuts with `?`)


## 🗺️ Offline Map Tiles

The app now supports runtime tile caching through the Service Worker (no Leaflet core changes):

- **Cache tiles while browsing** (default ON) via the **Offline Map** control on the map.
- **Prefetch area** downloads tiles around current map center.
  - Radius options: 1km / 3km / 5km / 10km
  - Zoom options: current zoom through +2 levels (capped at z18)
- Cache storage stats are shown in the control:
  - `Tiles cached: N`
  - `Approx MB: ...` (rough estimate)

### Limits + behavior

- Hard cap of ~2000 tile entries is enforced for runtime tile cache with LRU-like refresh behavior.
- Runtime tile caching targets supported dark basemaps used by this app:
  - CARTO Dark (`basemaps.cartocdn.com`)
  - Esri Dark Gray base/reference (fallback)
- If offline and a tile is not in cache, a clear in-app message appears: **"Tiles not cached for this area"** and a readable fallback tile is returned.
- OSM/debug basemap tiles are not part of offline caching strategy by default.

## ⚠️ Troubleshooting

### Markers/Waypoints Not Loading?
1. **Ensure proxy server is running**: `node proxy-server.js`
2. **Check console for errors**: Open browser DevTools (F12)
3. **Verify internet connection**: The proxy needs network access to fetch live data
4. **Look for sample markers**: If APIs fail, demo markers should still appear

### Footer Buttons Show "Loading..."?
- The proxy server needs a working internet connection
- Check console for "Unable to connect" messages
- Sample data will load if APIs are unreachable

### Console Errors About CORS?
- The proxy server isn't running or isn't accessible
- Make sure you're accessing `http://localhost:8000` (not `file://`)

## 🛠️ Development

### File Structure
- `index.html` - Main HTML structure
- `index.js` - Core application logic
- `styles.css` - Styling (if present)
- `proxy-server.js` - CORS proxy server with caching

### Key Functions
- `refreshAll()` - Fetches all data sources
- `pollRSS()` - Fetches RSS feeds with fallback data
- `pollVa511()` - Fetches 511 Virginia traffic data
- `fetchNWS()` - Fetches weather data
- `redraw()` - Updates map markers

### Configuration
Edit `CONFIG` object in `index.js` to:
- Adjust polling intervals
- Add/remove data sources
- Change map center/zoom
- Modify region bounding box

## 📝 Field Reports (Report Panel)

The **Report** panel supports offline-ish field notes and incident logging. Reports persist on the server in `data/reports.json` and render as their own map layer after reload.

### API Endpoints
- `GET /api/reports` — list reports `{ ok, count, items }`.
  - Optional filters: `since=ISO`, `sinceDays=number`, `bbox=minLng,minLat,maxLng,maxLat`.
- `POST /api/reports` — create a report (JSON or multipart form with optional `photo`).
  - Fields: `lat`, `lng`, `accuracy`, `type`, `severity` (1–5), `note` (max 2000).
  - Photo limits: 5MB max, JPEG/PNG/WebP only.
- `GET /api/reports/export.csv` — export CSV.
- `GET /api/reports/export.geojson` — export GeoJSON FeatureCollection.
- `GET /uploads/reports/<filename>` — serve uploaded photos.

### Usage Notes
- Reports are stored locally on the server for resiliency if external feeds are down.
- Use the Report panel to submit incidents, pick a map location, and export data.
- For light operational checks against an already running server, run `npm run smoke` (or `BASE_URL=http://host:port npm run smoke`, or `./scripts/smoke.sh http://host:port`).
- For a one-command local validation, run `npm run smoke:local` to start the proxy, run smoke checks, and shut it down automatically.

## 📝 Notes

- **Sample Data**: When external APIs are unreachable (no internet, sandbox environment), the app loads demonstration markers so you can test the interface
- **Caching**: The proxy server caches responses to reduce API rate limits
- **Performance**: Max 650 total markers, keeping newest items
- **Current Events Only**: Filters show last 24 hours by default

## 🐛 Known Issues

- External APIs may be down or rate-limited occasionally
- Sandbox environments without internet will show sample data only
- Some RSS feeds may have inconsistent formatting

## 📞 Support

If markers still don't load after following this guide:
1. Check browser console (F12) for errors
2. Verify `node proxy-server.js` is running and shows no errors
3. Test proxy with: `curl http://localhost:8000/proxy?url=https://api.weather.gov`
4. Look for the "sample markers" console message

---

**Version**: 14
**Last Updated**: 2026-01-02
**Author**: FXBG-PALANTIR Team


### PR blocked by "Binary Files are Not Allowed"
If your org/repo has a ruleset that rejects binary files in pull requests, remove binary assets from the diff before pushing.

```bash
git diff --name-only --cached
```

This repo uses `favicon.svg`; avoid committing binary icon assets when PR rules reject binaries.

## 📦 PWA Offline Install + Cache Behavior

The app now ships with a Progressive Web App setup for installability and faster offline reloads.

### Installability
- A web manifest is available at `/manifest.webmanifest`.
- Install metadata is provided by `manifest.webmanifest` and existing SVG favicon assets (no binary icon files required).
- Theme/background colors match the existing dark UI (`#0b1220`).
- On supported browsers/devices, you can use **Add to Home Screen** (or install from browser menu).

### Service Worker behavior
- Service worker file: `/sw.js`.
- Versioned caches use `CACHE_VERSION` so updates can safely rotate old caches.
- App shell is pre-cached:
  - `/`
  - `/index.html`
  - `/index.js`
  - `/styles.css`
  - `/favicon.svg`
  - manifest metadata

### Runtime API caching (stale-while-revalidate)
For local `GET /api/*` requests, the service worker serves cached data immediately (if present) while fetching fresh data in the background.
This improves reload speed and keeps timeline/report data available during intermittent connectivity.

Included endpoints:
- `/api/health`
- `/api/reports`
- `/api/reports/export.geojson`
- `/api/fxbg/crime-reports/incidents` (including default query usage)
- Other app timeline/report API sources fetched by `index.js`

### Cache growth control
- API cache is capped to the latest 100 entries.
- `/proxy?url=...` is not cached by the service worker, preventing unbounded proxy-response growth.

### UI indicators
Header chip states show service worker lifecycle:
- `📦 Cached` when active
- `⬇️ Installing…` while installing
- `⬆️ Update available` when a new worker is waiting

When first install caching completes, a subtle **Offline ready** toast appears.
If an update is waiting, an **Update** button posts `skipWaiting` and reloads after activation.


## 📍 Offline Gazetteer + Intersections (Module 6)

The hub now serves two small local datasets used by the client geocoder when offline:

- `data/gazetteer.json` via `GET /api/geo/gazetteer`
- `data/intersections.json` via `GET /api/geo/intersections`

### Data format

`data/gazetteer.json`:

```json
{
  "version": 1,
  "items": [
    { "name": "Place Name", "aliases": ["Alias A"], "lat": 38.30, "lng": -77.46, "tags": ["category"] }
  ]
}
```

`data/intersections.json`:

```json
{
  "version": 1,
  "items": [
    { "a": "Caroline St", "b": "William St", "lat": 38.3026, "lng": -77.4582 }
  ]
}
```

### How to add or edit entries

1. Open the JSON file and add/update an item in `items`.
2. Keep `version` as an integer (increment if you want to track major local changes).
3. Prefer including both canonical `name` and practical `aliases` (for fuzzy alias matching).
4. Keep datasets intentionally small in this module (seed/high-value locations only).
5. Restart the server after edits for immediate refresh, or wait up to 60s for server cache expiry.

The server auto-creates empty defaults if either file is missing, so startup remains safe.

