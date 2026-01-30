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
