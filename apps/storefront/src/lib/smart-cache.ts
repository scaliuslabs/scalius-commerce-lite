// src/lib/smart-cache.ts

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresIn: number;
}

const cacheStorage = new Map<string, CacheEntry<any>>();

/**
 * A shared storage for in-memory caching of high-traffic global data.
 * This persists across requests in Node.js (dev) and often in Cloudflare Workers (warm start).
 */
export const smartCache = {
  get<T>(key: string): T | null {
    const entry = cacheStorage.get(key);
    if (!entry) return null;

    if (Date.now() > entry.timestamp + entry.expiresIn) {
      cacheStorage.delete(key);
      return null;
    }

    return entry.data;
  },

  set<T>(key: string, data: T, ttlSeconds: number = 60): T {
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

const inflight = new Map<string, Promise<any>>();

/**
 * Wraps an API fetching function with caching AND request deduplication logic.
 * @param key Unique cache key (e.g., 'global_footer')
 * @param fetcher The async function to fetch data if cache misses
 * @param ttlSeconds Time to live in seconds (default 5 minutes)
 */
export async function withSmartCache<T>(
  key: string,
  fetcher: () => Promise<T | null>,
  ttlSeconds: number = 300,
): Promise<T | null> {
  // 1. Check L1 Cache
  const cached = smartCache.get<T>(key);
  if (cached) {
    return cached;
  }

  // 2. Check Inflight (Request Deduplication)
  if (inflight.has(key)) {
    return inflight.get(key) as Promise<T | null>;
  }

  // 3. Fetch & Cache
  const promise = (async () => {
    try {
      const data = await fetcher();
      if (data) {
        smartCache.set(key, data, ttlSeconds);
      }
      return data;
    } catch (error) {
      console.warn(`[SmartCache] Fetch failed for ${key}`);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}
