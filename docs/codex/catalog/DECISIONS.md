# Catalog Decisions and Implementation Order

Last reviewed: 2026-07-12

## Accepted decisions

1. Correctness and recoverability precede visual redesign.
2. Preserve the storefront product-page UI; change only correctness/cache/accessibility behavior unless the owner explicitly expands scope.
3. Lock base currency after catalog/order money exists until a real conversion workflow is designed. Never silently reinterpret live values.
4. Treat inventory quantities as positive finite integers at every mutation boundary; relative stock adjustment is the only signed input and must record the effective delta.
5. Replace replay-unsafe inventory paths with deterministic claim + counter CAS batches.
6. Stop storing variant-media configuration inside SEO fields. Migrate to stable explicit associations.
7. Separate catalog collection membership from homepage merchandising layout/config.
8. Use one buyer-catalog price/availability projection across listing, search, category, collection, related, feed diagnostics, UCP, and cards.
9. Operational failure is not not-found. Preserve typed 404/403/409/503 semantics through API clients, loaders, and UI.
10. Every admin mutation control is gated by the same capability used by its API route.
11. Product composition uses mandatory aggregate CAS; operational inventory traffic remains on SKU stock-version/ledger CAS.
12. Never preserve persisted exact-duplicate or duplicate bulk-writer APIs. Option duplication creates a local draft; mixed option updates use one atomic edit plan.
13. SKU deletion always soft-retires the identity. Permanent product deletion is trash-only and transactionally guards order, discount, and inventory history.
14. An editor owns one stable product/SKU snapshot. Background query refresh may update caches but only explicit Reload latest can replace a merchant draft.

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

- Resolved: explicit image-ID-to-variant/option-value media associations, legacy marker backfill, and stable reorder behavior.
- Normalized option/value identities and unique active combinations.
- Inventory ledger v2 with pool and before/after physical/reserved/preorder counters.
- Catalog collection membership/rules separated from merchandising modules.
- Currency-aware catalog money representation and optional audited conversion workflow.

### Batch 5 — product aggregate safety and editor recovery

- Mandatory product aggregate CAS across product, option, sort, tax classification, and relevant cascade writes.
- Typed draft-preserving conflict UX and explicit reload/terminal-deletion recovery.
- Normalized barcode pairing/checksum/duplicate validation and bounded duplicate-safe lookup.
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
