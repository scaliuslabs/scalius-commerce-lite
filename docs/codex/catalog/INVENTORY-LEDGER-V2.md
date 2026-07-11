# Inventory Ledger v2

Last reviewed: 2026-07-12

## Decision

Every production inventory counter mutation must write one version-2 movement claim in the same D1 batch as its `product_variants.stock_version` CAS update. A v2 movement is the authoritative audit event for one SKU mutation; legacy rows remain readable history but are not assumed to be foldable.

## Event contract

A version-2 movement records:

- `pool`: `regular`, `preorder`, or `backorder`;
- `reservation_generation`: the reservation lifecycle for order-bound movements, otherwise null;
- `stock_version_before` and `stock_version_after`, where `after = before + 1`;
- before/after values and deltas for physical `stock`, `reserved_stock`, and `preorder_stock`;
- the existing order, variant, type, actor, note, and deterministic claim identity.

For each counter, `after - before` must equal the stored delta. The row's legacy `previous_stock`/`new_stock` fields remain populated with physical stock for compatibility; they no longer change meaning by pool.

`(variant_id, stock_version_after)` is the per-SKU ledger sequence. Null legacy versions may repeat, but every v2 row must have a unique positive version edge. This makes concurrent events deterministically foldable without relying on second-resolution timestamps.

## Reservation generations

Generation is scoped to `(order_id, variant_id, pool)`.

1. The first reservation starts generation 1.
2. Additional partial reservations while that generation has outstanding units stay in the same generation and use a distinct deterministic claim key.
3. Release and deduction consume only outstanding units from the active generation; a partial terminal event leaves the remainder active.
4. Re-reservation after the active generation reaches zero starts `max(generation) + 1`.
5. Restore refers to the generation that was deducted. It does not create a reservation.
6. Expiry releases only the outstanding quantity of an orphaned generation. It must not treat the presence of any release/deduction row as proof that the entire generation is terminal.

Outstanding reservation quantity is derived from v2 `reserved_stock_delta` within the generation. Positive deltas reserve; negative deltas release or deduct. It must never be inferred from movement row counts.

## Pool counter rules

| Operation | Pool | Physical stock delta | Reserved delta | Preorder delta |
|---|---|---:|---:|---:|
| reserve | regular/backorder | 0 | `+qty` | 0 |
| reserve | preorder | 0 | `+qty` | `-qty` |
| release | regular/backorder | 0 | `-qty` | 0 |
| release | preorder | 0 | `-qty` | `+qty` |
| deduct | regular | `-qty` | `-qty` | 0 |
| deduct | preorder/backorder | 0 | `-qty` | 0 |
| restore | regular | `+qty` | 0 | 0 |
| restore | preorder | 0 | 0 | `+qty` |
| restore | backorder | 0 | 0 | 0 |
| manual stocktake | regular | effective delta | 0 | 0 |
| manual preorder adjustment | preorder | 0 | 0 | effective delta |

All counters remain non-negative. An event whose `before` snapshot does not match the prior v2 edge is a reconciliation failure, not a value to clamp or silently repair.

## Compatibility and rollout

- Add nullable v2 columns with `ledger_version = 1` for existing rows. Do not fabricate missing historical counter snapshots.
- New production writes use `ledger_version = 2` and fill every v2 counter/version field.
- Reads expose legacy rows, but reconciliation reports a legacy boundary and proves only the contiguous v2 suffix that follows a trusted SKU snapshot.
- Legacy sequential inventory exports remain compatibility-only and must not be used by production workflows. Their eventual removal is separate from the v2 migration.
- Deployment requires migration application before the Worker version that writes the new columns receives traffic.

## Release evidence required

- Pure fold tests for every operation/pool, partial release, re-reservation, and discontinuity rejection.
- D1 integration tests proving movement claim and CAS counter update share one batch.
- Replay tests proving the same deterministic claim is idempotent and a changed payload fails closed.
- Expiry tests proving a partially released orphan frees only its outstanding amount.
- A read-only production diagnostic reporting legacy rows, v2 rows, gaps, counter mismatches, and safe samples without buyer or credential data.

