# Inventory and Catalog Settings Audit

Last reviewed: 2026-07-12

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

## Admin workflow contract

- The compact adjustment dialog explicitly separates “Add or remove stock”
  from “Set counted stock.” It previews exact on-hand and signed available
  results, warns when a physical count exposes a reservation deficit, preserves
  input after failure, and disables no-op/invalid submissions.
- Variant search/filter/sort and movement search/type/page are server-backed.
  Filter changes reset pagination; stable ID tie-breakers prevent rows moving
  between pages when primary sort values are equal.
- Movement history shows ledger-v2 counter edges and links order-backed rows to
  the order. The `(type, created_at)` index supports the new bounded type/time
  access path. API page size is capped at 100.
- Read access uses `products.view`; adjustments, stocktakes, and alert
  acknowledgement use `products.edit`. UI actions mirror those same current
  capabilities. A separate inventory permission family is not yet modeled.

## Catalog settings truth

- Base currency code is locked once a product or order exists because live
  catalog prices have no per-row currency. Symbol and positive finite USD-rate
  corrections remain editable and all three values save atomically.
- Orders retain immutable currency/precision snapshots. A future base-currency
  conversion requires preview, explicit rounding policy, transactional rewrite,
  audit evidence, and rollback; changing a global code must never reinterpret
  existing amounts.

## Remaining release gaps

1. Manual/scanner adjustment requests do not yet have a merchant-supplied
   idempotency key. A retry after an unknown response can apply twice. Converge
   the two relative-write routes behind one idempotent operation contract.
2. Low-stock alerts are durable and acknowledgeable in the API, but the main
   inventory page still lacks the alert inbox, acknowledgement workflow, and
   resolved-history pagination.
3. Audit history still lacks date range, actor resolution, exact order filter,
   cursor pagination, and streaming CSV export. The current joined substring
   search and global ledger-health aggregate will not remain cheap at very
   large movement counts.
4. No bounded, atomic CSV/bulk stocktake import exists. Any future import must
   validate every row first, use stable SKU/barcode identity, require one
   idempotency key per import, chunk lookup sets below D1's parameter ceiling,
   and avoid partial inventory commits.
5. Ledger v1 rows remain a deliberate non-foldable history boundary. Health
   diagnostics may report them, but reconciliation must not invent missing
   counter edges.

## Verification for this slice

- Focused core/API/admin/database tests cover invalid numeric input,
  reason/direction mismatches, overdraw rejection, stocktake behavior, cache
  invalidation, bounded query validation, movement filters, and migration
  registration.
- API typecheck and generated OpenAPI client complete successfully. Repository
  typecheck remains independently gated by currently active Collections work;
  do not attribute that unrelated failure to inventory.
