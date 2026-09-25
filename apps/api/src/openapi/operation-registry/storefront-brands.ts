// Agent operation registry rows for the storefront brand routes.
import type { OperationRegistryEntry } from "./entry";

export const STOREFRONT_BRAND_OPERATIONS = {
  "storefront.brands.get": { limits: { request: 16_384 } },
  "storefront.brands.list": { limits: { request: 16_384 } },
  "storefront.brands.list_products": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason:
      "Browser brand listing embeds the brand description (up to 20,000 characters) beside up to 100 cards; use storefront.brands.get and storefront.products.list.",
  },
  "storefront.brands.sitemap": {
    exposure: "excluded",
    limits: { request: 16_384 },
    reason: "XML discovery source of up to 5,000 brand URLs for the storefront sitemap; use storefront.brands.list.",
  },
} satisfies Record<string, OperationRegistryEntry>;
