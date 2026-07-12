# Catalog Hardening Progress

Last updated: 2026-07-12

## Normalized option-matrix release

Status: deployed and live-verified on 2026-07-12.

Implemented:

- normalized five-axis / 150-combination option, value, assignment, and SKU
  schema with migrations 0007–0008;
- direct `product_variants.image_id` and primary product-media fallback;
- one create/edit option builder and paginated SKU matrix;
- explicit topology plan, stock-preserving expansion/contraction, simple stock
  allocation, committed/open-order guards, direct image and SKU discounts;
- normalized admin/API/storefront/cart/checkout/order/inventory/scanner/feed/UCP
  reads; fixed size/color and serialized mapping readers removed;
- atomic initial product + option matrix creation and aggregate-CAS matrix edits;
- old generator, spreadsheet, bulk-create/delete/edit-plan/sort-order, and image
  mapping code/routes removed;
- shared limits, focused matrix/model tests, generated SDK refresh, and durable
  architecture/UX docs;
- storefront product-page visual layout preserved.
- additional-section rich-text state is controlled without the former maximum
  update-depth crash;
- optioned creation omits the hidden default SKU, and simple-to-optioned
  conversion soft-retires it after stock allocation;
- parameterized D1 mutation guards use prepared `SELECT` builders rather than
  raw `db.run(sql...)` objects, fixing live atomic matrix/category/tax/SKU
  batches under Drizzle 0.45.

Verification green:

- full repository tests: 438 files / 3,234 tests;
- repository typecheck, lint, and production build;
- Worker environment, distribution-secret, admin-performance, migration
  metadata, and diff checks;
- generated API client and 267-route OpenAPI contract;
- `pnpm ops:check --queues` passed with 4/4 readiness samples;
- `pnpm release:check` passed, including admin auth, storefront, discovery,
  feeds, UCP, and product schema;
- remote D1 foreign-key check returned no rows.

Deployed Worker versions:

- API: `1f933970-107a-411a-b835-4396a54607d3`
- Admin V2: `7b6d96a5-6360-43ee-8230-b9923c268524`
- Storefront: `2f88f991-3b28-40d7-8446-4eb3c42fe79e`
- Ops monitor: `37764ca0-3abd-45d8-a8dc-6b7abc1074ef`

Live authenticated evidence:

- draft `prod_KyaDjWL28lOsRaynv9oOu` was created through the deployed admin;
- axes `Finish × Plug × Pack` persist as 3 definitions, 6 values, 8 active
  SKUs, and 24 normalized assignments;
- total stock is 96, one SKU has a 10% discount, and no active default SKU
  remains;
- the additional section persists its rich text and reloads collapsed;
- create/edit reloads completed without browser console or page errors after
  the rich-text fix.

Known operations warnings outside this catalog release remain visible in the
passing release check: ops email alerts are logs-only, and legacy worker
`testdash` still owns three unexpected production queue producer bindings.

## Durable release bars

- Full suite, typecheck, lint, build, SDK, migration metadata, Worker binding,
  performance, secret scan, and diff checks must pass.
- `pnpm ops:check --queues` and `pnpm release:check` must pass after deployment.
- No deployed claim is recorded until the live version and authenticated browser
  flow have been observed.
- The historical pre-0007 deployment evidence is available in Git history; it
  is intentionally not repeated here because it described the deleted model.
