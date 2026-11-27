// The orders a buyer listing takes (shop-all, search, a category, a
// collection, a brand), shared by core, the API schemas and the storefront.
// Dependency-free: the storefront imports it as is.

/** Every listing's orders. `popular`: best selling first (MIN_POPULAR_UNITS), then newest. */
export const STOREFRONT_LISTING_SORTS = [
  "newest",
  "price-asc",
  "price-desc",
  "name-asc",
  "name-desc",
  "discount",
  "rating",
  "popular",
] as const;
export type StorefrontListingSort = (typeof STOREFRONT_LISTING_SORTS)[number];

/**
 * The order a listing opens in when its address names none, until the
 * merchant picks another (Online store -> Preferences, the `seo` settings
 * document's `defaultListingSort`). A search with words opens best match first.
 */
export const DEFAULT_LISTING_SORT: StorefrontListingSort = "newest";

/** A search's orders: best match first, then every listing order. */
export const STOREFRONT_SEARCH_SORTS = ["relevance", ...STOREFRONT_LISTING_SORTS] as const;
export type StorefrontSearchSort = (typeof STOREFRONT_SEARCH_SORTS)[number];

/**
 * A product is popular with at least this many units sold in the last 30
 * days (`product_sales_stats.sold_30d`): the home "popular" list, the
 * `popular` listing order and the `popular` cache key all use it.
 */
export const MIN_POPULAR_UNITS = 2;
