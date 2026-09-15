/**
 * Centralized cache TTL constants (in seconds).
 *
 * All cache middleware in route files should reference these constants
 * instead of using magic numbers. This makes the cache strategy
 * auditable and adjustable from a single location.
 */
export const CACHE_TTLS = {
  /**
   * 7 days — every merchant write and every buyer-visible stock band
   * transition purges the affected tags directly and through the durable retry
   * sweep. The TTL is only the failure backstop, so it stays long enough that
   * public reads almost never pay for a cold origin render.
   */
  AVAILABILITY: 7 * 86_400,

  /** 30 days — mutation-purged content (categories, pages, collections, layout, navigation) */
  STANDARD: 30 * 86_400,

  /** 1 day — checkout reference data purged by the "checkout" tag (shipping methods) */
  SHORT: 86_400,

  /** 1 day — checkout reference data purged by the "checkout" tag (delivery locations) */
  MEDIUM: 86_400,

  /** 30 days — attribute definitions purged by the "attributes" tag */
  ATTRIBUTES: 30 * 86_400,

  /** 1 hour — checkout gateway readiness; purged by the "checkout" tag on every payment or auth settings save */
  CHECKOUT_CONFIG: 3600,

  /** 0 — explicitly no caching (analytics config — served fresh) */
  NONE: 0,
} as const;
