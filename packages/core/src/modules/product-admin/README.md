# Product admin

The dashboard's product editor. It creates, updates, duplicates, trashes and deletes products with their SKUs, option matrix, media, page sections and tax class. Every composition write runs under one aggregate revision. It also serves the admin product reads. Audience: contributors and coding agents.

The product model and its rules live in [`products`](../products/README.md). Stock movements live in [`inventory`](../inventory/README.md).

## Entries

`index.ts` is the only entry. There is no `browser.ts`. It re-exports every file. Main files:

- `write.ts` (create, update, duplicate), `variants.ts` (single-SKU writes, SKU and barcode identity checks), `lifecycle.ts` (trash, restore, permanent delete, bulk calls), `read.ts`.
- `option-matrix.ts`: `saveProductOptionMatrix` and `planProductOptionMatrix`, the atomic replace of options and SKUs.
- `aggregate-revision.ts`: the revision guard and bump, `ProductRevisionConflictError`.
- `semantic-sections.ts`: bounded named sections (`base`, `text`, `media`, `attributes`, `additional_info`, `options`, `variants`, `content_blocks`, `template`, `bundles`) for API and agent clients. `updateProductResourceSections` is the stable `products.update`: base fields, the whole gallery by media ids and the sales channels in one guarded batch.
- `sku-writes.ts`: one SKU at a time for the stable app API (`addProductSku`, `updateProductSku`, `restoreProductSku`), options named by value. A new or changed combination and a restore go through the option matrix (it adds a missing value, revives a retired combination's SKU row, prunes values no SKU uses); other SKU edits are `planVariantUpdate`. Stock never changes.
- `tax-classification.ts`: the tax class of a product or SKU. Classes and rates belong to `tax`.

## Layer and imports

- Layer L5. Imports `attributes`, `inventory`, `markets`, `products`, `settings` and `tax`.
- Imported by `store-transfer` and by the admin routes `products.ts`, `resources-products.ts`, `taxes.ts` and `orders/list.ts` (`apps/api/src/routes/admin/`).

## Aggregate revision

- `products.aggregate_revision` is the editor's concurrency token. Product reads and list rows return it.
- Every composition write sends `expectedAggregateRevision`. The write advances the revision exactly once in the same D1 batch (`buildProductAggregateRevisionGuard`, then `buildProductAggregateRevisionBump`) and returns the new value.
- A stale or wrong-state write fails with `409 product_revision_conflict` (carries expected and current revision) or `409 product_state_conflict`. Active edits cannot touch trash.
- Attribute value rewrites and category deletes advance affected products' revisions in their own batches, so an open editor goes stale.
- Operational stock and order writes do not touch the revision. They use SKU `stockVersion` and ledger v2.
- `createProduct` returns revision 1. A save that changes nothing writes nothing: no revision bump, no `updated_at`, no DVC key.
- For a product with options, the product `price_minor` equals the lowest live option SKU price. The bump re-derives it (`productPriceMinorSql`).

## Routes

Mounted at `/api/v1/admin/products` by `apps/api/src/routes/admin/products.ts`. Permissions are in `packages/core/src/auth/rbac/route-permissions/products.ts`.

| Method and path | Function | Permission |
|-----------------|----------|------------|
| `GET /`, `GET /summaries` | `listProducts`, `listProductAgentSummaries` | `products.view` |
| `GET /by-ids` | `getProductsByIds` (at most 100 ids) | `products.view` or `collections.view` |
| `GET /stats`, `GET /lookup-barcode` | `getProductStats`, `lookupByBarcode` | `products.view` |
| `POST /` | `createProduct` | `products.create` |
| `GET /{id}` | `getProductDetails` | `products.view` |
| `PUT /{id}` | `updateProduct` | `products.edit` |
| `DELETE /{id}` | `deleteProduct` (trash) | `products.delete` |
| `POST /{id}/duplicate` | `duplicateProduct` | `products.create` |
| `POST /{id}/restore` | `restoreProduct` | `products.restore` |
| `DELETE /{id}/permanent` | `permanentlyDeleteProduct` | `products.permanent_delete` |
| `POST /bulk-delete`, `POST /bulk-update` | `bulkDeleteProducts`, `bulkUpdateProducts` | `products.bulk_operations` |
| `GET, POST /{id}/variants` | `getProductVariants`, `createVariant` | `products.view`, `products.edit` |
| `PUT, DELETE /{id}/variants/{variantId}` | `updateVariant`, `deleteVariant` | `products.edit` |
| `PUT /{id}/options/matrix` | `saveProductOptionMatrix` | `products.edit` |
| `GET, PATCH /{id}/sections/{section}` | `getProductSemanticSection`, `updateProductSemanticSection` | `products.view`, `products.edit` |

- `GET /` takes `page` (reaches the first 1,000 rows, 10,000 on a Paid plan profile) or `after` and `before` cursors. A text search ranks by relevance, pages by position and also matches an exact SKU barcode, case-insensitively.
- Tax classification routes live in `admin/taxes.ts`: `GET /api/v1/admin/taxes/classifications` (`taxes.view`) and `PUT /api/v1/admin/taxes/classifications/{kind}/{id}` (`taxes.manage`). The write needs `expectedVersion` and `expectedAggregateRevision`.
- Setting a cost per item (`cost`, `skuCosts`) needs `products.view_costs` (`apps/api/src/routes/admin/cost-access.ts`).

## Rules

### Saves

- One editor Save is all-or-nothing. `updateProduct` accepts the details plus `optionMatrix` or `defaultSku`, `contentBlocks`, `bundles`, `pageTemplate`, `emiEligible` and `skuCosts`. It checks everything first, then writes one guarded batch.
- `updateProduct` replaces attribute values and legacy rich content. It diffs media by association id, so kept images keep their ids.
- Removing a gallery image that SKUs still use needs the id in `acknowledgedSkuImageRemovalIds`. Those SKUs then fall back to the product image (`image_id = NULL`).
- Product media: at most 250 items, exactly one featured, new items must be ready, an existing association cannot change its asset.
- An active product needs a price above 0 on the product and on every option SKU.
- `duplicateProduct` copies a product as an inactive draft with no stock, new SKUs (`…-COPY`) and fresh generated barcodes. It copies cost per item, alert level, backorder and preorder policy, tax class, content blocks, bundles and custom fields in namespace `custom`.

### SKUs and inventory

- A product created without options takes optional `defaultSku` facts. Opening stock is a ledger-v2 movement claim plus a `stockVersion` CAS in the create batch, at the default location.
- Quantity edits are compare-and-set. Send `stock` with the `expectedStockVersion` it was based on. Omit `stock` to keep the quantity. A mismatch fails and writes nothing.
- Simple to options: `saveProductOptionMatrix` soft-retires the default SKU. Its tracked physical units must be allocated exactly across the new tracked SKUs at the default location. Reserved or preorder units block it. A digital default SKU's stock cannot split.
- Replacing combinations must keep the tracked stock total. Retiring a combination needs no reserved or preorder units and no open order line. A retired combination that comes back reuses its old SKU row and stock. Two retired SKUs with one combination fail closed.
- The matrix needs 1 to 5 axes and at most 150 combinations. Every submitted value must be used by an active SKU. Each axis has a unique name. Each standard mapping other than `none` appears once. SKU and barcode values are unique inside the request.
- `deleteVariant` always soft-retires. It refuses the default SKU, reserved stock, open order lines and the final option SKU of an active product. A guard re-checks inside the batch. A SKU referenced by orders or movements is never hard-deleted, in single or bulk deletes.

### Trash and delete

- Trash and restore need the current revision. Restoring an active product with no live SKU recreates the default SKU.
- Permanent delete needs a trashed product and the current revision. It is blocked (409) when any order line references the product or its SKUs, or any SKU has inventory movements, purchase order lines or transfer lines. Keep such products in trash.
- Bulk calls take at most 90 claims. Bulk trash is one batch. Bulk permanent delete runs one guarded batch per product, in order, and returns `deleted`, `blocked` or `failed` for each.
- Bulk update sets `isActive` or `categoryId`. Activating skips products with a price at or below 0 (`needs_price`). A product that already has the values keeps its revision.

