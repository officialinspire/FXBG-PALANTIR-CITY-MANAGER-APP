const DEFAULT_REVALIDATE_BUDGET_MS = 2000;

function createCache() {
  const store = new Map();

  function get(key) {
    const entry = store.get(key);
    if (!entry) {
      return {
        hit: false,
        value: null,
        ageMs: 0,
        stale: false,
        expiresAt: null,
        cachedAt: null
      };
    }

    const now = Date.now();
    const ageMs = now - entry.cachedAt;
    const stale = ageMs > entry.ttlMs;
    return {
      hit: true,
      value: entry.value,
      ageMs,
      stale,
      expiresAt: entry.cachedAt + entry.ttlMs,
      cachedAt: entry.cachedAt
    };
  }

  function set(key, value, ttlMs) {
    const cachedAt = Date.now();
    store.set(key, {
      value,
      ttlMs,
      cachedAt
    });
  }

  async function wrap(key, ttlMs, fetchFn, { staleTtlMs = 0, revalidateBudgetMs = DEFAULT_REVALIDATE_BUDGET_MS } = {}) {
    const cached = get(key);
    if (cached.hit && !cached.stale) {
      return { value: cached.value, cache: cached, warning: null, refreshed: false };
    }

    const hasStaleWindow = Number.isFinite(staleTtlMs) && staleTtlMs > 0;
    if (cached.hit && cached.stale && hasStaleWindow && cached.ageMs <= staleTtlMs) {
      let refreshedValue = null;
      try {
        refreshedValue = await Promise.race([
          Promise.resolve(fetchFn()),
          new Promise((_, reject) => setTimeout(() => reject(new Error("revalidate_timeout")), revalidateBudgetMs))
        ]);
      } catch (err) {
        return {
          value: cached.value,
          cache: cached,
          warning: "stale_cache",
          refreshed: false,
          error: err
        };
      }

      if (refreshedValue !== null && refreshedValue !== undefined) {
        set(key, refreshedValue, ttlMs);
        return {
          value: refreshedValue,
          cache: { hit: false, value: refreshedValue, ageMs: 0, stale: false, expiresAt: Date.now() + ttlMs, cachedAt: Date.now() },
          warning: null,
          refreshed: true
        };
      }

      return { value: cached.value, cache: cached, warning: "stale_cache", refreshed: false };
    }

    try {
      const value = await fetchFn();
      set(key, value, ttlMs);
      return { value, cache: { hit: false, value, ageMs: 0, stale: false, expiresAt: Date.now() + ttlMs, cachedAt: Date.now() }, warning: null, refreshed: false };
    } catch (err) {
      if (cached.hit) {
        return { value: cached.value, cache: cached, warning: "stale_cache", refreshed: false, error: err };
      }
      throw err;
    }
  }

  return { get, set, wrap };
}

module.exports = {
  createCache
};
