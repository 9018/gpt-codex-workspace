export const _diagnosticsCache = new Map();
export const CACHE_DEFAULTS = {
  gitStatus: 5000,       // git status cache: 5s
  repoLockSummary: 2000, // repo lock summary: 2s
  staleCloneCount: 10000, // stale clones: 10s
  restartMarkers: 3000,  // restart markers: 3s
};

/**
 * Get a cached value or compute and cache it.
 * @param {string} key - cache key
 * @param {number} ttlMs - TTL in ms
 * @param {function} computeFn - async function to compute value on cache miss
 * @returns {Promise<*>} cached or computed value
 */
export async function withCache(key, ttlMs, computeFn) {
  const cached = _diagnosticsCache.get(key);
  if (cached && Date.now() - cached.ts < ttlMs) {
    return cached.value;
  }
  const value = await computeFn();
  _diagnosticsCache.set(key, { value, ts: Date.now() });
  return value;
}

/**
 * Invalidate a specific cache key or all keys matching a prefix.
 * @param {string} [prefix] - if provided, only invalidates keys starting with prefix
 */
export function invalidateCache(prefix) {
  if (!prefix) { _diagnosticsCache.clear(); return; }
  for (const key of _diagnosticsCache.keys()) {
    if (key.startsWith(prefix)) _diagnosticsCache.delete(key);
  }
}

/**
 * Get cache stats for diagnostics.
 * @returns {{ size: number, keys: string[] }}
 */
export function getCacheStats() {
  return { size: _diagnosticsCache.size, keys: [..._diagnosticsCache.keys()] };
}

/**
 * Try to find the repo root directory by walking up from cwd looking for .git.
 */
