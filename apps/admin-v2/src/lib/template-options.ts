/**
 * The templates a product, category, collection or brand may name
 * (`products.page_template`, `*.listing_template`); null is the theme's own.
 * Kept as plain lists so the editors don't load the theme schema; a test
 * holds them equal to `@scalius/shared/storefront-theme`.
 */

/** A product page: today's page (classic) or one template's own product page. */
export const PRODUCT_PAGE_TEMPLATE_IDS = [
  "classic",
  "boutique",
  "heritage-editorial",
  "fashion-value",
  "spec-catalogue",
  "rounded-tech",
  "marketplace",
  "mass-retail",
  "department-mall",
  "daily-essentials",
  "showcase-landing",
] as const;

/** A listing: a layout, or where its filters sit. */
export const LISTING_LAYOUT_TEMPLATE_IDS = ["grid", "list", "shelves", "quick-grid"] as const;
export const LISTING_FILTER_TEMPLATE_IDS = ["sidebar-dense", "sidebar-comfortable", "bar-dropdowns", "drawer"] as const;

export type ProductPageTemplateId = (typeof PRODUCT_PAGE_TEMPLATE_IDS)[number];
export type ListingTemplateId =
  | (typeof LISTING_LAYOUT_TEMPLATE_IDS)[number]
  | (typeof LISTING_FILTER_TEMPLATE_IDS)[number];
