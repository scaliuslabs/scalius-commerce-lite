/**
 * Centralized cache TTL constants (in seconds).
 *
 * All cache middleware in route files should reference these constants
 * instead of using magic numbers. This makes the cache strategy
 * auditable and adjustable from a single location.
 */
/**
 * One year is the longest edge residency Cloudflare honors. Every public route
 * below is tag-purged by the merchant write that changes it (directly, then
 * through the durable retry sweep), so the TTL is never the freshness
 * mechanism; it is the ceiling that lets a rarely edited store stay warm.
 */
const EDGE_MAX_TTL = 365 * 86_400;

export const CACHE_TTLS = {
  /** Buyer-visible price and availability; purged on writes and stock band transitions */
  AVAILABILITY: EDGE_MAX_TTL,

  /** Mutation-purged content (categories, pages, collections, layout, navigation) */
  STANDARD: EDGE_MAX_TTL,

  /** Checkout reference data purged by the "checkout" tag (shipping methods) */
  SHORT: EDGE_MAX_TTL,

  /** Checkout reference data purged by the "checkout" tag (delivery locations) */
  MEDIUM: EDGE_MAX_TTL,

  /** Attribute definitions purged by the "attributes" tag */
  ATTRIBUTES: EDGE_MAX_TTL,

  /** Checkout gateway readiness; purged by the "checkout" tag on every payment, delivery, or auth settings save */
  CHECKOUT_CONFIG: EDGE_MAX_TTL,

  /** 0 — explicitly no caching (analytics config — served fresh) */
  NONE: 0,
} as const;
