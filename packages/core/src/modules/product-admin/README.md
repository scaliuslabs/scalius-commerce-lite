# Product Admin Module

The dashboard's product editor: the merchant-edited product aggregate. Product create/update/duplicate (media associations, attributes, rich content, semantic sections), SKUs and the option matrix, trash/restore/permanent delete, the admin product reads, and the tax class a product or SKU carries, all under one aggregate revision. Opening and edited stock are written to the inventory ledger (movement claims, default location, unit costs) in the same batch, so this module sits above both [`../products`](../products/README.md) (the product model and rules) and [`../inventory`](../inventory/README.md).

Public entry: `index.ts`. Consumers: the admin product and tax routes, store transfer (product import) and the cache-dependency test actions.

## Data Flow

```
Admin UI (ProductForm.tsx)
  --> fetch(/api/v1/admin/products) [POST/PUT]
    --> apps/api/src/routes/admin/products.ts [Hono route, Zod validation]
      --> packages/core/src/modules/product-admin/write.ts [createProduct/updateProduct]
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
        --> D1: product + variants (filtered: deletedAt IS NULL) + ordered productMedia/media projections + richContent + attributeValues
        --> Returns ProductWithDetails with additionalInfo [{id, title, content, sortOrder}] and attributes [{attributeId, value}]

Storefront ([slug].astro)
  --> apps/storefront/src/lib/api/products.ts [getProductBySlug, edge-cached]
    --> fetch(/api/storefront/products/:slug)
      --> apps/api/src/routes/products.ts [Hono route, 1h cache middleware]
        --> packages/core/src/modules/catalog/product-page.ts [getStorefrontProductBySlug]
          --> D1: parallel queries for ordered product media, variants, richContent, attributes, category, recommendations
        --> apps/storefront/src/lib/product-sellable-variants.ts [buyer-visible SKU resolver]
          --> simple: one active no-option SKU; optioned: customer-option SKUs only; fake "default"/ambiguous rows fail closed

Storefront category ([slug].astro)
  --> apps/storefront/src/lib/api/products.ts [getProductsByCategory, edge-cached]
    --> fetch(/api/v1/categories/:slug/products)
      --> apps/api/src/routes/categories.ts [resolves category + query attribute filters]
        --> packages/core/src/modules/catalog/listing.ts [getStorefrontCategoryProducts]
          --> D1: shared public predicates/sort/attribute filtering + category-scoped rows/count + primary images
```

## Files

| Path | Purpose |
|------|---------|
| `validation.ts` | Zod schemas for product create/update: ordered media association ids, exactly-one-featured, attributes, additional info. |
| `read.ts` | `listProducts`, `listProductAgentSummaries`, `getProductsByIds`, `getProductDetails`, `getProductStats`, `getCategoryStats`. |
| `write.ts` | `createProduct`, `updateProduct`, `updateProductMediaSection`, `duplicateProduct` under the aggregate revision. |
| `lifecycle.ts` | `deleteProduct`, `restoreProduct`, `permanentlyDeleteProduct`, `bulkDeleteProducts`, `bulkUpdateProducts`. |
| `option-matrix.ts` | Active matrix-subset validation and atomic save (identities, images, discounts, stock allocation, safe retirement). |
| `variants.ts` | Single-SKU operations (create, update with stock CAS, delete, barcode lookup) under the aggregate revision. |
| `aggregate-revision.ts` | The product editor's revision claim and bump. |
| `semantic-sections.ts` | Named product-editor sections (details, media, SEO, content blocks, template, bundles, ...) saved under the aggregate revision. |
| `tax-classification.ts` | The tax class a product or SKU carries: the classification list and the guarded change under the aggregate revision (classes and rates themselves are the tax domain's). |

## API Endpoints

### Admin Products (`/api/v1/admin/products`)

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/stats` | `getProductStats` | Dashboard stats: total, active, with-images, category count |
| GET | `/lookup-barcode?barcode=X` | `lookupByBarcode` | Find the database-unique normalized barcode identity and its product |
| GET | `/` | `getProducts` | Paginated list with FTS search, category filter, sort, trash toggle. Returns `discountType`, `discountAmount`, `discountPercentage` per product. |
| POST | `/` | `createProduct` | Create product with images, attributes, rich content |
| POST | `/bulk-delete` | `bulkDeleteProducts` | Soft delete is aggregate-atomic. Permanent delete runs one guarded product batch at a time and returns ordered `deleted`/`blocked`/`failed` outcomes so safe rows are not rolled back by one retained-history row. |
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

## Known Gaps

1. **Update is delete-and-reinsert for images/attributes/richContent**: `updateProduct()` deletes ALL images, attributes, and rich content then re-inserts. This means image IDs change on every save (unless the admin passes the original ID and it doesn't start with `temp_`). A save whose aggregate equals the stored one (product columns, default SKU, SKU fulfilment kinds, media, attribute values, rich content) writes nothing and returns the current revision: no revision bump, no `updated_at`, no cache dependency key (`no-op-save.d1.test.ts`).

2. **Admin attributes route has inline logic**: Unlike products where logic lives in `@scalius/core`, the attributes admin routes (`apps/api/src/routes/admin/attributes.ts`) contain business logic inline rather than delegating to a core service module.

3. **Optioned -> simple remains an explicit future workflow**: Simple -> optioned requires exact allocation of tracked default-SKU stock and blocks while reservations/preorders exist. The reverse transition still needs a deliberate stock merge and cached-cart invalidation policy; do not infer it by deleting the final option SKU.

## Inventory Rules

- `isDefault` is the simple-SKU authority. Every non-default SKU must have an axis-ordered `optionCombinationKey` and one assignment row per active option definition.
- A product created without options takes optional `defaultSku` inventory (`trackInventory`, opening `stock`, optional `sku`); opening stock is a movement claim plus `stockVersion` CAS in the create batch. Omitting it keeps the untracked default. The dashboard edits that SKU through the variant update route.
- Editor quantity writes (variant update and every saved option-matrix row) are compare-and-set: omit `stock` to keep the current on-hand quantity, or send `stock` with the `expectedStockVersion` it was based on. A mismatch fails with "Stock changed since you opened this product. Reload to see the latest." and writes nothing, so a sale made while the editor was open is never overwritten. Unchanged matrix rows never rewrite `stock`.
- Option-matrix stock edits batch a stock-version guard, movement claim, SKU update, and aggregate revision bump. A tracked default SKU can become optioned only when its entire on-hand quantity is allocated across tracked option rows; its stock is then deducted in the same batch. Topology edits that retire and create combinations must also preserve the affected tracked-stock total.
- Variant delete and bulk delete must preserve order/inventory history. SKUs with `reservedStock > 0` or non-terminal order references are rejected; SKUs referenced only by terminal `order_items` history or `inventory_movements` are soft-deleted with a zero-reservation guard; only unused, unreserved SKUs may be hard-deleted.
- Product permanent delete must preserve SKU audit history too. If any SKU under the product has `inventory_movements`, the hard delete is blocked and the merchant should keep the product trashed/soft-deleted; only movement-free products may delete their variants and low-stock alerts permanently.
- Bulk permanent delete accepts at most 90 product claims, processes them sequentially to respect Worker/D1 connection limits, and isolates every product's revision/reference guard plus deletes in one D1 batch. Large SKU lookup sets use bound `json_each()` arrays rather than one SQL variable per SKU. The API returns per-row outcomes; the admin deselects only successfully deleted rows and leaves blocked/failed rows selected for retry or inspection.
- Live incident proof (2026-07-13): 31 selected trashed demo products owned 76 SKU rows. The former combined low-stock cleanup attempted 107 bound variables and failed D1's 100-variable statement limit before any useful row outcome reached the admin. The regression suite now proves a 150-SKU product uses two JSON lookup bindings and proves a failed product batch does not stop the next safe product.
- Optioned SKUs for one product cannot mix shapes: every active combination selects one value from every active arbitrary axis.
- Variant duplication copies merchandising fields only. The new SKU starts with zero physical stock; merchants must perform an explicit stocktake/adjustment to add sellable quantity.

