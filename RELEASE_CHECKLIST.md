# RELEASE CHECKLIST

**Pre-Release Testing Protocol for FXBG City Manager**

Use this checklist before deploying any changes to production or after significant updates to ensure system stability and reliability.

---

## 1. Server Startup

- [ ] Run the proxy server: `node proxy-server.js`
- [ ] Verify server starts without errors
- [ ] Confirm port binding (default: `http://localhost:8000`)
- [ ] Check console for startup messages (no crashes, no missing dependencies)

---

## 2. Initial Page Load

- [ ] Open `http://localhost:8000` in browser
- [ ] Page loads without JavaScript errors (check browser console)
- [ ] Map tiles render correctly
- [ ] UI components visible (header, footer, panels, controls)
- [ ] No 404 errors for static assets (CSS, JS, images)

---

## 3. Health & Observability Endpoints

- [ ] **Health check**: Visit `/health` endpoint
  - Returns JSON with `status: "ok"`
  - Shows uptime, cache stats, active fetches
  - No errors in response

- [ ] **Cache stats**: Visit `/cache/stats` endpoint
  - Returns cache entries and sizes
  - No entries with absurdly old TTLs
  - hostBackoff map size reasonable (< 100 entries)

- [ ] **Memory debug** (dev only): Visit `/debug/memory`
  - Returns process memory usage
  - Heap usage reasonable (< 200 MB for typical load)
  - Map sizes bounded (geocodeCache, sourceBackoff, clientCache)

---

## 4. Data Source Validation

### 4.1 RSS Feeds
- [ ] At least 1 RSS feed populates successfully
- [ ] Check console for RSS feed ingestion messages
- [ ] Verify feed items appear on map (check for markers)
- [ ] Footer panel shows RSS items (click category buttons)
- [ ] No 403 Forbidden errors stuck forever (stale cache should be used)

### 4.2 511 Virginia Traffic Data
- [ ] 511 incidents load without crashing
- [ ] Check console for "511 Virginia" success messages
- [ ] Verify incidents appear on map (traffic/crash markers)
- [ ] I-95 traffic indicator updates ("NORMAL", "SLOWING", "HEAVY")

### 4.3 ArcGIS Crash Data
- [ ] ArcGIS crash data loads without errors
- [ ] Check console for "ArcGIS" or "Virginia Crash Data" messages
- [ ] Verify crash markers appear on map
- [ ] No JSON parse errors or HTML-instead-of-data errors

---

## 5. Error Handling & Resilience

### 5.1 Non-JSON Response Handling
- [ ] If any source returns HTML error page, proxy serves stale cache instead
- [ ] Console shows "Using stale cache" warnings (not crashes)
- [ ] No uncaught exceptions from JSON.parse failures

### 5.2 Network Interruption
- [ ] **Test**: Disconnect network (turn off WiFi / unplug ethernet)
- [ ] App continues to function (shows stale data)
- [ ] Health indicator shows "DEGRADED" or "PARTIAL" status
- [ ] No JavaScript crashes or infinite error loops
- [ ] **Restore network**: App recovers and fetches fresh data

### 5.3 Rate Limiting / 429 Errors
- [ ] If source returns 429, proxy serves stale cache
- [ ] Adaptive backoff kicks in (check console for backoff messages)
- [ ] Source is not hammered repeatedly (check request spacing)

---

## 6. Memory Stability (30-Minute Test)

- [ ] Leave app running for 30 minutes with page open
- [ ] Check `/debug/memory` endpoint before and after
- [ ] Heap usage stable or grows slowly (no runaway memory leak)
- [ ] Map sizes remain bounded:
  - `geocodeCache` < 500 entries
  - `sourceBackoff` < 100 entries
  - `clientCache` < 100 entries
  - `healthTracker.recentErrors` < 50 entries
- [ ] Console shows periodic pruning messages (`[Prune] Map sizes: ...`)

---

## 7. Refresh & Polling Behavior

- [ ] Click "Refresh" button manually
- [ ] All data sources refresh without crashes
- [ ] Budget limits respected (check console for `[Budget]` warnings)
- [ ] Degraded mode activates if 3+ sources fail (check console for `[DegradedMode]`)
- [ ] Auto-polling works (sources refresh at configured intervals)

---

## 8. UI Interactions

- [ ] Map pan/zoom works smoothly
- [ ] Click markers to open popups (no errors)
- [ ] Category filter buttons work (footer panel)
- [ ] Panels are draggable and moveable
- [ ] Close buttons work for all panels
- [ ] Search box filters items correctly (if implemented)

---

## 9. Console Log Health

- [ ] No uncaught exceptions
- [ ] No infinite error loops
- [ ] Warnings are actionable (not spam)
- [ ] Backoff/budget/degraded mode messages appear when expected
- [ ] Pruning messages appear every 10 minutes

---

## 10. Adaptive Backoff Verification

- [ ] Check console for `[Backoff]` messages when sources fail
- [ ] Verify exponential backoff (2m → 5m → 10m → 20m)
- [ ] Verify backoff resets on success
- [ ] sourceBackoff map stays bounded (< 100 entries)

---

## 11. Degraded Mode Verification

- [ ] **Test**: Simulate 3+ source failures (e.g., block network for specific domains)
- [ ] Console shows `[DegradedMode]` warning
- [ ] Expensive operations skipped (clustering, list render)
- [ ] UI remains responsive (no freezing)
- [ ] App recovers when sources return to normal

---

## 12. Stale Data Handling

- [ ] When proxy returns stale data, health chip shows "PARTIAL" or "DEGRADED"
- [ ] Stale age visible in UI (future enhancement - check console for now)
- [ ] No crashes when stale data is used
- [ ] Fresh data replaces stale when available

---

## 13. Near-Duplicate Suppression

- [ ] Check console for duplicate crash items being suppressed
- [ ] Map doesn't fill with duplicate markers in same location
- [ ] Footer lists don't show obvious duplicates (same location + title)

---

## 14. Configuration Validation

- [ ] `CONFIG.reliability.simulateFailure.enabled` is **FALSE** (production safety)
- [ ] All critical sources enabled in CONFIG
- [ ] Polling intervals reasonable (not too aggressive)
- [ ] Budget limits set appropriately (maxRequestsPerCycle, maxTimePerCycleMs)

---

## 15. Browser Compatibility (Optional)

- [ ] Test in Chrome/Edge (primary)
- [ ] Test in Firefox (secondary)
- [ ] Test in Safari (if available)
- [ ] Mobile responsive (test on mobile device or responsive mode)

---

## 16. Production Deployment

- [ ] All checklist items above passed
- [ ] No critical errors in console
- [ ] Memory stable after 30+ minutes
- [ ] Data sources populate successfully
- [ ] Health endpoints return valid responses
- [ ] Proxy server logs clean (no crashes, reasonable warnings)

---

## Emergency Rollback Criteria

If any of the following occur, **ROLLBACK IMMEDIATELY**:

- Uncaught exceptions causing app crashes
- Infinite error loops flooding console
- Memory leak (heap grows > 500 MB after 30 minutes)
- Data sources permanently broken (no stale cache fallback)
- Proxy server crashes or becomes unresponsive
- Critical functionality broken (map doesn't load, no markers appear)

---

## Post-Deployment Monitoring

After deployment, monitor for:

- [ ] Server uptime (should stay up 24+ hours)
- [ ] Memory usage trends (check `/debug/memory` periodically)
- [ ] Error rates (check console/logs for error frequency)
- [ ] Data freshness (verify sources update at expected intervals)
- [ ] User reports of issues (if applicable)

---

## Notes

- This checklist assumes running in development/staging environment first
- Always test major changes in non-production before deploying
- Keep a recent backup or git tag for quick rollback
- Document any deviations or known issues in DEV_NOTES.md

---

**Last Updated**: Round 3 Reliability Hardening (2025)
