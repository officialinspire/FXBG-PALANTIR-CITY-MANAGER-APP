# Troubleshooting Proxy Endpoint Errors

This document describes known issues with external data sources and how to address them.

## Known Issues (as of January 2026)

### 0. Missing API Keys (Optional Features Only)

**Issue:** Some external data features (UV/AQI) are unavailable.

**Root Cause:** `.env` file or environment variables are missing optional API keys.

**Important behavior:**
- Missing `OPENUV_API_KEY` and/or `WAQI_TOKEN` should **not** prevent server startup.
- Missing `LOG_DIR` should **not** prevent startup; server defaults to `logs` and can fall back to OS temp logs if needed.

**Fix (recommended - persistent across repo downloads):**
1. Create a global env file once:
   ```
   npm run install-env
   ```
2. Edit `~/.config/fxbg-palantir/.env` and add:
   ```
   OPENUV_API_KEY=your-openuv-key
   WAQI_TOKEN=your-waqi-token
   ```
3. Run `./scripts/up.sh` (it will copy your global env into the repo if `.env` is missing).

**Fix (repo-local):**
1. Create a `.env` file in the repo root (see `.env.example`)
2. Add the API keys shown above.

**Why this works:** The repo `.env` is gitignored (to keep secrets out of Git), while the global env file persists across repo downloads.

**Note:** For local diagnostics-only sessions, you can bypass validation by setting `SKIP_CONFIG_VALIDATION=1` (not recommended for production).

### 1. Virginia Crash Data - HTTP 404 Errors

**Issue:** The data.virginia.gov Socrata API endpoint returns 404 Not Found errors.

```
[proxy] https://data.virginia.gov/resource/e9fd3f45-7f33-424b-b472-b531043fa02a.json?$limit=200&$order=:id%20DESC returned HTTP 404
```

**Root Cause:** The dataset ID `e9fd3f45-7f33-424b-b472-b531043fa02a` has been removed or changed on the Virginia Open Data Portal.

**Status:** ✅ RESOLVED - Disabled in `index.js` (CONFIG.virginiaCrashData.enabled = false) as of January 2026

**Current Solution:** The app now relies on `CONFIG.arcgisCrash` which provides the same crash data from the ArcGIS FeatureServer:
- Endpoint: `https://services.arcgis.com/p5v98VHDX9Atv3l7/arcgis/rest/services/CrashData_test/FeatureServer/0/query`
- Status: ✅ Working
- Data: Same Virginia crash data, updated regularly

**Future Alternatives (if ArcGIS endpoint fails):**
1. **Virginia Roads API**:
   - CrashData Details: https://www.virginiaroads.org/datasets/crashdata-details-2/api
   - CrashData Basic: https://www.virginiaroads.org/datasets/crashdata-basic-1/api
   - Search the portal: https://data.virginia.gov/dataset/crash-data

2. **Socrata API** - Find new dataset ID:
   - Search portal: https://data.virginia.gov
   - Get an App Token if required: https://data.virginia.gov
   - Update `CONFIG.virginiaCrashData.crashDataDetailsUrl` with new endpoint

---

### 2. RSS Feeds - Empty Responses (0 bytes)

**Issue:** Fredericksburg and Spotsylvania government RSS feeds return empty responses.

```
[proxy] WARNING: https://www.fredericksburgva.gov/RSSFeed.aspx?CID=Emergency-Alerts-3 returned empty response (0 bytes)
[proxy] WARNING: https://www.spotsylvania.va.us/RSSFeed.aspx?CID=Notices-8 returned empty response (0 bytes)
```

**Root Cause:** These endpoints are blocking automated requests with `403 Forbidden` and header `x-deny-reason: host_not_allowed`. This is an anti-scraping security measure.

**Affected Feeds:**
- **Fredericksburg:**
  - Emergency Alerts
  - Police Alerts
  - Transit Alerts (FRED)
  - News Flash
  - Special Events

- **Spotsylvania:**
  - Emergency Alerts
  - Notices
  - SpotsyAlert
  - County Press Releases
  - Fire Rescue & Emergency Management
  - Parks & Recreation

**Current Mitigation:** The proxy server caches successful responses and serves stale data when fresh fetches fail.

**Potential Solutions:**
1. **Whitelist IP Address** - Contact city/county IT departments to whitelist your server's IP for API access
2. **Official API Access** - Request official API credentials or access tokens
3. **Browser Automation** - Use a headless browser (Puppeteer/Playwright) instead of direct HTTP requests
4. **Alternative Sources** - Find alternative data sources (social media feeds, emergency alert systems)
5. **Manual RSS Reader** - Use a traditional RSS reader service as an intermediary

**Workaround:** The proxy's stale cache fallback will continue serving the last successful response until the cache expires.

---

### 3. 511 Virginia & Iteris - Host Blocking (403 Forbidden)

**Issue:** Traffic incident endpoints may return 403 Forbidden with host blocking headers in some environments (cloud/Docker IPs).

```
HTTP/1.1 403 Forbidden
x-deny-reason: host_not_allowed
[proxy] WARNING: https://www.511virginia.org/data/geojson/icons.incident.geojson returned HTML when structured data expected
[proxy] WARNING: http://files5.iteriscdn.com/WebApps/VA/SafeTravel/data/local/icons/metadata/icons.incident.geojsonp returned HTML when structured data expected
```

**Root Cause:** VDOT has implemented host-based access control (`x-deny-reason: host_not_allowed`) on their 511 GeoJSON endpoints to prevent automated scraping from cloud/bot IP ranges. This typically **only affects cloud environments** - the endpoints work fine from normal browsers and residential/business servers.

**Affected Endpoints:**
- Primary: https://www.511virginia.org/data/geojson/icons.incident.geojson
- Fallback: http://files5.iteriscdn.com/WebApps/VA/SafeTravel/data/local/icons/metadata/icons.incident.geojsonp
- Cameras: https://511.vdot.virginia.gov/services/map/layers/map/cams
- Alternative Cameras: http://www.511virginia.org/data/icons.cameras.geojson
- Construction: https://www.511virginia.org/data/geojson/icons.construction.geojson

**Status:** ✅ RE-ENABLED with fallback support (January 2026) - **ENHANCED with multiple fallback endpoints**

**Current Solution:**
- ✅ Feature is **re-enabled** in `index.js` (CONFIG.va511.enabled = true)
- ✅ **NEW: Multiple API endpoint fallbacks configured** - cameras now try 3 different endpoints:
  - Primary: `https://511.vdot.virginia.gov/services/map/layers/map/cams`
  - Fallback 1: `http://www.511virginia.org/data/icons.cameras.geojson`
  - Fallback 2: `http://files4.iteriscdn.com/WebApps/VA/SafeTravel/data/local/icons/metadata/icons.cameras_inactive.geojsonp` (Iteris CDN)
- ✅ **NEW: Iteris CDN domains added to proxy allowlist** (`iteriscdn.com`, `files4.iteriscdn.com`, `files5.iteriscdn.com`)
- ✅ **Manual camera data** provided for Fredericksburg/I-95 area (8 cameras) as final fallback
- ✅ Manual cameras automatically load when all API endpoints are blocked
- ✅ Proxy server's stale cache serves last successful data when endpoints are temporarily unavailable
- 📷 **Traffic cameras will populate** from any working endpoint or manual data if all APIs fail

**Manual Camera Coverage (I-95 Fredericksburg Area):**
- I-95 SB at MM 122 (Fredericksburg)
- I-95 SB at MM 130.8 (Fredericksburg North)
- I-95 NB at MM 131.5 (Fredericksburg North)
- I-95 SB at MM 132 (Fredericksburg North)
- I-95 NB at MM 126 (Fredericksburg Central)
- I-95 SB at MM 118 (Thornburg)
- I-95 NB at MM 140 (Stafford)
- I-95 SB at MM 143 (Stafford North)

**Potential Solutions:**
1. **Official API Access** - Contact VDOT to request:
   - API key/token for authenticated access
   - IP whitelist approval for your server
   - Developer program enrollment (if available)

2. **Alternative Data Sources:**
   - Check Open Virginia portal: http://data.openva.com/dataset/vdot-511-geodata
   - Virginia Roads portal: https://www.virginiaroads.org
   - VDOT Data & APIs: https://www.virginiadot.org/info/developer.asp

3. **Browser-Based Access** - Use headless browser (Puppeteer/Playwright) to access data as a browser would (may violate ToS)

**Contact Information:**
- VDOT 511 Support: Call 511 or visit https://www.511virginia.org
- VDOT Developer Resources: https://www.virginiadot.org/info/developer.asp

---

### 4. Stafford Schools - HTML Pages (Expected)

**Issue:** These are HTML pages, not RSS feeds.

```
[proxy] WARNING: https://www.staffordschools.net/about-us/calendar returned HTML when structured data expected
```

**Root Cause:** These URLs point to HTML pages. The app is configured with `type: "html_discover"` to extract RSS feed URLs from the page HTML.

**Status:** This is expected behavior. The `fetchRSS()` function includes HTML feed discovery logic to find `<link rel="alternate" type="application/rss+xml">` tags.

**Action Required:** None. This is working as designed.

---

## General Proxy Troubleshooting

### Verify Proxy Server is Running

```bash
# Check if proxy is running
ps aux | grep proxy-server

# Start the proxy server
node proxy-server.js

# Test the proxy endpoint
curl "http://localhost:8000/proxy?url=https://api.weather.gov/alerts/active.atom?area=VA"
```

### Check Network Connectivity

```bash
# Test direct access to endpoints
curl -I https://www.511virginia.org/data/geojson/icons.incident.geojson
curl -I https://www.fredericksburgva.gov/RSSFeed.aspx?CID=Emergency-Alerts-3
curl -I https://data.virginia.gov/resource/e9fd3f45-7f33-424b-b472-b531043fa02a.json
```

### Monitor Proxy Logs

The proxy server logs detailed information about each request:
- `[proxy] WARNING:` - Non-fatal issues (empty responses, HTML instead of JSON)
- `[proxy] Failed to fetch` - Network or fetch errors
- `[proxy] Using stale cache` - Falling back to cached data
- `[proxy] returned HTTP 404` - Resource not found errors

### Clear Proxy Cache

The proxy caches responses in memory. Restart the proxy server to clear the cache:

```bash
# Kill the proxy server
pkill -f proxy-server

# Restart it
node proxy-server.js
```

---

## Configuration Changes

### Disable Problematic Sources

Edit `index.js` and set `enabled: false` for failing sources:

```javascript
virginiaCrashData: {
  enabled: false,  // Disable until endpoint is fixed
  // ...
},
```

### Adjust Cache TTL

Increase cache duration for unreliable endpoints in `proxy-server.js`:

```javascript
// Line ~69-72
if (h.includes("fredericksburgva.gov") || h.includes("spotsylvania.va.us")) {
  return 3600 * 1000; // Cache for 1 hour instead of 6 minutes
}
```

### Remove Failing RSS Feeds

Comment out or remove failing feeds from `CONFIG.rss` array in `index.js`:

```javascript
// {
//   id: "fxbg-emergency-alerts",
//   name: "Fredericksburg — Emergency Alerts",
//   url: "https://www.fredericksburgva.gov/RSSFeed.aspx?CID=Emergency-Alerts-3",
//   // ...
// },
```

---

## Reporting New Issues

When encountering new proxy errors:

1. **Check console logs** - Look for `[proxy]` prefixed messages
2. **Test endpoint directly** - Use curl to verify the issue isn't with the proxy
3. **Check upstream service** - Visit the website to see if it's operational
4. **Document the error** - Include:
   - Full URL that's failing
   - HTTP status code
   - Error message
   - Expected vs. actual response format
5. **Update this document** - Add the issue and any solutions found

---

## References

- Virginia Open Data Portal: https://data.virginia.gov
- 511 Virginia Traffic: https://www.511virginia.org
- Virginia Roads Portal: https://www.virginiaroads.org
- VDOT Data & APIs: https://www.virginiadot.org/info/developer.asp
- Fredericksburg City: https://www.fredericksburgva.gov
- Spotsylvania County: https://www.spotsylvania.va.us


## Android / Termux (mobile)

If you run locally on Android (Termux):

```bash
pkg install nodejs
npm install
./scripts/up.sh
```

`up.sh` now auto-detects Android/Termux, supports Android-safe global env locations, and prints the local URL to open from the same device browser.

## Mobile / Termux Quick Start

1. Move the repo into `$HOME` (no spaces in the path).
2. `npm run termux:setup`
3. `npm run termux`

## GitHub PR blocked: "Binary Files are Not Allowed"

If GitHub rulesets reject the PR, check staged files and remove binary assets from the commit.

```bash
git diff --name-only --cached
```

In this repo, use `favicon.svg`; avoid committing `favicon.ico`.
