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

## Deployment and live evidence

- API version `b6c213f5-e945-4a98-a39e-398e5a5f483a` serves 100% traffic; four post-deploy readiness samples passed.
- Admin version `63cea645-5d5e-446a-8b8a-fe1883fbcf38` serves 100% traffic.
- Storefront version `0b090a73-0c85-47b2-8cfd-30a1adb24be5` serves 100% traffic; health passed and critical catalog pages were warmed.
- Authenticated Chrome confirmed the repaired 2026 product timestamp, merchant option label, absent internal SEO marker, 63 loaded inventory SKUs, accessible inventory tabs, truthful `Deducted -1 / 3 → 2`, and the locked BDT currency control.
- Live HTTP confirmed base product HTML remains cacheable, a `size`-selected product request returns `X-Cache-Status: BYPASS_VARIANT_SELECTION` plus private/no-store, and an authoritative missing product remains 404.
- Pre-existing release warnings remain for the unconfigured ops-monitor email channel and unexpected `worker:testdash` queue producer bindings; they are not introduced by this catalog batch and remain operational follow-up items.
- Reliability batch 2 API version `d6a04312-94d7-4036-88b9-3261fe9f051e` and admin version `7a0808d3-a7c6-4c8a-a641-956061f3b0e1` each serve 100% traffic; API health and four readiness samples passed.
- Fresh authenticated Chrome tabs confirmed current assets hydrate without console errors. New Product and New Collection show visible headings and unchecked Draft status. Attribute `brand` reports five values/nine product assignments, search for `Apple` reports one value/four assignments, and the compact pagination contract renders from authoritative totals.

## Still open after batch 2

- Legacy inventory deduction/release callers, partial reservation generations, and the ledger-v2 model remain P1.
- Mixed create/update variant edit plans still use two API calls; each call is safer, but the combined UI plan is not atomic.
- Collection product picking remains truncated/pagination-unsafe.
- Variant-media configuration is still stored inside SEO metadata and matched positionally; this batch only prevents the marker from leaking in admin display.
- Buyer listing price/filter/sort is still product-row based rather than one SKU-aware projection. Facets and price bounds remain inaccurate.
- The mobile admin catalog table, route-backed settings architecture, and broader keyboard/accessibility pass remain open.
- Dedicated RBAC permissions do not yet exist for attribute restore/permanent delete, collection permanent delete, or bulk-permanent operations; the UI intentionally mirrors the current API permission map rather than inventing authority.

## Next implementation slice

1. Design and implement one atomic mixed create/update variant edit-plan contract.
2. Replace collection product picking with one paginated, cancellable server query.
3. Migrate variant-media configuration out of SEO metadata into stable associations.
4. Build one SKU-aware buyer pricing/availability projection for lists, filters, sort, cards, feeds, and UCP.
