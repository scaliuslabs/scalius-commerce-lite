// Catalog domain: buyer-facing catalogue reads. Listings, facets, the product
// page, search, feeds, sitemaps, recommendations and storefront sections all
// read through the product rules owned by modules/products (public
// eligibility, buyer pricing, media). Category, collection, attribute and
// brand records keep their own domains beside this one.
export * from "./listing";
export {
  OPTION_FACET_PREFIX,
  type PublicProductFacet,
  type PublicProductFacetValue,
} from "./facets";
export * from "./product-page";
export * from "./search";
export * from "./feed";
export * from "./sitemap";
export * from "./recommendations";
export * from "./feed-diagnostics";
export * from "./feed-row-preview";
export * from "./storefront-sections";
