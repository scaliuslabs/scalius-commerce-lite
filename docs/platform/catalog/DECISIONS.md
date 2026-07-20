# Catalog Decisions and Implementation Order

Last reviewed: 2026-07-12

## Accepted decisions

1. Correctness and recoverability precede visual redesign.
2. Preserve the storefront product-page UI; change only correctness/cache/accessibility behavior unless the owner explicitly expands scope.
3. Lock base currency after catalog/order money exists until a real conversion workflow is designed. Never silently reinterpret live values.
4. Treat inventory quantities as positive finite integers at every mutation boundary; relative stock adjustment is the only signed input and must record the effective delta.
5. Replace replay-unsafe inventory paths with deterministic claim + counter CAS batches.
6. Product media owns primary order. Variant imagery is one optional exact `product_variants.image_id`; `null` means product-primary fallback. Bulk option/value convenience materializes exact SKU references and never creates an inheritance layer.
7. Separate catalog collection membership from homepage merchandising layout/config.
8. Use one buyer-catalog price/availability projection across listing, search, category, collection, related, feed diagnostics, UCP, and cards.
9. Operational failure is not not-found. Preserve typed 404/403/409/503 semantics through API clients, loaders, and UI.
10. Every admin mutation control is gated by the same capability used by its API route.
11. Product composition uses mandatory aggregate CAS; operational inventory traffic remains on SKU stock-version/ledger CAS.
12. Never preserve duplicate bulk-writer APIs. One complete normalized option matrix is the only topology/SKU composition writer.
13. SKU deletion always soft-retires the identity. Permanent product deletion is trash-only and transactionally guards order, discount, and inventory history.
14. An editor owns one stable product/SKU snapshot. Background query refresh may update caches but only explicit Reload latest can replace a merchant draft.
15. Simple and optioned products are one SKU topology workflow, not separate product types. A simple product has exactly one active protected default SKU; an optioned product has no active default SKU. First conversion must preserve reservations, allocate tracked stock exactly once, then soft-retire the default identity for audit history.
16. Option composition uses shared five-axis and 150-combination ceilings across UI, core, API, and D1; the dense matrix replaces separate generator and spreadsheet modes.
17. Option names are arbitrary merchant-defined buyer choices. Size/color/material/pattern are optional discovery mappings, not storage semantics.
18. Topology edits are staged and explicitly materialized. Expansion/contraction preserves tracked physical stock and never clones stock into every generated child.
19. Initial product creation may atomically include the complete option matrix, direct media references, assignments, discounts, and initial stock ledger movements.
20. Demo data has no compatibility obligation for migration 0007. Remove the legacy model cleanly, then reseed through normalized writers.
21. Parameterized atomic D1 guards must use `buildBatchGuard()` (a prepared `SELECT` builder). Never put parameterized `db.run(sql...)` raw objects into a Drizzle D1 batch; Drizzle 0.45 cannot bind them.

## Resolved design: partial variant imagery

- Required behavior: only some SKUs may need distinct images. An unmapped SKU is
  valid, remains sellable, and visibly falls back to the product primary image.
- Verified current implementation: migration 0007 already persists only an
  optional exact image per SKU. A bulk “apply image” action materializes the
  same exact mapping across selected SKUs, giving option-value convenience
  without a hidden inheritance layer.
- Remaining work is UI clarity and regression coverage, not a new persistence
  model. See `VARIANT-IMAGES.md` for option rename/add/remove, topology,
  deletion/reorder, conflict, storefront, feed, and schema boundaries.

## Implementation order

### Batch 1 — safety blockers

- Restore preorder inventory on expiry and validate quantities at mutation boundaries.
- Block unsafe currency-code changes; strictly validate and atomically save currency fields.
- Bypass product HTML cache for `size`/`color` selection requests without changing product UI.
- Fix product-detail timestamp normalization and stop leaking internal metadata in admin detail.
- Disable collection drag reorder when the entire order set is not loaded.

### Batch 2 — admin reliability shell

- Wire query error/refetch/stale states through every catalog list and inventory.
- Gate create/edit/delete/restore/reorder/adjust controls by capability.
- Make destructive confirmations consistent and impact-aware.
- Preserve typed detail-loader failures.
- Make action bars inert during save and include variant drafts in dirty-state guards.

### Batch 3 — atomic catalog editing

- Atomic variant edit-plan endpoint with row-level conflict reporting.
- Real paginated attribute-value manager and normalized uniqueness.
- Collection product picker server query with pagination/cancellation.
- Single category/attribute deletion primitives used by row and bulk actions.

### Batch 4 — model corrections

- Resolved: explicit image-ID-to-variant/option-value media associations, one-time marker backfill, permanent marker removal, and stable reorder behavior.
- Normalized option/value identities and unique active combinations.
- Inventory ledger v2 with pool and before/after physical/reserved/preorder counters.
- Resolved locally: collection membership is explicit in canonical `config.source`; independent `presentation` values are `grid` and `carousel`, with no runtime legacy inference.
- Currency-aware catalog money representation and optional audited conversion workflow.

### Batch 5 — product aggregate safety and editor recovery

- Mandatory product aggregate CAS across product, option, sort, tax classification, and relevant cascade writes.
- Typed draft-preserving conflict UX and explicit reload/terminal-deletion recovery.
- Normalized SKU/barcode/option identity at both application and database boundaries.
- Remove persisted duplicate and redundant bulk-update endpoints; standardize on atomic edit plan.
- Always-soft SKU retirement and in-transaction lifecycle/reservation/order/history guards.

### Batch 6 — buyer projection and admin workflow polish

- Shared SKU-aware pricing/availability projection for every catalog surface.
- Facet counts/multi-select and dynamic price bounds.
- Route-backed settings information architecture.
- Mobile admin catalog rows/cards, keyboard workflows, and axe coverage.

## Verification requirements per batch

- Focused regression tests for the exact failure before broad gates.
- Package tests and affected typechecks.
- `pnpm check:env` when Worker bindings/contracts change.
- `pnpm generate:sdk` after API contract changes; never hand-edit generated SDK files.
- `pnpm db:generate` after schema changes; inspect migration and metadata.
- Chrome verification for affected admin/storefront flows at desktop and 390x844 where UI changed.
- `pnpm ops:check` for relevant read-only production API smoke; `pnpm release:check` before declaring release readiness.
- Document local, deployed, and live-smoke evidence; commit only a meaningful verified achievement.

## Benchmark interpretation

- Shopify’s advantage is operational depth: variant publication, bulk inventory editing, explicit audit versus override paths, and mature list workflows.
- Medusa’s advantage is explicit domain separation: product, option, variant, inventory item, and collection are not hidden inside unrelated fields.
- Figma’s relevant lesson is that expert speed and predictable fixed surfaces beat novelty.
- Notion’s relevant lesson is that compactness succeeds only with strong search/filter/view semantics and keyboard continuity.

Scalius should not copy another product’s chrome. It should match their operational guarantees while retaining its compact visual identity and Bangladesh-first commerce behavior.
