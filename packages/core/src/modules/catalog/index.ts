// Catalog domain: buyer-facing catalogue reads. Listings, facets, the product
// page, search, feeds, sitemaps, recommendations and storefront sections all
// read through the product rules owned by modules/products (public
// eligibility, buyer pricing, media). Category, collection, attribute and
// brand records keep their own domains beside this one.
export * from "./listing";
export {
  BRAND_FACET_KEY,
  FACET_ATTRIBUTE_LIMIT,
  FACET_VALUE_LIMIT,
  MAX_PUBLIC_FACET_FILTER_VALUES,
  OPTION_FACET_PREFIX,
  resolvePublicAttributeFilters,
  getPublicCategoryFacets,
  getPublicSearchFacets,
  type PublicProductFacet,
  type PublicProductFacetKind,
  type PublicProductFacetValue,
} from "./facets";
export * from "./compare";
export * from "./product-page";
export {
  getPublicProductReviews,
  PRODUCT_PAGE_REVIEW_COUNT,
  PUBLIC_REVIEW_PAGE_SIZE,
  PUBLIC_REVIEW_SORTS,
  type ProductPageReviews,
  type PublicReview,
  type PublicReviewPage,
  type PublicReviewQuery,
  type PublicReviewSort,
  type PublicReviewSummary,
} from "./product-reviews";
export * from "./search";
export * from "./feed";
export * from "./sitemap";
export * from "./recommendations";
export * from "./feed-diagnostics";
export * from "./feed-row-preview";
export * from "./storefront-sections";
export * from "./cards";
export * from "./card-facts";
export * from "./home-lists";
export * from "./recommendation-refresh";
