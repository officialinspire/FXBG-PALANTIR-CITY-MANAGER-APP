# CITY MANAGER — FXBG-PALANTIR (v12)

Real-time situational awareness dashboard for Fredericksburg, VA metro area.

## 🚀 Quick Start

**CRITICAL: The proxy server MUST be running for markers/waypoints to load!**

### 1. Start the Server
```bash
node proxy-server.js
```

### 2. Open in Browser
```
http://localhost:8000
```

The proxy server handles all external API requests (RSS feeds, 511 Virginia traffic, NWS weather, ArcGIS crash data) to bypass CORS restrictions.

## 🔧 Recent Fixes (v12)

### Fixed Issues
- ✅ **Markers/Waypoints now load correctly** - Fixed data ingestion and display
- ✅ **511 API errors resolved** - Improved error handling with better logging
- ✅ **Footer buttons show data** - RSS feeds and API info now display properly
- ✅ **Better error messages** - Console warnings are now more helpful
- ✅ **Fallback sample data** - Demo markers appear when APIs are unavailable (for testing)

### What Was Wrong
1. **Proxy server wasn't running** - External API calls failed due to CORS
2. **Poor error handling** - Errors weren't caught properly, blocking marker display
3. **No fallback data** - When APIs failed, nothing was shown

### What's Fixed
1. **Enhanced `fetchWithProxies` function** - Better error detection and reporting
2. **Sample/mock data** - Demonstration markers load when APIs are unreachable
3. **Improved error logging** - Clearer messages with actionable guidance
4. **Proxy detection** - Console warns if proxy server isn't detected

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

**Version**: 12
**Last Updated**: 2026-01-02
**Author**: FXBG-PALANTIR Team
