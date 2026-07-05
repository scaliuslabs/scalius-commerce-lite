# Orders Module

Full order lifecycle: storefront checkout, admin CRUD, state machine validation, fulfillment, COD tracking, synchronous storefront order commit, and notification dispatch.

## Files

| File | Exports | Purpose |
|------|---------|---------|
| `index.ts` | barrel re-exports | Public API surface |
| `orders.types.ts` | `OrderShipmentSummary`, `OrderListItem`, `OrderDetails`, `StorefrontOrderItem`, `CreateStorefrontOrderInput`, `CreateStorefrontOrderResult`, `StorefrontOrderCommitPayload`, `StatusUpdateResult` | Shared TypeScript interfaces for admin and storefront order flows |
| `orders.admin.ts` | `listOrders()`, `getOrderDetails()`, `createOrder()`, `updateOrder()`, `deleteOrder()`, `restoreOrder()`, `permanentlyDeleteOrder()`, `bulkDeleteOrders()` | Admin dashboard queries and write operations |
| `orders.storefront.ts` | `createStorefrontOrder()` | Storefront checkout validation and synchronous order payload builder |
| `cart-validation.ts` | `validateStorefrontCartItems()` | Batched buyer-cart freshness checks for active products, concrete variants, stock availability, and server-authoritative prices |
| `checkout-attempts.ts` | `buildCheckoutAttemptIdentity()`, `claimCheckoutAttempt()`, `markCheckoutAttemptCommitted()`, `markCheckoutAttemptFailed()` | D1-backed storefront submit idempotency ledger |
| `order-support-requests.ts` | `getCustomerOrderSupportRequestState()`, `createCustomerOrderSupportRequest()`, `getReceiptOrderSupportRequestState()`, `createReceiptOrderSupportRequest()`, `updateOrderSupportRequestStatus()` | Shared account-owned and receipt-token guest cancellation/return/refund request ledger with admin resolution transitions |
| `orders.fulfillment.ts` | `bulkShipOrders()`, `processCodAction()`, `getOrderShipments()`, `createFulfillmentShipment()`, `updateOrderStatus()` | Shipment creation, COD actions, status transitions with notification dispatch |
| `orders.validation.ts` | `createOrderSchema`, `updateOrderSchema`, `bulkDeleteOrderSchema`, `bulkShipOrderSchema`, `CreateOrderInput`, `UpdateOrderInput`, `BulkDeleteOrderInput`, `BulkShipOrderInput` | Zod validation schemas for API routes |
| `order-state-machine.ts` | `canTransitionTo()`, `validateTransition()`, `getAvailableTransitions()`, `StatusDimension` | Enforces valid order/payment/fulfillment status transitions |

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

1. **Storefront cart freshness** -- The cart page revalidates persisted local cart items through `/api/v1/orders/cart-validation` on load, cart edits, and submit. The `/buy/{slug}` quick-buy route also validates the resolved SKU, quantity, price, and availability before writing `quickBuyData` to session storage or firing quick-buy analytics; if that storage write cannot be proven, cart renders a storage-specific error instead of silently showing an empty cart. Multi-gateway cart checkout must persist and read back the required `scalius_checkout_data` transfer before navigating to `/checkout`, while the optional gateway snapshot can fall back to fresh public checkout config. The checkout page revalidates the transferred snapshot on load and immediately before payment/order submit; stale results write a one-shot repair payload and send the buyer back to `/cart?checkoutIssues=1` so the existing row-level actions can repair the cart, while missing/unreadable transfer data shows an explicit Return to cart recovery state instead of a silent bounce. Deleted/inactive products, products without persisted inventory variants, literal legacy `default` variant ids, deleted variants, variant/product mismatches, non-default no-option SKUs, low stock, and price changes are returned per item with buyer actions (`remove`, `reduce_quantity`, `refresh_item`, or `select_variant`). If the freshness check itself cannot be read, the storefront fails closed with a top-of-cart retry message instead of clearing issues and allowing checkout. `validateStorefrontCartItems()` returns an in-memory proof marker; `createStorefrontOrder()` rejects forged prevalidated cart objects instead of trusting plain object literals.
2. **Storefront POST /orders** -- The storefront sends a stable `checkoutRequestId` for the checkout session and includes cart line metadata (`cartKey`, product name, variant label) so late validation issues can map back to the exact local cart row. The API route builds a canonical request hash from the order input, does a read-only `checkout_attempts` lookup so committed/active same-key retries return before mutable checkout policy or rate-limit checks, then runs `validateStorefrontCartItems()` and delivery preflight again for new/non-replay attempts. The API enforces the merchant include/exclude phone-country policy before gateway readiness, customer-session checks, rate limits, claim creation, or order writes. If a customer session token is present, the API resolves it even when guest checkout is enabled; the session phone must match the checkout phone, and a stale session returns `CUSTOMER_SESSION_STALE` so the storefront proxy can clear stale customer cookies before the buyer retries as a real guest or signs in again.
3. **Claim behavior** -- A new claim reserves the canonical `orderId` and checkout/receipt token for this submit. A committed same-key/same-payload retry replays the stored response. An active same-key/same-payload retry returns `202` with the reserved `orderId` and checkout token for polling. Same-key fresh processing rows short-circuit from the first selected row instead of attempting a doomed reclaim update. A same-key/different-payload retry is rejected as `409`. The route keeps the post-policy `claimCheckoutAttempt()` replay/processing branches for races where another request wins after the read-only lookup.
4. **Order build** -- `createStorefrontOrder()` validates prices server-side from the prevalidated cart snapshot, verifies discounts, checks partial-payment rules, rejects inactive/deleted products, product/variant mismatches, and variantless buyer lines, resolves active city/zone/area names from D1, and builds the order payload using the reserved `orderId` and checkout token from the attempt. Account ownership is carried only from the authoritative customer session identity supplied by the API; true guest checkouts keep `existingCustomer: null` even when the submitted phone matches a customer account. Delivery preflight also carries an in-memory proof marker, so the API can avoid duplicate hot-path reads while plain forged delivery preflight objects fail closed before order reads or payload construction.
5. **Commit** -- The API writes legacy checkout-status/receipt KV hints, then commits the D1 order synchronously through `commitStorefrontOrderPayload()`. Authenticated payloads fresh-read the active customer row by session customer id before order writes; deleted/missing customers fail before inventory reservation, discounts, or order inserts. Guest payloads commit with `orders.customerId = null`. Discount usage limits are enforced inside the same D1 batch by `discount_usage` triggers; trigger aborts are translated back into checkout `ValidationError`s after `releaseReservedStockBatch()` proves any reserved stock was released. If release cannot be proven, checkout fails closed with a temporary-unavailable error instead of hiding a possible reserved-stock leak. The buyer receives `201` only after the order row exists.
6. **Attempt finalization** -- After the order commit, the API stores the committed response on `checkout_attempts` and clears the processing claim. If the Worker crashes after the order commit but before finalization, the same request can reclaim the stale attempt with the same reserved IDs and converge on the existing order instead of creating a duplicate.
7. **Post-commit work** -- COD tracking, durable order-notification enqueue, and product availability cache invalidation run after commit through `executionCtx.waitUntil()` when available. These failures are logged and retried by their own durable paths instead of turning a committed checkout into a false `500`.
8. **Recovery and guest support** -- `GET /orders/status/:token` and receipt validation use KV as the fast path, then fall back to D1 `checkout_attempts` plus the committed `orders` row. D1 fallbacks that prove a completed or failed checkout schedule KV repair through `waitUntil()` when available, including `order_receipt:{token}` for completed orders, so repeated polling returns to the fast path after transient KV misses. Receipt-token validation only repairs `order_receipt:{token}` for committed attempts; still-processing attempts must be proven by the caller's authoritative order read before any buyer-facing state is returned. `GET /orders/receipt/:id` returns buyer-safe receipt facts plus eligible support-request actions and reuses its receipt order projection for support-action eligibility instead of rereading the order. `POST /orders/receipt/:id/support-requests` accepts the private receipt token and creates a cancellation, return, or refund request in the same support-request ledger used by customer accounts, with `customerId = null` unless the order was genuinely account-owned. It never directly mutates payment, shipment, inventory, COD, or order status.

### Admin Order Creation (synchronous, reserve then deduct)

1. **Admin POST /admin/orders** -- `createOrder()` calculates totals, resolves locations, finds/creates customer
2. **SKU authority**: `resolveAdminOrderItemInventory()` requires every manual order item to use a concrete SKU, joins the SKU to its parent product, and rejects missing/deleted SKUs, product/SKU mismatches, inactive products, and soft-deleted products before any inventory or order write starts. The returned `inventoryTracked` flag is trusted only after this validation.
3. **Reserve stock**: Calls `reserveStockBatch()` only for validated tracked SKUs. If any SKU has insufficient stock, throws `ValidationError` immediately -- order is never created.
4. **Atomic DB write**: Inserts customer (new or update), order, and items in a single `db.batch()` call with `inventoryAction: "reserved"` when tracked reservations exist, otherwise `"none"`.
5. **On batch failure**: Calls `releaseReservedStockBatch()` to prove all reservations made in step 3 were released with deterministic movement claims. If cleanup cannot be proven, the admin create request fails closed with a temporary-unavailable error.
6. **Convert to deduction**: Calls `deductMultiple()` to permanently deduct stock (decrements `stock`, clears `reservedStock`). On success, updates `inventoryAction` to `"deducted"`.
7. **On deduction failure**: Stock remains reserved (no overselling risk). Error is logged but the order itself succeeds.

### Admin Order Update

1. `updateOrder()` validates status transition via state machine
2. `resolveAdminOrderItemInventory()` revalidates the complete replacement item set before inventory deltas are calculated, so stale admin tabs cannot swap in deleted, inactive, mismatched, or variantless lines
3. If `inventoryAction === "reserved"`: reserves positive deltas and releases removed/reduced quantities before replacing item rows
4. If `inventoryAction === "deducted"`: deducts positive deltas and restores removed/reduced quantities before replacing item rows
5. Calls `applyInventoryForStatusChange()` after item writes unless an explicit item-delta/status branch already handled inventory; this also repairs same-status retries whose status was persisted before inventory completed
6. Optimistic locking via `version` column -- throws `ConflictError` if version mismatch
7. Deletes all existing items and re-inserts (full replacement)
8. Updates customer stats for both old and new customer (if customer changed)

### Status Update Flow

1. `updateOrderStatus()` reads current order state
2. Validates transition via `validateTransition()`
3. **COD paid-state guard**: If order is COD and new status is DELIVERED or COMPLETED, the order must already have successful COD collection evidence. Generic status updates do not synthesize COD payment state.
4. CAS update on `version` column FIRST (prevents race between admin + webhook)
5. On CAS success, or when retry sees the requested status already persisted, applies inventory side effects via `applyInventoryForStatusChange()`
6. Persists/reconfirms the resulting `inventoryAction`; if inventory throws before `inventoryAction` changes, `rollbackOrderStatusIfInventoryUnchanged()` reverts the visible status behind the claimed version/status/action guard
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
| `partially_refunded` | `order_partially_refunded` |

All 10 buyer-visible order statuses that trigger status notifications are covered. Payment milestones can also enqueue order events, currently including `payment_balance_paid` for confirmed remaining-balance payments. Each dispatches to enabled channels (email, SMS, WhatsApp, push) via the queue consumer. Queue handoff is durable through `packages/core/src/modules/notifications/order-notification-outbox.ts`; channel targets are fenced by `order_notification_delivery_receipts` so accepted/skipped email, SMS, Meta WhatsApp template sends, and FCM token sends are not retried after a later target fails. Resend and GenNet also receive provider-native idempotency/client reference keys where supported.

### Fulfillment Flow

1. `createFulfillmentShipment()` checks order is not cancelled/returned
2. Validates no items are already shipped/delivered (throws `ConflictError` if so)
3. Claims the order with a version/status/fulfillment check, then creates a manual/own-courier `deliveryShipments` row and updates item fulfillment statuses to `shipped`
4. If final shipment: updates order `fulfillmentStatus` to `complete`, and order status to `shipped` when it was still confirmed
5. Applies inventory deduction for final shipments, including retries where the order was already marked shipped or delivered before inventory completed
6. When the final manual shipment actually changes the buyer-visible order status to `shipped`, the core result returns a private `statusChange` fact and the API route records it through the durable order-notification outbox. Plain fulfillment-status-only edits do not reuse `order_completed`; that event remains tied to the buyer-visible `completed` order status.

### COD Actions

`processCodAction()` handles three actions with CAS protection on the order version:
- `collected`: CAS-updates the order toward `delivered`, records collection via `recordCODCollection()` before inventory movement, rolls back the delivered claim if COD evidence or inventory repair fails, and treats existing COD evidence as a retry signal
- `failed`: Records failure via `recordCODFailure()`
- `returned`: CAS-updates the order toward `returned`, marks COD returned before inventory restoration, rolls back the returned claim if the COD marker or inventory repair fails, and retries inventory restoration when the order is already returned

### Bulk Ship Orders

`bulkShipOrders()` applies CAS protection per order:
1. Reads order status and version
2. If the order is already `shipped`, treats the call as a retry and reconciles inventory without calling the provider again
3. For unshipped orders: claims by version, calls the provider, CAS-updates status to `shipped`, then deducts inventory
4. Provider-success/local-finalization failures leave the shipment `reconcile_required` and keep the matching order shipment claim until repair succeeds
5. CAS conflicts (concurrent admin + webhook edits) are logged and skipped gracefully

Admin bulk-shipping UI must submit one `/bulk-ship` request with all selected order ids and render the aggregate per-order result. Do not loop over `/:id/shipments` from the browser for selected rows.

### Delete Flow

- **Soft delete**: Releases inventory via `applyInventoryForStatusChange(db, id, "cancelled")` if reserved or deducted, sets `deletedAt`, sets `inventoryAction` to `"restored"`
- **Permanent delete**: Releases inventory, deletes order items first (FK ordering), then deletes order
- **Restore**: Clears `deletedAt`, but does not secretly change order status. `incomplete`, `pending`, `processing`, and `confirmed` orders with `inventoryAction = "restored"` re-reserve variant inventory and become `reserved`; if there are no variant items they become `none`. `cancelled`, `returned`, and `refunded` restored orders remain `restored`. Shipped/delivered/completed/partially-refunded restored orders reject until inventory/status are explicitly reconciled. Existing `reserved` or `deducted` actions are accepted only for compatible statuses, and re-reservations are compensated if the final restore CAS fails.
- **Bulk delete**: Iterates and applies inventory release per order. For permanent: deletes items first, then orders (FK ordering fixed).

### Stale Hosted-Payment Cleanup

`archiveStaleIncompleteOrders()` is the only scheduled path that may move an existing stale checkout order. It handles hosted-payment methods only (`stripe`, `sslcommerz`, `polar`), requires `status = incomplete`, `paymentStatus` of `unpaid` or `failed`, `paidAmount <= 0`, no soft delete, no active shipment claim, no pending/succeeded `order_payments`, and no live `payment_session_attempts` processing lease. Each order must win a guarded cancelled claim before inventory is released through `applyInventoryForStatusChange(db, orderId, "cancelled")`; release failure rolls the claim back to `incomplete`.

After release succeeds, the final archive soft-deletes the order, marks inventory restored, conditionally cancels a pending payment plan only when the order finalization actually won, and writes the `abandoned_checkouts` snapshot after finalization. The API scheduled worker runs it with a 60-minute grace period and a batch limit of 25, then invalidates product availability caches for archived order ids.

## Queue Processing

Storefront order creation is not queue-backed. Checkout commits the order synchronously through `commitStorefrontOrderPayload()`, then runs durable side effects after commit. One order-facing queue remains relevant:

| Queue | Message Type | Handler |
|-------|-------------|---------|
| `ORDER_NOTIFICATIONS_QUEUE` | `order.notification` | Outbox-backed `sendOrderNotificationEmail()` + `sendOrderNotification()` (FCM push) via `queue-consumer.ts` |

The `order.notification` handler in `queue-consumer.ts` claims `order_notification_outbox` rows by `outboxId`, sends email/SMS/WhatsApp through `sendOrderNotificationEmail()` with `db` for channel preference checking, optionally sends FCM push notifications through `sendOrderNotification()`, then marks the row `sent` only if enabled receipt targets are accepted or skipped. Retryable customer-channel or admin-push failures mark the parent row failed with D1 `nextAttemptAt` backoff and ack the Queue message, so scheduled outbox flushing owns durable retries. Legacy messages without an `outboxId` still use Cloudflare Queue retry. Merchant-actionable provider failures such as invalid SMS credentials, missing Meta WhatsApp credentials, or missing recipients become skipped receipts instead of hot retry loops.

Payment-related queue messages (`payment.stripe.confirmed`, `payment.sslcommerz.confirmed`, `payment.polar.confirmed`, etc.) are handled in `queue-consumer.ts` and call `processPaymentConfirmed()` / `processPaymentFailed()` from the payments module. Confirmed `paymentType = "balance"` messages enqueue `payment_balance_paid` instead of replaying `order_created`, so customers receive a distinct remaining-payment receipt.

## Concurrency Control

- **Optimistic locking on orders**: `version` column, CAS update in `updateOrder()` and `updateOrderStatus()`
- **Optimistic locking on inventory**: `stockVersion` column on `productVariants`, separate from general `version`
- **Checkout reservation rollback**: `commitStorefrontOrderPayload()` reserves tracked stock before the order write and calls `releaseReservedStockBatch()` if the D1 order batch fails. Rollback release writes a deterministic `released` movement claim and the variant counter update in one D1 `safeBatch()`, retries CAS/transient failures, treats exact duplicate release claims as idempotent, and fails checkout closed if cleanup cannot be proven. Late reservation failures surface buyer-safe cart issues.
- **Checkout idempotency**: `checkout_attempts` owns same-key replay, in-flight `202`, reserved order ids, and stale-claim recovery. `commitStorefrontOrderPayload()` also treats an already-committed order id as success so a crash after commit can converge without a duplicate order.
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
| POST | `/:id/payment-recovery-link` | `createOrderPaymentRecoveryLink()` | Issue an RBAC-gated SSLCommerz/Polar private receipt recovery URL without provider calls |
| GET | `/:id/cod` | direct query | COD tracking record |
| POST | `/:id/cod` | `processCodAction()` | COD collected/failed/returned |
| GET | `/:id/fulfill` | `getOrderShipments()` | Fulfillment shipments |
| POST | `/:id/fulfill` | `createFulfillmentShipment()` | Create fulfillment with item tracking |
| GET | `/:id/shipments` | `DeliveryService.getShipments()` | Delivery shipments with provider names |
| POST | `/:id/shipments` | `DeliveryService.createShipment()` | Create delivery shipment |
| GET | `/:id/shipments/:shipmentId` | `DeliveryService.getShipment()` | Single shipment detail |
| DELETE | `/:id/shipments/:shipmentId` | `DeliveryService.deleteShipment()` | Delete shipment |
| POST | `/:id/shipments/:shipmentId/status` | shared check + sync helper | Check provider status, sync order/inventory/cache/notifications |
| POST | `/:id/shipments/:shipmentId/refresh` | shared check + sync helper | Refresh provider status, sync order/inventory/cache/notifications |
| POST | `/:id/shipments/:shipmentId/reconcile` | `reconcileOrderShipment()` | Repair `reconcile_required` shipment/order/inventory state without calling the provider again |
| POST | `/:id/return` | `processReturn()` | Return with optional auto-refund |
| POST | `/:id/refund` | `processRefund()` | Refund with optional gateway |
| GET | `/:id/form-data` | direct query | Order + products for edit form |

Bulk provider shipment creation uses a durable order-level shipment claim (`orders.shipmentClaimId` / `orders.shipmentClaimExpiresAt`) linked to the insert-first `delivery_shipments` row. Admin order mutations, status changes, manual fulfillment, COD actions, refunds, returns, public payment-session creation, shipment refresh/deletion, and cleanup must reject or skip active claims. Queue/webhook paths must surface retryable failures so external payment or delivery truth is not acknowledged while shipment creation is being finalized. Provider success with failed local finalization leaves the shipment in `reconcile_required` and keeps the order claim active until `reconcileOrderShipment()` repairs local order status, inventory state, shipment status, and then clears only the matching claim. The repair path must use persisted provider evidence on the shipment; it must not create another provider shipment.

Admin order list/detail projections expose only a sanitized `shipmentRecovery` summary for this state. `creating` or `reconcile_required` shipments and active shipment claims are active locks; failed provider rows are visible as retryable so merchants can create a new shipment after the failed evidence is recorded. Do not expose shipment claim ids, provider payloads, request hashes, or raw metadata through order list/detail. Admin mutation affordances should block edit/status/delete/refresh/bulk delete/bulk ship/manual fulfillment/provider shipment creation before click when `shipmentRecovery.activeLock` is true. Shipment managers may run the explicit repair action from the recovery notice; view-only users only see the operator copy.

Admin hosted-payment recovery link issuance is intentionally narrow. `POST /api/v1/admin/orders/{id}/payment-recovery-link` is gated by `orders.edit`, supports only SSLCommerz and Polar because those are the receipt-page retry gateways, validates local order/payment/session/shipment evidence before minting proof, stores only the `order_receipts` token hash in D1, and writes the existing `order_receipt:{token}` KV hint only after the full storefront URL can be built. It must not call payment providers, enqueue jobs, or expose raw receipt tokens anywhere except the one returned private URL.

### Admin Shipments (`/api/v1/admin/shipments`)

| Method | Path | Handler | Purpose |
|--------|------|---------|---------|
| GET | `/:id` | `DeliveryService.getShipment()` | Get shipment by ID |
| DELETE | `/:id` | `DeliveryService.deleteShipment()` | Delete shipment |
| POST | `/:id/check-status` | shared check + sync helper | Check provider status, sync order/inventory/cache/notifications |

### Storefront (`/api/v1/orders`)

| Method | Path | Handler | Purpose |
|--------|------|---------|---------|
| GET | `/:id` | direct query | Order with items, shipments, delivery providers |
| GET | `/receipt/:id` | receipt-token validation + support-request state | Buyer-safe private receipt detail with support request history/actions |
| POST | `/receipt/:id/support-requests` | `createReceiptOrderSupportRequest()` | Receipt-token cancellation, return, or refund request creation; writes the support-request ledger and enqueues merchant/admin notification only after proof validation |
| GET | `/status/:token` | KV lookup | Poll checkout processing status |
| POST | `/` | `createStorefrontOrder()` + `commitStorefrontOrderPayload()` | Synchronous idempotent order placement (returns `201` after D1 commit; `202` only for duplicate in-flight submits) |

## Admin Full Edit Inventory Safety

`updateOrder()` keeps the existing `order_items` rows as the retry snapshot until inventory deltas are safe. Positive quantity deltas are reserved or deducted before the order CAS. Removed/reduced reserved or deducted deltas, plus terminal cancellation/return/refund release or restore, are applied before replacing item rows and now fail closed instead of logging and succeeding. The final item replacement uses a single D1 batch for delete plus insert, so item insert failure does not leave old rows deleted; pre-write inventory compensation runs if a later write fails.

## Dependencies

- `@scalius/database` -- `orders`, `orderItems`, `orderSupportRequests`, `orderSupportRequestEvents`, `customers`, `customerHistory`, `products`, `productVariants`, `productImages`, `deliveryShipments`, `deliveryProviders`, `deliveryLocations`, `discountUsage`, `discountCustomerRedemptions`, `codTracking`
- `inventory` module -- reservation, deduction, release, transitions
- `payments` module -- COD collection/return, refund service
- `delivery` module -- `DeliveryService`, `ShipmentTracker`
- `notifications` module -- `sendOrderNotificationEmail()`, `sendOrderNotification()` (FCM push)
- `@scalius/core/search` -- FTS5 for order search
- `@scalius/core/errors` -- `NotFoundError`, `ValidationError`, `ConflictError`
- `@scalius/shared/price-utils` -- `roundPrice`, `addPrices`, `subtractPrice`
- `@scalius/shared/order-utils` -- `generateOrderId`
- `@scalius/shared/customer-utils` -- `phoneNumberSchema`, `calculateCustomerStats`
