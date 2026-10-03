# Products Core Module

What a product and its SKUs are, and the product rules other domains read through: public eligibility, buyer pricing and projections, money, media projections, the option model, the SKU alert level that bands buyer availability, customization, content blocks, bundles, EMI and the digital and gift-card stock rules, plus the catalogue projections that cache them. It depends on settings only.

The dashboard's product editor (create, update, duplicate, trash, delete, variants, the option matrix and the aggregate revision) lives in [`../product-admin`](../product-admin/README.md) and builds on this module and inventory. Buyer-facing catalogue reads (listings, facets, product page, search, feeds, sitemaps, recommendations, storefront sections) live in [`../catalog`](../catalog/README.md). Both depend on this module, never the reverse.

Public entry: `index.ts`.

## Features

- Paginated product listing with FTS5 full-text search (admin + storefront)
- Barcode-aware search: auto-detects digit-only 8-13 char queries and searches by exact barcode match in addition to FTS
- Product CRUD with slug uniqueness enforcement
- Soft delete / restore / permanent delete lifecycle with order/discount safety checks
- Bulk soft-delete and bulk permanent-delete with order/discount guards
- Ordered product media: up to 250 immutable associations to global Media assets, with one explicit featured item and dense request order stored in `productMedia`
- Image-only projection uses featured image, featured-video poster, ordered image, then ordered-video poster; it never returns a placeholder or video URL as an image
- Rich content sections (additional info): arbitrary titled HTML blocks stored in `productRichContent`, ordered by `sortOrder`
- Product attributes: many-to-many via `productAttributeValues`, linked to global `productAttributes` definitions
- Normalized product options: up to five merchant-named axes and 150 potential Cartesian combinations, with any non-empty active SKU subset stored in `productOptionDefinitions`, `productOptionValues`, and `productVariantOptionValues`
- Variant CRUD: selected option values, optional exact image association, weight, globally unique SKU/barcode identities, price, stock, and percentage or flat discount. `NULL` image means featured/product image fallback; videos are never exact SKU images.
- Atomic full-matrix save with aggregate-revision concurrency, stock-version guards, movement-ledger claims, safe combination retirement, and D1-batched writes
- Soft-deleted variants filtered out: all variant queries use `isNull(deletedAt)` or `deletedAt IS NULL` conditions
- Discount type support: both percentage and flat amount discounts at product and variant level
- `ProductWithDetails` type includes `additionalInfo` (`{id, title, content, sortOrder}[]`) and `attributes` (`{attributeId, value}[]`)
- `ProductListItem` type includes `discountType`, `discountAmount`, and `discountPercentage` fields
- `getProducts()` selects `discountType` and `discountAmount` alongside `discountPercentage` for the admin list
- `getProductDetails()` fetches `productRichContent` (mapped to `additionalInfo`) and `productAttributeValues` (mapped to `attributes`)
- Storefront product listing with attribute-based filtering (AND logic across attributes), with page rows/count read in one DB wave and image/category enrichment read in one dependent wave
- Storefront category-product listing delegates to `getStorefrontCategoryProducts()`, which reuses the shared public product predicate/sort/attribute-filter helpers without paying for the global product list's variant/category enrichment
- Storefront product detail: parallel fetching of images, variants, rich content, attributes, category, and ranked recommendations (`catalog/recommendations.ts`)
- Storefront search: lightweight variant-aware product search for cart/checkout use
- Discounted price calculation supporting both percentage and flat discount types
- Feature extraction from description (parses bullet-point lines)
- SKU-first purchasability: every sellable product has a persisted `productVariants` row. Simple products use exactly one protected default SKU with no option assignments. Optioned products use non-default SKUs whose assignment set contains exactly one active value for every active product option; incomplete, mixed-shape, or fake default rows fail closed.
- Product options are arbitrary merchant-defined axes, not fixed size/color slots. An axis may explicitly map to `size`, `color`, `material`, `pattern`, or `none` for catalog standards; each non-`none` mapping can be claimed by only one axis. Combination identity is the axis-ordered option-value ID sequence, independent of request order.
- Product editor concurrency is aggregate-versioned. Admin detail and list/trash rows expose `aggregateRevision`; every direct product-editor mutation requires `expectedAggregateRevision`, increments the product revision exactly once in the same D1 batch, and returns the new revision. External category/attribute/tax cascades bump affected product revisions atomically so an open editor becomes stale. Stale direct writes fail with `PRODUCT_REVISION_CONFLICT` and safe expected/current revision details. Operational inventory transitions remain separately guarded by SKU `stockVersion` and ledger v2.
- SKU and barcode writes trim values and use global case-insensitive identity. New SKUs without a merchant barcode receive a stable internal `code128` identity; retail barcode types validate supported shape/checksum rules, and discovery outputs whitelist only true retail identifiers. Migration 0006 installs normalized unique indexes plus canonical row triggers, and scanner/admin lookup uses those indexed identities.
- Public catalog eligibility is centralized in `public-eligibility.ts`: storefront lists/details/search, global search, filterable attributes, and collection/homepage product resolution must all require a buyer-resolvable active SKU topology, while stock availability remains a separate display/checkout concern. Buyer-facing `hasVariants` means at least one non-default SKU with a real customer option, not the protected default SKU. Public product lists also project `availableForSale` from the same SKU topology (`trackInventory = false` or positive `stock - reservedStock`), so catalog feeds can match product-page JSON-LD and checkout availability without variant N+1 reads. The dedicated feed projection carries `canonicalPath`, option-axis mapping, and supported variant barcode fields so storefront XML can emit canonical product links, `variant_option` pairs, ProductGroup-compatible standard attributes, and true GTINs without expanding normal listing cards.
- Storefront buyer availability uses `apps/storefront/src/lib/product-sellable-variants.ts` so product detail, JSON-LD, stock badges, and `/buy/{slug}` all classify simple/optioned/unavailable products through one resolver.

## Files

| Path | Description |
|------|-------------|
| `index.ts` | Public entry |
| `types.ts` | Zod schemas for single-SKU create/update and shared product/storefront projection types. |
| `media.ts` | Bounded association loader and the shared product/SKU image resolvers. |
| `option-model.ts` | Normalized option reads, assignment resolution, axis-ordered combination labels/keys, the five-axis/150-combination limits. |
| `variant-identity.ts` | Normalized SKU/barcode identity: the predicates that match the partial normalized barcode index exactly. |
| `public-eligibility.ts` | Shared public catalogue predicates and default simple-SKU values. Every buyer-facing surface uses these instead of checking only `products.isActive` and `products.deletedAt`. |
| `buyer-projection.ts`, `money.ts` | Integer buyer pricing and availability projections, store-currency helpers. |
| `low-stock-policy.ts` | A SKU's alert level (its own, else the store default from the `inventory` settings document) and the dashboard low/needs-restock conditions; the same level bands buyer availability, so it lives with the buyer rules. |
| `catalog-projections.ts` | `catalogProjectionRefreshStatements()` (both projections, per product) and `catalogBuyerStateRefreshStatementsForSkus()` (buyer state, per SKU, for stock writes): statements every product, SKU, stock and checkout batch appends after its ledger edge and CAS, at most 90 products each through one `json_each` parameter; `rebuildCatalogProjections()` recomputes them in keyset pages. Single-sourced from the buyer pricing projection and the public eligibility predicate. `catalog-projections.d1.test.ts` is the drift test. |
| `content-blocks.ts` | The `content_blocks` section (bounded list, `content_block` chunk read, replace with keep-by-id; strict `@scalius/shared/product-content-blocks` schemas, sanitised rich-text HTML, ready media checked and guarded in the batch) and the product page's one ordered block read. Tabs mirrored from `product_rich_content` (0090 triggers, id `pcb_<row id>`) are read-only here and keep their legacy ids on the page until the contract step drops that table. |
| `bundles.ts` | The `bundles` section (quantity tiers, whole taka, no gift cards) and the active-tier reads the product page and checkout price from. |
| `emi.ts` | The product page's "EMI on card payment, from X/month" line from the `emi` settings document; informational only. |
| `digital-stock-rules.ts` | A digital SKU's stock is its licence keys: every manual path (create, product/variant/option-matrix saves, inventory adjust and count, scanner, CSV import, purchase orders, transfers) refuses to change it with one `ValidationError` (`details.reason = "digital_stock_is_keys"`, `details.field` where there is one). A SKU turns digital only with no stock (or exactly its unused keys), and a digital SKU with a ready key pool keeps tracking. Batch guards keep it true against a racing kind or stock change. Key import/revoke and order flows still move the stock; gift cards keep their own rules (`gift-card-rules.ts`). Tests: `digital-stock.d1.test.ts` (here, `inventory/`, `store-transfer/digital-stock-import`). |


## API Endpoints

### Admin Attributes (`/api/v1/admin/attributes`)

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/` | inline | Paginated list with search, sort, trash toggle, value counts |
| POST | `/` | inline | Create attribute (name, slug, filterable, options) |
| PUT | `/{id}` | inline | Update attribute fields |
| DELETE | `/{id}` | inline | Soft delete (blocked if in use by products) |
| DELETE | `/{id}/permanent` | inline | Hard delete |
| POST | `/{id}/restore` | inline | Restore soft-deleted attribute |
| POST | `/bulk-delete` | inline | Bulk soft or permanent delete |
| POST | `/bulk-restore` | inline | Bulk restore |
| GET | `/{id}/values` | inline | List unique values with product counts, preset flags, sample products |
| POST | `/{id}/values` | inline | Add preset value to options array |
| PUT | `/{id}/values` | inline | Rename value across all products + options array |
| DELETE | `/{id}/values` | inline | Remove value from all products + options array |

### Storefront reads

See [catalog](../catalog/README.md#api-endpoints).

## Dependencies

### This module depends on:
- `@scalius/database/schema` -- products, normalized option definitions/values/assignments, variants, images, rich content, attributes, categories, orders, and inventory history
- `@scalius/core/search` -- `ftsMatch`, `sanitizeFtsQuery` for FTS5 full-text search
- `@scalius/core/errors` -- `NotFoundError`, `ConflictError`, `ValidationError`
- `drizzle-orm` -- query building, batch operations
- `nanoid` -- ID generation (prefixed: `prod_`, `img_`, `var_`, `prc_`, `val_`, `attr_`)
- `zod` -- validation schemas

### Depends on this module:
- `apps/api/src/routes/admin/products.ts` -- admin API routes
- `apps/api/src/routes/products.ts` -- storefront API routes
- `apps/admin-v2/src/lib/api-query-options/products.ts` -- dashboard queries (generated SDK)
- `apps/admin-v2/src/components/admin/ProductForm.tsx` -- admin form (generated SDK)
- `apps/admin-v2/src/components/admin/ProductView.tsx` -- admin product view (via route query, uses `info.title`/`info.content` for additionalInfo)
- `apps/admin-v2/src/components/admin/product-form/variants/` -- variant management (via fetch)
- `apps/storefront/src/lib/api/products.ts` -- storefront API client (via fetch, edge-cached)
- `apps/storefront/src/pages/products/[slug].astro` -- product detail page
