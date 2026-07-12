# Products Core Module

Product CRUD, variant management, ordered image/video associations, rich content (additional info), product attributes, barcode support, and storefront queries.

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
- Storefront product detail: parallel fetching of images, variants, rich content, attributes, category, and up to 6 related products from same category
- Storefront search: lightweight variant-aware product search for cart/checkout use
- Discounted price calculation supporting both percentage and flat discount types
- Feature extraction from description (parses bullet-point lines)
- SKU-first purchasability: every sellable product has a persisted `productVariants` row. Simple products use exactly one protected default SKU with no option assignments. Optioned products use non-default SKUs whose assignment set contains exactly one active value for every active product option; incomplete, mixed-shape, or fake default rows fail closed.
- Product options are arbitrary merchant-defined axes, not fixed size/color slots. An axis may explicitly map to `size`, `color`, `material`, `pattern`, or `none` for catalog standards; each non-`none` mapping can be claimed by only one axis. Combination identity is the axis-ordered option-value ID sequence, independent of request order.
- Product editor concurrency is aggregate-versioned. Admin detail and list/trash rows expose `aggregateRevision`; every direct product-editor mutation requires `expectedAggregateRevision`, increments the product revision exactly once in the same D1 batch, and returns the new revision. External category/attribute/tax cascades bump affected product revisions atomically so an open editor becomes stale. Stale direct writes fail with `PRODUCT_REVISION_CONFLICT` and safe expected/current revision details. Operational inventory transitions remain separately guarded by SKU `stockVersion` and ledger v2.
- SKU and barcode writes trim values and use global case-insensitive identity. New SKUs without a merchant barcode receive a stable internal `code128` identity; retail barcode types validate supported shape/checksum rules, and discovery outputs whitelist only true retail identifiers. Migration 0006 installs normalized unique indexes plus canonical row triggers, and scanner/admin lookup uses those indexed identities.
- Public catalog eligibility is centralized in `products.public-eligibility.ts`: storefront lists/details/search, global search, filterable attributes, and collection/homepage product resolution must all require a buyer-resolvable active SKU topology, while stock availability remains a separate display/checkout concern. Buyer-facing `hasVariants` means at least one non-default SKU with a real customer option, not the protected default SKU. Public product lists also project `availableForSale` from the same SKU topology (`trackInventory = false` or positive `stock - reservedStock`), so catalog feeds can match product-page JSON-LD and checkout availability without variant N+1 reads. The dedicated feed projection carries `canonicalPath`, option-axis mapping, and supported variant barcode fields so storefront XML can emit canonical product links, `variant_option` pairs, ProductGroup-compatible standard attributes, and true GTINs without expanding normal listing cards.
- Storefront buyer availability uses `apps/storefront/src/lib/product-sellable-variants.ts` so product detail, JSON-LD, stock badges, and `/buy/{slug}` all classify simple/optioned/unavailable products through one resolver.

## Data Flow

```
Admin UI (ProductForm.tsx)
  --> fetch(/api/v1/admin/products) [POST/PUT]
    --> apps/api/src/routes/admin/products.ts [Hono route, Zod validation]
      --> packages/core/src/modules/products/products.admin.ts [createProduct/updateProduct]
        --> D1 batch: products + productMedia + productRichContent + productAttributeValues

Admin option-matrix editor
  --> PUT /api/v1/admin/products/{id}/options/matrix
    --> saveProductOptionMatrix()
      --> validate active matrix subset + identities + image ownership + discounts
      --> D1 batch: option definitions/values + SKU rows/assignments + stock ledger + one aggregate revision bump

Admin UI (ProductView.tsx)
  --> Astro loader: getProductViewData()
    --> apiGet(/products/:id)
      --> getProductDetails()
        --> D1: product + variants (filtered: deletedAt IS NULL) + images + richContent + attributeValues
        --> Returns ProductWithDetails with additionalInfo [{id, title, content, sortOrder}] and attributes [{attributeId, value}]

Storefront ([slug].astro)
  --> apps/storefront/src/lib/api/products.ts [getProductBySlug, edge-cached]
    --> fetch(/api/storefront/products/:slug)
      --> apps/api/src/routes/products.ts [Hono route, 1h cache middleware]
        --> packages/core/src/modules/products/products.storefront.ts [getStorefrontProductBySlug]
          --> D1: parallel queries for images, variants, richContent, attributes, category, relatedProducts
        --> apps/storefront/src/lib/product-sellable-variants.ts [buyer-visible SKU resolver]
          --> simple: one active no-option SKU; optioned: customer-option SKUs only; fake "default"/ambiguous rows fail closed

Storefront category ([slug].astro)
  --> apps/storefront/src/lib/api/products.ts [getProductsByCategory, edge-cached]
    --> fetch(/api/v1/categories/:slug/products)
      --> apps/api/src/routes/categories.ts [resolves category + query attribute filters]
        --> packages/core/src/modules/products/products.storefront.ts [getStorefrontCategoryProducts]
          --> D1: shared public predicates/sort/attribute filtering + category-scoped rows/count + primary images
```

## Files

| File | Description |
|------|-------------|
| `index.ts` | Barrel re-exports from all submodules |
| `products.types.ts` | Zod schemas for single-SKU create/update operations and shared product/storefront projection types. |
| `products.validation.ts` | Zod schemas for product create/update, including stable ordered media association IDs, exactly-one-featured validation, attributes, and additional info. |
| `products.media.ts` | Bounded association loader and the shared pure product/SKU image representation resolvers. |
| `products.option-model.ts` | Normalized option reads, assignment resolution, axis-ordered combination labels/keys, and the five-axis/150-combination limits. |
| `products.option-matrix.ts` | Active matrix-subset validation and atomic save. Owns arbitrary axes, potential-combination limits, used-value/unique-combination invariants, unique standard mappings, canonical combination order, per-SKU image ownership, SKU/barcode conflicts, discount consistency, stock allocation, assignment replacement, and safe retirement. |
| `products.public-eligibility.ts` | Shared public catalog predicates and default simple-SKU values. Any storefront/catalog/search surface that exposes buyer product cards must use these predicates instead of checking only `products.isActive` and `products.deletedAt`. |
| `products.admin.ts` | Admin read queries (`getProducts`, `getProductDetails`, `getProductStats`, `getCategoryStats`) and product write mutations (`createProduct`, `updateProduct`, `deleteProduct`, `restoreProduct`, `permanentDeleteProduct`, `bulkDeleteProducts`). `getProducts` returns `discountType` and `discountAmount`. `getProductDetails` fetches `productRichContent` and `productAttributeValues`. All variant queries filter `deletedAt IS NULL`. |
| `products.storefront.ts` | Storefront read queries (`getStorefrontProducts`, `getStorefrontProductBySlug`, `searchStorefrontProducts`) with discount calculation (percentage and flat), feature extraction, SKU/default-SKU metadata, and attribute-based filtering. All variant queries filter `isNull(deletedAt)`; buyer purchase flows must use real variant rows and cart validation as inventory proof. |
| `products.variants.ts` | Single-SKU operations (`lookupByBarcode`, `getProductVariants`, `createVariant`, `updateVariant`, `deleteVariant`) and shared normalized identity/axis guards. All reads filter soft-deleted variants; deletion rejects active reservations/open orders and preserves audit history. |

## API Endpoints

### Admin Products (`/api/v1/admin/products`)

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/stats` | `getProductStats` | Dashboard stats: total, active, with-images, category count |
| GET | `/lookup-barcode?barcode=X` | `lookupByBarcode` | Find the database-unique normalized barcode identity and its product |
| GET | `/` | `getProducts` | Paginated list with FTS search, category filter, sort, trash toggle. Returns `discountType`, `discountAmount`, `discountPercentage` per product. |
| POST | `/` | `createProduct` | Create product with images, attributes, rich content |
| POST | `/bulk-delete` | `bulkDeleteProducts` | Soft or permanent bulk delete |
| GET | `/{id}` | `getProductDetails` | Full product with variants (soft-deleted filtered), images, additionalInfo (`{id, title, content, sortOrder}`), attributes (`{attributeId, value}`) |
| PUT | `/{id}` | `updateProduct` | Replace product + images + attributes + rich content |
| DELETE | `/{id}` | `deleteProduct` | Soft delete (set deletedAt) |
| POST | `/{id}/restore` | `restoreProduct` | Clear deletedAt; active products with zero active SKUs are repaired with the protected simple SKU before they can re-enter public catalog reads |
| DELETE | `/{id}/permanent` | `permanentDeleteProduct` | Hard delete with order/discount guards |
| POST | `/{id}/variants` | `createVariant` | Create single variant |
| GET | `/{id}/variants` | `getProductVariants` | List variants for product (soft-deleted filtered) |
| PUT | `/{id}/variants/{variantId}` | `updateVariant` | Update single variant |
| DELETE | `/{id}/variants/{variantId}` | `deleteVariant` | Soft-delete the SKU after transactional reservation/open-order/final-option guards |
| PUT | `/{id}/options/matrix` | `saveProductOptionMatrix` | Atomically replace the complete normalized option definition/value/SKU matrix |

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

### Storefront Products (`/api/storefront/products`)

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/` | `getStorefrontProducts` | Paginated list with category, search, price range, freeDelivery, hasDiscount, attribute filters, sort, `hasVariants`, and SKU-aware `availableForSale` |
| GET | `/feed` | `getStorefrontFeedProducts` | Dedicated feed projection with description, primary image, category summary, filterable attributes, SKU-aware availability, and buyer-safe variants bulk-read for the current page |
| GET | `/search` | `searchStorefrontProducts` | Lightweight search with variants for cart/checkout |
| GET | `/{slug}` | `getStorefrontProductBySlug` | Full product detail with variants, images, attributes, additionalInfo, relatedProducts |

### Storefront Category Products (`/api/v1/categories`)

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/{slug}/products` | `getStorefrontCategoryProducts` | Category-scoped product list using shared public list filtering/sort helpers, preserving the category-products response shape |

### Storefront Attributes (`/api/storefront/attributes`)

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/filterable` | inline | All filterable attributes with their unique values (1h cache) |
| GET | `/category/{categoryId}` | inline | Filterable attributes scoped to a category by ID (30m cache) |
| GET | `/category-slug/{categorySlug}` | inline | Filterable attributes scoped to a category by slug (30m cache) |
| GET | `/search-filters?q=X&categoryId=Y` | inline | Filterable attributes for search results (based on matching product categories) |

## Known Gaps

1. **Update is delete-and-reinsert for images/attributes/richContent**: `updateProduct()` deletes ALL images, attributes, and rich content then re-inserts. This means image IDs change on every save (unless the admin passes the original ID and it doesn't start with `temp_`).

2. **Admin attributes route has inline logic**: Unlike products where logic lives in `@scalius/core`, the attributes admin routes (`apps/api/src/routes/admin/attributes.ts`) contain business logic inline rather than delegating to a core service module.

3. **Optioned -> simple remains an explicit future workflow**: Simple -> optioned requires exact allocation of tracked default-SKU stock and blocks while reservations/preorders exist. The reverse transition still needs a deliberate stock merge and cached-cart invalidation policy; do not infer it by deleting the final option SKU.

## Inventory Rules

- `isDefault` is the simple-SKU authority. Every non-default SKU must have an axis-ordered `optionCombinationKey` and one assignment row per active option definition.
- Option-matrix stock edits batch a stock-version guard, movement claim, SKU update, and aggregate revision bump. A tracked default SKU can become optioned only when its entire on-hand quantity is allocated across tracked option rows; its stock is then deducted in the same batch. Topology edits that retire and create combinations must also preserve the affected tracked-stock total.
- Variant delete and bulk delete must preserve order/inventory history. SKUs with `reservedStock > 0` or non-terminal order references are rejected; SKUs referenced only by terminal `order_items` history or `inventory_movements` are soft-deleted with a zero-reservation guard; only unused, unreserved SKUs may be hard-deleted.
- Product permanent delete must preserve SKU audit history too. If any SKU under the product has `inventory_movements`, the hard delete is blocked and the merchant should keep the product trashed/soft-deleted; only movement-free products may delete their variants and low-stock alerts permanently.
- Optioned SKUs for one product cannot mix shapes: every active combination selects one value from every active arbitrary axis.
- Variant duplication copies merchandising fields only. The new SKU starts with zero physical stock; merchants must perform an explicit stocktake/adjustment to add sellable quantity.

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
- `apps/admin-v2/src/loaders/admin/products.ts` -- SSR data loaders
- `apps/admin-v2/src/components/admin/ProductForm.tsx` -- admin form (via fetch)
- `apps/admin-v2/src/components/admin/ProductView.tsx` -- admin product view (via loader, uses `info.title`/`info.content` for additionalInfo)
- `apps/admin-v2/src/components/admin/product-form/variants/` -- variant management (via fetch)
- `apps/storefront/src/lib/api/products.ts` -- storefront API client (via fetch, edge-cached)
- `apps/storefront/src/pages/products/[slug].astro` -- product detail page
