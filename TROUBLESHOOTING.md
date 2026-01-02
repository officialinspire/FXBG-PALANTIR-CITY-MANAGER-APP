# Troubleshooting Proxy Endpoint Errors

This document describes known issues with external data sources and how to address them.

## Known Issues (as of January 2026)

### 1. Virginia Crash Data - HTTP 404 Errors

**Issue:** The data.virginia.gov Socrata API endpoint returns 404 Not Found errors.

```
[proxy] https://data.virginia.gov/resource/e9fd3f45-7f33-424b-b472-b531043fa02a.json?$limit=200&$order=:id%20DESC returned HTTP 404
```

**Root Cause:** The dataset ID `e9fd3f45-7f33-424b-b472-b531043fa02a` appears to have been removed or changed on the Virginia Open Data Portal.

**Status:** Currently DISABLED in `index.js` (CONFIG.virginiaCrashData.enabled = false)

**Alternative Solutions:**
1. **Virginia Roads API** - Explore these alternatives:
   - CrashData Details: https://www.virginiaroads.org/datasets/crashdata-details-2/api
   - CrashData Basic: https://www.virginiaroads.org/datasets/crashdata-basic-1/api
   - Search the portal: https://data.virginia.gov/dataset/crash-data

2. **ArcGIS FeatureServer** - The existing `CONFIG.arcgisCrash` endpoint may still work

3. **Request new API token** - The Socrata API may require authentication:
   - Get an App Token from https://data.virginia.gov
   - Add to `CONFIG.virginiaCrashData.apiKey`

**Fix Required:** Update `CONFIG.virginiaCrashData.crashDataDetailsUrl` with the correct endpoint and re-enable.

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

### 3. 511 Virginia & Iteris - HTML Instead of GeoJSON

**Issue:** Traffic incident endpoints return HTML error pages instead of expected GeoJSON data.

```
[proxy] WARNING: https://www.511virginia.org/data/geojson/icons.incident.geojson returned HTML when structured data expected
[proxy] WARNING: http://files5.iteriscdn.com/WebApps/VA/SafeTravel/data/local/icons/metadata/icons.incident.geojsonp returned HTML when structured data expected
```

**Root Cause:** The endpoints may be:
- Temporarily down for maintenance
- Moved to new URLs
- Requiring authentication or API keys
- Experiencing server errors (returning generic error pages)

**Affected Endpoints:**
- Primary: https://www.511virginia.org/data/geojson/icons.incident.geojson
- Fallback: http://files5.iteriscdn.com/WebApps/VA/SafeTravel/data/local/icons/metadata/icons.incident.geojsonp

**Current Mitigation:** The proxy detects HTML responses and falls back to stale cached GeoJSON data when available.

**Potential Solutions:**
1. **Check Official API** - Visit https://www.511virginia.org to see if there's updated API documentation
2. **VDOT Contact** - Reach out to VDOT for official API access
3. **Alternative Format** - The primary 511.vdot.virginia.gov cameras endpoint may still work
4. **Browser Inspection** - Use browser dev tools on 511virginia.org to find the actual API endpoints the web app uses
5. **Wait for Service Restoration** - The endpoints may come back online automatically

**Monitoring:** Watch for console messages:
- `Using stale cache instead of HTML error page` - Proxy is using cached data
- `511 cameras endpoint may be down or blocking requests` - Primary endpoint failure

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
