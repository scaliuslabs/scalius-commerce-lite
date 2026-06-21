# Products Core Module

Product CRUD, variant management, image handling, rich content (additional info), product attributes, barcode support, and storefront queries. Split across three service files by consumer: admin, storefront, and variant-specific operations.

## Features

- Paginated product listing with FTS5 full-text search (admin + storefront)
- Barcode-aware search: auto-detects digit-only 8-13 char queries and searches by exact barcode match in addition to FTS
- Product CRUD with slug uniqueness enforcement
- Soft delete / restore / permanent delete lifecycle with order/discount safety checks
- Bulk soft-delete and bulk permanent-delete with order/discount guards
- Product images: ordered, first = primary, stored via `productImages` table
- Rich content sections (additional info): arbitrary titled HTML blocks stored in `productRichContent`, ordered by `sortOrder`
- Product attributes: many-to-many via `productAttributeValues`, linked to global `productAttributes` definitions
- Variant CRUD: size, color, weight, SKU (unique), price, stock, barcode, barcode type, discount (percentage or flat)
- Variant duplicate with auto-incrementing SKU suffix (`-COPY`, `-COPY2`, etc.)
- Bulk variant create (chunked at 50 per insert), bulk delete, bulk update
- Variant sort order: separate `colorSortOrder` and `sizeSortOrder` columns, updated per-value across all variants of a product
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
- SKU-first purchasability: every sellable product must have a real `productVariants` row. Simple products use one hidden/default SKU (`isDefault = true`, no size/color); optioned products require an explicit selected SKU; SKU-less or ambiguous no-option products fail closed. Merchant-created variants must include at least one customer option (`size` or `color`) so the hidden simple SKU stays the only no-option SKU. The storefront no longer synthesizes fake `default` variants.
- Storefront buyer availability uses `apps/storefront/src/lib/product-sellable-variants.ts` so product detail, JSON-LD, stock badges, and `/buy/{slug}` all classify simple/optioned/unavailable products through one resolver.

## Data Flow

```
Admin UI (ProductForm.tsx)
  --> fetch(/api/v1/admin/products) [POST/PUT]
    --> apps/api/src/routes/admin/products.ts [Hono route, Zod validation]
      --> packages/core/src/modules/products/products.admin.ts [createProduct/updateProduct]
        --> D1 batch: products + productImages + productRichContent + productAttributeValues

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
| `products.types.ts` | Zod schemas for variant operations (`createVariantSchema`, `updateVariantSchema`, `bulkVariantSchema`, `bulkCreateVariantsSchema`, `bulkDeleteVariantsSchema`, `bulkUpdateVariantsSchema`, `updateSortOrderSchema`) and TypeScript interfaces (`ProductWithDetails`, `ProductListItem`, `StorefrontProductFilterInput`). Discount percentage capped at 0-100 in all schemas. |
| `products.validation.ts` | Zod schemas for product create/update: `createProductSchema`, `updateProductSchema` with shared sub-schemas for images, attributes (`{attributeId, value}`), and additional info (`{id, title, content, sortOrder}`). Discount percentage capped at 0-100. |
| `products.admin.ts` | Admin read queries (`getProducts`, `getProductDetails`, `getProductStats`, `getCategoryStats`) and write mutations (`createProduct`, `updateProduct`, `deleteProduct`, `restoreProduct`, `permanentDeleteProduct`, `bulkDeleteProducts`, `bulkUpdateVariants`). `getProducts` returns `discountType` and `discountAmount`. `getProductDetails` fetches `productRichContent` and `productAttributeValues`. All variant queries filter `deletedAt IS NULL`. |
| `products.storefront.ts` | Storefront read queries (`getStorefrontProducts`, `getStorefrontProductBySlug`, `searchStorefrontProducts`) with discount calculation (percentage and flat), feature extraction, SKU/default-SKU metadata, and attribute-based filtering. All variant queries filter `isNull(deletedAt)`; buyer purchase flows must use real variant rows and cart validation as inventory proof. |
| `products.variants.ts` | Variant-specific operations (`lookupByBarcode`, `getProductVariants`, `createVariant`, `updateVariant`, `deleteVariant`, `duplicateVariant`, `bulkCreateVariants`, `bulkDeleteVariants`, `getVariantSortOrder`, `updateVariantSortOrder`). All queries filter soft-deleted variants. Normal variants must have a customer option; hidden/simple default SKUs cannot be duplicated or converted into option rows through this API. |

## API Endpoints

### Admin Products (`/api/v1/admin/products`)

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/stats` | `getProductStats` | Dashboard stats: total, active, with-images, category count |
| GET | `/lookup-barcode?barcode=X` | `lookupByBarcode` | Find variant + product by exact barcode |
| GET | `/` | `getProducts` | Paginated list with FTS search, category filter, sort, trash toggle. Returns `discountType`, `discountAmount`, `discountPercentage` per product. |
| POST | `/` | `createProduct` | Create product with images, attributes, rich content |
| POST | `/bulk-delete` | `bulkDeleteProducts` | Soft or permanent bulk delete |
| GET | `/{id}` | `getProductDetails` | Full product with variants (soft-deleted filtered), images, additionalInfo (`{id, title, content, sortOrder}`), attributes (`{attributeId, value}`) |
| PUT | `/{id}` | `updateProduct` | Replace product + images + attributes + rich content |
| DELETE | `/{id}` | `deleteProduct` | Soft delete (set deletedAt) |
| POST | `/{id}/restore` | `restoreProduct` | Clear deletedAt |
| DELETE | `/{id}/permanent` | `permanentDeleteProduct` | Hard delete with order/discount guards |
| POST | `/{id}/variants` | `createVariant` | Create single variant |
| GET | `/{id}/variants` | `getProductVariants` | List variants for product (soft-deleted filtered) |
| PUT | `/{id}/variants/{variantId}` | `updateVariant` | Update single variant |
| DELETE | `/{id}/variants/{variantId}` | `deleteVariant` | Hard delete variant |
| POST | `/{id}/variants/bulk-create` | `bulkCreateVariants` | Bulk create (chunked at 50) |
| POST | `/{id}/variants/bulk-delete` | `bulkDeleteVariants` | Bulk hard delete |
| POST | `/{id}/variants/bulk-update` | `bulkUpdateVariants` | Bulk update fields |
| POST | `/{id}/variants/{variantId}/duplicate` | `duplicateVariant` | Clone variant with new SKU |
| GET | `/{id}/variants/sort-order` | `getVariantSortOrder` | Get color/size sort order |
| POST | `/{id}/variants/sort-order` | `updateVariantSortOrder` | Set color/size sort order |

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
| GET | `/` | `getStorefrontProducts` | Paginated list with category, search, price range, freeDelivery, hasDiscount, attribute filters, sort |
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

2. **Variant sort order updates are not batched**: `updateVariantSortOrder()` in `products.variants.ts` runs individual UPDATE queries per color and per size value rather than using `db.batch()`, which could be slow for many distinct values.

3. **Admin attributes route has inline logic**: Unlike products where logic lives in `@scalius/core`, the attributes admin routes (`apps/api/src/routes/admin/attributes.ts`) contain all business logic inline in the route handlers rather than delegating to a core service module.

4. **Variant images feature uses HTML comment marker**: The variant-images-enabled flag is stored as `<!--variant_images:enabled-->` appended to `metaDescription`. Both admin and storefront parse this marker. This piggybacks on an SEO field for unrelated feature flagging.

5. **Simple/optioned transitions need a guided stock workflow**: The backend is SKU-first. Admin edit now presents one protected default no-option SKU as an `Inventory & SKU` panel, hides that SKU from optioned product tables, and rejects non-default/no-option SKUs everywhere new option rows can be created. The remaining workflow gap is deliberate conversion UX: merchants need explicit stock/price copy-or-merge choices when a tracked simple SKU becomes optioned, and an optioned -> simple flow with cached-cart invalidation guidance.

## Inventory Rules

- Migration `0055_default_sku_inventory_tracking` established the SKU-first columns/backfill. Migration `0057_simple_sku_legacy_repair` was a one-time data repair that gave active SKU-less products a protected untracked default SKU. Current runtime rules are strict: protected default SKUs must stay optionless, and every non-default SKU must expose at least one customer option.
- Product variant edit and bulk edit split `stock` out of ordinary metadata writes. Existing-SKU stock changes must batch the movement claim with the guarded variant stock/`stockVersion` update so `inventory_movements`, stock, and low-stock checks stay in sync.
- Variant duplication copies merchandising fields only. The new SKU starts with zero physical stock; merchants must perform an explicit stocktake/adjustment to add sellable quantity.

## Dependencies

### This module depends on:
- `@scalius/database/schema` -- `products`, `productVariants`, `productImages`, `productRichContent`, `productAttributes`, `productAttributeValues`, `categories`, `orderItems`, `discountProducts`
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
