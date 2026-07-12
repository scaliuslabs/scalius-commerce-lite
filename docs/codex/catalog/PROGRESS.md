# Catalog Hardening Progress

Last updated: 2026-07-12

## Inventory and catalog-settings hardening

Status: deployed and live-verified on 2026-07-12.

- Relative adjustment and absolute stocktake reject fractional, unsafe, zero,
  negative-result, and contradictory reason/direction input without rounding or
  clamping the requested operation.
- The compact admin dialog separates adjustments from physical counts, previews
  signed availability deficits, preserves exact audit notes, and exposes named,
  busy-state-aware controls.
- Movement history has bounded server search/type filters, stable pagination,
  order links, an indexed `(type, created_at)` path, and a complete documented
  ledger-health response contract.
- Inventory query enums/page sizes and scanner inputs now fail before D1 work;
  successful writes retain targeted buyer/feed/sitemap/storefront cache
  invalidation.
- Currency code lock, atomic save, supported-code validation, order snapshots,
  and UI lock copy were re-audited with no new mismatch found.
- Remaining P1/P2 work is recorded in `INVENTORY.md`, especially adjustment
  idempotency, alert inbox/acknowledgement UI, audit export/filter depth, and a
  bounded atomic bulk-stocktake design.

## Collections source and workflow hardening

Status: deployed and live-verified on 2026-07-12.

- Added explicit manual-product versus dynamic-category content source and an
  independent grid/carousel presentation column. Migration 0010 performs the
  one-time demo-era conversion; runtime legacy inference was removed.
- Buyer collection detail and homepage resolution now ignore stale selections
  from the inactive source mode.
- Manual membership has compact accessible move-up/down ordering, server-paged
  product search, a 90-ID bound, and dirty-state-safe add/remove/reorder writes.
- Active collections fail closed when their chosen source is empty. Ordinary
  updates cannot mutate trash; hard delete is trash-only; bulk ID and reorder
  payloads are bounded and validated below D1's parameter ceiling.
- Collection presentation copy now names grid/carousel honestly instead of
  conflating layout with membership semantics.
- Deferred cross-slice work is recorded in ADMIN/STOREFRONT: paginated dynamic
  category lookup, consistent destructive confirmation, and product/category
  invalidation of collection detail API/HTML caches.

## Normalized option-matrix release

Status: deployed and live-verified on 2026-07-12.

### SKU subset and buyer-validation follow-up

Status: deployed and live-verified on 2026-07-12.

- Active option SKUs may be a non-empty subset of the potential Cartesian
  matrix. Duplicate combinations, unused option values, empty matrices, and
  more than 150 potential combinations remain invalid.
- The matrix supports single/bulk omission, restore-one/all, direct SKU images,
  explicit discount modes, readable compact typography, and internal barcode
  generation for new SKUs.
- Saved omissions soft-retire their SKU identity without erasing stock. An exact
  later restore reactivates that identity under revision/stock/reservation
  guards, preserving audit history instead of colliding with global SKU
  uniqueness.
- Root cause of the reported cart 500 was an unqualified outer SKU `id` in the
  shared option-label SQL helper. D1 reported `ambiguous column name: id`;
  qualification at the helper authority repairs cart validation and every
  order/inventory/tax/customer projection using the same label expression.

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

Verification green for the latest catalog follow-up:

- full repository tests: 450 files / 3,323 tests;
- repository typecheck, lint, and production build;
- Worker environment, migration metadata, database-trigger, and diff checks;
- generated API client and 267-route OpenAPI contract;
- `pnpm release:check` passed, including admin auth, storefront, discovery,
  feeds, UCP, product schema, 4/4 API readiness, and eight queue checks.

Deployed Worker versions:

- API: `9e4bc7a7-3cbd-49de-b04f-153fb01873de`
- Admin V2: `45c629ae-99fa-41fd-b4c5-65ceca6c30af`
- Storefront: `e7b52512-2bae-473d-a644-0ed1d82c5c4b`
- Ops monitor: `2ca32a62-ed91-4fb6-a562-7eb391322c86`

Live authenticated evidence:

- draft `prod_KyaDjWL28lOsRaynv9oOu` was created through the deployed admin;
- axes `Finish × Plug × Pack` persist as 3 definitions, 6 values, 8 active
  SKUs, and 24 normalized assignments;
- total stock is 96, one SKU has a 10% discount, and no active default SKU
  remains;
- the additional section persists its rich text and reloads collapsed;
- create/edit reloads completed without browser console or page errors after
  the rich-text fix.
- deployed Nike Shoe Test editor exposed four active generic Color × Weight
  SKUs, per-row images, explicit discount types, and an omit/restore workflow;
  the browser verification omitted White / 5KG and restored it locally without
  persisting the test draft;
- the exact production White / 5KG cart-validation request that returned 500
  before deployment now returns 200, `valid: true`, unit price 5000, and 50
  available; the hydrated storefront cart renders its saved Nike line without
  a validation error or browser console warning;
- the product-list category filter now opens a trigger-width searchable listbox
  with bounded scrolling and keyboard semantics instead of the oversized
  Radix Select menu.

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
