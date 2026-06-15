/**
 * Centralized cache TTL constants (in seconds).
 *
 * All cache middleware in route files should reference these constants
 * instead of using magic numbers. This makes the cache strategy
 * auditable and adjustable from a single location.
 */
export const CACHE_TTLS = {
  /** 1 hour — standard for content that changes occasionally (products, categories, pages, widgets, collections) */
  STANDARD: 3600,

  /** 5 minutes — for data that changes frequently (search results, order lookups, shipping methods) */
  SHORT: 300,

  /** 10 minutes — for semi-static reference data (delivery locations) */
  MEDIUM: 600,

  /** 30 minutes — for attribute data that changes less often */
  ATTRIBUTES: 1800,

  /** 1 minute — for highly dynamic config (checkout gateway config) */
  CHECKOUT_CONFIG: 60,

  /** 0 — explicitly no caching (analytics config — served fresh) */
  NONE: 0,
} as const;
