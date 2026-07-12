# Catalog Hardening Progress

Last updated: 2026-07-12

## 2026-07-12 catalog release batch

Status: deployed and live-verified on 2026-07-12.

- Product option axes remain merchant-defined facts rather than hard-coded
  size/color concepts. The compact builder and SKU matrix support exact SKU
  subsets, omission/restoration, explicit discount modes, safe stock editing,
  global SKU/barcode identity, and direct per-SKU image selection.
- Variant-image authority is exact SKU assignment only. An unassigned SKU
  visibly previews and uses the product primary image; no hidden option-value,
  positional, or SEO-marker inheritance was reintroduced.
- Attributes now distinguish product facts from storefront facets, validate
  active assignments in bounded reads, expose assignment usage, and provide a
  searchable product editor workflow.
- Category and collection lifecycle writes are trash-aware, bounded for D1,
  revision/CAS protected where required, and coupled to truthful storefront,
  discovery, count, ordering, and cache invalidation behavior.
- Inventory now includes compact operations, ledger-v2-safe mutation paths,
  available/reserved/on-hand explanations, movement history, and an actionable
  low-stock alert inbox with review state.
- Shared admin forms fail closed on explicit create/edit permission, and native
  submits plus keyboard shortcuts use the same authority.
- Item-level return policy, return processing, invoice authority, and order
  detail loading were hardened as the first slice of the expanded platform
  release program.

Final repository verification for this batch:

- 487 test files / 3,486 tests passed;
- typecheck, lint, production builds, environment binding checks, dist-secret
  checks, migration metadata, and diff checks passed;
- migration 0015 applied successfully to production;
- `pnpm release:check` passed after both deployments, covering API readiness,
  admin auth, storefront/cache behavior, discovery XML, both product feeds,
  UCP catalog discovery, and Product schema.

Deployed Worker versions:

- API: `f16a32ce-ae97-4549-9c54-f2db0e3a4bfd`
- Storefront: `e54719ea-62a8-4749-9d80-3dffab8fe3b8`
- Ops monitor: `3e9e49f7-ca38-4852-84f7-8f6c60e2bbc3`
- Admin V2: deployed in the same release batch and authenticated-live-verified;
  the deploy command's retained output did not include its version line.

Live authenticated evidence:

- the product editor rendered generic Color × Weight axes, four exact SKU rows,
  direct images, explicit discount selectors, omission actions, and compact
  available/committed stock disclosure without console errors;
- Inventory loaded its variant table and new Low-stock alerts tab; the current
  demo catalog truthfully reports 74 sold-out SKUs and no alerts needing review;
- Attributes, Categories, and Collections loaded their revised list/lifecycle
  interfaces without console errors;
- order `16V71E` opened its detail page instead of redirecting, with item,
  payment, fulfillment, notification, shipment-readiness, invoice, and return
  state present;
- a live browser check caught and repaired a post-hydration category price
  regression: absent URL filters were parsed as zero even though the API and
  server HTML carried `50–7055`. Commit `17bb64fb` now preserves those API
  bounds, and `/categories/drinks` renders `৳50–৳7,055` with no console errors.

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
- Manual adjustment, scanner adjustment, and stocktake now converge on one
  replay-safe operation engine. Migration 0012 stores the canonical request
  hash and exact result in the same D1 batch as the ledger-v2 movement and
  stock-version CAS; exact retries replay and changed-payload key reuse fails.
- Currency code lock, atomic save, supported-code validation, order snapshots,
  and UI lock copy were re-audited with no new mismatch found.
- Remaining P1/P2 work is recorded in `INVENTORY.md`, especially audit
  export/filter depth and a bounded atomic bulk-stocktake design.
- Commit `51f557a6` is deployed as API Worker
  `e0a160ae-12ab-4436-b16a-9e6338e432e3` and Admin Worker
  `09c60e31-d127-46d5-bb88-a581cfb941cc`. The live inventory read returns 86
  SKUs, and the write contract rejects a missing operation key before mutation.

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
