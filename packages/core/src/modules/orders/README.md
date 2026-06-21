# Orders Module

Full order lifecycle: storefront checkout, admin CRUD, state machine validation, fulfillment, COD tracking, queue-based async ingestion, and notification dispatch.

## Files

| File | Exports | Purpose |
|------|---------|---------|
| `index.ts` | barrel re-exports | Public API surface |
| `orders.types.ts` | `OrderShipmentSummary`, `OrderListItem`, `OrderDetails`, `StorefrontOrderItem`, `CreateStorefrontOrderInput`, `CreateStorefrontOrderResult`, `OrderIngestQueuePayload`, `StatusUpdateResult` | Shared TypeScript interfaces for admin, storefront, and queue |
| `orders.admin.ts` | `listOrders()`, `getOrderDetails()`, `createOrder()`, `updateOrder()`, `deleteOrder()`, `restoreOrder()`, `permanentlyDeleteOrder()`, `bulkDeleteOrders()` | Admin dashboard queries and write operations |
| `orders.storefront.ts` | `createStorefrontOrder()` | Storefront checkout validation and synchronous order payload builder |
| `cart-validation.ts` | `validateStorefrontCartItems()` | Batched buyer-cart freshness checks for active products, concrete variants, stock availability, and server-authoritative prices |
| `checkout-attempts.ts` | `buildCheckoutAttemptIdentity()`, `claimCheckoutAttempt()`, `markCheckoutAttemptCommitted()`, `markCheckoutAttemptFailed()` | D1-backed storefront submit idempotency ledger |
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
confirmed  --> shipped, delivered, cancelled
shipped    --> confirmed, delivered, returned, cancelled
delivered  --> completed, returned, refunded, partially_refunded
completed  --> returned, refunded, partially_refunded
cancelled  --> pending, confirmed       (admin reactivation only)
returned   --> refunded
refunded   --> (terminal)
partially_refunded --> refunded
```

All 11 states: `incomplete`, `pending`, `processing`, `confirmed`, `shipped`, `delivered`, `completed`, `cancelled`, `returned`, `refunded`, `partially_refunded`.

**Note on CANCELLED:** The state machine allows `cancelled -> pending` and `cancelled -> confirmed` for admin reactivation. When this happens, `inventory-transitions.ts` detects `currentAction === "restored"` and re-reserves stock via `reserveOrderItems()`. The comment in the state machine explicitly says "Admin override only: merchants can reactivate cancelled orders."

**Note on carrier retries:** `confirmed -> delivered` is allowed for direct delivery confirmation, and `shipped -> confirmed` is allowed when a carrier delivery attempt fails and the merchant needs to retry shipment without restoring or deducting stock.

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

Admin detail and `GET /api/v1/admin/orders/:id/items` must expose this field so the dashboard can disable already shipped/delivered items before posting manual fulfillment. Own-courier shipments are stored in `deliveryShipments` without a provider id; API/admin history can render `courierName`, `trackingUrl`, `note`, `shipmentItems`, `shipmentAmount`, and `isFinalShipment`, but provider status refresh must remain disabled for those manual rows.

## Data Flow

### Storefront Order Creation (synchronous, idempotent)

1. **Storefront cart freshness** -- The cart page revalidates persisted local cart items through `/api/v1/orders/cart-validation` on load, cart edits, and submit. The `/buy/{slug}` quick-buy route also validates the resolved SKU, quantity, price, and availability before writing `quickBuyData` to session storage or firing quick-buy analytics. The checkout page revalidates the transferred snapshot on load and immediately before payment/order submit; stale results write a one-shot repair payload and send the buyer back to `/cart?checkoutIssues=1` so the existing row-level actions can repair the cart. Deleted/inactive products, products without persisted inventory variants, deleted variants, variant/product mismatches, low stock, and price changes are returned per item with buyer actions (`remove`, `reduce_quantity`, `refresh_item`, or `select_variant`). If the freshness check itself cannot be read, the storefront fails closed with a top-of-cart retry message instead of clearing issues and allowing checkout.
2. **Storefront POST /orders** -- The storefront sends a stable `checkoutRequestId` for the checkout session and includes cart line metadata (`cartKey`, product name, variant label) so late validation issues can map back to the exact local cart row. The API route builds a canonical request hash from the order input, does a read-only `checkout_attempts` lookup so committed/active same-key retries return before mutable checkout policy or rate-limit checks, then runs `validateStorefrontCartItems()` again for new/non-replay attempts before policy/rate gates or claim creation.
3. **Claim behavior** -- A new claim reserves the canonical `orderId` and checkout/receipt token for this submit. A committed same-key/same-payload retry replays the stored response. An active same-key/same-payload retry returns `202` with the reserved `orderId` and checkout token for polling. A same-key/different-payload retry is rejected as `409`. The route keeps the post-policy `claimCheckoutAttempt()` replay/processing branches for races where another request wins after the read-only lookup.
4. **Order build** -- `createStorefrontOrder()` validates prices server-side from the prevalidated cart snapshot, verifies discounts, checks partial-payment rules, rejects inactive/deleted products, product/variant mismatches, and variantless buyer lines, resolves active city/zone/area names from D1, and builds the order payload using the reserved `orderId` and checkout token from the attempt.
5. **Commit** -- The API writes legacy checkout-status/receipt KV hints, then commits the D1 order synchronously through `commitStorefrontOrderPayload()`. Discount usage limits are enforced inside the same D1 batch by `discount_usage` triggers; trigger aborts are translated back into checkout `ValidationError`s and any reserved stock is released before the buyer sees the failure. The buyer receives `201` only after the order row exists.
6. **Attempt finalization** -- After the order commit, the API stores the committed response on `checkout_attempts` and clears the processing claim. If the Worker crashes after the order commit but before finalization, the same request can reclaim the stale attempt with the same reserved IDs and converge on the existing order instead of creating a duplicate.
7. **Post-commit work** -- COD tracking, durable order-notification enqueue, and product availability cache invalidation run after commit through `executionCtx.waitUntil()` when available. These failures are logged and retried by their own durable paths instead of turning a committed checkout into a false `500`.
8. **Recovery** -- `GET /orders/status/:token` and receipt validation use KV as the fast path, then fall back to D1 `checkout_attempts` plus the committed `orders` row. KV may be repaired best-effort from D1.

### Admin Order Creation (synchronous, reserve then deduct)

1. **Admin POST /admin/orders** -- `createOrder()` calculates totals, resolves locations, finds/creates customer
2. **Reserve stock**: Calls `reserveMultiple()` for all variant items. If any variant has insufficient stock, throws `ValidationError` immediately -- order is never created.
3. **Atomic DB write**: Inserts customer (new or update), order, and items in a single `db.batch()` call with `inventoryAction: "reserved"`.
4. **On batch failure**: Calls `releaseMultiple()` to release all reservations made in step 2.
5. **Convert to deduction**: Calls `deductMultiple()` to permanently deduct stock (decrements `stock`, clears `reservedStock`). On success, updates `inventoryAction` to `"deducted"`.
6. **On deduction failure**: Stock remains reserved (no overselling risk). Error is logged but the order itself succeeds.

### Admin Order Update

1. `updateOrder()` validates status transition via state machine
2. If `inventoryAction === "reserved"`: reserves positive deltas and releases removed/reduced quantities before replacing item rows
3. If `inventoryAction === "deducted"`: deducts positive deltas and restores removed/reduced quantities before replacing item rows
4. Calls `applyInventoryForStatusChange()` after item writes unless an explicit item-delta/status branch already handled inventory; this also repairs same-status retries whose status was persisted before inventory completed
5. Optimistic locking via `version` column -- throws `ConflictError` if version mismatch
6. Deletes all existing items and re-inserts (full replacement)
7. Updates customer stats for both old and new customer (if customer changed)

### Status Update Flow

1. `updateOrderStatus()` reads current order state
2. Validates transition via `validateTransition()`
3. **COD paid-state guard**: If order is COD and new status is DELIVERED or COMPLETED, the order must already have successful COD collection evidence. Generic status updates do not synthesize COD payment state.
4. CAS update on `version` column FIRST (prevents race between admin + webhook)
5. On CAS success, or when retry sees the requested status already persisted, applies inventory side effects via `applyInventoryForStatusChange()`
6. Persists/reconfirms the resulting `inventoryAction`
7. Returns `StatusUpdateResult` with optional notification payload and transition dedupe key
8. API route records the notification in `order_notification_outbox`, then relays it to `ORDER_NOTIFICATIONS_QUEUE` when available

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

All 9 statuses that trigger notifications are covered. Each dispatches to enabled channels (email, SMS, WhatsApp, push) via the queue consumer. Queue handoff is durable through `packages/core/src/modules/notifications/order-notification-outbox.ts`; channel targets are fenced by `order_notification_delivery_receipts` so accepted/skipped email, SMS, Meta WhatsApp template sends, and FCM token sends are not retried after a later target fails. Resend and GenNet also receive provider-native idempotency/client reference keys where supported.

### Fulfillment Flow

1. `createFulfillmentShipment()` checks order is not cancelled/returned
2. Validates no items are already shipped/delivered (throws `ConflictError` if so)
3. Claims the order with a version/status/fulfillment check, then creates a manual/own-courier `deliveryShipments` row and updates item fulfillment statuses to `shipped`
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
- **Restore**: Clears `deletedAt`, but does not secretly change order status. `incomplete`, `pending`, `processing`, and `confirmed` orders with `inventoryAction = "restored"` re-reserve variant inventory and become `reserved`; if there are no variant items they become `none`. `cancelled`, `returned`, and `refunded` restored orders remain `restored`. Shipped/delivered/completed/partially-refunded restored orders reject until inventory/status are explicitly reconciled. Existing `reserved` or `deducted` actions are accepted only for compatible statuses, and re-reservations are compensated if the final restore CAS fails.
- **Bulk delete**: Iterates and applies inventory release per order. For permanent: deletes items first, then orders (FK ordering fixed).

### Stale Hosted-Payment Cleanup

`archiveStaleIncompleteOrders()` is the only scheduled path that may move an existing stale checkout order. It handles hosted-payment methods only (`stripe`, `sslcommerz`, `polar`), requires `status = incomplete`, `paymentStatus` of `unpaid` or `failed`, `paidAmount <= 0`, no soft delete, no active shipment claim, no pending/succeeded `order_payments`, and no live `payment_session_attempts` processing lease. Each order must win a guarded cancelled claim before inventory is released through `applyInventoryForStatusChange(db, orderId, "cancelled")`; release failure rolls the claim back to `incomplete`.

After release succeeds, the final archive soft-deletes the order, marks inventory restored, conditionally cancels a pending payment plan only when the order finalization actually won, and writes the `abandoned_checkouts` snapshot after finalization. The API scheduled worker runs it with a 60-minute grace period and a batch limit of 25, then invalidates product availability caches for archived order ids.

## Queue Processing

Two queues are relevant:

| Queue | Message Type | Handler |
|-------|-------------|---------|
| `ORDER_INGEST_QUEUE` | `order.ingest` | `handleOrderIngestBatch()` -- batched DB writes + inventory reservation |
| `ORDER_NOTIFICATIONS_QUEUE` | `order.notification` | Outbox-backed `sendOrderNotificationEmail()` + `sendOrderNotification()` (FCM push) via `queue-consumer.ts` |

The `order.notification` handler in `queue-consumer.ts` claims `order_notification_outbox` rows by `outboxId`, sends email/SMS/WhatsApp through `sendOrderNotificationEmail()` with `db` for channel preference checking, optionally sends FCM push notifications through `sendOrderNotification()`, then marks the row `sent` only if enabled receipt targets are accepted or skipped. Retryable customer-channel or admin-push failures mark the parent row retryable before the Cloudflare Queue message is retried.

Payment-related queue messages (`payment.stripe.confirmed`, `payment.sslcommerz.confirmed`, `payment.polar.confirmed`, etc.) are handled in `queue-consumer.ts` and call `processPaymentConfirmed()` / `processPaymentFailed()` from the payments module.

## Concurrency Control

- **Optimistic locking on orders**: `version` column, CAS update in `updateOrder()` and `updateOrderStatus()`
- **Optimistic locking on inventory**: `stockVersion` column on `productVariants`, separate from general `version`
- **Reservation rollback**: `reserveMultiple()` rolls back all successful reservations if any fail; queue ingest uses checked `releaseMultiple()` results before retrying messages after an isolated DB-write failure
- **Batch atomicity**: Queue handler uses `db.batch()` for atomic multi-row writes; on DB failure it treats the outcome as ambiguous, checks whether each order committed, and never reserves the same queue message twice
- **Discount redemption authority**: Discount validation endpoints and pre-commit reads are advisory. The authoritative `maxUses` and one-per-customer guards are D1 triggers on `discount_usage`; one-per-customer redemptions also claim immutable `discount_customer_redemptions` rows keyed by the checkout phone proof so later admin edits to `orders.customerPhone` cannot reopen a coupon.

## API Endpoints

### Admin (`/api/v1/admin/orders`)

| Method | Path | Handler | Purpose |
|--------|------|---------|---------|
| GET | `/` | `listOrders()` | Paginated list with FTS5 search, status/date filters, shipment summary |
| POST | `/` | `createOrder()` | Manual order creation with reserve-then-deduct inventory |
| GET | `/:id` | `getOrderDetails()` | Full order with items, variant info, images |
| PUT | `/:id` | `updateOrder()` | Full order update with inventory adjustment |
| DELETE | `/:id` | `deleteOrder()` | Soft delete |
| POST | `/:id/restore` | `restoreOrder()` | Restore soft-deleted order with status/inventory safety checks |
| DELETE | `/:id/permanent` | `permanentlyDeleteOrder()` | Hard delete |
| POST | `/bulk-delete` | `bulkDeleteOrders()` | Bulk soft/permanent delete |
| POST | `/bulk-ship` | `bulkShipOrders()` | Bulk shipment creation |
| PUT | `/:id/status` | `updateOrderStatus()` | Status change with inventory + COD paid-state guard + notifications |
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

- `@scalius/database` -- `orders`, `orderItems`, `customers`, `customerHistory`, `products`, `productVariants`, `productImages`, `deliveryShipments`, `deliveryProviders`, `deliveryLocations`, `discountUsage`, `discountCustomerRedemptions`, `codTracking`
- `inventory` module -- reservation, deduction, release, transitions
- `payments` module -- COD collection/return, refund service
- `delivery` module -- `DeliveryService`, `ShipmentTracker`
- `notifications` module -- `sendOrderNotificationEmail()`, `sendOrderNotification()` (FCM push)
- `@scalius/core/search` -- FTS5 for order search
- `@scalius/core/errors` -- `NotFoundError`, `ValidationError`, `ConflictError`
- `@scalius/shared/price-utils` -- `roundPrice`, `addPrices`, `subtractPrice`
- `@scalius/shared/order-utils` -- `generateOrderId`
- `@scalius/shared/customer-utils` -- `phoneNumberSchema`, `calculateCustomerStats`
