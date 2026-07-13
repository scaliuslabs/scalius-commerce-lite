# Inventory and Catalog Settings Audit

Last reviewed: 2026-07-13

## Authority and architecture

- D1 `product_variants` counters are inventory authority. Buyer availability is
  `stock - reservedStock`; negative availability is a real operational deficit,
  not a value to hide in the admin. Storefront sellability remains fail-closed.
- Every new stock mutation must commit one ledger-v2 edge and the matching
  `stockVersion` CAS update in the same D1 batch. KV and rendered storefront
  caches are projections and are invalidated only after a successful write.
- Manual adjustment, scanner adjustment, and stocktake now accept exact safe
  integers only. They reject fractions, zero relative adjustments, negative
  absolute counts, overflow, and relative removals larger than on-hand stock;
  no boundary rounds or clamps the merchant's request into a different audit
  movement.
- Directional reasons are enforced for the primary admin adjustment contract:
  received/return add stock, damage/theft remove it, and correction/other work
  in either direction.
- Manual relative adjustment, scanner adjustment, and stocktake require a
  merchant operation key. D1 stores the canonical request hash and committed
  result in `inventory_operations` in the same batch as the guarded ledger-v2
  movement and `stockVersion` CAS. Exact retries replay the original result;
  reusing a key with changed mode/SKU/quantity/reason/notes/pool fails closed.
  No standalone pending operation row exists.

## Admin workflow contract

- The compact adjustment dialog explicitly separates “Add or remove stock”
  from “Set counted stock.” It previews exact on-hand and signed available
  results, warns when a physical count exposes a reservation deficit, preserves
  input after failure, and disables no-op/invalid submissions.
- Variant search/filter/sort and movement product/SKU search, type, exact-order,
  and Bangladesh-calendar date filters are server-backed. Filter changes reset
  pagination. Movement history uses a bounded `(created_at, id)` keyset cursor,
  while variant/alert pages retain stable ID tie-breakers.
- Movement history shows ledger-v2 counter edges and links order-backed rows to
  the order. It resolves the current admin display name in the same query,
  labels null actors as System, labels deleted accounts as Former admin, and
  never exposes actor email in the history projection or CSV. The
  `(type, created_at)` index supports the bounded type/time access path. API
  page size is capped at 100.
- Movement CSV is streamed from sequential keyset pages of at most 100 rows,
  is hard-capped at 5,000 rows per request, inherits `products.view` RBAC, and
  neutralizes spreadsheet formula prefixes. It does not accumulate the export
  in Worker memory. Global ledger health is a separate, five-minute-stale admin
  query rather than an aggregate repeated on every history page/filter.
- Read access uses `products.view`; adjustments, stocktakes, and alert
  acknowledgement use `products.edit`. UI actions mirror those same current
  capabilities. A separate inventory permission family is not yet modeled.
- The inventory workspace has three compact operational views: sellable SKUs,
  low-stock alerts, and movements. The alert inbox is server-searched and
  paginated, separates needs-review/acknowledged/resolved states, links to the
  owning product, and lets a merchant jump to the exact SKU before adjusting
  stock. Acknowledgement is conditional: the API returns not-found when the
  alert was already acknowledged or resolved instead of claiming a write that
  did not happen.
- The sellable-SKU view uses mutually exclusive responsive projections: the
  existing dense table remains at desktop widths, while narrow screens receive a
  semantic card list with product/SKU/merchant-option identity, on-hand,
  committed, available, stock status, and the same permission-gated Adjust
  control. Search, stock-state filtering, pagination, and sorting continue to use
  the one existing query state; mobile adds an explicit sort selector because its
  projection intentionally has no table headers.

## Catalog settings truth

- Base currency code is locked once a product or order exists because live
  catalog prices have no per-row currency. Symbol and positive finite USD-rate
  corrections remain editable and all three values save atomically.
- Orders retain immutable currency/precision snapshots. A future base-currency
  conversion requires preview, explicit rounding policy, transactional rewrite,
  audit evidence, and rollback; changing a global code must never reinterpret
  existing amounts.

## Remaining release gaps

1. Actor names are resolved from the current admin account because movement
   rows do not contain an immutable actor-name snapshot. Renames intentionally
   show the current name and deleted accounts show Former admin; changing that
   policy requires an explicit audit schema decision rather than copying PII
   into read projections.
2. No bounded, atomic CSV/bulk stocktake import exists. Any future import must
   validate every row first, use stable SKU/barcode identity, require one
   idempotency key per import, chunk lookup sets below D1's parameter ceiling,
   and avoid partial inventory commits.
3. Ledger v1 rows remain a deliberate non-foldable history boundary. Health
   diagnostics may report them, but reconciliation must not invent missing
   counter edges.
4. The narrow-screen SKU projection is locally source-tested and linted, but the
   deployed authenticated 320/360/390/430 px browser flow still needs verification.
   Low-stock alerts and movement-history responsive behavior were not redesigned
   in this slice and remain separate browser-audit targets.

## Verification for this slice

- Focused core/API/admin/database tests cover invalid numeric input,
  reason/direction mismatches, overdraw rejection, stocktake behavior,
  exact replay, changed-payload conflict, operation-key races, CAS retries,
  atomic batch composition, cache invalidation, bounded query validation,
  movement cursor/filter bounds, streamed formula-safe CSV, and migration
  registration.
- The responsive admin source test proves that the desktop table and mobile list
  are mutually exclusive, the mobile list contains every required SKU identity
  and stock fact, and both projections reuse the existing query result, sort
  state, stock-status helper, and accessible Adjust action.
- The generated OpenAPI client, repository typecheck, API/admin production
  builds, migration metadata, and focused core/API/admin/database tests pass
  from the clean inventory release commit.
