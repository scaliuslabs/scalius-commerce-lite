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

## Verification evidence

- Full repository suite: 416 files and 3,167 tests passed.
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

## Still open after batch 1

- Legacy inventory deduction/release callers, partial reservation generations, and the ledger-v2 model remain P1.
- Product editor single and bulk variant stock changes now reconcile low-stock alerts after both depletion and replenishment.
- UI/API capability parity, typed admin detail-loader errors, save/dirty navigation guards, and destructive confirmation consistency remain open.
- Variant edit plans are not atomic; attribute values and collection product picking remain truncated/pagination-unsafe.
- Variant-media configuration is still stored inside SEO metadata and matched positionally; this batch only prevents the marker from leaking in admin display.
- Buyer listing price/filter/sort is still product-row based rather than one SKU-aware projection. Facets and price bounds remain inaccurate.
- The mobile admin catalog table, route-backed settings architecture, and broader keyboard/accessibility pass remain open.

## Next implementation slice

1. Preserve typed 404/403/409/503 failures in admin product/category/collection detail loaders.
2. Add one shared catalog capability model and gate visible mutations with it.
3. Replace first-page attribute value management with server pagination and search.
4. Design the atomic variant edit-plan contract before changing its persistence workflow.
