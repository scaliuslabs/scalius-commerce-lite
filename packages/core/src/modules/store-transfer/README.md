# Store transfer

Import products, customers and inventory from Shopify, WooCommerce or a spreadsheet, and export products and inventory again. Imports are client-driven, chunked and idempotent. There are no job tables. Audience: contributors and merchants' developers.

The dashboard reads the CSV in the browser and sends bounded batches. This domain validates and applies each batch through the other domains' own services. Progress lives in the page. Running the same file again is safe.

## Entries

`index.ts` is the only entry. There is no `browser.ts`. CSV parsing, format detection and row mapping are not here: they run in the dashboard (`packages/shared/src/store-transfer/`).

Main files:

- `product-import.ts` (`importProducts`: match, create, update, reprice), `product-images.ts`, `customer-import.ts`, and `inventory-import.ts` (on-hand counts as ledger-v2 stocktakes).
- `references.ts`: `ImportReferenceResolver` finds or creates brands, categories and specification attributes by name.
- `pricing.ts` converts compare-at prices to and from stored discounts. `budget.ts` holds `ImportBudget` (20 s per request).
- `product-export.ts`, `inventory-export.ts`: CSV pages.

## Layer and imports

- Layer L7. Imports `attributes`, `brands`, `categories`, `customer-marketing`, `inventory`, `product-admin`, `products` and `settings`.
- Nothing imports it except the API routes.

## Flow

1. The dashboard parses the file, detects the format, maps rows to normalized items and validates each with the API's zod schemas.
2. A dry run per batch (`dryRun: true`) reports each item's action, the aggregate revision (or on-hand count) it saw, and the brands, categories and specifications the write would create.
3. The write sends the items back with that revision as `expected`. A product that changed since the preview is refused (`changed_since_preview`). Images attach afterwards.

A batch may stop early when its time budget runs out or D1's per-invocation query limit is hit (1,000 on Workers Paid, 50 on Free). It returns `processed`. The caller sends the rest again and halves its batch size.

## Rules

### Products

- Writes go through `createProduct`, `updateProduct`, `updateVariant` and `saveProductOptionMatrix`, so SKU identity, the option matrix (up to five axes, 150 combinations), ledger-v2 stock at the default location, gift-card rules, catalogue projections and DVC hold for imports.
- Matching order: the source handle (Shopify), then SKUs, then, for WooCommerce (no handle in the file), the derived handle or its `-2` twins with the same name.
- Mode `create` skips matched products. Mode `upsert` updates only what the file states. It never removes options, SKUs, media, attributes or descriptions, leaves stock of existing SKUs alone, and turns tracking on but never off. Mode `price` changes only prices of SKUs found by SKU.
- An item that changes nothing writes nothing.
- An option set that differs from the stored one fails with `option_shape_changed`. Change options in the product editor.
- A compare-at price above the price becomes a flat discount. A stored percentage discount that already gives the file's prices is kept.
- Brands and categories are found by name (category paths level by level) or created published. Specifications become text attributes. Creating any of them needs the staff member's create permission.
- Cost per item maps to `product_variants.cost_minor`. A file with costs needs `products.view_costs`. Create sets the cost. Upsert sets it where it differs. A blank keeps the SKU's cost. Price mode leaves costs alone. The export writes costs only for staff with that permission.

### Images

- Remote media get the id `media_u<sha256(url)[:24]>_<suffix>`. One URL downloads once per store. An image already on the product is left alone. This store's own media URLs (a re-imported export) are reused.
- New images append in one aggregate-revision write. The first becomes featured when the product has none. A SKU without an image gets the one the file named.
- Downloads use the guarded media URL import that the API injects (public HTTPS, bounded size, signature checked). The API then queues the rendition job.

### Customers

- Matching: phone first (an account that proved the phone beats a guest record), then email. An email owned by another phone is refused.
- Mode `upsert` only fills what is missing and adds tags. It never overwrites or removes.
- Consent is recorded only for channels the file marks yes. Source is `import`, the actor is the staff member, and the note is the file's wording. A "no" or a blank never unsubscribes.
- One D1 batch per request. If it fails, each customer is written on its own.

### Inventory

- Each row is a ledger-v2 stocktake with reason `import` at a location (code or name, default when blank). The operation key derives from the run id, SKU and location, so a retry replays.
- A count that matches writes nothing. A count that changed since the dry run is refused. A digital SKU's stock is its licence keys, so its row is refused unless it confirms the current count. A count above 0 for an untracked SKU is refused (`untracked_sku`).

### Exports

- `product-export.ts` writes Shopify's product CSV columns. The category path goes in Type. Compare-at covers discounts. Options three and beyond are joined into Option3. Images are the original upload URLs. Our importer reads the file back.
- `inventory-export.ts` writes on-hand per tracked SKU and active location, in the columns the inventory import reads.
- Both page by id with a next cursor (`X-Export-Next-Cursor`). The dashboard joins the pages. Page size: products 250 (at most 500), inventory 500 (at most 1,000).

## Routes

Mounted at `/api/v1/admin/import` and `/api/v1/admin/export` by `apps/api/src/routes/admin/store-transfer.ts`. Permissions are in `packages/core/src/auth/rbac/route-permissions/store-transfer.ts`. The route admits staff who can do any part of the batch. The handler then requires the permission of the mode.

| Method and path | Batch limit | Permission |
|-----------------|-------------|------------|
| `POST /import/products` | 50 items | `products.create` or `products.edit` (`create` needs create, `upsert` needs both, `price` needs edit) |
| `POST /import/product-images` | 20 products, 250 images per product | `products.edit` and `media.upload` |
| `POST /import/customers` | 100 items | `customers.create` or `customers.edit` (`upsert` needs both) |
| `POST /import/inventory` | 100 items | `products.edit` |
| `GET /export/products`, `GET /export/inventory` | page | `products.view` |

The demo-store seed bundle (`pnpm demo:store --export`) is a separate tool that shares no code with this domain (see [`scripts/demo-store/README.md`](../../../../../scripts/demo-store/README.md)).
