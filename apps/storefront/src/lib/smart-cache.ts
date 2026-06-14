// src/lib/smart-cache.ts

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresIn: number;
}

const MAX_ENTRIES = 1000;
const cacheStorage = new Map<string, CacheEntry<unknown>>();

/**
 * A shared storage for in-memory caching of high-traffic global data.
 * This persists across requests in Node.js (dev) and often in Cloudflare Workers (warm start).
 * Capped at MAX_ENTRIES with LRU eviction to prevent unbounded memory growth.
 */
export const smartCache = {
  get<T>(key: string): T | null {
    const entry = cacheStorage.get(key);
    if (!entry) return null;

    if (Date.now() > entry.timestamp + entry.expiresIn) {
      cacheStorage.delete(key);
      return null;
    }

    // Move to end (most recently used) for LRU ordering
    cacheStorage.delete(key);
    cacheStorage.set(key, entry);

    return entry.data as T;
  },

  set<T>(key: string, data: T, ttlSeconds: number = 60): T {
    // Delete first so re-insertion moves to end (most recent)
    cacheStorage.delete(key);

    // Evict oldest entry if at capacity
    if (cacheStorage.size >= MAX_ENTRIES) {
      const oldest = cacheStorage.keys().next().value;
      if (oldest !== undefined) cacheStorage.delete(oldest);
    }

    cacheStorage.set(key, {
      data,
      timestamp: Date.now(),
      expiresIn: ttlSeconds * 1000,
    });
    return data;
  },

  /**
   * Delete all entries whose key starts with the given prefix.
   */
  deleteByPrefix(prefix: string) {
    for (const key of cacheStorage.keys()) {
      if (key.startsWith(prefix)) {
        cacheStorage.delete(key);
      }
    }
  },

  /**
   * Delete all entries matching any of the given prefixes.
   */
  deleteByPrefixes(prefixes: string[]) {
    if (!prefixes.length) return;
    for (const key of cacheStorage.keys()) {
      if (prefixes.some(p => key.startsWith(p))) {
        cacheStorage.delete(key);
      }
    }
  },

  /**
   * Clears all cached data. Useful for purge events.
   */
  clear() {
    cacheStorage.clear();
  },
};
