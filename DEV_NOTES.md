# Development Notes — CITY MANAGER Dashboard

## Quick Start

### How to Run
```bash
node proxy-server.js
```

Then open in your browser:
```
http://localhost:8000
```

**Default port:** 8000 (override with `PORT=9000 node proxy-server.js`)

---

## Endpoints

### Main Application
- **GET /** — Serves `index.html` (main dashboard)
- **GET /index.js** — Frontend JavaScript
- **GET /styles.css** — Stylesheet
- **GET /favicon.svg** — Site icon

### Proxy Server
- **GET /proxy?url=<target>** — CORS proxy for external APIs
  - Caches responses with TTL-based expiration
  - Rate limits per-host to avoid 429 errors
  - Supports stale-on-error fallback
  - **Security:** URL allowlist enforced (see allowlist below)

- **GET /health** — Health check endpoint (JSON)
  - Returns cache stats, uptime, active connections

- **GET /cache/stats** — Detailed cache inspection (JSON)
  - Cache entries, backoff status, memory usage

### OPTIONS (CORS Preflight)
- Responds with `204 No Content` and appropriate CORS headers

### Crime Reports API (FXBG PD)
- **GET /api/fxbg/crime-reports/incidents?months=6** — Retrieve crime incidents
  - Returns JSON with crime reports for the specified time period
  - Cached in `./data/fxbg-crime-reports/incidents.json`
  - Generates sample data if no real data exists (for testing)

- **GET /api/fxbg/crime-reports/refresh?months=6** — Trigger refresh of crime reports
  - Initiates PDF scraping or API fetch (placeholder implementation)
  - Real implementation would scrape FXBG PD crime report PDFs

---

## Crime Reports Feature

### Overview
The Crime Reports feature displays FXBG PD crime incidents as a **marker overlay** (NOT part of ArcGIS GIS overlays). It operates independently with its own toggle control in both desktop and mobile headers.

### User Interaction

**CRIME Button Controls:**
1. **Single click/tap** → Toggle overlay ON/OFF
2. **Right-click (desktop)** → Open Crime Reports menu panel WITHOUT toggling
3. **Long-press (mobile, 550ms)** → Open Crime Reports menu panel WITHOUT toggling
4. **Fallback behavior:** When toggling ON via single click, auto-open menu panel (controlled by `menuAutoOpen` setting, default: true)

**Active State Indicator:**
- When enabled, CRIME button shows subtle active state (pink glow, slightly lighter background)
- CSS class `.active` and `aria-pressed="true"` attribute applied
- Visual indicator without increasing header height

### Crime Reports Menu Panel

**Controls:**
- **Enable Overlay** — Toggle checkbox to show/hide crime markers
- **Time Window** — Dropdown: 7/30/90/180 days (filters which incidents appear on map)
- **Sort By** — Toggle buttons: Newest/Oldest (affects list ordering)
- **Auto-open menu on enable** — Checkbox to control automatic panel opening
- **Refresh PDFs** — Button to trigger backend refresh (calls `/api/fxbg/crime-reports/refresh`)

**Incidents List:**
- Shows top 50 incidents within selected time window
- Each item displays: emoji, offense type, date, location
- Click item → enables overlay (if disabled), zooms to marker, closes panel

### Implementation Details

**State Management:**
- State stored in `store.crime` object:
  ```js
  {
    enabled: boolean,      // Overlay ON/OFF
    windowDays: number,    // Time window filter (7/30/90/180)
    sort: string,          // "newest" or "oldest"
    menuAutoOpen: boolean, // Auto-open menu on enable
    ids: Set,              // Set of crime item IDs
    markersOnMap: Set      // Set of currently visible marker IDs
  }
  ```
- Persisted to localStorage key: `"fxbg.crimeUI"`
- Defaults: `{ enabled: true, windowDays: 30, sort: "newest", menuAutoOpen: true }`

**Marker Overlay Logic:**
- Crime incidents are stored as regular items in `store.itemsById` with category `"police_crime"`
- Item ID format: `"crime:<incident.id>"`
- Markers created via existing `attachMarker()` workflow
- Visibility controlled by `applyCrimeOverlayVisibility()`:
  - Checks `store.crime.enabled` flag
  - Filters by `windowDays` time window
  - Adds/removes markers from cluster layer dynamically

**Emoji Mapping:**
- Each crime type mapped to specific emoji for visual categorization
- Mapping in `CRIME_EMOJI_MAP` constant
- Normalization function `normalizeOffenseKey()` handles various offense descriptions
- Default fallback: 🚓 (police car)

**Data Flow:**
1. `pollFxbgCrimeReports()` fetches incidents from `/api/fxbg/crime-reports/incidents`
2. Each incident converted to store item with:
   - `category: "police_crime"` (appears in News Flash)
   - `sourceId: "fxbg-crime-reports"`
   - Title format: `"[CRIME REPORT] <offense> — <location>"`
   - Emoji assigned via `crimeEmojiFor(incident)`
3. Markers attached via `attachMarker(item)`
4. `applyCrimeOverlayVisibility()` manages cluster layer membership

**Polling:**
- Interval: 5 minutes (configurable in `CONFIG.fxbgCrimeReports.polling`)
- Integrated into `refreshAll()` via `Promise.allSettled`
- Fetches last 6 months of data by default (configurable in `CONFIG.fxbgCrimeReports.months`)

**Backend Data:**
- Incidents stored in: `./data/fxbg-crime-reports/incidents.json`
- Sample data auto-generated on first request (for testing without real PDF scraping)
- Geocode cache shared with other features: `./data/geocode-cache.json`

### File Changes Summary
- `proxy-server.js` — Added `/api/fxbg/crime-reports/*` routes + sample data generator
- `index.js` — Added Crime state, polling, overlay logic, panel functions, event listeners
- `index.html` — Added CRIME button to headers + Crime Reports panel markup
- `styles.css` — Added `.crime-btn.active` styles + `.crimePanel` and related styles

---

## Quick Manual Smoke Test Checklist

Run these checks after making changes:

### 1. Server Starts
```bash
node proxy-server.js
```
- ✅ Should print: `CITY MANAGER server running: http://localhost:8000`
- ✅ No error messages in console

### 2. Frontend Loads
Open `http://localhost:8000` in browser
- ✅ Map displays centered on Fredericksburg, VA
- ✅ No console errors (check DevTools F12)
- ✅ Top bar shows "CITY MANAGER" branding
- ✅ Live indicator shows "Live" with green dot

### 3. RSS Feeds Load
Wait 10-20 seconds after page load
- ✅ Footer legend shows categories (not all "0 items")
- ✅ Map markers appear (emoji waypoints)
- ✅ Click a filter button → markers filter correctly
- ✅ Console shows RSS fetch logs (check for "Non-JSON response" errors)

### 4. Virginia 511 Traffic Data
- ✅ Traffic chip in top bar shows I-95 status (not "Loading...")
- ✅ Traffic camera markers appear on map (📹 emoji)
- ✅ Click camera marker → panel shows camera image

### 5. ArcGIS Crash Data
- ✅ Crash markers appear on map (💥 emoji)
- ✅ Footer shows "traffic_crashes" category count
- ✅ Click crash marker → panel shows details

### 6. Weather Data
- ✅ Weather chip shows current conditions + temperature
- ✅ Weather chip shows 3-day forecast on hover
- ✅ Weather alerts appear on map if active (⚠️ emoji)

### 7. Proxy Endpoints Work
Test proxy directly:
```bash
# Test weather API
curl 'http://localhost:8000/proxy?url=https://api.weather.gov/alerts/active?area=VA'

# Test health endpoint
curl 'http://localhost:8000/health' | jq

# Test cache stats
curl 'http://localhost:8000/cache/stats' | jq .cache
```
- ✅ Proxy returns data (not 502 errors)
- ✅ Health shows cache stats and uptime
- ✅ Cache stats show bounded entry count

### 8. No Request Spam
Open DevTools → Network tab
- ✅ No rapid-fire duplicate requests to same endpoint
- ✅ RSS feeds polled every ~20 minutes (not every second)
- ✅ Traffic data polled every ~2 minutes
- ✅ Check for `X-Proxy-Cache-Fresh: 1` header on cached responses

### 9. Memory Stays Bounded
Leave server running for 30+ minutes:
```bash
# Check cache stats every 5 seconds
watch -n 5 'curl -s http://localhost:8000/cache/stats | jq .cache'
```
- ✅ Cache entries stay under maxEntries (default 500)
- ✅ Cache bytes stay under maxBytes (default 50MB)
- ✅ Cleanup logs appear in server console every ~60s

### 10. Error Recovery Works
Simulate upstream failures:
```bash
# Test stale-on-error fallback
curl -I 'http://localhost:8000/proxy?url=https://httpbin.org/status/500'
```
- ✅ Stale responses include `X-Proxy-Stale: 1` header
- ✅ Server logs show backoff escalation for failing hosts
- ✅ Frontend shows stale data indicator (if stale data served)

---

## Known API Endpoints Used

The proxy server accepts requests to these allowlisted domains:

### Weather
- `api.weather.gov` — National Weather Service alerts/forecasts
- `openuv.io` — UV index data

### Traffic & Incidents
- `511virginia.org` — Virginia 511 traffic cameras/incidents
- `511.vdot.virginia.gov` — VDOT traffic data
- `virginiaroads.org` — Road conditions
- `iteriscdn.com` — Iteris CDN (fallback for 511 traffic data)
- `files4.iteriscdn.com` — Camera snapshots fallback
- `files5.iteriscdn.com` — Incidents data fallback
- `staffordschools.net` / `www.staffordschools.net` — Stafford Schools calendar pages

### Crash Data
- `data.virginia.gov` — Virginia Socrata open data portal
- `services1.arcgis.com` — ArcGIS FeatureServer (crash data)
- `gis.virginiadot.org` — VDOT GIS services

### RSS Feeds
- `fredericksburgva.gov` — City of Fredericksburg RSS feeds
- `spotsylvania.va.us` — Spotsylvania County RSS feeds
- `co.caroline.va.us` — Caroline County RSS feeds
- `warrentonva.gov` — Town of Warrenton RSS feeds
- `potomaclocal.com` — Local news
- `fredericksburgfreepress.com` — Local news

### Health Data
- `data.cdc.gov` — CDC health surveillance data (optional, requires `CDC_APP_TOKEN`)

### Geocoding
- `nominatim.openstreetmap.org` — Reverse geocoding for addresses

### Utilities
- `httpbin.org` — Testing/debugging (dev only)

**Security Note:** The proxy server enforces an allowlist and blocks:
- Private IP ranges (localhost, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
- Non-HTTP(S) protocols (file://, ftp://, etc.)
- Unknown domains not in the allowlist above

Allowlist matching normalizes hosts to lowercase and strips a leading `www.` before comparison.
Blocked requests log host + original URL and include a hint: `Add <host> to ALLOWLIST if approved.`

### New API endpoints
- `GET /api/va511/icons-metadata` — server-side fetch for VA511 incident icons geojsonp (JSONP decoded to JSON, cached in memory + `data/cache/va511-icons-metadata.json`)
- `GET /api/cdc/wonder` — CDC fetch proxy (disabled unless `CDC_APP_TOKEN` set; uses 30-minute backoff on 403/429 and serves cached data when available)
- `GET /api/places` — address-first places dataset for schools/campuses/hospitals (`data/places.json`)

---

## Environment Variables

### Cache Limits
```bash
CACHE_MAX_ENTRIES=500         # Max cached items (default 500)
CACHE_MAX_BYTES=52428800      # Max cache memory bytes (default 50MB)
```

### Cache TTLs (milliseconds)
```bash
CACHE_TTL_WEATHER=60000       # Weather API cache (default 1 min)
CACHE_TTL_TRAFFIC=90000       # Traffic data cache (default 1.5 min)
CACHE_TTL_RSS=1200000         # RSS feed cache (default 20 min)
CACHE_TTL_CAMERAS=120000      # Camera images (default 2 min)
CACHE_TTL_UV=1800000          # UV data (default 30 min)
CACHE_TTL_HEALTH=21600000     # CDC health data (default 6 hours)
CACHE_TTL_GEOCODE=604800000   # Geocoding (default 7 days)
CACHE_TTL_DEFAULT=60000       # Default fallback (1 min)
```

### Server Port
```bash
PORT=8000                     # HTTP server port (default 8000)
```

---

## Common Issues

### "Markers not loading"
1. Check proxy server is running (`node proxy-server.js`)
2. Check browser console for CORS errors
3. Check `/health` endpoint shows cache is working
4. Verify internet connection (proxy needs network access)

### "Non-JSON response" errors
- Some RSS feeds may return HTML error pages instead of XML
- Proxy automatically serves stale cache when this happens
- Check console for "Using stale cache" messages
- Check response headers for `X-Proxy-Stale: 1`

### "403 Forbidden" from RSS feeds
- Some `.gov` sites block automated requests
- Proxy uses realistic User-Agent and Referer headers
- Stale cache served automatically on 403 errors
- Check proxy logs for `x-deny-reason: host_not_allowed`

### Memory growth over time
- Cache should auto-evict old entries every 60 seconds
- Check `/cache/stats` for `entries` and `bytes` counts
- If unbounded growth, check logs for eviction messages
- Adjust `CACHE_MAX_ENTRIES` or `CACHE_MAX_BYTES` if needed

### Rapid duplicate requests
- Client-side fetch cache prevents re-render storms
- Check Network tab for `X-Proxy-Cache-Fresh` headers
- Should see mostly cached responses, not fresh upstream hits

---

## Development Workflow

### Making Changes
1. Edit files (`proxy-server.js`, `index.js`, `styles.css`)
2. Restart proxy server (`Ctrl+C` then `node proxy-server.js`)
3. Hard refresh browser (`Ctrl+Shift+R` or `Cmd+Shift+R`)
4. Run manual smoke tests above
5. Check console for errors
6. Monitor `/health` and `/cache/stats` endpoints

### Adding a New Data Source
1. Add endpoint domain to allowlist in `proxy-server.js` (if needed)
2. Add fetch logic in `index.js` (follow RSS/ArcGIS patterns)
3. Add category to `CATEGORIES` object
4. Add emoji and color to legend
5. Test with `curl` first before frontend integration

### Debugging Proxy Issues
```bash
# Watch server logs
node proxy-server.js

# Test specific endpoint
curl -v 'http://localhost:8000/proxy?url=https://api.weather.gov/alerts/active?area=VA'

# Check QQMS headers
curl -I 'http://localhost:8000/proxy?url=<target>' | grep QQMS

# Monitor cache stats
watch -n 5 'curl -s http://localhost:8000/cache/stats | jq'
```

---

## Performance Notes

- **Max markers on map:** 650 items (hard cap via `enforceCaps`)
- **Max per source:** 180 items (prevents floods from single source)
- **Polling intervals:** RSS 20min, Traffic 2min, Weather 2min
- **Cache cleanup:** Every 60 seconds (expired entries removed)
- **Concurrent upstream fetches:** Max 3 simultaneous
- **Per-host rate limiting:** Min 600ms between requests to same host
- **Backoff on errors:** Exponential (600ms → 1.2s → 2.4s → 4.8s → 10s max)

---

## File Structure

```
.
├── index.html              # Main HTML structure
├── index.js                # Frontend logic (map, data fetching, UI)
├── styles.css              # Styling
├── proxy-server.js         # Node.js CORS proxy with caching
├── favicon.svg             # Site icon
├── README.md               # User-facing documentation
├── DEV_NOTES.md           # This file (developer guide)
├── RELIABILITY_IMPROVEMENTS.md  # Recent reliability enhancements
└── TROUBLESHOOTING.md     # Troubleshooting guide (if exists)
```

---

## Testing Strategy

### Unit Testing (Manual)
- Test individual endpoints with `curl`
- Verify cache headers and TTLs
- Check stale-on-error behavior
- Monitor backoff escalation

### Integration Testing (Manual)
- Load frontend and verify all data sources
- Test category filters
- Test marker clicks and panel display
- Test refresh button
- Test News Flash and Radio panels

### Load Testing (Manual)
- Leave server running 30+ minutes
- Monitor memory usage via `/cache/stats`
- Check for request spam in Network tab
- Verify cache eviction logs appear

### Regression Testing
- After changes, run full smoke test checklist
- Compare `/cache/stats` before/after
- Check for new console errors
- Verify no duplicate markers

---

**Last Updated:** 2026-01-03
**Maintained by:** FXBG-PALANTIR Team

## FXBG Precision Places Pack (Downtown + Central Park)

- Dataset file: `data/places-downtown-centralpark.json`
- API endpoint: `GET /api/places/downtown-centralpark` (returns `{ ok: true, data }`)
- Resolver behavior: precision pack is checked first (name, alias, intersection text, address) before Module 5 fallback logic.

### How to extend

1. Open browser console and run:
   `FXBGGeocode.addPlaceAnchor({ name, lat, lng, aliases, tags, type, address })`
2. Copy the printed JSON snippet.
3. Paste into `data/places-downtown-centralpark.json` under `items`.
4. Prefer verified coordinates only. If unknown, set `lat/lng` to `null` and include a `todo` note.
5. Reload app to refresh client cache, or wait up to 60s for server cache expiry.

---

## Module 1: VA511 Status Indicators (server-side endpoints)

### New Server Endpoints

| Endpoint | Description | Cache TTL | Stale Fallback |
|---|---|---|---|
| `GET /api/va511/events` | VA511 traffic events (raw JSON from VDOT) | 3 min | 1 hour |
| `GET /api/va511/cams` | VA511 camera feeds (raw JSON from VDOT) | 5 min | 1 hour |
| `GET /api/va511/status` | Computed status summary (counts, I-95 corridor, categories) | Reuses events cache | — |
| `GET /api/va511/icons-metadata` | Icons metadata (unchanged, no longer treated as incidents) | 5 min | disk fallback |

### Test Commands

```bash
# Start server
node proxy-server.js

# Test endpoints
curl -s http://localhost:8000/api/va511/events | python3 -m json.tool | head -20
curl -s http://localhost:8000/api/va511/cams | python3 -m json.tool | head -20
curl -s http://localhost:8000/api/va511/status | python3 -m json.tool
curl -s http://localhost:8000/api/va511/icons-metadata | python3 -m json.tool | head -10
```

### Browser Verification

1. Open browser DevTools console
2. Confirm **no** console error about icons-metadata being "invalid GeoJSON"
3. Confirm traffic indicator chip shows one of: `NORMAL`, `SLOWING (n)`, `HEAVY (n)`, `DEGRADED (cached)`, or `Traffic status unavailable`
4. Verify incidents load from `server-events` endpoint first (check console log for `"511 incidents loaded successfully from server-events"`)

### Key Changes

- **Bug fix**: Removed `/api/va511/icons-metadata` from `incidentsEndpoints` — it is NOT a GeoJSON FeatureCollection of incidents
- **New primary**: `/api/va511/events` is now the preferred incidents source (server-side cached with proper anti-bot headers)
- **Fallback preserved**: `511virginia.org` GeoJSON endpoint remains as fallback
- **Status polling**: `pollVa511()` now fetches `/api/va511/status` for the I-95 indicator chip with "updated X min ago" label
- **Icons metadata**: Loaded separately into `store.va511IconMeta` (not mixed with incidents)

---

## Module 4: RSS Reliability Notes (Feeds + Geocoding)

### Known Blocked/Degraded Feeds (Mitigations)

- **fredericksburgva.gov / spotsylvania.va.us / staffordcountyva.gov / staffordschools.net**
  - **Symptom:** 403 or empty responses when RSS requests lack browser-like headers.
  - **Mitigation:** Proxy applies an RSS header shim (User-Agent, Accept, Accept-Language, Referer/Origin) when the URL looks like RSS/XML.
  - **Fallback behavior:** If still blocked, stale cache is served when available and diagnostics mark the feed degraded.

### Caching Notes

- Client now sends `X-Cache-TTL-MS` to align with proxy TTL parsing.
- Proxy continues to honor TTL caps and serves cached data when upstreams fail.
