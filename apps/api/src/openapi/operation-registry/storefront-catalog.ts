// Agent operation registry rows for the storefront catalogue routes.
import type { OperationRegistryEntry } from "./entry";

export const STOREFRONT_CATALOG_OPERATIONS = {
  "storefront.attributes.category_id_alias": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason:
      "ID compatibility alias; use storefront.attributes.list_for_category with the public category slug.",
  },
  "storefront.attributes.list_filterable": { limits: { request: 16_384 } },
  "storefront.attributes.list_for_category": { limits: { request: 16_384 } },
  "storefront.attributes.list_for_search": { limits: { request: 16_384 } },
  "storefront.categories.get": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason:
      "Unbounded browser category aggregate; use storefront.categories.get_section for reconstructable bounded detail.",
  },
  "storefront.categories.get_breadcrumb": { limits: { request: 16_384 } },
  "storefront.categories.get_section": { limits: { request: 16_384, response: 32_768 } },
  "storefront.categories.list": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason:
      "Unbounded browser category aggregate can exceed the structured-result ceiling; use storefront.categories.list_summaries plus storefront.categories.get_section.",
  },
  "storefront.categories.list_product_summaries": { limits: { request: 16_384 } },
  "storefront.categories.list_products": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason:
      "Browser category listing embeds the unbounded category aggregate; use storefront.categories.list_product_summaries plus storefront.categories.get_section.",
  },
  "storefront.categories.list_children": { limits: { request: 16_384 } },
  "storefront.categories.list_summaries": { limits: { request: 16_384 } },
  "storefront.categories.tree": { limits: { request: 16_384 } },
  "storefront.collections.get": { limits: { request: 16_384 } },
  "storefront.collections.list": { limits: { request: 16_384 } },
  "storefront.products_feed.get_feed": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Crawler-only Merchant XML feed projection; agents use canonical catalog list, search, and bounded detail operations.",
  },
  "storefront.products_sitemap.get_sitemap": {
    exposure: "excluded",
    principals: ["internal"],
    reason:
      "Crawler-only sitemap projection is discovery infrastructure, not a buyer-visible catalog capability.",
  },
  "storefront.products.get": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason:
      "Unbounded browser page aggregate; use storefront.products.get_section for reconstructable bounded detail.",
  },
  "storefront.products.get_section": { limits: { request: 16_384, response: 61_440 } },
  "storefront.products.list": { limits: { request: 16_384 } },
  "storefront.products.list_recommendations": { limits: { request: 16_384 } },
  "storefront.products.search_legacy": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason:
      "Legacy variant aggregate duplicates storefront.products.list plus storefront.products.get_section.",
  },
  "storefront.search.predict": { limits: { request: 16_384, response: 32_768 } },
} satisfies Record<string, OperationRegistryEntry>;
