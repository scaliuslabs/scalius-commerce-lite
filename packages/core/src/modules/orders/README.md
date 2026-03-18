# Orders Module

Full order lifecycle: storefront checkout, admin CRUD, state machine validation, fulfillment, COD tracking, queue-based async ingestion, and notification dispatch.

## Files

| File | Exports | Purpose |
|------|---------|---------|
| `index.ts` | barrel re-exports | Public API surface |
| `orders.types.ts` | `OrderShipmentSummary`, `OrderListItem`, `OrderDetails`, `StorefrontOrderItem`, `CreateStorefrontOrderInput`, `CreateStorefrontOrderResult`, `StatusUpdateResult` | Shared TypeScript interfaces for admin and storefront |
| `orders.admin.ts` | `getOrders()`, `getOrderDetails()`, `createOrder()`, `updateOrder()`, `deleteOrder()`, `restoreOrder()`, `permanentlyDeleteOrder()`, `bulkDeleteOrders()` | Admin dashboard queries and write operations |
| `orders.storefront.ts` | `createStorefrontOrder()` | Storefront checkout validation and queue payload builder |
| `orders.fulfillment.ts` | `bulkShipOrders()`, `processCodAction()`, `getOrderShipments()`, `createFulfillmentShipment()`, `updateOrderStatus()` | Shipment creation, COD actions, status transitions |
| `orders.validation.ts` | `createOrderSchema`, `updateOrderSchema`, `bulkDeleteOrderSchema`, `bulkShipOrderSchema`, `CreateOrderInput`, `UpdateOrderInput`, `BulkDeleteOrderInput`, `BulkShipOrderInput` | Zod validation schemas for API routes |
| `order-state-machine.ts` | `canTransitionTo()`, `validateTransition()`, `getAvailableTransitions()` | Enforces valid order/payment/fulfillment status transitions |
| `orders.queue.ts` | `handleOrderIngestBatch()`, `setCheckoutStatus()`, `OrderIngestQueueMessage` | Queue consumer for async order ingestion |

## Order State Machine

Three independent status dimensions, each with its own transition map.

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

**Note on CANCELLED:** The state machine allows `cancelled -> pending` and `cancelled -> confirmed` for admin reactivation. When this happens, `inventory-transitions.ts` detects `currentAction === "restored"` and re-reserves stock via `reserveOrderItems()`. The README previously stated "CANCELLED is terminal" -- that is incorrect per the actual code. The comment in the state machine explicitly says "Admin override only: merchants can reactivate cancelled orders."

**Note on ORDER_STATUSES in admin UI:** The `orderview/types.ts` file defines `ORDER_STATUSES` as only 8 values: `pending`, `processing`, `confirmed`, `shipped`, `delivered`, `completed`, `cancelled`, `returned`. The status dropdown in `OrderStatusCard` renders only these 8, meaning `incomplete`, `refunded`, and `partially_refunded` cannot be set via the UI status dropdown (they are set programmatically by payment/refund flows).

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

### Admin Order Creation (synchronous)

1. **Admin POST /admin/orders** -- `createOrder()` calculates totals, resolves locations, finds/creates customer, inserts order + items in `db.batch()` with `inventoryAction: "deducted"` (stock is directly deducted, not reserved)
2. No queue involved -- writes happen synchronously

### Admin Order Update

1. `updateOrder()` validates status transition via state machine
2. If `inventoryAction === "reserved"`: releases old reservations, reserves new quantities (rollback on failure)
3. If `inventoryAction === "deducted"`: adjusts stock deltas directly on `productVariants`
4. Optimistic locking via `version` column -- throws `ConflictError` if version mismatch
5. Deletes all existing items and re-inserts (full replacement)
6. Updates customer stats

### Status Update Flow

1. `updateOrderStatus()` reads current order state
2. Validates transition via `validateTransition()`
3. CAS update on `version` column FIRST (prevents race between admin + webhook)
4. On CAS success: applies inventory side effects via `applyInventoryForStatusChange()`
5. Persists new `inventoryAction`
6. Returns `StatusUpdateResult` with optional notification payload
7. API route enqueues notification to `ORDER_NOTIFICATIONS_QUEUE` if present

### Fulfillment Flow

1. `createFulfillmentShipment()` checks order is not cancelled/returned
2. Validates no items are already shipped/delivered
3. Creates `deliveryShipments` row, updates item fulfillment statuses to `shipped`
4. If final shipment: updates order `fulfillmentStatus` to `complete`, order status to `shipped`
5. Applies inventory deduction for the shipped status

### COD Actions

`processCodAction()` handles three actions:
- `collected`: Records collection via `recordCODCollection()`, sets order to `delivered`
- `failed`: Records failure via `recordCODFailure()`
- `returned`: Marks COD returned, applies inventory restoration, sets order to `returned`

### Delete Flow

- **Soft delete**: Sets `deletedAt`, releases inventory (`inventoryAction` set to `restored`)
- **Permanent delete**: Releases inventory, deletes order items, then deletes order
- **Restore**: Clears `deletedAt` (does NOT re-reserve inventory -- known gap)
- **Bulk delete**: Iterates and applies inventory release per order

## Queue Processing

Two queues are relevant:

| Queue | Message Type | Handler |
|-------|-------------|---------|
| `ORDER_INGEST_QUEUE` | `order.ingest` | `handleOrderIngestBatch()` -- batched DB writes + inventory reservation |
| `ORDER_NOTIFICATIONS_QUEUE` | `order.notification` | `sendOrderNotificationEmail()` via `queue-consumer.ts` |

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
| GET | `/` | `getOrders()` | Paginated list with FTS5 search, status/date filters, shipment summary |
| POST | `/` | `createOrder()` | Manual order creation |
| GET | `/:id` | `getOrderDetails()` | Full order with items, variant info, images |
| PUT | `/:id` | `updateOrder()` | Full order update with inventory adjustment |
| DELETE | `/:id` | `deleteOrder()` | Soft delete |
| POST | `/:id/restore` | `restoreOrder()` | Restore soft-deleted order |
| DELETE | `/:id/permanent` | `permanentlyDeleteOrder()` | Hard delete |
| POST | `/bulk-delete` | `bulkDeleteOrders()` | Bulk soft/permanent delete |
| POST | `/bulk-ship` | `bulkShipOrders()` | Bulk shipment creation |
| PUT | `/:id/status` | `updateOrderStatus()` | Status change with inventory + notifications |
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

## Known Gaps

1. **`restoreOrder()` does not re-reserve inventory**: Soft-delete releases inventory, but restore only clears `deletedAt` without re-reserving. The order's `inventoryAction` remains "restored". This means restored orders have untracked inventory until a status change triggers re-reservation via `inventory-transitions.ts`.

2. **Admin create sets `inventoryAction: "deducted"` but does not actually deduct**: `createOrder()` sets the flag to "deducted" and does NOT call any inventory functions. Stock is not reserved or deducted. This means admin-created orders do not affect inventory at all until a status change.

3. ~~**`bulkDeleteOrders()` permanent delete ordering**~~: Fixed — order items are now deleted before orders.

4. ~~**No payment status update on status change**~~: Fixed — `updateOrderStatus()` now auto-updates `paymentStatus` to "paid" for COD orders when status changes to DELIVERED or COMPLETED. Non-COD orders (gateway payments) are not touched.

5. **Notification types limited**: Only `shipped` and `delivered` trigger customer notifications from `updateOrderStatus()`. Other transitions (confirmed, completed, etc.) do not.

6. **`ORDER_STATUSES` in UI missing states**: The admin UI status dropdown shows only 8 of 11 states. `incomplete`, `refunded`, and `partially_refunded` are not selectable.

## Dependencies

- `@scalius/database` -- `orders`, `orderItems`, `customers`, `customerHistory`, `products`, `productVariants`, `productImages`, `deliveryShipments`, `deliveryProviders`, `deliveryLocations`, `discountUsage`, `codTracking`
- `inventory` module -- reservation, deduction, release, transitions
- `payments` module -- COD collection/return, refund service
- `delivery` module -- `DeliveryService`, `ShipmentTracker`
- `notifications` module -- `sendOrderNotificationEmail()`
- `@scalius/core/search` -- FTS5 for order search
- `@scalius/core/errors` -- `NotFoundError`, `ValidationError`, `ConflictError`
- `@scalius/shared/price-utils` -- `roundPrice`, `addPrices`, `subtractPrice`
- `@scalius/shared/order-utils` -- `generateOrderId`
- `@scalius/shared/customer-utils` -- `phoneNumberSchema`, `calculateCustomerStats`
