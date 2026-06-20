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
                    └──> reserved (admin reactivation)
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
     deductStock()        releaseReservation()    [orphan cleanup cron]
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
| Any -> `shipped`    | Must be `reserved`       | `deductMultiple()` -- decrements `stock`, releases `reservedStock` | `deducted`     |
| Any -> `cancelled`  | `reserved` or `deducted` | `releaseMultiple()` (reserved) or `restoreDeductedMultiple()` (deducted) | `restored` |
| Any -> `returned`   | `reserved` or `deducted` | `releaseMultiple()` (reserved) or `restoreDeductedMultiple()` (deducted) | `restored` |
| Any -> `refunded`   | `reserved` or `deducted` | `releaseMultiple()` (reserved) or `restoreDeductedMultiple()` (deducted) | `restored` |
| `restored` -> `incomplete`/`pending`/`processing`/`confirmed` | Must be `restored` | `reserveMultiple()` -- re-reserves stock | `reserved` |

All transitions are **idempotent**: calling `applyInventoryForStatusChange()` multiple times with the same status produces no duplicate adjustments because it checks `inventoryAction` before acting.

## Admin Order Creation Inventory Flow

Admin-created orders follow a reserve-then-deduct pattern:

1. `reserveMultiple()` validates availability and holds stock for all variant items
2. `db.batch()` inserts customer + order + items atomically with `inventoryAction: "reserved"`
3. If batch fails: `releaseMultiple()` releases all reservations (no orphaned holds)
4. `deductMultiple()` converts reservations to permanent deductions (decrements `stock`, clears `reservedStock`)
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

The sweep groups by `(variantId, orderId)`, sums quantities, and processes a bounded batch per invocation (`limit` default `50`, max `200`). It reads one extra sentinel group and returns `hasMore` so cron logs can show whether more orphaned reservations remain for the next scheduled pass. For each processed expired group:
- Decrements `reservedStock` on the variant (clamped to 0 via `MAX(0, ...)`)
- Records a "released" movement with note `"expired reservation (age > 30min, order {orderId})"`

The function is **idempotent** -- the "released" movement it creates excludes that reservation from future sweeps. Expiry releases use deterministic movement ids (`expiry_release:{orderId}:{variantId}`) and run the movement insert plus variant counter update in a single D1 batch, so overlapping cron invocations cannot both claim and apply the same expiry release.

## Files

| File                       | Exports / Purpose                                                                                  |
|----------------------------|----------------------------------------------------------------------------------------------------|
| `index.ts`                 | Barrel re-exports for all public API                                                               |
| `types.ts`                 | `StockOperationResult`, `ReservationEntry`, `MovementEntry` interfaces                             |
| `reserve.ts`               | `reserveStock()` -- single variant CAS reservation; `reserveMultiple()` -- sequential with rollback; `reserveStockBatch()` -- strict D1 batch movement-claim + counter reservation with CAS verification and rollback |
| `deduct.ts`                | `deductStock()` -- single variant CAS deduction; `deductMultiple()` -- sequential with rollback via `restoreDeductedStock()` |
| `restore.ts`               | `restoreDeductedStock()` -- restores deducted stock for a single variant (regular: increments `stock`, preorder: restores `preorderStock`, backorder: no-op); `restoreDeductedMultiple()` -- sequential restore with low stock alert check |
| `release.ts`               | `releaseReservation()` -- single variant (no CAS, safe to apply unconditionally with MAX(0,...)); `releaseMultiple()` -- best-effort, continues on individual failures, checks low stock alerts after release |
| `expiry.ts`                | `releaseExpiredReservations()` -- bounded cron sweep; `ExpiryResult` interface                     |
| `movements.ts`             | `recordMovement()` -- best-effort audit log insert (errors logged, not thrown)                      |
| `alerts.ts`                | `checkAndAlertLowStock()` -- creates/reactivates/resolves `productLowStockAlerts`; `acknowledgeLowStockAlert()` -- marks alert as acknowledged |
| `stock-adjustment.ts`      | `adjustStock()` -- relative delta adjustment with `stockVersion` CAS; `setStock()` -- absolute stocktake; `lookupByBarcodeOrSku()` -- barcode/SKU lookup with product image |
| `inventory.service.ts`     | `InventoryService.getInventoryOverview()` -- paginated variants/movements/alerts query; `InventoryService.adjustInventory()` -- admin adjustment with `stockVersion` CAS + retry (3 attempts, exponential backoff) |
| `inventory.validation.ts`  | `adjustInventorySchema` -- Zod schema for adjustment payload (delta, reason enum, notes, pool)     |
| `inventory-transitions.ts` | `buildInventoryStatements()` -- returns SQL statements for batching; `applyInventoryForStatusChange()` -- standalone wrapper; single source of truth for order-status-driven inventory changes; `InventoryAction` type |
| `validation.ts`            | `validateStockNonNegative()`, `validateBackorderLimit()`, `validateReservedStockConsistency()`, `validatePositiveQuantity()`, `calculateFinalPrice()` |

Admin stock-only mutations (`adjustInventory()`, `adjustStock()`, `setStock()`) affect product availability, not product/category/collection metadata. API routes should invalidate by affected variant through `invalidateProductAvailabilityCaches(db, { variantIds }, c)` after the write commits, avoiding broad catalog invalidation unless product metadata changed too.

## Database Schema

### `product_variants` (stock columns only)

| Column             | Type      | Default | Notes                                              |
|--------------------|-----------|---------|---------------------------------------------------|
| `stock`            | integer   | 0       | Physical on-hand count                             |
| `reserved_stock`   | integer   | 0       | Units held for unconfirmed orders                  |
| `preorder_stock`   | integer   | 0       | Pre-order allocation pool                          |
| `stock_version`    | integer   | 1       | CAS counter for stock operations only              |
| `version`          | integer   | 1       | General optimistic locking (non-stock changes)     |
| `low_stock_threshold` | integer | null   | Alert trigger threshold (null = no alerts)         |
| `allow_preorder`   | boolean   | false   | Whether pre-order pool is enabled                  |
| `preorder_date`    | text      | null    | Expected availability date                         |
| `allow_backorder`  | boolean   | false   | Whether backorder pool is enabled                  |
| `backorder_limit`  | integer   | 0       | Max backorder quantity (0 = unlimited)             |
| `barcode`          | text      | null    | Scannable barcode value                            |
| `barcode_type`     | text enum | null    | `ean13`, `upc`, `isbn`, `gtin`, `custom`          |

### `inventory_movements` (audit log)

| Column          | Type      | Notes                                                         |
|-----------------|-----------|---------------------------------------------------------------|
| `id`            | text PK   | UUID or deterministic reservation/release claim id             |
| `variant_id`    | text FK   | References `product_variants.id` (restrict)                   |
| `order_id`      | text      | Nullable order id, intentionally not FK-enforced because checkout reservation claims are written before the queued order row commits |
| `type`          | text      | `reserved`, `deducted`, `released`, `adjusted`, `preorder_reserved`, `preorder_deducted` |
| `quantity`      | integer   | Positive = added, negative = removed                          |
| `previous_stock`| integer   | Stock level before operation                                  |
| `new_stock`     | integer   | Stock level after operation                                   |
| `notes`         | text      | Human-readable context                                        |
| `created_by`    | text      | Admin user ID (for manual adjustments)                        |
| `created_at`    | timestamp | Unix epoch seconds                                            |

Indexes: `variant_id`, `order_id`, `created_at`

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
[stock drops below threshold]
     │
     ├── No existing alert ──> CREATE alert (status: active)
     ├── Existing alert resolved ──> REACTIVATE (status: active, clear ack/resolved dates)
     └── Existing alert active/acknowledged ──> UPDATE currentQty only

[stock rises above threshold]
     └── Existing non-resolved alert ──> RESOLVE (status: resolved, set resolvedAt)

[admin acknowledges]
     └── Active alert ──> status: acknowledged
```

Alerts are checked after: manual adjustments (negative delta), stock deductions on shipment, scanner adjustments, reservation releases, and stock restorations.

## Concurrency Control Details

### Reserve: Two Strategies

1. **`reserveMultiple()`** -- Sequential. Reserves one variant at a time with individual CAS. On any failure, rolls back all previously successful reservations. Suitable for small order sizes.

2. **`reserveStockBatch()`** -- Atomic for batch reservations. Reads all variant states upfront through a sellability guard (`product_variants.deleted_at IS NULL`, parent product active, parent product not deleted), validates ALL availability before writing, inserts strict reservation movement claims and variant CAS counter updates in one D1 `safeBatch()`, then verifies every movement insert and update returned a row. Movement inserts are `INSERT ... SELECT` gated on the same pre-read `stockVersion`, so stale versions create neither audit rows nor counter updates. Variant counter updates also require the variant to remain non-deleted at write time. If any insert/update returns empty, successful movement claims are deleted, successful counter updates are reversed, and the whole operation retries. Callers may pass `reservationKey` (queued checkout uses `checkout-ingest:v1`) or explicit `movementId` for deterministic replay; exact duplicate deterministic claims are treated as idempotent success, while mismatches return `manualReconciliationRequired`.

### Deduct

`deductMultiple()` -- Sequential deduction with rollback via `restoreDeductedStock()`. For regular pool: decrements both `stock` and `reservedStock`. For preorder/backorder pool: decrements only `reservedStock`.

### Release

`releaseMultiple()` -- Best-effort. Does NOT use CAS because releasing is always safe (uses `MAX(0, ...)` to guard underflow). Continues processing even if individual releases fail. A missed release only over-reserves, never causes overselling. Checks low stock alerts after each release.

### Restore

`restoreDeductedStock()` -- Restores stock after a post-shipment cancellation or return. For regular pool: increments `stock` (undoes the deduction). For preorder pool: restores `preorderStock`. For backorder pool: no-op on stock counters (backorder never decremented physical stock). `restoreDeductedMultiple()` processes sequentially and checks low stock alerts after each restore.

### adjustInventory (InventoryService)

`InventoryService.adjustInventory()` uses `stockVersion` CAS with 3 retries and exponential backoff (50ms base). Supports `stock` and `preorderStock` pools. Throws `ConflictError` after exhausting retries.

## Dependencies

- `@scalius/database` -- `productVariants`, `products`, `productImages`, `inventoryMovements`, `productLowStockAlerts`, `orders`, `orderItems`, `InventoryPool`
- `@scalius/core/errors` -- `NotFoundError`, `ValidationError`, `ConflictError`
- `@scalius/shared/price-utils` -- `roundPrice()` (used in `calculateFinalPrice`)

## Known Gaps

- **Batch deduction not implemented** -- `deductMultiple()` is sequential (no batch equivalent like `reserveStockBatch()`)
