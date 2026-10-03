# Products

The product model and the rules other domains read: public eligibility, buyer pricing, the option model, money, product media, the low-stock policy, and the catalogue projections that cache them. Audience: contributors and coding agents.

This domain reads and defines. [`product-admin`](../product-admin/README.md) writes products (the dashboard editor). [`catalog`](../catalog/README.md) serves buyer reads (listings, product page, feeds, sitemaps). Both depend on this domain, never the reverse.

## Entries

`index.ts` is the only entry. There is no `browser.ts`. It re-exports every file. The ones other code uses most:

- `option-model.ts`: option reads, axis-ordered combination keys, `MAX_PRODUCT_OPTION_AXES` (5), `MAX_PRODUCT_OPTION_COMBINATIONS` (150).
- `public-eligibility.ts`: `publicProductBaseConditions`, `publicProductHasBuyerResolvableSku`, `publicProductHasAvailableBuyerSku`, `operationalSkuRowPredicate`, `defaultProductSkuValues`.
- `variant-identity.ts`: SQL predicates that match the partial normalized barcode index. Use them for every barcode lookup.
- `buyer-projection.ts` and `money.ts`: the one-row-per-product buyer pricing projection, `effectivePriceMinorSql`, minor-unit to decimal conversion.
- `media.ts`: product media reads and the image resolvers (product image, card images, exact SKU image).
- `low-stock-policy.ts`: the `inventory` settings document and the effective alert level SQL.
- `catalog-projections.ts`: refresh and rebuild of `product_buyer_state` and `product_facet_values`.

## Layer and imports

- Layer L2. Imports `settings` only (currency helpers and the `currency` and `emi` documents). It also uses `settings-store`, `cache-deps` and `packages/core/src/integrations/storage.ts` (public media URL).
- Imported by `analytics`, `catalog`, `categories`, `checkout`, `inventory`, `orders`, `product-admin`, `promotions` and `store-transfer`.

## Tables

| Table | Role and constraints |
|-------|----------------------|
| `products` | Merchandising container with no stock column. Unique `slug`. Carries `aggregate_revision`, `product_condition` (`new`, `refurbished`, `used`, or null) and `customization_schema` (JSON, at most 4,096 characters). |
| `product_variants` | The SKU: the only sellable and inventory identity. Unique `lower(trim(sku))` and, when set, `lower(trim(barcode))`. A default SKU has no option key, a non-default SKU has one. Unique `(product_id, option_combination_key)` among live non-default SKUs. Holds `stock`, `reserved_stock`, `stock_version`, `cost_minor`, `fulfillment_kind`, `image_id`. |
| `product_option_definitions` | One option axis. `position` 0 to 4. `standard_mapping` is `size`, `color`, `material`, `pattern` or `none` (default). Unique live name per product. |
| `product_option_values`, `product_variant_option_values` | Axis values (unique live value per axis) and the SKU to value assignment (primary key `(variant_id, option_definition_id)`). |
| `product_media` | Ordered gallery. Unique `(product_id, media_id)` and `(product_id, sort_order)`. At most one primary row. Foreign key to `media` is `restrict`. |
| `product_content_blocks`, `product_bundles` | Typed page blocks (at most 40) and quantity tiers (at most 6). |
| `product_rich_content` | Legacy tabs. Triggers mirror each row into a read-only `tabs` content block (`pcb_<row id>`). |
| `product_buyer_state`, `product_facet_values` | Projections of public eligibility, card pricing, availability band, brand, category and facets. Never checkout authority. |

## Rules

- A product holds no inventory. A simple product has exactly one hidden default SKU (`is_default = 1`, no option key, id `var_default_<productId>`).
- A product with options keeps one active SKU per chosen combination, and each active SKU assigns exactly one value of every active axis. Mixed shapes fail closed (`publicProductHasBuyerResolvableSku`).
- Option axes are merchant-named, up to five. `size` and `color` are two optional `standard_mapping` values, not fixed slots, and a mapping other than `none` belongs to one axis. Feeds and ProductGroup read the saved name and mapping, never an assumed size or color.
- A combination key is the value ids in axis order joined by `|`. Request order never creates a second identity.
- SKU and barcode identity is global and case-insensitive. A new SKU without a barcode gets an internal Code 128 identity.
- `product_variants.image_id` is the only variant-image authority: null or a ready image association of the same product (triggers `product_variants_identity_insert_guard` and `product_variants_identity_update_guard`). Precedence: exact SKU image, then the product's featured image. A video never serves as an image URL, but its poster can.
- A public product is active, not trashed and has a buyer-resolvable SKU topology. Stock is not part of eligibility. Buyer reads use the predicates in `public-eligibility.ts`, never `is_active` and `deleted_at` alone.
- A product is `availableForSale` when at least one SKU in its buyer pool is untracked or has `stock - reserved_stock > 0`. Feeds, JSON-LD and checkout read the same rule.
- A product's brand is the record `brand_id`, never an attribute. The editor accepts any brand that is not in trash. Feeds, JSON-LD and the product page publish only a published, live brand and never a placeholder.
- `product_condition` null means unknown. Feeds and JSON-LD emit a condition only from this column.
- A valid SKU discount overrides the product discount. A percentage discount rounds half-up to the store's price increment (whole taka by default for BDT) and never exceeds the price.
- The alert level of a SKU is its own `low_stock_threshold`, else the store default. Level 0 turns alerts off. The same level bands buyer availability.
- Money is integer minor units. `presentCatalogPrice` converts to decimal once, at the edge. A staff read of a SKU row adds `cost`. Buyer reads never carry it.
- A digital SKU's stock is its licence keys. Every manual stock path refuses to change it (`details.reason = "digital_stock_is_keys"`). A SKU turns digital only with no stock, and a digital SKU with a ready key pool keeps tracking.
- A gift-card product has only digital, untracked, undiscounted SKUs and no bundles. Every aggregate batch ends with `buildGiftCardProductRulesGuard`.
- Customization allows at most 10 fields. Bundle tiers need a quantity from 2 to 100. A customization change advances the aggregate revision and fences in-flight checkouts. Triggers on `product_bundles` bump `checkout_authority` on every insert, price-relevant update and delete.
- The EMI line is informational. It shows only when the `emi` document is enabled, the product is `emi_eligible` and a plan applies.

## Catalogue projections

- Every write that can change a projection appends `catalogProjectionRefreshStatements` (or the SKU-scoped `catalogBuyerStateRefreshStatementsForSkus` for stock writes) to its own batch, after the ledger edge and the `stockVersion` CAS. A statement group covers at most 90 products through one `json_each` parameter. The facet refresh rewrites only rows that differ, so unchanged saves fire no DVC trigger.
- `rebuildCatalogProjections` recomputes in keyset pages of 90. One call handles 900 products by default and 2,700 at most.
- The API queues `catalog.projections.rebuild` nightly (first cron tick at or after 20:00 UTC) and on the first cron tick of a new API version (`apps/api/src/scheduled/catalog-projections.ts`).
- To heal or fill by hand, call `POST /api/v1/admin/catalog/projections/rebuild` (`PRODUCTS_EDIT`). Send `{}`, then `{ "afterProductId": <nextAfterProductId> }`, until `done` is true.

## Settings and DVC

- Declares the settings document `inventory` (`defaultLowStockThreshold`) in `low-stock-policy.ts`. Reads `currency` and `emi` from `settings`.
- Readers declare `deps.inventoryBands()`, `deps.settings()` for `currency` and `emi`, `deps.media()` for an unready poster and `deps.mediaItems()` for content-block files. Triggers on each product table advance `p:<id>` and the list keys ([`cache-deps`](../../cache-deps/README.md)).
