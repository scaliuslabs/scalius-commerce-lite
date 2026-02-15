/**
 * Simple in-memory cache for layout-level data that changes infrequently.
 * Reduces DB round-trips on every admin page load.
 * TTL: 5 minutes (settings rarely change during a session).
 */
const LAYOUT_CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry<T> = { value: T; expires: number };

const cache = new Map<string, CacheEntry<unknown>>();

function get<T>(key: string): T | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry || Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function set<T>(key: string, value: T): void {
  cache.set(key, {
    value,
    expires: Date.now() + LAYOUT_CACHE_TTL_MS,
  });
}

export const layoutCache = {
  get,
  set,
  /** Invalidate a specific key */
  invalidate: (key: string) => cache.delete(key),
  /** Invalidate all (call when settings are updated) */
  clear: () => cache.clear(),
};

export const CACHE_KEYS = {
  FIREBASE_CONFIG: "layout:firebase_config",
  STOREFRONT_URL: "layout:storefront_url",
} as const;
