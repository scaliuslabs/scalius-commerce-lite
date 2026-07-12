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
- Variant search/filter/sort and movement search/type/page are server-backed.
  Filter changes reset pagination; stable ID tie-breakers prevent rows moving
  between pages when primary sort values are equal.
- Movement history shows ledger-v2 counter edges and links order-backed rows to
  the order. The `(type, created_at)` index supports the new bounded type/time
  access path. API page size is capped at 100.
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

## Catalog settings truth

- Base currency code is locked once a product or order exists because live
  catalog prices have no per-row currency. Symbol and positive finite USD-rate
  corrections remain editable and all three values save atomically.
- Orders retain immutable currency/precision snapshots. A future base-currency
  conversion requires preview, explicit rounding policy, transactional rewrite,
  audit evidence, and rollback; changing a global code must never reinterpret
  existing amounts.

## Remaining release gaps

1. Audit history still lacks date range, actor resolution, exact order filter,
   cursor pagination, and streaming CSV export. The current joined substring
   search and global ledger-health aggregate will not remain cheap at very
   large movement counts.
2. No bounded, atomic CSV/bulk stocktake import exists. Any future import must
   validate every row first, use stable SKU/barcode identity, require one
   idempotency key per import, chunk lookup sets below D1's parameter ceiling,
   and avoid partial inventory commits.
3. Ledger v1 rows remain a deliberate non-foldable history boundary. Health
   diagnostics may report them, but reconciliation must not invent missing
   counter edges.

## Verification for this slice

- Focused core/API/admin/database tests cover invalid numeric input,
  reason/direction mismatches, overdraw rejection, stocktake behavior,
  exact replay, changed-payload conflict, operation-key races, CAS retries,
  atomic batch composition, cache invalidation, bounded query validation,
  movement filters, and migration registration.
- The generated OpenAPI client, repository typecheck, API/admin production
  builds, migration metadata, and focused core/API/admin/database tests pass
  from the clean inventory release commit.
