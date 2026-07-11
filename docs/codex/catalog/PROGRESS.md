# Catalog Hardening Progress

Last updated: 2026-07-12

This log records implementation state. The finding files remain the source for open risk; a finding is not closed merely because a partial mitigation exists.

## Landed in safety batch 1

- Currency settings now reject non-finite, partial, zero, and negative exchange rates; code changes are blocked after the first product or order; symbol/rate corrections remain possible; all three fields commit in one D1 batch. The GET contract exposes `currencyCodeLocked`, the admin explains and enforces the lock, and the generated SDK was regenerated.
- Expired preorder reservations restore `preorderStock` rather than moving units into the regular pool. Reserve, deduct, and release boundaries reject zero, negative, fractional, `NaN`, and infinite quantities before database work.
- Low-stock status uses one policy: only an explicit positive threshold enables it. Manual adjustments, scanner writes, and absolute stock sets reconcile alerts after increases, decreases, and no-op corrections.
- Product HTML requests containing `size` or `color` bypass the shared HTML cache and return a private/no-store response. Base and tracking-only product URLs retain cache behavior. No product-page visual layout was changed.
- Product and collection detail reads preserve `found | not_found | unavailable`; only an authoritative API 404 becomes a page 404, while 5xx, timeout, thrown, non-2xx, and malformed responses become no-store 503 responses.
- Product admin timestamps now use the shared timestamp normalizer, internal variant-image metadata is removed from visible SEO copy, merchant option labels replace generic labels, and deleted-category products render as Uncategorized.
- Collection drag reorder is disabled unless the full ordered collection set is loaded, preventing a paginated slice from being renumbered as the global order.
- Product, category, attribute, collection, sortable-table, and inventory query failures render an explicit retry state instead of an empty catalog. Destructive/bulk actions are disabled while list authority is unavailable.
- Inventory movement UI derives the displayed signed change from its before/after stock transition. Inventory tabs have tab semantics, adjustment controls have accessible names/labels, and both inventory queries expose Retry.

## Landed in reliability batch 2

- Admin product, category, and collection detail loaders redirect only for an authoritative API 404. The admin transport preserves status/code, and 401/403/409/5xx/timeout failures reach the route error boundary.
- One API-grounded catalog capability model gates create, edit, inline edit, status toggle, reorder, delete, restore, permanent delete, bulk selection, and stock adjustment across Products, Categories, Attributes, Collections, Inventory, product detail, and edit-form create-another shortcuts.
- Product and shared form action bars replace navigation anchors with inert buttons while a save is in flight. Option add/edit/bulk drafts participate in navigation protection.
- New products and collections start as Draft. Product, collection, and shared entity forms expose a compact visible page heading and concise workflow context.
- Variant creates keep parameter-safe four-row statements but commit every chunk in one D1 transaction. Bulk updates reject duplicate variant IDs before reads.
- New or changed SKU option combinations are compared after trim/case normalization and cannot duplicate an active sibling. The guard allows one SKU at a time to repair legacy duplicates.
- Single and bulk category permanent deletion share one primitive. Collection-config cleanup and category deletion commit atomically; malformed collection configuration blocks deletion instead of leaving a dangling reference.
- Attribute values use server-backed debounced search and pagination with authoritative global/search-scoped value and product totals. Presets reconcile against the complete used-value set through D1-safe `json_each()` lookups; trim/case duplicates and rename collisions are rejected while merchant casing is preserved. Loading failures expose Retry instead of an empty state.

## Verification evidence

- Full repository suite after reliability batch 2: 426 files and 3,213 tests passed.
- Full workspace typecheck: eight runnable packages passed; Astro reported zero errors, warnings, or hints across 286 files.
- Full workspace lint, Worker environment parity, admin performance checks, generated SDK diff check, and `git diff --check` passed.
- Post-deploy `pnpm release:check` passed API health/readiness, OpenAPI, dashboard auth gate, storefront health/pages/cache headers, discovery XML/feeds, UCP discovery/search/lookup/product, and Product schema.
- Reliability batch 3 integrated suite: 432 files and 3,246 tests passed after the legacy order-atomicity harness was migrated to deterministic claim/release APIs.
- Full workspace typecheck passed across eight runnable packages; Astro reported zero errors, warnings, or hints across 287 files. Full workspace lint, Worker binding parity, admin performance constraints, distribution secret checks, production builds, SDK regeneration, and `git diff --check` passed.
- An executable SQLite projection test proves hidden default-SKU exclusion, purchasable-SKU preference, SKU-over-product discount inheritance, sold-out fallback, and exact interval matching. Read-only production D1 probes ranked roughly 400 rows into 28 product projections in 12.10 ms cold and 1.52 ms warm with zero writes.
- Reliability batch 4 integrated suite: 439 files and 3,283 tests passed. Full workspace TypeScript/Astro checks passed across 290 storefront files with zero diagnostics; full workspace lint passed without warnings after listing-loader cleanup.
- Migration metadata validation passed with five contiguous SQL/journal/snapshot entries. A full SQLite 0000→0004 apply, foreign-key check, stable variant-image backfill, ledger-v2 trigger test, and no-rebuild legacy movement preservation smoke passed.
- Read-only production preflight found three legacy variant-image marker products with valid absolute images and bounded option/image sets, plus 310 version-1 inventory movement rows across 24 SKUs and zero currently partial reservation groups. No production rows were changed.

## Deployment and live evidence

- API version `b6c213f5-e945-4a98-a39e-398e5a5f483a` serves 100% traffic; four post-deploy readiness samples passed.
- Admin version `63cea645-5d5e-446a-8b8a-fe1883fbcf38` serves 100% traffic.
- Storefront version `0b090a73-0c85-47b2-8cfd-30a1adb24be5` serves 100% traffic; health passed and critical catalog pages were warmed.
- Authenticated Chrome confirmed the repaired 2026 product timestamp, merchant option label, absent internal SEO marker, 63 loaded inventory SKUs, accessible inventory tabs, truthful `Deducted -1 / 3 → 2`, and the locked BDT currency control.
- Live HTTP confirmed base product HTML remains cacheable, a `size`-selected product request returns `X-Cache-Status: BYPASS_VARIANT_SELECTION` plus private/no-store, and an authoritative missing product remains 404.
- Pre-existing release warnings remain for the unconfigured ops-monitor email channel and unexpected `worker:testdash` queue producer bindings; they are not introduced by this catalog batch and remain operational follow-up items.
- Reliability batch 2 API version `d6a04312-94d7-4036-88b9-3261fe9f051e` and admin version `7a0808d3-a7c6-4c8a-a641-956061f3b0e1` each serve 100% traffic; API health and four readiness samples passed.
- Fresh authenticated Chrome tabs confirmed current assets hydrate without console errors. New Product and New Collection show visible headings and unchecked Draft status. Attribute `brand` reports five values/nine product assignments, search for `Apple` reports one value/four assignments, and the compact pagination contract renders from authoritative totals.
- Reliability batch 3 API version `4ce4408c-cbac-43df-8d3d-25e3e13a5f79`, admin version `c5992f88-48b5-4b98-bd21-b4333d411601`, and storefront version `f306dfd3-1d97-4c80-9515-773fc4ce0f53` each serve 100% traffic.
- The serial post-deploy `pnpm ops:check --queues` and `pnpm release:check` gates passed: API health, four readiness samples, 272 OpenAPI paths, eight queue bindings, admin/API auth rejection, dashboard redirect, storefront health/home/search, cache policy, robots and six sitemap checks, both five-item product feeds, UCP search/lookup/product, and a live Product schema route.
- Live catalog HTTP responses confirmed the batch 3 buyer projection contract: the global listing exposes `maxBuyerPrice`, `priceVaries`, `availableForSale`, and effective `priceRange`; product search exposes buyer availability and variant-aware price state; and category listing derives its own effective SKU price bounds (`Mobile Top up` currently reports 10–10).
- The zero-price `Xrink` record remains a live-data quality finding. This release does not silently rewrite merchant catalog data; discovery feeds continue to omit non-positive rows under the existing fail-closed policy.

## Landed in reliability batch 3 (deployed and live verified)

- The option spreadsheet now submits one atomic mixed create/update edit plan. D1 version and stock-version guards execute inside the transaction, SKU swaps use temporary transaction-private values, normalized SKU/option/axis conflicts fail before commit, stock movements share the batch, and the UI reconciles only authoritative returned rows while preserving failed drafts.
- Collection product selection now uses one debounced, cancellable, paginated multi-category endpoint and TanStack infinite query. It has authoritative loading/empty/error/retry/load-more states, stable selected labels, a 90-category parameter boundary, and no per-category request fan-out.
- Production order, payment, fulfillment, stale-checkout, manual-edit, and trash-restore workflows no longer call the replay-unsafe sequential inventory APIs. Manual order edits use version-scoped deterministic reservation/release/deduct/restore claims with stock CAS batches, guarded rollback evidence, and pool-correct preorder behavior. The sequential exports remain compatibility-only.
- Global listings, category listings, collection cards/home modules, related cards, feed filtering/sorting, UCP's feed-backed catalog, and command-palette product search now share the buyer-SKU pricing projection. It prefers purchasable SKUs, falls back truthfully when all are sold out, applies SKU-over-product discount inheritance, exposes `From`/sold-out card state, and computes availability-scoped discount truth.
- Price filtering requires an actual SKU inside the requested interval; a product with only 50 and 150 price points does not falsely match 80–120. Category and search controls receive live effective SKU bounds, retain fractional values, and no longer treat 50,000 as a magic ceiling.
- Public search no longer converts backend failure into an empty result. The command palette has a retryable failure state, dialog/combobox/listbox semantics, focus containment/restoration, labelled close control, keyboard-focusable result options, and buyer-SKU prices.
- Collection config ID arrays are write-validated and legacy-normalized to 90. Cross-collection lookup sets use one bound `json_each()` token instead of exceeding D1's parameter ceiling.

## Landed in reliability batch 4 (local integration verified; deployment pending)

- Variant images now use stable image-ID associations to either an exact active SKU or normalized merchant option value. Reordering/removing images cannot shift later mappings, temp IDs reconcile to authoritative persisted IDs, exact SKU mapping wins over option mapping, and the protected product-page layout is unchanged.
- Generated migration 0001 adds product configuration and the mapping table; custom migration 0002 materializes the three live legacy positional configurations but retains their markers for old-reader rollout safety. New API/storefront readers prefer explicit rows, and successful new-admin writes remove markers atomically. Database triggers plus core validation reject invalid axes, negative order, cross-product images/SKUs, default/deleted SKU targets, and stale option values.
- Ledger v2 writes one pool-aware event in the same batch as each production stock-version CAS edge. It records physical, reserved, and preorder before/after/delta counters, reservation generation, and a unique per-SKU version sequence; database triggers reject incomplete or operation-inconsistent rows. The admin movement view shows the counters that actually changed plus pool/generation instead of implying every event changes physical stock.
- Reservation expiry subtracts pool/generation-specific deductions and releases and frees only the outstanding orphan quantity. Re-reservation advances generation only after the prior generation closes. Multi-order or multi-pool requests that would create multiple ledger events for one CAS edge fail closed.
- Product, category, and collection listings now return result-scoped multi-select facets. Values OR within one attribute and attributes AND across axes; counts exclude the facet's own selection, selected zero-count values remain removable, unknown values canonicalize away, and repeated cache keys retain stable identities.
- Public collection detail is a truthful paginated buyer catalog. Membership is the deduplicated union of explicit products and categories; curated products appear first in saved order, category-derived products follow the requested/default sort, and the response includes totals, dynamic SKU price bounds, facets, categories, and optional featured product.

## Still open after batch 4

- The buyer projection is a derived window query. Correctness is unified, but very large catalogs should move it to a transactionally maintained projection table after write-path coverage and benchmark evidence exist.
- The mobile admin catalog table, route-backed settings architecture, and broader keyboard/accessibility pass remain open.
- Dedicated RBAC permissions do not yet exist for attribute restore/permanent delete, collection permanent delete, or bulk-permanent operations; the UI intentionally mirrors the current API permission map rather than inventing authority.
- Product aggregate revision/CAS, normalized barcode uniqueness, minor-unit catalog money, and the legacy duplicate option-combination cleanup remain open P1 model work.
- Collection membership remains JSON configuration shared with merchandising metadata; a normalized membership/rules model with revisioned ordering is still required for very large catalogs and concurrent editors.
- Attribute visibility/export/schema roles remain coupled to `filterable`; quick-buy pricing, UCP eligible pagination, and feed cursor pagination retain their documented gaps.
- The category/collection mobile filter drawer still needs a complete focus trap and automated accessibility coverage.

## Next implementation slice

1. Add product aggregate CAS/reload UX, resolve the legacy option duplicate, and enforce normalized option/barcode uniqueness.
2. Normalize collection membership/rules with revisioned ordering and benchmark/materialize the buyer projection.
3. Finish mobile catalog rows, route-backed settings, keyboard workflows, and automated accessibility coverage.
4. Split attribute facet/display/export/schema roles, then harden quick-buy, UCP pagination, and feed cursors.
