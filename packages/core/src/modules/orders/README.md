# Orders Module

Full order lifecycle: storefront checkout, admin CRUD, state machine validation, fulfillment, COD tracking, queue-based async ingestion, and notification dispatch.

## Files

| File | Exports | Purpose |
|------|---------|---------|
| `index.ts` | barrel re-exports | Public API surface |
| `orders.types.ts` | `OrderShipmentSummary`, `OrderListItem`, `OrderDetails`, `StorefrontOrderItem`, `CreateStorefrontOrderInput`, `CreateStorefrontOrderResult`, `OrderIngestQueuePayload`, `StatusUpdateResult` | Shared TypeScript interfaces for admin, storefront, and queue |
| `orders.admin.ts` | `listOrders()`, `getOrderDetails()`, `createOrder()`, `updateOrder()`, `deleteOrder()`, `restoreOrder()`, `permanentlyDeleteOrder()`, `bulkDeleteOrders()` | Admin dashboard queries and write operations |
| `orders.storefront.ts` | `createStorefrontOrder()` | Storefront checkout validation and queue payload builder |
| `orders.fulfillment.ts` | `bulkShipOrders()`, `processCodAction()`, `getOrderShipments()`, `createFulfillmentShipment()`, `updateOrderStatus()` | Shipment creation, COD actions, status transitions with notification dispatch |
| `orders.validation.ts` | `createOrderSchema`, `updateOrderSchema`, `bulkDeleteOrderSchema`, `bulkShipOrderSchema`, `CreateOrderInput`, `UpdateOrderInput`, `BulkDeleteOrderInput`, `BulkShipOrderInput` | Zod validation schemas for API routes |
| `order-state-machine.ts` | `canTransitionTo()`, `validateTransition()`, `getAvailableTransitions()`, `StatusDimension` | Enforces valid order/payment/fulfillment status transitions |
| `orders.queue.ts` | `handleOrderIngestBatch()`, `setCheckoutStatus()`, `OrderIngestQueueMessage` | Queue consumer for async order ingestion |

## Order State Machine

Three independent status dimensions, each with its own transition map. Exported type `StatusDimension` is `"order" | "payment" | "fulfillment"`.

### Order Status Transitions

```
incomplete --> pending, cancelled
pending    --> processing, confirmed, cancelled
processing --> confirmed, cancelled
confirmed  --> shipped, cancelled
shipped    --> delivered, returned, cancelled
delivered  --> completed, returned, refunded, partially_refunded
completed  --> returned, refunded, partially_refunded
cancelled  --> pending, confirmed       (admin reactivation only)
returned   --> refunded
refunded   --> (terminal)
partially_refunded --> refunded
```

All 11 states: `incomplete`, `pending`, `processing`, `confirmed`, `shipped`, `delivered`, `completed`, `cancelled`, `returned`, `refunded`, `partially_refunded`.

**Note on CANCELLED:** The state machine allows `cancelled -> pending` and `cancelled -> confirmed` for admin reactivation. When this happens, `inventory-transitions.ts` detects `currentAction === "restored"` and re-reserves stock via `reserveOrderItems()`. The comment in the state machine explicitly says "Admin override only: merchants can reactivate cancelled orders."

### Payment Status Transitions

```
unpaid  --> partial, paid, failed
partial --> paid, unpaid, refunded, failed
paid    --> partial, refunded
refunded --> (terminal)
failed  --> unpaid, partial, paid
```

5 states: `unpaid`, `partial`, `paid`, `refunded`, `failed`.

### Fulfillment Status Transitions

```
pending  --> partial, complete
partial  --> complete, pending
complete --> pending
```

3 states: `pending`, `partial`, `complete`.

### Item Fulfillment Status

Per-item tracking (on `orderItems.fulfillmentStatus`): `pending`, `picked`, `packed`, `shipped`, `delivered`. These are NOT governed by the state machine -- they are set directly by `createFulfillmentShipment()`.

## Data Flow

### Storefront Order Creation (async, queue-based)

1. **Storefront POST /orders** -- `createStorefrontOrder()` validates prices server-side, verifies discounts, checks partial payment rules, resolves locations, builds queue payload with pre-generated `orderId` and `checkoutToken`
2. **Enqueue** -- API route sends payload to `ORDER_INGEST_QUEUE`, writes `{ status: "processing", orderId }` to KV
3. **Queue consumer** -- `handleOrderIngestBatch()` processes the batch:
   - Phase 1: Accumulate DB write statements (customer, order, items, discount usage) and reservation entries
   - Phase 1b: Re-check discount usage limits to narrow race window
   - Phase 2: `reserveStockBatch()` per pool -- if any fail, retry all messages
   - Phase 3: `db.batch()` atomic write -- if succeeds, init COD tracking for COD orders, write "completed" to KV, ack messages
   - Phase 4: On DB failure, rollback inventory via `releaseMultiple()`, retry all messages
4. **Storefront polls** -- `GET /orders/status/:token` reads KV until "completed" or "failed"

### Admin Order Creation (synchronous, reserve then deduct)

1. **Admin POST /admin/orders** -- `createOrder()` calculates totals, resolves locations, finds/creates customer
2. **Reserve stock**: Calls `reserveMultiple()` for all variant items. If any variant has insufficient stock, throws `ValidationError` immediately -- order is never created.
3. **Atomic DB write**: Inserts customer (new or update), order, and items in a single `db.batch()` call with `inventoryAction: "reserved"`.
4. **On batch failure**: Calls `releaseMultiple()` to release all reservations made in step 2.
5. **Convert to deduction**: Calls `deductMultiple()` to permanently deduct stock (decrements `stock`, clears `reservedStock`). On success, updates `inventoryAction` to `"deducted"`.
6. **On deduction failure**: Stock remains reserved (no overselling risk). Error is logged but the order itself succeeds.

### Admin Order Update

1. `updateOrder()` validates status transition via state machine
2. If `inventoryAction === "reserved"`: releases old reservations, reserves new quantities (rollback on failure)
3. If `inventoryAction === "deducted"`: adjusts stock deltas directly on `productVariants` -- restores stock for removed/changed variants, deducts for new/increased variants (validates stock availability before deducting)
4. Calls `applyInventoryForStatusChange()` after item writes unless an explicit item-delta/status branch already handled inventory; this also repairs same-status retries whose status was persisted before inventory completed
5. Optimistic locking via `version` column -- throws `ConflictError` if version mismatch
6. Deletes all existing items and re-inserts (full replacement)
7. Updates customer stats for both old and new customer (if customer changed)

### Status Update Flow

1. `updateOrderStatus()` reads current order state
2. Validates transition via `validateTransition()`
3. **COD auto-sync**: If order is COD and new status is DELIVERED or COMPLETED, auto-updates `paymentStatus` to `paid`
4. CAS update on `version` column FIRST (prevents race between admin + webhook)
5. On CAS success, or when retry sees the requested status already persisted, applies inventory side effects via `applyInventoryForStatusChange()`
6. Persists/reconfirms the resulting `inventoryAction`
7. Returns `StatusUpdateResult` with optional notification payload
8. API route enqueues notification to `ORDER_NOTIFICATIONS_QUEUE` if present

**Notification Status Mapping** (`NOTIFICATION_STATUSES` in `orders.fulfillment.ts`):

| Order Status | Notification Type |
|-------------|-------------------|
| `pending` | `order_created` |
| `confirmed` | `order_confirmed` |
| `processing` | `order_processing` |
| `shipped` | `order_shipped` |
| `delivered` | `order_delivered` |
| `completed` | `order_completed` |
| `cancelled` | `order_cancelled` |
| `returned` | `order_returned` |
| `refunded` | `order_refunded` |

All 9 statuses that trigger notifications are covered. Each dispatches to enabled channels (email, SMS, WhatsApp, push) independently via the queue consumer.

### Fulfillment Flow

1. `createFulfillmentShipment()` checks order is not cancelled/returned
2. Validates no items are already shipped/delivered (throws `ConflictError` if so)
3. Claims the order with a version/status/fulfillment check, then creates `deliveryShipments` row and updates item fulfillment statuses to `shipped`
4. If final shipment: updates order `fulfillmentStatus` to `complete`, and order status to `shipped` when it was still confirmed
5. Applies inventory deduction for final shipments, including retries where the order was already marked shipped or delivered before inventory completed

### COD Actions

`processCodAction()` handles three actions with CAS protection on the order version:
- `collected`: CAS update first, then records collection via `recordCODCollection()`, sets order to `delivered`
- `failed`: Records failure via `recordCODFailure()`
- `returned`: CAS update first unless already returned on retry, then marks COD returned and applies inventory restoration

### Bulk Ship Orders

`bulkShipOrders()` applies CAS protection per order:
1. Reads order status and version
2. If the order is already `shipped`, treats the call as a retry and reconciles inventory without calling the provider again
3. For unshipped orders: claims by version, calls the provider, CAS-updates status to `shipped`, then deducts inventory
4. CAS conflicts (concurrent admin + webhook edits) are logged and skipped gracefully

### Delete Flow

- **Soft delete**: Releases inventory via `applyInventoryForStatusChange(db, id, "cancelled")` if reserved or deducted, sets `deletedAt`, sets `inventoryAction` to `"restored"`
- **Permanent delete**: Releases inventory, deletes order items first (FK ordering), then deletes order
- **Restore**: If `inventoryAction === "restored"`, re-reserves stock via `reserveMultiple()`. Throws `ValidationError` if insufficient stock to re-reserve. Sets `inventoryAction` to `"reserved"`. If inventory was not previously tracked, simply clears `deletedAt`.
- **Bulk delete**: Iterates and applies inventory release per order. For permanent: deletes items first, then orders (FK ordering fixed).

## Queue Processing

Two queues are relevant:

| Queue | Message Type | Handler |
|-------|-------------|---------|
| `ORDER_INGEST_QUEUE` | `order.ingest` | `handleOrderIngestBatch()` -- batched DB writes + inventory reservation |
| `ORDER_NOTIFICATIONS_QUEUE` | `order.notification` | `sendOrderNotificationEmail()` + `sendOrderNotification()` (FCM push) via `queue-consumer.ts` |

The `order.notification` handler in `queue-consumer.ts` sends both email (via `sendOrderNotificationEmail()` with `db` for channel preference checking) and FCM push notifications (via `sendOrderNotification()`) to admin devices. FCM failures are caught and logged but do not affect email delivery.

Payment-related queue messages (`payment.stripe.confirmed`, `payment.sslcommerz.confirmed`, `payment.polar.confirmed`, etc.) are handled in `queue-consumer.ts` and call `processPaymentConfirmed()` / `processPaymentFailed()` from the payments module.

## Concurrency Control

- **Optimistic locking on orders**: `version` column, CAS update in `updateOrder()` and `updateOrderStatus()`
- **Optimistic locking on inventory**: `stockVersion` column on `productVariants`, separate from general `version`
- **Reservation rollback**: `reserveMultiple()` rolls back all successful reservations if any fail
- **Batch atomicity**: Queue handler uses `db.batch()` for atomic multi-row writes; rolls back inventory on DB failure
- **Discount race narrowing**: Queue handler re-checks discount usage before DB write to narrow the window between HTTP validation and queue processing

## API Endpoints

### Admin (`/api/v1/admin/orders`)

| Method | Path | Handler | Purpose |
|--------|------|---------|---------|
| GET | `/` | `listOrders()` | Paginated list with FTS5 search, status/date filters, shipment summary |
| POST | `/` | `createOrder()` | Manual order creation with reserve-then-deduct inventory |
| GET | `/:id` | `getOrderDetails()` | Full order with items, variant info, images |
| PUT | `/:id` | `updateOrder()` | Full order update with inventory adjustment |
| DELETE | `/:id` | `deleteOrder()` | Soft delete |
| POST | `/:id/restore` | `restoreOrder()` | Restore soft-deleted order (re-reserves inventory) |
| DELETE | `/:id/permanent` | `permanentlyDeleteOrder()` | Hard delete |
| POST | `/bulk-delete` | `bulkDeleteOrders()` | Bulk soft/permanent delete |
| POST | `/bulk-ship` | `bulkShipOrders()` | Bulk shipment creation |
| PUT | `/:id/status` | `updateOrderStatus()` | Status change with inventory + COD auto-sync + notifications |
| GET | `/:id/items` | direct query | Items with product details and images |
| GET | `/:id/payments` | direct query | Order payments + payment plan |
| GET | `/:id/cod` | direct query | COD tracking record |
| POST | `/:id/cod` | `processCodAction()` | COD collected/failed/returned |
| GET | `/:id/fulfill` | `getOrderShipments()` | Fulfillment shipments |
| POST | `/:id/fulfill` | `createFulfillmentShipment()` | Create fulfillment with item tracking |
| GET | `/:id/shipments` | `DeliveryService.getShipments()` | Delivery shipments with provider names |
| POST | `/:id/shipments` | `DeliveryService.createShipment()` | Create delivery shipment |
| GET | `/:id/shipments/:shipmentId` | `DeliveryService.getShipment()` | Single shipment detail |
| DELETE | `/:id/shipments/:shipmentId` | `DeliveryService.deleteShipment()` | Delete shipment |
| POST | `/:id/shipments/:shipmentId/status` | `DeliveryService.checkShipmentStatus()` | Check status from provider |
| POST | `/:id/shipments/:shipmentId/refresh` | check + update order status | Refresh and sync order status |
| POST | `/:id/return` | `processReturn()` | Return with optional auto-refund |
| POST | `/:id/refund` | `processRefund()` | Refund with optional gateway |
| GET | `/:id/form-data` | direct query | Order + products for edit form |

Bulk provider shipment creation uses a durable order-level shipment claim (`orders.shipmentClaimId` / `orders.shipmentClaimExpiresAt`) linked to the insert-first `delivery_shipments` row. Admin order mutations, status changes, manual fulfillment, COD actions, refunds, returns, public payment-session creation, shipment refresh/deletion, and cleanup must reject or skip active claims. Queue/webhook paths must surface retryable failures so external payment or delivery truth is not acknowledged while shipment creation is being finalized. Provider success with failed local finalization leaves the shipment in `reconcile_required` and keeps the order claim active until reconciliation.

### Admin Shipments (`/api/v1/admin/shipments`)

| Method | Path | Handler | Purpose |
|--------|------|---------|---------|
| GET | `/:id` | `DeliveryService.getShipment()` | Get shipment by ID |
| DELETE | `/:id` | `DeliveryService.deleteShipment()` | Delete shipment |
| POST | `/:id/check-status` | check + notify | Check and update from provider |

### Storefront (`/api/v1/orders`)

| Method | Path | Handler | Purpose |
|--------|------|---------|---------|
| GET | `/:id` | direct query | Order with items, shipments, delivery providers |
| GET | `/status/:token` | KV lookup | Poll checkout processing status |
| POST | `/` | `createStorefrontOrder()` + queue | Async order placement (returns 202) |

## Admin Full Edit Inventory Safety

`updateOrder()` keeps the existing `order_items` rows as the retry snapshot until inventory deltas are safe. Positive quantity deltas are reserved or deducted before the order CAS. Removed/reduced reserved or deducted deltas, plus terminal cancellation/return/refund release or restore, are applied before replacing item rows and now fail closed instead of logging and succeeding. The final item replacement uses a single D1 batch for delete plus insert, so item insert failure does not leave old rows deleted; pre-write inventory compensation runs if a later write fails.

## Dependencies

- `@scalius/database` -- `orders`, `orderItems`, `customers`, `customerHistory`, `products`, `productVariants`, `productImages`, `deliveryShipments`, `deliveryProviders`, `deliveryLocations`, `discountUsage`, `codTracking`
- `inventory` module -- reservation, deduction, release, transitions
- `payments` module -- COD collection/return, refund service
- `delivery` module -- `DeliveryService`, `ShipmentTracker`
- `notifications` module -- `sendOrderNotificationEmail()`, `sendOrderNotification()` (FCM push)
- `@scalius/core/search` -- FTS5 for order search
- `@scalius/core/errors` -- `NotFoundError`, `ValidationError`, `ConflictError`
- `@scalius/shared/price-utils` -- `roundPrice`, `addPrices`, `subtractPrice`
- `@scalius/shared/order-utils` -- `generateOrderId`
- `@scalius/shared/customer-utils` -- `phoneNumberSchema`, `calculateCustomerStats`
