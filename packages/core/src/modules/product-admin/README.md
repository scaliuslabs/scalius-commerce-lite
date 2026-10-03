# Product admin

The dashboard's product editor. It creates, updates, duplicates, trashes and deletes products with their SKUs, option matrix, media, page sections and tax class. Every composition write runs under one aggregate revision. It also serves the admin product reads. Audience: contributors and coding agents.

The product model and its rules live in [`products`](../products/README.md). Stock movements live in [`inventory`](../inventory/README.md).

## Entries

- `index.ts` is the only entry. There is no `browser.ts`. It re-exports every file in the table below.

| File | Owns |
|------|------|
| `write.ts` | `createProduct`, `updateProduct`, `updateProductMediaSection`, `duplicateProduct`. |
| `variants.ts` | Single-SKU writes (`createVariant`, `updateVariant`, `deleteVariant`), SKU and barcode identity checks, `lookupByBarcode`, `getProductVariants`. |
| `option-matrix.ts` | `saveProductOptionMatrix` and `planProductOptionMatrix`: the atomic replace of options and SKUs, stock allocation, retirement and restore of combinations. |
| `lifecycle.ts` | `deleteProduct` (trash), `restoreProduct`, `permanentlyDeleteProduct`, `bulkDeleteProducts`, `bulkUpdateProducts`. |
| `aggregate-revision.ts` | The revision guard and bump, `executeProductAggregateMutationBatch`, `ProductRevisionConflictError`. |
| `semantic-sections.ts` | Bounded named sections (`base`, `text`, `media`, `attributes`, `additional_info`, `options`, `variants`, `content_blocks`, `template`, `bundles`) for API and agent clients. |
| `read.ts` | `listProducts`, `listProductAgentSummaries`, `getProductsByIds`, `getProductDetails`, `getProductStats`, `getCategoryStats`. |
| `validation.ts` | `createProductSchema` and `updateProductSchema`. |
| `tax-classification.ts` | `listTaxClassifications` and `updateTaxClassification`: the tax class of a product or SKU. Classes and rates belong to the `tax` domain. |

## Layer and imports

- Layer L4. Imports `attributes`, `inventory`, `products`, `settings` and `tax`.
- Imported by `store-transfer` and by three admin routes under `apps/api/src/routes/`: `admin/products.ts`, `admin/taxes.ts` and `admin/orders/list.ts`.

## Aggregate revision

- `products.aggregate_revision` is the editor's concurrency token. Product reads and list rows return it.
- Every composition write sends `expectedAggregateRevision`. The write advances the revision exactly once in the same D1 batch (`buildProductAggregateRevisionGuard`, then `buildProductAggregateRevisionBump`). It returns the new value.
- A stale or wrong-state write fails with `409 PRODUCT_REVISION_CONFLICT` (carries expected and current revision) or `409 PRODUCT_STATE_CONFLICT`. Active edits cannot touch trash.
- Attribute value rewrites and category deletes advance affected products' revisions in their own batches, so an open editor goes stale.
- Operational stock and order writes do not touch the revision. They use SKU `stockVersion` and ledger v2.
- `createProduct` returns revision 1. A save that changes nothing writes nothing: no revision bump, no `updated_at`, no DVC key (`no-op-save.d1.test.ts`).
- The batch ends with the gift-card rules guard and the catalogue projection refresh, which read the batch's own writes.
- For a product with options, the product `price_minor` equals the lowest live option SKU price. The bump re-derives it (`productPriceMinorSql`).

## Routes

Mounted at `/api/v1/admin/products` by `apps/api/src/routes/admin/products.ts`. Permissions are in `packages/core/src/auth/rbac/route-permissions/products.ts`.

| Method and path | Function | Permission |
|-----------------|----------|------------|
| `GET /` | `listProducts` | `products.view` |
| `GET /summaries` | `listProductAgentSummaries` | `products.view` |
| `GET /by-ids` | `getProductsByIds` (at most 100 ids) | `products.view` or `collections.view` |
| `GET /stats`, `GET /lookup-barcode` | `getProductStats`, `lookupByBarcode` | `products.view` |
| `POST /` | `createProduct` | `products.create` |
| `GET /{id}` | `getProductDetails` | `products.view` |
| `PUT /{id}` | `updateProduct` | `products.edit` |
| `DELETE /{id}` | `deleteProduct` (trash) | `products.delete` |
| `POST /{id}/duplicate` | `duplicateProduct` | `products.create` |
| `POST /{id}/restore` | `restoreProduct` | `products.restore` |
| `DELETE /{id}/permanent` | `permanentlyDeleteProduct` | `products.permanent_delete` |
| `POST /bulk-delete` | `bulkDeleteProducts` | `products.bulk_operations` |
| `POST /bulk-update` | `bulkUpdateProducts` | `products.bulk_operations` |
| `GET, POST /{id}/variants` | `getProductVariants`, `createVariant` | `products.view`, `products.edit` |
| `PUT, DELETE /{id}/variants/{variantId}` | `updateVariant`, `deleteVariant` | `products.edit` |
| `PUT /{id}/options/matrix` | `saveProductOptionMatrix` | `products.edit` |
| `GET /{id}/sections/{section}` | `getProductSemanticSection` | `products.view` |
| `PATCH /{id}/sections/{section}` | `updateProductSemanticSection` | `products.edit` |

- `GET /` takes `page` (reaches the first 1,000 rows, 10,000 on a Paid plan profile) or `after` and `before` cursors. A text search ranks by relevance and pages by position.
- A search term also matches an exact SKU barcode, case-insensitively.
- Tax classification routes live in `admin/taxes.ts`: `GET /api/v1/admin/taxes/classifications` (`taxes.view`) and `PUT /api/v1/admin/taxes/classifications/{kind}/{id}` (`taxes.manage`). The write needs `expectedVersion` and `expectedAggregateRevision`.
- Setting a cost per item (`cost`, `skuCosts`) needs `products.view_costs` (`apps/api/src/routes/admin/cost-access.ts`).

## Rules

### Saves

- One editor Save is all-or-nothing. `updateProduct` accepts the details plus `optionMatrix` or `defaultSku`, `contentBlocks`, `bundles`, `pageTemplate`, `emiEligible` and `skuCosts`. It checks everything first, then writes one guarded batch.
- `updateProduct` replaces attribute values and legacy rich content. It diffs media by association id, so kept images keep their ids.
- Removing a gallery image that SKUs still use needs the id in `acknowledgedSkuImageRemovalIds`. Those SKUs then fall back to the product image (`image_id = NULL`).
- Product media: at most 250 items, exactly one featured, new items must be ready, an existing association cannot change its asset.
- A slug that is taken fails with a conflict. An omitted slug on create is derived from the name.
- An active product needs a price above 0 on the product and on every option SKU.
- `duplicateProduct` copies a product as an inactive draft with no stock. It makes new SKUs (`…-COPY`) and fresh generated barcodes. It copies cost per item, alert level, backorder and preorder policy, tax class, content blocks, bundles and custom fields in namespace `custom`.

### SKUs and inventory

- A product created without options takes optional `defaultSku` facts. Opening stock is a ledger-v2 movement claim plus a `stockVersion` CAS in the create batch, at the default location.
- Quantity edits are compare-and-set. Send `stock` with the `expectedStockVersion` it was based on. Omit `stock` to keep the quantity. A mismatch fails and writes nothing.
- Simple to options: `saveProductOptionMatrix` soft-retires the default SKU. Its tracked physical units must be allocated exactly across the new tracked SKUs, and they must sit at the default location. Reserved or preorder units block it. A digital default SKU's stock cannot split.
- Replacing combinations must keep the tracked stock total. Retiring a combination needs no reserved or preorder units and no open order line.
- A retired combination that comes back reuses its old SKU row and stock. Two retired SKUs with one combination fail closed.
- The matrix needs 1 to 5 axes and at most 150 combinations. Every submitted value must be used by an active SKU. Each axis has a unique name. Each standard mapping other than `none` appears once. SKU and barcode values are unique inside the request.
- `deleteVariant` always soft-retires. It refuses the default SKU, reserved stock, open order lines and the final option SKU of an active product. A guard re-checks inside the batch.
- Bulk and single deletes keep SKU history. A SKU referenced by orders or movements is never hard-deleted.

### Trash and delete

- Trash and restore need the current revision. Restoring an active product with no live SKU recreates the default SKU.
- Permanent delete needs a trashed product and the current revision. It is blocked (409) when any order line references the product or its SKUs, or any SKU has inventory movements, purchase order lines or transfer lines. Keep such products in trash.
- Bulk calls take at most 90 claims. Bulk trash is one batch. Bulk permanent delete runs one guarded batch per product, in order, and returns `deleted`, `blocked` or `failed` for each.
- Bulk update sets `isActive` or `categoryId`. Activating skips products with a price at or below 0 (`needs_price`). A product that already has the values keeps its revision.
- Lookup sets use bound `json_each()` arrays. A single D1 statement allows at most 100 bound parameters.

## Where to look

- Dashboard: `apps/admin-v2/src/routes/admin/products/**`, `components/admin/ProductForm.tsx`, `components/admin/product-form/`, `components/admin/product-form/variants/` (option matrix editor), `components/admin/product-list/`.
- API contract tests: `apps/api/src/routes/admin/products-aggregate-revision-openapi.test.ts`, `products-composition-save.d1.test.ts`.
- Domain tests: `aggregate-revision.test.ts`, `option-matrix.d1.test.ts`, `default-sku.d1.test.ts`, `lifecycle-delete.test.ts`, `no-op-save.d1.test.ts`, `variant-images.test.ts`, `digital-stock.d1.test.ts`, `stock-ledger.test.ts`.
