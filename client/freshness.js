(function (global) {
  const SOURCE_THRESHOLDS_MS = {
    default: 6 * 60 * 60 * 1000,
    crime: 24 * 60 * 60 * 1000,
    reports: 12 * 60 * 60 * 1000,
    va511: 6 * 60 * 60 * 1000,
    openuv: 6 * 60 * 60 * 1000,
    waqi: 6 * 60 * 60 * 1000
  };

  function nowMs() {
    return Date.now();
  }

  function normalizeError(err) {
    if (!err) return null;
    const s = String(err).trim();
    return s.length > 140 ? `${s.slice(0, 137)}...` : s;
  }

  function createFreshnessTracker(opts = {}) {
    const statuses = new Map();
    let hubReachable = true;

    function ensure(key) {
      if (!statuses.has(key)) {
        statuses.set(key, {
          key,
          lastSuccessTs: null,
          lastAttemptTs: null,
          failCount: 0,
          state: 'DEGRADED',
          lastError: null,
          usingCached: false
        });
      }
      return statuses.get(key);
    }

    function computeState(status) {
      if (!hubReachable) return 'OFFLINE';
      if (status.failCount >= 3 || status.lastError) return 'DEGRADED';
      if (status.usingCached && status.lastSuccessTs) return 'CACHED';
      if (!status.lastSuccessTs) return 'DEGRADED';
      const ageMs = nowMs() - status.lastSuccessTs;
      if (ageMs < 10 * 60 * 1000) return 'LIVE';
      const thresholdMs = (opts.thresholds && opts.thresholds[status.key]) || SOURCE_THRESHOLDS_MS[status.key] || SOURCE_THRESHOLDS_MS.default;
      if (ageMs > thresholdMs) return 'STALE';
      return 'CACHED';
    }

    function update(key, patch = {}) {
      const st = ensure(key);
      Object.assign(st, patch);
      st.state = computeState(st);
      return { ...st };
    }

    return {
      markAttempt(key) {
        return update(key, { key, lastAttemptTs: nowMs() });
      },
      markSuccess(key, extra = {}) {
        return update(key, {
          key,
          lastAttemptTs: extra.lastAttemptTs || nowMs(),
          lastSuccessTs: extra.lastSuccessTs || nowMs(),
          failCount: 0,
          lastError: null,
          usingCached: Boolean(extra.usingCached)
        });
      },
      markFailure(key, error, extra = {}) {
        const prev = ensure(key);
        return update(key, {
          key,
          lastAttemptTs: extra.lastAttemptTs || nowMs(),
          failCount: Math.max(0, Number(prev.failCount || 0) + 1),
          lastError: normalizeError(error),
          usingCached: Boolean(extra.usingCached)
        });
      },
      setCached(key, usingCached = true) {
        return update(key, { key, usingCached: Boolean(usingCached) });
      },
      setHubReachable(reachable) {
        hubReachable = Boolean(reachable);
        for (const key of statuses.keys()) {
          update(key, {});
        }
      },
      get(key) {
        return { ...ensure(key) };
      },
      snapshot() {
        return Array.from(statuses.values()).map((s) => ({ ...s }));
      },
      hydrate(arr) {
        if (!Array.isArray(arr)) return;
        for (const raw of arr) {
          if (!raw || !raw.key) continue;
          statuses.set(raw.key, {
            key: raw.key,
            lastSuccessTs: Number(raw.lastSuccessTs) || null,
            lastAttemptTs: Number(raw.lastAttemptTs) || null,
            failCount: Number(raw.failCount) || 0,
            state: raw.state || 'DEGRADED',
            lastError: normalizeError(raw.lastError),
            usingCached: Boolean(raw.usingCached)
          });
          update(raw.key, {});
        }
      }
    };
  }

  global.createFreshnessTracker = createFreshnessTracker;
})(window);
