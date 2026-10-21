// Agent operation registry rows for the dashboard product, price list, category, collection and attribute routes.
import type { OperationRegistryEntry } from "./entry";

export const DASHBOARD_CATALOG_OPERATIONS = {
  "dashboard.attribute_values.create": {},
  "dashboard.attribute_values.delete": { risk: "destructive" },
  "dashboard.attribute_values.list": {},
  "dashboard.attribute_values.rename": {},
  "dashboard.attributes.bulk_delete": { risk: "destructive" },
  "dashboard.attributes.bulk_restore": {},
  "dashboard.attributes.create": {},
  "dashboard.attributes.delete_permanently": { risk: "destructive" },
  "dashboard.attributes.list": {
    exposure: "excluded",
    reason:
      "Legacy dashboard list may include up to 500 preset values per attribute; use dashboard.attributes.list_summaries and dashboard.attribute_values.list.",
  },
  "dashboard.attributes.list_summaries": {},
  "dashboard.attributes.restore": {},
  "dashboard.attributes.trash": { risk: "destructive" },
  "dashboard.attributes.update": {},
  // Many creates per call for importers: per-item keys, bounded by plan (resources-batch.ts).
  "dashboard.categories.batch_create": {
    idempotency: "supported",
    batch: "forbidden",
    uncurated: true,
  },
  "dashboard.categories.bulk_delete": {
    risk: "destructive",
    revision: "required",
  },
  "dashboard.categories.bulk_restore": { revision: "required" },
  "dashboard.categories.create": {},
  "dashboard.categories.delete_permanently": {
    risk: "destructive",
    revision: "required",
  },
  "dashboard.categories.form_options": {},
  "dashboard.categories.get": {
    exposure: "excluded",
    reason: "Legacy oversized category aggregate; use dashboard.categories.get_section.",
  },
  "dashboard.categories.get_ancestors": {},
  // Editor-shaped (offset into one rich-text field): beta.
  "dashboard.categories.get_section": {},
  "dashboard.categories.list": {
    exposure: "excluded",
    reason:
      "Legacy dashboard list may include oversized category rich text; use dashboard.categories.list_summaries.",
  },
  "dashboard.categories.list_children": {},
  // Page-numbered (dashboard-shaped): beta until a cursor list joins the stable API.
  "dashboard.categories.list_summaries": {},
  "dashboard.categories.move": { revision: "required" },
  "dashboard.categories.publish_readiness": {},
  "dashboard.categories.restore": { revision: "required" },
  "dashboard.categories.set_status": { revision: "required" },
  "dashboard.categories.trash": {
    risk: "destructive",
    revision: "required",
  },
  "dashboard.categories.update": { revision: "required" },
  "dashboard.collections.bulk_activate": {},
  "dashboard.collections.bulk_deactivate": {},
  "dashboard.collections.bulk_delete": { risk: "destructive" },
  "dashboard.collections.bulk_restore": {},
  "dashboard.collections.category_options": {},
  "dashboard.collections.create": {},
  "dashboard.collections.delete_permanently": { risk: "destructive" },
  "dashboard.collections.form_options": {},
  "dashboard.collections.get": {
    exposure: "excluded",
    reason: "Legacy oversized aggregate projection; use dashboard.collections.get_section.",
  },
  "dashboard.collections.get_by_ids": {},
  // Editor-shaped (offset into one rich-text field): beta.
  "dashboard.collections.get_section": {},
  // Page-numbered (dashboard-shaped): beta until a cursor list joins the stable API.
  "dashboard.collections.list": {},
  "dashboard.collections.product_options": {},
  "dashboard.collections.reorder": { revision: "required" },
  "dashboard.collections.restore": { revision: "optional" },
  "dashboard.collections.trash": { risk: "destructive", revision: "optional" },
  "dashboard.collections.update": { revision: "required" },
  "dashboard.collections.update_products": { revision: "required" },
  "dashboard.product_options.save_matrix": { revision: "required" },
  "dashboard.product_variants.create": { revision: "required" },
  "dashboard.product_variants.list": {},
  "dashboard.product_variants.retire": {
    risk: "destructive",
    revision: "required",
  },
  "dashboard.product_variants.update": { revision: "required" },
  // Price lists (MARKETS-DESIGN D5): a market's, a segment's or a sale's fixed prices.
  "dashboard.price_lists.choices": {},
  "dashboard.price_lists.create": {},
  "dashboard.price_lists.delete": { risk: "destructive", revision: "required" },
  "dashboard.price_lists.get": {},
  "dashboard.price_lists.list": {},
  "dashboard.price_lists.prices_list": {},
  "dashboard.price_lists.prices_set": { revision: "required", limits: { request: 262_144 } },
  "dashboard.price_lists.update": { revision: "required" },
  "dashboard.products.bulk_delete": {
    risk: "destructive",
    revision: "required",
  },
  "dashboard.products.bulk_restore": { revision: "required" },
  "dashboard.products.bulk_update": { revision: "required" },
  "dashboard.products.create": { limits: { response: 16_384 } },
  "dashboard.products.duplicate": {},
  "dashboard.products.delete_permanently": {
    risk: "destructive",
    revision: "required",
  },
  "dashboard.products.get": {
    exposure: "excluded",
    reason: "Legacy oversized aggregate projection; use dashboard.products.get_section.",
  },
  "dashboard.products.get_by_ids": {},
  "dashboard.products.get_section": {},
  "dashboard.products.list": {
    exposure: "excluded",
    reason:
      "Legacy dashboard list may include oversized rich text and media projections; use dashboard.products.list_summaries.",
  },
  "dashboard.products.list_summaries": {},
  "dashboard.products.lookup_barcode": {},
  // Publishing (MARKETS-DESIGN D6): not under the product's revision.
  "dashboard.products.publications_bulk": {},
  "dashboard.products.publications_set": {},
  "dashboard.products.restore": { revision: "required" },
  "dashboard.products.stats": {},
  "dashboard.products.trash": {
    risk: "destructive",
    revision: "required",
  },
  "dashboard.products.update": { revision: "required" },
  "dashboard.products.update_section": {
    revision: "required",
    limits: { request: 16_384, response: 16_384 },
  },
} satisfies Record<string, OperationRegistryEntry>;
