# Inventory Module

Stock management with reservation-based concurrency control, batch operations, order-status-driven transitions, reservation expiry, low-stock alerts, and audit logging.

## Overview

The inventory system tracks stock at the **product variant** level. Three stock counters live on the `product_variants` table:

| Column          | Purpose                                                        |
|-----------------|----------------------------------------------------------------|
| `stock`         | Physical on-hand inventory count                               |
| `reservedStock` | Units currently held for unconfirmed orders                     |
| `preorderStock` | Pre-order allocation (separate from regular stock)             |

**Available stock** is always `stock - reservedStock`.

Concurrency is managed through `stockVersion` (CAS -- compare-and-swap), a dedicated optimistic-locking counter on `product_variants` that is independent from the general `version` column used for non-stock updates (price, metadata, etc.). Every stock mutation increments `stockVersion` and conditions the UPDATE on the previously-read value. On conflict the operation retries up to 3 times with exponential backoff (50ms base).

Merchant-originated manual adjustments, scanner adjustments, and stocktakes
also require an operation key. `inventory_operations` stores the canonical
request hash and committed result in the same D1 batch as the ledger-v2 claim
and counter CAS. Exact retries replay; changed-payload key reuse is a conflict.
There is no pre-commit pending row.

## Locations (commerce hook H1)

Physical stock is held at `inventory_locations`; exactly one active location
is the default (migration 0102 creates `loc_default`, "Main location").
`inventory_levels` (SKU × location `on_hand`) is trigger-maintained only:

- every ledger-v2 movement with a non-zero `stock_delta` must name an active
  `location_id` (`INVENTORY_LOCATION_REQUIRED`), and a removal needs the units
  there (`INVENTORY_LEVEL_SHORTFALL`; the `on_hand >= 0` CHECK is the backstop),
  so the whole batch aborts;
- receipts upsert the level, removals lower it, a compensating movement delete
  reverses it, and a v2 movement's location/delta never change;
- a SKU inserted with stock (seeds, imports) books it at the default location.

So for every SKU, `sum(inventory_levels.on_hand) = product_variants.stock`
(`locations.d1.test.ts` folds random sequences to prove it). Reservations and
releases stay location-agnostic (`location_id` null). Deducts leave from the
order's `fulfillment_location_id` (the default when null); restores return to
the location of the generation's deduct movement (the order's location, then
the default, when that one is archived), or to a return receipt's
`restockLocationId`. Manual adjustments, stocktakes and scanner writes take an
optional `locationId` (the default when omitted) that is part of the operation
request hash; a stocktake counts that location. Product-editor stock edits and
licence-key pools move stock at the default location: with several locations
the editor shows and edits the default location's quantity (a SKU total minus
its units elsewhere, read for the whole product with `getProductInventoryLevels`)
and lists the rest per location read-only. Converting a simple product to
options is refused while its SKU holds units at a non-default location
(`assertSimpleConversionStockAtDefaultLocation`): those units cannot be
assigned to a combination, and the matrix books its quantities at the default.
Movement history and its CSV carry the location (`locationId` filter, a
`Location` column). Changing an order's location logs a
`fulfillment_location_changed` timeline line in the same batch. A location can
be archived only when it is not the default, holds no units and no open order
is set to ship from it.

## Purchasing, transfers and unit cost (migration 0109)

**Who sees what (RBAC).** Stock is product data: `products.view` reads it,
`products.edit` adjusts it. Unit costs, margins, inventory value,
purchase-order money and profit reports need `products.view_costs` (Shopify's
"View product costs"): reads leave those fields out without it
(`cost-visibility.ts`, applied at the API edge, so agent connections get the
same answers) and writes that set a cost are refused. Suppliers, purchase
orders, transfers and location addresses need `inventory.view`; their writes
`inventory.manage` (drafting or editing a purchase order also
`products.view_costs`). Locations are listed by name to anyone who can see
stock; their writes take `inventory.manage` or `settings.general.edit`.

**Unit cost.** `product_variants.cost_minor` is the SKU's current cost per
item (minor units, NULL = not set; a trigger keeps it a non-negative safe
integer). It is staff-only: buyer reads project explicit columns and never
carry it; staff reads present it as decimal `cost` (`presentCatalogPrice`).
Costs may carry paisa (they are not cash amounts). `setSkuCosts` writes up to
100 SKUs atomically, optionally guarded by the cost the merchant saw.
`order_items.unit_cost_minor` snapshots the SKU cost when a line is created
(trigger `order_items_unit_cost_snapshot`, every creation path, no extra bound
values) and is immutable once set; no backfill of older orders.

**Cost policy: weighted moving average, opt-in per receipt.** Receiving a
purchase order with `updateCost` sets each received SKU's cost to
`round_half_up((onHand × currentCost + received × unitCost) / (onHand + received))`
with `onHand` = the SKU's stock across every location before the receipt
(units in transit are not on hand). Without a current cost, or with nothing
on hand, the receipt's unit cost becomes the cost. Exact BigInt arithmetic
(`weightedAverageCostMinor`). Without `updateCost` the cost is unchanged.
Every receipt line records its unit cost and the cost before/after
(`purchase_order_receipt_lines`): the SKU's cost history. PO shipping, other
costs and tax are kept as entered and are not spread into unit costs.

**Stock commands** (`stock-commands.ts`): receiving a PO and shipping,
receiving or cancelling a transfer each commit as one batch: subject guard
(document still at the planned revision/status) → per SKU a ledger-v2 claim
(`received`, `transfer_out`, `transfer_in`; pool regular, never reservations)
and the stockVersion CAS update (plus the cost, guarded on the cost read) →
CAS guards proving every SKU landed on its planned edge (a lost race aborts
the whole batch, nothing partial) → the `inventory_commands` replay row
(operation key, request hash, the subject revision it produced, unique per
subject) → document writes → buyer-state refresh. The level triggers keep
`sum(levels) = stock`; removals are pre-checked (`assertInventoryLocationCovers`,
and stock may not drop below reserved) and the level CHECK is the backstop.
An exact retry replays the stored result; the same key with a changed request
is refused (409). Retries re-plan from fresh reads (3 attempts).

**Purchase orders**: draft (editable, lines replaced, deletable) → ordered
(lines locked by triggers; open quantity is incoming stock at the
destination) → partially received → received, or cancelled (received units
stay). At most 100 lines; live physical SKUs only.

**Transfers**: draft → in transit (all lines leave the origin at once) →
partially received → received, or cancelled (units still in transit return
to the origin). **In-transit units are out of both locations and out of the
SKU's `stock`**, so buyer availability (`stock − reserved`) never includes
them; `inventory_transfer_lines` holds them (shipped − received − returned).
Receiving or returning still works for a SKU retired meanwhile (the units
exist); shipping and PO receipts need live SKUs.

**Incoming** = open PO lines + transfers in transit, per destination
(`readIncomingStock`, `incomingUnitsSql`); not on hand and never shown to
buyers (no storefront "restocking soon" hint: it would need its own buyer
dependency key). **Valuation** (`getInventoryValuation`) = on hand × current
unit cost per location; SKUs without a cost are counted, not valued; units in
transit are valued separately. A location with open POs or transfers cannot
be archived; PO and transfer lines block a product's permanent delete like
movements. Events: `inventory.purchase_order_updated` and
`inventory.transfer_updated` (one per revision), plus
`inventory.level_changed` per movement.

## Inventory Lifecycle / State Machine

Stock follows a clear lifecycle driven by order status transitions. The order-level `inventoryAction` column (`orders.inventory_action`) tracks which phase each order is in.

### Per-Order Inventory States

```
  none ──> reserved ──> deducted
             │              │
             │              └──> restored (returned/refunded)
             │
             └──> restored (cancelled pre-payment)
                    │
                    └──> reserved (active-order projection repair)
```

| `inventoryAction` | Meaning                                                              |
|-------------------|----------------------------------------------------------------------|
| `none`            | No inventory action yet (e.g. incomplete checkout)                   |
| `reserved`        | `reservedStock` incremented on storefront checkout                   |
| `deducted`        | `stock` decremented and reservation released on shipment             |
| `restored`        | Stock added back on cancellation/return after deduction              |

### Per-Variant Stock Transitions

```
                    ┌──────────────────────────────────┐
                    │       product_variants row        │
                    │  stock=100  reservedStock=0       │
                    └──────────────┬───────────────────┘
                                   │
                          reserveStock() [checkout]
                          reservedStock += qty
                          stockVersion += 1
                                   │
                    ┌──────────────▼───────────────────┐
                    │  stock=100  reservedStock=5       │
                    │  available = 95                   │
                    └──────────────┬───────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                     │
     claimed deduct       releaseReservation()    [orphan cleanup cron]
     [order shipped]      [cancel/payment fail]   releaseExpiredReservations()
     stock -= qty         reservedStock -= qty    reservedStock -= qty
     reservedStock -= qty stockVersion += 1       stockVersion += 1
     stockVersion += 1
              │                    │                     │
              ▼                    ▼                     ▼
    stock=95                stock=100              stock=100
    reservedStock=0         reservedStock=0         reservedStock=0
```

### Order Status to Inventory Action Mapping

Handled by `inventory-transitions.ts` -- the **single source of truth** for how inventory reacts to order status changes:

| Order status change | `inventoryAction` guard  | Inventory operation              | New `inventoryAction` |
|---------------------|-------------------------|----------------------------------|-----------------------|
| Any -> `shipped`    | Must be `reserved`       | Claimed CAS deduction batch -- decrements `stock`, releases `reservedStock` | `deducted`     |
| Any -> `cancelled`  | `reserved` or `deducted` | Claimed CAS release or restore batch | `restored` |
| Any -> `returned`   | `reserved` or `deducted` | Claimed CAS release or restore batch | `restored` |
| Any -> `refunded`   | `reserved` or `deducted` | Claimed CAS release or restore batch | `restored` |
| `restored` -> `incomplete`/`pending`/`processing`/`confirmed` | Must be `restored` | Claimed `reserveStockBatch()` -- re-reserves stock | `reserved` |

All transitions are **idempotent**: calling `applyInventoryForStatusChange()` multiple times with the same status produces no duplicate adjustments because it checks `inventoryAction` before acting.

## Admin Order Creation Inventory Flow

Admin-created orders follow a reserve-then-deduct pattern:

1. `reserveStockBatch()` validates availability and holds stock for all variant items with deterministic claims
2. `db.batch()` inserts customer + order + items atomically with `inventoryAction: "reserved"`
3. If the order batch fails, `releaseReservedStockBatch()` proves deterministic release claims and counter updates together
4. `applyInventoryForStatusChange()` converts reservations through the claimed CAS transition engine (decrements `stock`, clears `reservedStock`)
5. If deduction succeeds: `inventoryAction` updated to `"deducted"`
6. If deduction fails: stock remains reserved (logged, not fatal -- no overselling risk)

## Stock Pools

Three pools control how stock is sourced:

| Pool        | Reserve behavior                              | Deduct behavior                                   |
|-------------|-----------------------------------------------|---------------------------------------------------|
| `regular`   | Increments `reservedStock`, checks `stock - reservedStock >= qty` | Decrements both `stock` and `reservedStock`    |
| `preorder`  | Decrements `preorderStock`, increments `reservedStock`, requires `allowPreorder` | Decrements only `reservedStock` (preorderStock already consumed) |
| `backorder` | Increments `reservedStock`, requires `allowBackorder`, checks `backorderLimit` (0 = unlimited) | Decrements only `reservedStock`               |

The pool is stored on `orders.inventoryPool` and flows through all inventory operations.

## Reservation Expiry (Cron)

`releaseExpiredReservations()` sweeps for orphaned reservations. Designed for a Cloudflare Cron Trigger (e.g. every 15 minutes).

A reservation is considered expired when:
1. It is a movement of type `reserved` or `preorder_reserved`
2. It was created more than `maxAgeMinutes` ago (default: 30)
3. It has an `orderId` (not null), but no matching row exists in `orders`
4. No corresponding `deducted` / `preorder_deducted` movement exists for the same order+variant
5. No corresponding `released` movement exists for the same order+variant (prevents double-release after cancellations, payment failures, queue rollbacks, or previous sweeps)

Existing orders are not expired by this cron. Stale order cancellation must update order status, `orders.inventoryAction`, variant counters, and movement logs through explicit order transition logic.

The sweep groups by `(variantId, orderId, pool, reservation generation)`, subtracts pool-specific deducted/released quantities from reservations, and processes a bounded batch per invocation (`limit` default `50`, max `200`). It reads one extra sentinel group and returns `hasMore` so cron logs can show whether more orphaned reservations remain for the next scheduled pass. A partial terminal movement leaves the exact remainder eligible; it no longer hides the whole reservation generation. For each processed expired group:
- Decrements `reservedStock` on the variant (clamped to 0 via `MAX(0, ...)`)
- Restores `preorderStock` when the expired claim is `preorder_reserved`
- Records a "released" movement that identifies the expired regular or preorder pool

The function is **idempotent** -- a same-pool "released" movement excludes that reservation from future sweeps. Regular expiry releases keep deterministic movement ids `expiry_release:{orderId}:{variantId}`; preorder expiry releases use `expiry_release:{orderId}:{variantId}:preorder`. The movement insert and pool-aware counter update run in one D1 batch, so overlapping cron invocations cannot both claim and apply the same expiry release.

## Files

| File                       | Exports / Purpose                                                                                  |
|----------------------------|----------------------------------------------------------------------------------------------------|
| `index.ts`                 | Barrel re-exports for all public API                                                               |
| `types.ts`                 | `StockOperationResult`, `ReservationEntry`, `MovementEntry` interfaces                             |
| `reserve.ts`               | `reserveStock()` -- single variant CAS reservation; `reserveMultiple()` -- sequential with rollback; `reserveStockBatch()` -- strict D1 batch movement-claim + counter reservation with CAS verification and rollback |
| `locations.ts`             | Inventory locations (hook H1): location records (list, create, update, archive, unarchive, set default), the location a stock movement resolves to, `assertInventoryLocationCovers()` shortfall pre-check, per-SKU level reads and the level/location trigger error mapping |
| `release.ts`               | `releaseReservation()` -- single variant (no CAS, safe to apply unconditionally with MAX(0,...)); `releaseMultiple()` -- best-effort, continues on individual failures, checks low stock alerts after release |
| `expiry.ts`                | `releaseExpiredReservations()` -- bounded cron sweep; `ExpiryResult` interface                     |
| `movements.ts`             | `recordMovement()` -- best-effort audit log insert (errors logged, not thrown)                      |
| `alerts.ts`                | `checkAndAlertLowStock()` -- creates/reactivates/resolves `productLowStockAlerts`; `acknowledgeLowStockAlert()` -- marks a SKU that needs review as seen; `setDefaultLowStockThreshold()` -- the store alert level |
| `low-stock-policy.ts`      | Store alert level (settings document `inventory`) and `effectiveLowStockThresholdSql()` = COALESCE(SKU level, store level), used by the Low stock list, alerts and the buyer availability band |
| `stock-adjustment.ts`      | `adjustStock()` -- relative delta adjustment with `stockVersion` CAS; `setStock()` -- absolute stocktake; `lookupByBarcodeOrSku()` -- barcode/SKU lookup with product image |
| `inventory-operations.ts`  | Shared idempotent manual/scanner/stocktake command engine; canonical request hashing, exact replay, atomic operation + movement + counter batch |
| `inventory.service.ts`     | `InventoryService.getInventoryOverview()` -- paginated current-product variants/alerts plus audit-preserving movement history; `InventoryService.adjustInventory()` -- admin adjustment with `stockVersion` CAS + retry (3 attempts, exponential backoff) |
| `inventory.validation.ts`  | `adjustInventorySchema` -- Zod schema for adjustment payload (delta, reason enum, notes, pool)     |
| `inventory-transitions.ts` | Claimed movement + stock-CAS engine; `applyInventoryForStatusChange()` for order lifecycle transitions; `applyClaimedInventoryEntryBatch()` for version-scoped manual-order deltas; `InventoryAction` type |
| `validation.ts`            | `validateStockNonNegative()`, `validateBackorderLimit()`, `validateReservedStockConsistency()`, `validatePositiveQuantity()` |
| `stock-commands.ts`        | `executeStockCommand()` -- the multi-SKU command engine (receipts, transfers); `weightedAverageCostMinor()` |
| `unit-costs.ts`            | `setSkuCosts()`, cost parsing (`unitCostToMinor`), `marginPercent()` |
| `cost-visibility.ts`       | What readers without `products.view_costs` get (SKUs, purchase orders, receipts without money) and location details without `inventory.view`/`settings.general.view` |
| `suppliers.ts`             | Supplier records (list, create, update at version, archive while no open PO, unarchive) |
| `purchase-orders.ts`       | Purchase orders: list/get, draft create/edit/delete, mark ordered, receive (cost history, average cost), cancel, CSV |
| `transfers.ts`             | Transfers: list/get, draft create/edit/delete, ship, receive in parts, cancel (returns in-transit units) |
| `inventory-insights.ts`    | Incoming stock per SKU and location; inventory valuation per location |

Admin stock-only mutations (`adjustInventory()`, `adjustStock()`, `setStock()`) affect product availability, not product/category/collection metadata. API routes call `bumpCacheGeneration(c)` after the write commits only when `findStockMutationAvailabilityTransitions()` reports an availability-band change; same-band writes leave public caches alone.

## Database Schema

### `product_variants` (stock columns only)

| Column             | Type      | Default | Notes                                              |
|--------------------|-----------|---------|---------------------------------------------------|
| `stock`            | integer   | 0       | Physical on-hand count                             |
| `reserved_stock`   | integer   | 0       | Units held for unconfirmed orders                  |
| `preorder_stock`   | integer   | 0       | Pre-order allocation pool                          |
| `stock_version`    | integer   | 1       | CAS counter for stock operations only              |
| `version`          | integer   | 1       | General optimistic locking (non-stock changes)     |
| `low_stock_threshold` | integer | null   | Alert level, set by `setLowStockThreshold()` (null = the store level, 0 = off; sold out still alerts) |
| `allow_preorder`   | boolean   | false   | Whether pre-order pool is enabled                  |
| `preorder_date`    | text      | null    | Expected availability date                         |
| `allow_backorder`  | boolean   | false   | Whether backorder pool is enabled                  |
| `backorder_limit`  | integer   | 0       | Max backorder quantity (0 = unlimited)             |
| `barcode`          | text      | null    | Scannable barcode value                            |
| `barcode_type`     | text enum | null    | `ean13`, `upc`, `isbn`, `gtin`, `custom`          |

### `inventory_movements` (audit log and ledger v2)

| Column          | Type      | Notes                                                         |
|-----------------|-----------|---------------------------------------------------------------|
| `id`            | text PK   | UUID or deterministic reservation/release claim id             |
| `variant_id`    | text FK   | References `product_variants.id` (restrict)                   |
| `order_id`      | text      | Nullable order id, intentionally not FK-enforced because checkout reservation claims are written before the queued order row commits |
| `type`          | text      | `reserved`, `deducted`, `released`, `adjusted`, `restored`, `preorder_reserved`, `preorder_deducted`, `received` (PO receipt), `transfer_out`, `transfer_in` |
| `quantity`      | integer   | Positive = added, negative = removed                          |
| `previous_stock`| integer   | Stock level before operation                                  |
| `new_stock`     | integer   | Stock level after operation                                   |
| `notes`         | text      | Human-readable context                                        |
| `created_by`    | text      | Admin user ID (for manual adjustments)                        |
| `created_at`    | timestamp | Unix epoch seconds                                            |

New production counter writes use `ledger_version = 2` and additionally record `pool`, `reservation_generation`, `stock_version_before/after`, and before/after/delta values for physical, reserved, and preorder counters. `(variant_id, stock_version_after)` is unique, so the CAS version is also the deterministic per-SKU ledger sequence. Legacy rows remain version 1 history and are not falsely backfilled with counter facts that were never recorded.

Indexes: `variant_id`, `order_id`, `created_at`

### `inventory_operations` (merchant command replay ledger)

| Column | Notes |
|---|---|
| `operation_key` | Merchant/client generated primary replay identity |
| `request_hash` | SHA-256 of canonical mode/type/SKU/pool/quantity/reason/notes |
| `operation_type` | `manual_adjustment`, `scanner_adjustment`, or `stocktake` |
| `variant_id` | Affected SKU |
| `movement_id` | Matching ledger-v2 edge, null only for a no-op stocktake |
| `result_payload` | Exact committed `previousStock/newStock/delta` response |
| `stock_version_before/after` | Counter CAS edge committed with the operation |
| `created_by`, `created_at` | Original actor and timestamp; actor is not part of replay identity |

### `product_low_stock_alerts`

| Column           | Type      | Notes                                              |
|------------------|-----------|----------------------------------------------------|
| `id`             | text PK   | UUID                                               |
| `variant_id`     | text FK   | References `product_variants.id` (unique, cascade)  |
| `product_id`     | text FK   | References `products.id` (cascade)                  |
| `current_qty`    | integer   | Available stock at time of alert                    |
| `threshold`      | integer   | The threshold that triggered the alert              |
| `alert_status`   | text      | `active`, `acknowledged`, `resolved`                |
| `alert_sent_at`  | timestamp | When the alert was first triggered                  |
| `acknowledged_at`| timestamp | When admin acknowledged                             |
| `resolved_at`    | timestamp | When stock was replenished above threshold          |
| `created_at`     | timestamp |                                                     |
| `updated_at`     | timestamp |                                                     |

Indexes: `product_id`, `alert_status`

## Low Stock Alert Lifecycle

```
[stock drops to the alert level, or sells out (level 0 when none is set)]
     │
     ├── No existing alert ──> CREATE alert (status: active)
     ├── Existing alert resolved ──> REACTIVATE (status: active, clear ack/resolved dates)
     └── Existing alert active/acknowledged ──> UPDATE currentQty and threshold

[stock rises above threshold]
     └── Existing non-resolved alert ──> RESOLVE (status: resolved, set resolvedAt)

[admin sets the alert level: setLowStockThreshold(), no stock movement]
     └── Re-check at once; the API bumps the public cache generation

[admin sets the store alert level: setDefaultLowStockThreshold(), no SKU rewritten]
     └── The API bumps the public cache generation (buyer bands can change)

[admin acknowledges]
     └── Refresh the alert from live stock, then active ──> status: acknowledged
```

The Low stock list reads live stock, not stored alerts: every tracked SKU at or
under the level that applies (sold out included) needs review unless its alert
row says it was seen; a stored alert that no longer applies lists as restocked.

Alerts are checked after: manual adjustments (negative delta), stock deductions on shipment, scanner adjustments, reservation releases, and stock restorations.

## Concurrency Control Details

### Reserve: Two Strategies

1. **`reserveMultiple()`** -- Sequential. Reserves one variant at a time with individual CAS. On any failure, rolls back all previously successful reservations. Suitable for small order sizes.

2. **`reserveStockBatch()`** -- Atomic for batch reservations. Reads all variant states upfront through a sellability guard (`product_variants.deleted_at IS NULL`, parent product active, parent product not deleted), validates ALL availability before writing, inserts strict reservation movement claims and variant CAS counter updates in one D1 `safeBatch()`, then verifies every movement insert and update returned a row. Movement inserts are `INSERT ... SELECT` gated on the same pre-read `stockVersion`, so stale versions create neither audit rows nor counter updates. Variant counter updates also require the variant to remain non-deleted at write time. If any insert/update returns empty, successful movement claims are deleted, successful counter updates are reversed, and the whole operation retries. Callers may pass `reservationKey` (queued checkout uses `checkout-ingest:v1`) or explicit `movementId` for deterministic replay; exact duplicate deterministic claims are treated as idempotent success, while mismatches return `manualReconciliationRequired`.

### Deduct

Production order workflows use the claimed transition engine: deterministic movement insert and every variant `stockVersion` CAS update are submitted in one D1 batch. Deduct/release claims also require enough reserved units (and regular deductions require enough physical stock), so drift fails closed instead of being hidden by counter clamping. Exact duplicate claims are idempotent success; mismatched claims fail closed. For regular pool it decrements both `stock` and `reservedStock`; for preorder/backorder it decrements only `reservedStock`.

### Release

Production order workflows use either the claimed order transition engine or `releaseReservedStockBatch()`. Both keep deterministic movement claims and stock CAS updates together. `releaseReservedStockBatch()` also proves an outstanding reservation movement exists before releasing it. Partial-batch compensation is itself stock-version guarded; if rollback cannot be proven, the operation stops for manual reconciliation without deleting its evidence claim. The old best-effort sequential helpers remain compatibility-only and have no production caller.

Transition preparation and low-stock projection refreshes use at most four concurrent database tasks, below D1's six-connection invocation ceiling. Low-stock refresh is ancillary after the ledger/CAS batch: a refresh failure is logged without turning an already-committed inventory mutation into a false failure that callers might retry.

### Restore

Restores run through the claimed transition engine (status-driven cancel/return, or `applyClaimedInventoryEntryBatch()` for return receipts). For regular pool: increments `stock` (undoes the deduction) at the location the units left from, or at the receipt's restock location. For preorder pool: restores `preorderStock`. For backorder pool: no-op on stock counters (backorder never decremented physical stock).

### adjustInventory (InventoryService)

`InventoryService.adjustInventory()` uses `stockVersion` CAS with 3 retries and exponential backoff (50ms base). Supports `stock` and `preorderStock` pools. Throws `ConflictError` after exhausting retries.

## Dependencies

- `@scalius/database` -- `productVariants`, `products`, `productMedia`, `media`, `inventoryMovements`, `productLowStockAlerts`, `orders`, `orderItems`, `InventoryPool`
- `@scalius/core/errors` -- `NotFoundError`, `ValidationError`, `ConflictError`

## Known Gaps

- The legacy sequential reserve/release exports remain for compatibility, but no production order, checkout, payment, or fulfillment caller uses them. Do not add new callers. The legacy deduct/restore helpers were removed (H1): they moved physical stock without a ledger-v2 movement, so the location levels could not follow.
- Version-1 legacy movements predate complete counter snapshots and cannot be folded before the v2 boundary. Production diagnostics must report that boundary rather than claiming historical reconstruction.
