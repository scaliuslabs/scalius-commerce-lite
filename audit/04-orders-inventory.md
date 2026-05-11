# Orders / Inventory Audit

## Scope

Audited the end-to-end orders and inventory slice centered on:

- `packages/core/src/modules/orders/**`
- `packages/core/src/modules/inventory/**`

Read adjacent touchpoints only where they materially change order or inventory state:

- `packages/core/src/modules/payments/process-payment.ts`
- `packages/core/src/modules/payments/refund-service.ts`
- `packages/core/src/modules/payments/cod.ts`
- `packages/core/src/modules/payments/polar.ts`
- `packages/core/src/modules/delivery/tracking.ts`
- `apps/api/src/routes/orders.ts`
- `apps/api/src/routes/admin/orders.ts`
- `apps/api/src/routes/admin/orders-status.ts`
- `apps/api/src/queue-consumer.ts`
- `packages/database/src/schema/orders.ts`
- `packages/database/src/schema/products.ts`
- related tests under `tests/unit/core/orders/**`, `tests/unit/core/inventory/**`, and payment tests that exercise this lifecycle

Not audited in depth:

- admin UI component behavior
- storefront UI pages
- unrelated delivery provider internals beyond status-to-order syncing

## End-to-End Flow Map

1. Storefront checkout enters through `createStorefrontOrder()` in `packages/core/src/modules/orders/orders.storefront.ts`, which price-validates, validates discounts/shipping, and emits an `ORDER_INGEST_QUEUE` payload.
2. `handleOrderIngestBatch()` in `packages/core/src/modules/orders/orders.queue.ts` batches customer/order/item writes, reserves inventory via `reserveStockBatch()`, writes checkout status to KV, and initializes COD tracking for COD orders.
3. Admin order creation in `packages/core/src/modules/orders/orders.admin.ts` takes a different path: it reserves stock first, inserts the order synchronously, then immediately converts the reservation to a deduction.
4. Admin order editing in `updateOrder()` recomputes totals, swaps order items, and then tries to reconcile inventory based on the prior `inventoryAction`.
5. Status changes run through `updateOrderStatus()` and `applyInventoryForStatusChange()`. Shipment/COD routes also mutate order state through `bulkShipOrders()`, `createFulfillmentShipment()`, `processCodAction()`, and `updateOrderStatusFromShipment()`.
6. Payment webhooks hit `processPaymentConfirmed()` / `processPaymentFailed()` from `packages/core/src/modules/payments/process-payment.ts`. Refunds and returns go through `processRefund()` / `processReturn()` in `refund-service.ts`, plus Polar's webhook-specific refund path.
7. Inventory storage lives on `product_variants` via `stock`, `reservedStock`, `preorderStock`, and `stockVersion`. The order-side summary of what happened is `orders.inventoryAction`.
8. Reservation expiry is handled by the cron-triggered `releaseExpiredReservations()` in `packages/core/src/modules/inventory/expiry.ts`.

Cross-cutting architectural note:

- The same business status can mean different stock reality depending on the entry path. Storefront orders are usually `reserved` until shipping, while admin-created orders become `deducted` immediately even though they start at `status = "pending"` (`packages/core/src/modules/orders/orders.admin.ts:555-600`). That makes `inventoryAction`, not `status`, the true stock source of truth, which raises maintenance risk everywhere the two can drift.

## Findings

### P0 - `updateOrder()` can commit order changes even when the inventory change fails

Files:

- `packages/core/src/modules/orders/orders.admin.ts:715-788`
- `packages/core/src/modules/orders/orders.admin.ts:821-850`

Why this is serious:

- The function performs the order-row CAS update first, then deletes and reinserts all `orderItems`, and only after that tries to release/re-reserve stock or validate/deduct delta stock.
- If `reserveStockBatch()` fails in the `reserved` branch, or the deducted branch throws on stock validation, the API returns an error after the order row and order items have already been mutated.
- The rollback only attempts to restore previous reservations. It never restores the previous order payload or previous line items.

User-visible failure mode:

- The caller sees a failed update, but the database can still contain the new customer/address/items/total.
- Inventory can remain on the old shape while the order rows show the new shape, or vice versa.

### P0 - queue ingestion can create phantom or misattributed reservations

Files:

- `packages/core/src/modules/orders/orders.queue.ts:96-108`
- `packages/core/src/modules/orders/orders.queue.ts:252-352`
- `packages/core/src/modules/inventory/reserve.ts:230-243`

Why this is serious:

- Phase 1b can reject an order after discount re-check by removing its write statements from `writeBatch`, but it does not remove that order's entries from `reservationEntries`.
- Phase 2 still reserves stock for those rejected orders.
- `reserveStockBatch()` then deduplicates by `variantId` only and stores only the first `orderId` for the merged entry. The queue deliberately batches multiple orders together per pool, so two different orders containing the same variant collapse into one movement record.

Impact:

- Stock can be held for an order that never gets written.
- Inventory movement history becomes wrong at the per-order level.
- Expiry logic and audit logic that depend on `orderId` lose the ability to tell which order owns which hold.

### P1 - multiple fulfillment/return/COD paths still mutate side effects before the authoritative order write is guaranteed

Files:

- `packages/core/src/modules/payments/refund-service.ts:397-416`
- `packages/core/src/modules/orders/orders.fulfillment.ts:78-81`
- `packages/core/src/modules/orders/orders.fulfillment.ts:89-95`
- `packages/core/src/modules/orders/orders.fulfillment.ts:141-151`
- `packages/core/src/modules/payments/cod.ts:69-111`
- `packages/core/src/modules/payments/cod.ts:146-157`

Why this is serious:

- `processReturn()` explicitly applies inventory before the CAS-protected order update.
- `createFulfillmentShipment()` deducts inventory before the shipment/order batch write.
- `processCodAction("collected")` records COD payment state before the final delivered-status CAS.
- `processCodAction("returned")` marks COD returned before the order-status CAS.

Impact:

- A concurrent order edit or a late DB failure can leave stock/payment/COD tables changed while the order row does not reflect the transition that supposedly justified the side effect.

### P1 - payment confirmation has no order-level CAS, so concurrent successful payments can overwrite each other

Files:

- `packages/core/src/modules/payments/process-payment.ts:71-156`

Why this is serious:

- `processPaymentConfirmed()` reads `paidAmount`, computes new totals in memory, and updates the order without a version guard.
- Unique indexes only protect duplicate gateway identifiers. They do not protect distinct successful payments that arrive close together, such as deposit plus balance, cross-gateway reconciliation mistakes, or duplicate business events with different IDs.

Impact:

- The last writer wins on `paidAmount`, `balanceDue`, and `paymentStatus`.
- `orderPayments` can correctly contain both payments while `orders.paidAmount` only reflects one of them.

### P1 - `inventory-transitions` can mark `inventoryAction` as successful even when the stock operation failed

Files:

- `packages/core/src/modules/inventory/inventory-transitions.ts:67-120`
- `packages/core/src/modules/inventory/inventory-transitions.ts:176-188`
- `packages/core/src/modules/inventory/inventory-transitions.ts:253-259`
- `packages/core/src/modules/inventory/inventory-transitions.ts:292-299`

Why this is serious:

- `deductOrderStock()`, `reserveOrderItems()`, and `restoreDeductedOrderStock()` log failures but do not throw.
- `buildInventoryStatements()` still returns `"deducted"`, `"reserved"`, or `"restored"` and callers persist that new action.

Impact:

- The order can claim the stock transition already happened when the underlying stock mutation partially failed or never happened.
- This hides the problem from later flows, because subsequent transitions key off `inventoryAction`.

### P1 - deducted-order edits bypass the inventory module's core invariants

Files:

- `packages/core/src/modules/orders/orders.admin.ts:791-850`

Why this is serious:

- The deducted branch writes `productVariants.stock` directly instead of going through the inventory helpers.
- It does not use `stockVersion` CAS.
- It does not record inventory movements.
- It does not trigger low-stock checks.
- It ignores pool semantics entirely, so preorder/backorder orders are treated like regular-stock orders during edit-time reconciliation.

Impact:

- Lost-update races are possible against scanner/manual stock adjustments.
- Audit trail and alerting become incomplete.
- Preorder/backorder stock can be silently corrupted if admin editing ever reaches those orders.

### P1 - delete/restore reuses cancellation semantics and can fabricate stock for fulfilled orders

Files:

- `packages/core/src/modules/orders/orders.admin.ts:884-942`
- `packages/core/src/modules/orders/orders.admin.ts:950-975`

Why this is serious:

- Soft delete restocks any order whose `inventoryAction` is `reserved` or `deducted`, regardless of whether that order already shipped or completed.
- Restore then re-reserves the order if `inventoryAction === "restored"`, even if the order had previously been fulfilled and should still be deducted.

Impact:

- An archival operation can mutate physical inventory like a business cancellation.
- A shipped order can become a reserved order simply by delete/restore cycling.

### P1 - expired preorder reservations leak `preorderStock`

Files:

- `packages/core/src/modules/inventory/expiry.ts:79-152`

Why this is serious:

- The expiry sweep explicitly includes `preorder_reserved` movements, but its release update only decrements `reservedStock`.
- Unlike `releaseReservation()` in `packages/core/src/modules/inventory/release.ts`, it never adds the quantity back to `preorderStock`.

Impact:

- Expired preorder holds permanently consume preorder capacity until someone manually repairs the stock.

### P2 - storefront and admin order writes do not validate variant/product consistency

Files:

- `packages/core/src/modules/orders/orders.storefront.ts:196-223`
- `packages/core/src/modules/orders/orders.admin.ts:449-465`
- `packages/core/src/modules/orders/orders.admin.ts:564-577`
- `packages/core/src/modules/orders/orders.admin.ts:744-756`

Why this matters:

- Storefront validation only checks that the variant exists and the product exists. It never checks that `variant.productId === item.productId`.
- Admin create/update accept the product/variant pairing as-is and write it directly.

Impact:

- A mismatched pair can produce wrong pricing, wrong product attribution, and wrong stock attribution for the order line.

### P2 - direct status updates can mark COD orders as paid without recording payment facts

Files:

- `packages/core/src/modules/orders/orders.fulfillment.ts:185-199`

Why this matters:

- `updateOrderStatus()` auto-flips COD `paymentStatus` to `paid` when the order moves to delivered/completed.
- It does not create an `orderPayments` record and does not update `paidAmount` or `balanceDue`.
- The dedicated COD path in `recordCODCollection()` does all three, so the generic status route can create an accounting state that looks paid but has no payment evidence.

## Test Coverage Gaps

Verification performed:

- Ran `pnpm vitest run tests/unit/core/orders/order-state-machine.test.ts tests/unit/core/orders/order-lifecycle.test.ts tests/unit/core/inventory/batch-reservation.test.ts tests/unit/core/inventory/reserve-deduct-release.test.ts tests/unit/core/payments/process-payment.test.ts tests/unit/core/payments/refund-validation.test.ts tests/unit/core/payments/cod-idempotency.test.ts`
- Result: `7` files passed, `108` tests passed

Why the current suite still leaves major risk:

- The current tests are mostly pure logic replicas, not tests of the real module functions against a real D1/Drizzle state machine.
- `tests/unit/core/orders/order-state-machine.test.ts:42-54` hard-codes a transition map that no longer matches production in `packages/core/src/modules/orders/order-state-machine.ts:19-35`. Examples: the test allows `pending -> shipped`, `processing -> pending`, `confirmed -> pending`, and broader `partially_refunded` exits that production no longer allows.
- `tests/unit/core/orders/order-lifecycle.test.ts:60-63` still expects `deducted` inventory to stay `deducted` on cancel/return, but production `inventory-transitions.ts:80-91` now restores deducted stock on those statuses.
- No test currently exercises mixed-order queue batches that share a variant.
- No test currently exercises Phase 1b discount rejection followed by Phase 2 reservation.
- No test currently proves `updateOrder()` rolls back order rows/items on failed stock validation, because it does not.
- No test currently covers preorder reservation expiry.
- No test currently covers concurrent payment success, return/COD conflicts, or shipment-batch failures with real stock side effects.

## Prioritized Follow-Ups

1. Fix `updateOrder()` first. Put order row, item replacement, and inventory reconciliation behind one coherent transaction/compensation boundary. Do not mutate persistent order state before stock validation succeeds.
2. Fix queue reservation accounting. Remove rejected orders from `reservationEntries`, and stop cross-order merging inside `reserveStockBatch()` unless the key includes `orderId` and the downstream audit/expiry model supports it.
3. Refactor the side-effect-before-CAS flows. `processReturn()`, `createFulfillmentShipment()`, and `processCodAction()` should only apply inventory/payment side effects after the authoritative order write is guaranteed, or must include durable rollback.
4. Add order-level CAS or atomic increment semantics to `processPaymentConfirmed()` so aggregate money fields cannot lose concurrent payments.
5. Route all deducted-order edits through inventory helpers instead of direct `productVariants.stock` updates. Preserve `stockVersion`, movement logging, low-stock alerts, and pool semantics.
6. Split delete/archive from business cancellation. Either disallow deleting fulfilled orders, or preserve and restore their prior stock state instead of pretending delete means cancel.
7. Fix preorder expiry to restore `preorderStock`.
8. Add integration tests around real Drizzle/D1 behavior for: queue ingest, mixed-order batches, discount rejection, update rollback, concurrent payment/refund/COD, preorder expiry, and delete/restore on fulfilled orders.
