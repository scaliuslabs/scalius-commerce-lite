# Store transfer (import and export)

Moving a store in from Shopify, WooCommerce or a spreadsheet, and out again.
Client-driven, chunked and idempotent, with no job tables: the dashboard reads
the CSV in the browser, the API applies bounded batches, progress lives in the
page, and running the same file again is safe.

## Flow

1. The dashboard streams the file through the RFC 4180 parser
   (`@scalius/shared/store-transfer/csv`: BOM, quoted line breaks, CRLF/LF/CR,
   `sep=`, semicolon and tab files, Windows-1252 fallback), detects its format
   (`detect.ts`) and maps rows to normalized items (`shopify-products.ts`,
   `woocommerce-products.ts`, `customers.ts`, `inventory.ts`), validating each
   with the same zod schemas the API uses.
2. A dry run per batch (`dryRun: true`) reports each item's action, the
   aggregate revision (or on-hand count) it saw, and the brands, categories and
   specifications the write would create.
3. The write sends the items back with that revision as `expected`; a product
   changed since the preview is refused (`changed_since_preview`).
4. Images are attached afterwards (`product-images.ts`).

Every batch may stop early (`ImportBudget` time budget, or D1's per-invocation
query limit: 1,000 on Workers Paid, 50 on Free) and returns `processed`; the
caller sends the rest again and halves its batch size.

## Products (`product-import.ts`)

Written through `createProduct`, `updateProduct`, `updateVariant` and
`saveProductOptionMatrix`, so SKU identity, the option matrix (up to five axes,
150 combinations), ledger-v2 stock at the default location, gift-card rules,
catalog projections and cache dependencies hold for imports.

- Matching: the source handle (Shopify), then SKUs, then (WooCommerce, which
  exports no handle) the derived handle or its `-2` twins with the same name.
- `create` skips matched products; `upsert` updates only what the file states
  (never removes options, SKUs, media, attributes or descriptions; leaves stock
  of existing SKUs alone; turns tracking on but never off); `price` changes
  only prices of SKUs found by SKU. An unchanged item writes nothing.
- Compare-at above price becomes a flat discount; a stored percentage discount
  that already gives the file's prices is kept.
- Brands and categories (`references.ts`) are found by name (category paths
  level by level) or created published; specifications become text attributes.
  Creating any of them needs the staff member's create permission.
- Cost per item maps to `product_variants.cost_minor` in the store currency's minor
  units: create sets it, upsert sets the file's cost where it differs (a blank
  keeps the SKU's cost; price mode leaves costs alone), and the export writes it.

## Images (`product-images.ts`)

Media downloaded from a URL are named `media_u<sha256(url)[:24]>_<suffix>`, so
a URL is fetched once per store and an image already on the product is left
alone; this store's own media URLs (a re-imported export) are reused. New
images are appended in one aggregate-revision write; the first is featured when
the product has none, and SKUs without an image get the one the file named.
Downloads use the guarded media URL import injected by the API.

## Customers (`customer-import.ts`)

Matched by phone (an account beats a guest record), then email; an email
owned by another phone is refused. `upsert` only fills what is missing and adds
tags. Consent is recorded only for channels the file marks yes, source
`import`, actor the staff member, the file's wording as the note; never an
unsubscribe. One D1 batch per request, falling back to one per customer.

## Inventory (`inventory-import.ts`)

Each row is a ledger-v2 stocktake (reason `import`) at a location (code or
name; default when blank), with an operation key derived from the run id, SKU
and location. Matching counts write nothing; a count changed since the dry run
is refused.

## Exports

`product-export.ts` writes Shopify's product CSV columns (category path in
Type, compare-at for discounts, original image URLs, options past the third
folded into Option3); `inventory-export.ts` writes on-hand per SKU and active
location. Both are paged by id with a next cursor; the dashboard joins pages.
