# Orders Module

The order record and everything staff do to it: the dashboard list and detail, manual orders and COD amendments, detail edits, archive, the status lifecycle kernel, returns, invoices, buyer receipts, order lookup and payment recovery. Storefront checkout lives in [`../checkout`](../checkout/README.md); the actions that hand units over (parcels, courier bookings, delivery outcomes) live in [`../fulfilment`](../fulfilment/README.md).

Public entries: `index.ts` (the server API) and `browser.ts` (types, the state machine, the archive policy, money helpers, search parsing and CSV export; safe for the dashboard).

## Files

| Path | Exports | Purpose |
|------|---------|---------|
| `index.ts` / `browser.ts` | re-exports | Public entries |
| `types.ts` | `OrderListItem`, `OrderDetails`, `CreateStorefrontOrderInput`, `StorefrontOrderCommitPayload`, `StatusUpdateResult`, `OrderSupportRequestView`, ... | Shared order types |
| `validation.ts` | `createOrderSchema`, `updateOrderDetailsSchema`, `bulkShipOrderSchema`, `MAX_ORDER_LINE_ITEMS`, ... | Zod schemas for order routes |
| `admin/list.ts` | `listOrders()`, `loadOrderExportDetails()`, `ORDER_LIST_VIEWS` | Dashboard list: views, filters, order-number/phone search, refund owed, export rows |
| `admin/detail.ts` | `getOrderDetails()` | Dashboard order detail |
| `admin/quote.ts` | `quoteManualOrder()`, `resolveAdminOrderItemInventory()` | Manual-order SKU resolution, inventory facts and money |
| `admin/create.ts` | `createOrder()` | Manual order: one guarded batch |
| `admin/create-attempts.ts` | `buildAdminOrderCreateAttemptIdentity()`, `claimAdminOrderCreateAttempt()`, ... | Actor-scoped replay authority for manual-order submits |
| `admin/amend.ts` | `previewManualOrderAmendment()`, `confirmManualOrderAmendment()` | COD line amendments under the order version |
| `admin/edit.ts` | `updateOrderDetails()` | Customer and delivery details before shipment |
| `admin/readiness.ts` | `buildOrderEditReadiness()`, `getOrderEditReadiness()` | What staff may still edit, and why not |
| `admin/archive.ts` | `archiveOrders()`, `restoreOrder()` | Archive visibility (never a hard delete) |
| `admin/recovery-link.ts` | `previewOrderPaymentRecoveryLink()`, `createOrderPaymentRecoveryLink()` | Merchant-sendable hosted-payment recovery links |
| `admin/shared.ts` | -- | Helpers shared by the admin files (not exported) |
| `status/lifecycle.ts` | `updateOrderStatus()`, `applyOrderStatusChange()`, `bulkConfirmOrders()`, `reconcileInventoryForStatus()`, ... | The status kernel: validated transitions, inventory reconciliation, COD gates, cancel guards, status notifications. Fulfilment actions call it. |
| `status/state-machine.ts` | `canTransitionTo()`, `validateTransition()` | Order/payment/fulfilment transition maps |
| `status/policy.ts` | `assertGenericAdminOrderStatusTransition()` | What the generic status editor may do (R3-ORD-01) |
| `status/claim.ts` | `rollbackOrderStatusIfInventoryUnchanged()` | Status-claim rollback when inventory did not move |
| `shipment-claim.ts` | `assertNoActiveShipmentClaim()`, `hasActiveShipmentClaim()` | The order-level lease a courier booking holds |
| `returns/returns.ts`, `returns/validation.ts` | `createOrderReturn()`, `approveOrderReturn()`, `receiveOrderReturn()`, ... | Item-level returns and receipts |
| `invoices/{service,snapshot,order-reader,printable-artifact}.ts` | `issueInvoice()`, `getInvoiceDocument()`, `renderPrintableInvoice()`, ... | Immutable invoice snapshots and printable artifacts |
| `order-support-requests.ts` | `createCustomerOrderSupportRequest()`, `createReceiptOrderSupportRequest()`, `updateOrderSupportRequestStatus()` | Buyer cancel/return/refund requests (moves to `conversations` in Wave A) |
| `receipts.ts`, `lookup.ts`, `payment-recovery.ts` | receipt proof, order lookup OTP, buyer-verified payment recovery | Guest access to an order |
| `timeline.ts`, `number.ts`, `money.ts`, `search.ts`, `csv-export.ts`, `archive-policy.ts`, `stale-incomplete.ts` | -- | Timeline, `#1001` numbers, money projections, search parsing, CSV, archive eligibility, stale hosted-payment cleanup |

## Order State Machine

Three independent status dimensions, each with its own transition map. Exported type `StatusDimension` is `"order" | "payment" | "fulfillment"`.

### Order Status Transitions

```
incomplete --> pending, cancelled
pending    --> processing, confirmed, cancelled
processing --> confirmed, cancelled
confirmed  --> shipped, delivered, cancelled
shipped    --> confirmed, delivered, returned, cancelled
delivered  --> completed, returned, refunded
completed  --> returned, refunded
cancelled                              (terminal)
returned   --> refunded
refunded   --> (terminal)
```

All 10 states: `incomplete`, `pending`, `processing`, `confirmed`, `shipped`, `delivered`, `completed`, `cancelled`, `returned`, `refunded`.

A partial refund is a payment fact, not a lifecycle state: the order keeps its status and the payment status becomes `partially_refunded` with nothing due. `partial` payment status means a real under-payment only.

**Note on CANCELLED:** Cancellation is terminal. Generic admin cancellation is limited to an order with an exact numeric zero paid amount, `unpaid` or `failed` payment status, no pending/confirmed/succeeded payment ledger row, and no active payment/refund setup. Captured, partially captured, or payment-uncertain orders must use the dedicated refund workflow; a successful full pre-fulfillment refund owns the safe transition to `cancelled` after provider and local reconciliation. Cancellation releases or restores inventory and notifies the buyer, while a merchant who wants to continue the sale must create a new order with a new lifecycle identity. Archive restoration is separate and does not reopen the order lifecycle.

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

### Storefront Order Creation

See [checkout](../checkout/README.md#storefront-order-creation-synchronous-idempotent).

### Admin Order Creation (synchronous, idempotent, reserve until fulfillment)

1. **Admin POST /admin/orders** -- the browser submits a UUID `requestKey`. It persists only a submitted opaque key in tab-local storage for lost-response recovery and clears it after success or explicit discard. Customer and order facts never enter the key or storage entry.
2. **Claim before mutable validation** -- `buildAdminOrderCreateAttemptIdentity()` scopes the key to the authenticated actor and hashes a canonical request projection. `claimAdminOrderCreateAttempt()` owns one stable order ID and reservation identity. A committed same-payload retry replays before catalog, delivery, customer, currency, or inventory validation; stale or failed same-payload work reclaims the same identity.
3. **Changed-payload recovery** -- a key never silently changes meaning. If the earlier payload committed, the typed conflict returns its actor-scoped order ID so the dashboard opens that order instead of risking a duplicate. A fresh processing lease keeps the edited form and asks the operator to retry shortly. A failed lease permits exactly one browser-generated replacement key; an expired processing lease is first fenced to `failed` behind its old request hash so an overdue worker cannot commit after that replacement is authorized.
4. **SKU authority** -- `resolveAdminOrderItemInventory()` requires every item to use a concrete SKU, joins it to its parent product, and rejects missing/deleted SKUs, product/SKU mismatches, inactive products, and soft-deleted products before any inventory or order write starts. The returned `inventoryTracked` flag is trusted only after this validation.
5. **Reserve stock** -- calls `reserveStockBatch()` only for validated tracked SKUs, using the attempt's stable reservation key. Insufficient stock fails before the order write.
6. **Atomic commit** -- one guarded D1 batch inserts or updates the customer, order, and items and commits the replay response on `admin_order_create_attempts`. The attempt guard prevents an expired worker from committing after another worker reclaims or fences its lease.
7. **On preparation or batch failure** -- the attempt is marked failed when safe to reclaim. Reserved stock is released with deterministic movement claims only while this worker still owns the attempt; an expired worker must never release a new owner's shared reservation. Cleanup failure is surfaced as temporary unavailability.
8. **Fulfillment owns deduction** -- the committed confirmed order intentionally keeps `inventoryAction = "reserved"`. Shipment/final-fulfillment commands later call `applyInventoryForStatusChange()` with deterministic movement claims, stock CAS, and guarded `inventoryAction` convergence. There is no post-commit creation step that can leave a newly created manual order half-converted.

### Editing an Order

`buildOrderEditReadiness()` decides what can still change, with a reason code the dashboard words:
- **Details** (name, phone, email, delivery address) until the order ships: `updateOrderDetails()` (PUT `/:id/details`) CAS-updates them; a changed phone links the order to that phone's customer. Money, items and tax snapshots are untouched.
- **Items** (products, quantities, discount, delivery charge) on an unpaid, unshipped cash-on-delivery order without a discount code — dashboard or checkout orders alike — through the quote-backed amendment (`previewManualOrderAmendment()` / `confirmManualOrderAmendment()`), which keeps before/after snapshots in `order_amendments`. Kept lines keep the price the buyer agreed to; added lines use today's catalog price.

### Status Update Flow

1. `updateOrderStatus()` reads current order state
2. Validates transition via `validateTransition()`
3. **COD paid-state guard**: If order is COD and new status is DELIVERED or COMPLETED, the order must already have successful COD collection evidence. Generic status updates do not synthesize COD payment state.
4. CAS update on `version` column FIRST (prevents race between admin + webhook)
5. On CAS success, or when retry sees the requested status already persisted, applies inventory side effects via `applyInventoryForStatusChange()`
6. Persists/reconfirms the resulting `inventoryAction`; if inventory throws before `inventoryAction` changes, `rollbackOrderStatusIfInventoryUnchanged()` reverts the visible status behind the claimed version/status/action guard
7. Returns `StatusUpdateResult` with optional notification payload and transition dedupe key
8. API route records the notification in `order_notification_outbox`, then relays it to `JOBS_QUEUE` when available

**Notification Status Mapping** (`NOTIFICATION_STATUSES` in `status/lifecycle.ts`):

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

All 9 buyer-visible order statuses that trigger status notifications are covered; a partial refund sends `order_partially_refunded` from the refund path. Payment milestones can also enqueue order events, currently including `payment_balance_paid` for confirmed remaining-balance payments. Each dispatches to enabled channels (email, SMS, WhatsApp, push) via the queue consumer. Queue handoff is durable through `packages/core/src/modules/notifications/order-notification-outbox.ts`; channel targets are fenced by `order_notification_delivery_receipts` so accepted/skipped email, SMS, Meta WhatsApp template sends, and FCM token sends are not retried after a later target fails. Resend and GenNet also receive provider-native idempotency/client reference keys where supported.

### Fulfilment, COD and bulk shipping

See [fulfilment](../fulfilment/README.md). Those actions move the order through `status/lifecycle.ts`.

### Archive Flow

- **Archive** is admin-list visibility only. It sets `archivedAt` with the browser-loaded order-version CAS and never changes status, inventory, payment, fulfillment, items, buyer access, invoices, returns, refunds, or support evidence.
- Only `cancelled`, `completed`, `returned`, and `refunded` orders are eligible. Active shipment claims, refund attempts, return receipts, and hosted-payment setup block archive.
- **Restore** clears `archivedAt` with the current version CAS. No inventory reservation or lifecycle transition is required because archive never released stock or changed the order.
- Bulk archive accepts 1–90 unique `{ id, expectedVersion }` records and applies one guarded D1 batch. Ordinary admin APIs expose no order hard-delete endpoint.
- `deletedAt` remains a separate legacy cleanup marker for stale incomplete hosted-payment checkout cleanup. It is not merchant archive state.

### Stale Hosted-Payment Cleanup

`archiveStaleIncompleteOrders()` is the only scheduled path that may move an existing stale checkout order. It handles online payment methods only (every registered gateway), requires `status = incomplete`, `paymentStatus` of `unpaid` or `failed`, `paidAmount <= 0`, no soft delete, no active shipment claim, no pending/succeeded `order_payments`, and no live `payment_session_attempts` processing lease. Each order must win a guarded cancelled claim before inventory is released through `applyInventoryForStatusChange(db, orderId, "cancelled")`; release failure rolls the claim back to `incomplete`.

After release succeeds, the final archive soft-deletes the order, marks inventory restored, conditionally cancels a pending payment plan only when the order finalization actually won, and writes the `abandoned_checkouts` snapshot after finalization. The API scheduled worker runs it with a 60-minute grace period and a batch limit of 25, then invalidates product availability caches for archived order ids.

## Queue Processing

Storefront order creation is not queue-backed. Checkout commits the order synchronously through `commitStorefrontOrderPayload()`, then runs durable side effects after commit. One order-facing queue remains relevant:

| Queue | Message Type | Handler |
|-------|-------------|---------|
| `JOBS_QUEUE` | `order.notification` | Outbox-backed `sendOrderNotificationEmail()` + `sendOrderNotification()` (FCM push) via `queue-consumer.ts` |

The `order.notification` handler in `queue-consumer.ts` claims `order_notification_outbox` rows by `outboxId`, sends email/SMS/WhatsApp through `sendOrderNotificationEmail()` with `db` for channel preference checking, optionally sends FCM push notifications through `sendOrderNotification()`, then marks the row `sent` only if enabled receipt targets are accepted or skipped. Retryable customer-channel or admin-push failures mark the parent row failed with D1 `nextAttemptAt` backoff and ack the Queue message, so scheduled outbox flushing owns durable retries. Legacy messages without an `outboxId` still use Cloudflare Queue retry. Merchant-actionable provider failures such as invalid SMS credentials, missing Meta WhatsApp credentials, or missing recipients become skipped receipts instead of hot retry loops.

Payment events (one `payment.event` message type for every gateway) are handled in `queue-consumer.ts` and call `processPaymentConfirmed()` / `processPaymentFailed()` from the payments module. Confirmed `paymentType = "balance"` messages enqueue `payment_balance_paid` instead of replaying `order_created`, so customers receive a distinct remaining-payment receipt.

## Concurrency Control

- **Optimistic locking on orders**: `version` column, CAS update in `updateOrderDetails()`, amendments and `updateOrderStatus()`
- **Request keys on every dashboard write**: a repeated request (double click, retry) returns the first result. Refunds key their attempt rows (`refund_request:<order>:<key>:<n>`, same key + different amount is a 409); own-courier sends store the key on the shipment (bulk runs use `bulk:<key>` per order); bulk confirm and timeline lines derive the `order_events` id from the key, so a repeat can't add a line; return commands keep their `commandKey`.
- **Fulfilment states come only from parcels**: the generic status change (`updateOrderStatus`, dashboard and agents alike) makes only side-effect-free moves (incomplete→pending, pending/processing→confirmed, →cancelled, delivered→completed). Shipped comes from Mark as sent / Book courier, delivered from cash collected (COD) or `markOrderDelivered` (paid, fully sent), returned from Mark returned or a return. A Shipped order with nothing actually sent can still be cancelled, which restores its stock. On a part-sent order an own-courier parcel that came back is taken off the sent list (`markParcelReturned`); part-sent stock is still reserved, so no stock moves.
- **Nothing with the courier is cancelled**: `updateOrderStatus(..., "cancelled")` refuses while any item has `shipped_quantity > 0` (also in the CAS), so units with a rider never go back into sellable stock. Own-courier parcels follow the order: a failed attempt marks open parcels `delivery_failed`, return to sender marks them `returned`, cash collected marks them `delivered`.
- **Optimistic locking on inventory**: `stockVersion` column on `productVariants`, separate from general `version`
- **Checkout reservation rollback**: `commitStorefrontOrderPayload()` commits inventory CAS and ledger edges in the same guarded batch as the order. A failed authority, inventory, or order guard rolls back the whole batch; no compensating stock release is needed. Late reservation failures surface buyer-safe cart issues.
- **Checkout idempotency**: `checkout_attempts` owns same-key replay, in-flight `202`, reserved order ids, and stale-claim recovery. `commitStorefrontOrderPayload()` also treats an already-committed order id as success so a crash after commit can converge without a duplicate order.
- **Discount redemption authority**: One engine (`modules/promotions`): `quoteStorefrontDiscount` evaluates the typed code with active automatic discounts; the commit re-evaluates the snapshot. Validation endpoints and pre-commit reads are advisory. Code discounts write immutable `promotion_redemptions` rows keyed to the canonical CRM customer (including guest profiles) with D1-triggered total/per-customer/spend limits; automatic discounts have no limits and write allocations only (revision-guarded). An order retry returns the existing order before a second claim. Cancellation/refund does not release typed claims; any future release policy must use an auditable adjustment ledger.

## API Endpoints

### Admin (`/api/v1/admin/orders`)

| Method | Path | Handler | Purpose |
|--------|------|---------|---------|
| GET | `/` | `listOrders()` | Paginated list with FTS5 search, status/date filters, shipment summary |
| POST | `/` | `createOrder()` | Manual order creation with reserve-then-deduct inventory |
| GET | `/:id` | `getOrderDetails()` | Full order with items, variant info, images |
| PUT | `/:id/details` | `updateOrderDetails()` | Customer and delivery details before shipment |
| GET/POST | `/:id/timeline` | `listOrderTimeline()` / `addOrderComment()` | Order timeline and staff comments |
| POST | `/bulk-confirm` | `bulkConfirmOrders()` | Confirm several new orders |
| POST | `/bulk-fulfill` | `bulkFulfillOrders()` | Own-courier "Mark as sent" for several confirmed orders |
| POST | `/:id/restore` | `restoreOrder()` | Restore archived order visibility with version CAS |
| POST | `/archive` | `archiveOrders()` | Bounded versioned archive without commerce mutation |
| POST | `/bulk-ship` | `bulkShipOrders()` | Bulk shipment creation |
| PUT | `/:id/status` | `updateOrderStatus()` | Status change with inventory + COD paid-state guard + notifications |
| GET | `/:id/items` | direct query | Items with product details and images |
| GET | `/:id/payments` | direct query | Order payments + payment plan |
| POST | `/:id/payment-recovery-link` | `previewOrderPaymentRecoveryLink()` | Issue an RBAC-gated SSLCommerz buyer verification URL without provider calls or receipt proof minting |
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
| GET/POST | `/:id/returns` | `listOrderReturns()` / `createOrderReturn()` | Read or request item-level returns; request does not change stock |
| GET | `/:id/returns/:returnId` | `getOrderReturn()` | Read item lines, lifecycle, and sanitized recovery state |
| POST | `/:id/returns/:returnId/approve` | `approveOrderReturn()` | Approve/reject every requested unit without changing stock |
| POST | `/:id/returns/:returnId/receive` | `receiveOrderReturn()` | Record immutable restock/damaged dispositions and exact ledger movement |
| POST | `/:id/returns/:returnId/reconcile` | `reconcileOrderReturnReceipt()` | Resume a claimed receipt from server-owned durable input |
| POST | `/:id/returns/:returnId/cancel` | `cancelOrderReturn()` | Cancel an unreceived request/approval |
| POST | `/:id/refund` | `processRefund()` | Refund with optional gateway |
| GET | `/:id/form-data` | direct query | Order + products for edit form |

Bulk provider shipment creation uses a durable order-level shipment claim (`orders.shipmentClaimId` / `orders.shipmentClaimExpiresAt`) linked to the insert-first `delivery_shipments` row. Admin order mutations, status changes, manual fulfillment, COD actions, refunds, returns, public payment-session creation, shipment refresh/deletion, and cleanup must reject or skip active claims. Queue/webhook paths must surface retryable failures so external payment or delivery truth is not acknowledged while shipment creation is being finalized. Provider success with failed local finalization leaves the shipment in `reconcile_required` and keeps the order claim active until `reconcileOrderShipment()` repairs local order status, inventory state, shipment status, and then clears only the matching claim. The repair path must use persisted provider evidence on the shipment; it must not create another provider shipment.

Admin order list/detail projections expose only a sanitized `shipmentRecovery` summary for this state. `creating` or `reconcile_required` shipments and active shipment claims are active locks; failed provider rows are visible as retryable so merchants can create a new shipment after the failed evidence is recorded. Do not expose shipment claim ids, provider payloads, request hashes, or raw metadata through order list/detail. Admin mutation affordances should block edit/status/archive/refresh/bulk archive/bulk ship/manual fulfillment/provider shipment creation before click when `shipmentRecovery.activeLock` is true. Shipment managers may run the explicit repair action from the recovery notice; view-only users only see the operator copy. The summary carries a stable `reason` code (`courier_unconfirmed`, `reconcile_required`, `creating`, `claim_expired`, `failed`); the dashboard words it from its own en/bn catalog and never shows the server's English `label`/`message`, which remain for agent and CLI readers. Refund attempts (keyed by `status` and `gateway`) and payment webhook issues (`reason`) follow the same rule.

Admin hosted-payment recovery link issuance is intentionally narrow. `POST /api/v1/admin/orders/{id}/payment-recovery-link` is gated by `orders.edit`, supports only SSLCommerz because it is the hosted receipt-page retry gateway, validates local order/payment/session/shipment evidence through `previewOrderPaymentRecoveryLink()`, and returns a clean `/payment-recovery?orderId=...` buyer verification URL. It must not mint receipt proof, call payment providers, enqueue jobs, write raw receipt tokens into KV, or expose raw receipt tokens in returned URLs, logs, analytics, or clipboard copy.

Cross-browser guest hosted-payment recovery is buyer-verified, not bearer-link based. `/api/v1/orders/payment-recovery/send-otp` creates an order-owned `order_payment_recovery_challenges` row with hashed contact/code state and reuses the existing `auth.send_otp` queue with `purpose: "order_payment_recovery"`. New queue payloads carry only `challengeKey` and `deliveryKey`; the API queue consumer derives the OTP at send time, so raw OTP codes do not enter Cloudflare Queues. `/api/v1/orders/payment-recovery/verify-otp` is service-JWT protected for the storefront server proxy; successful OTP proof rechecks eligibility, consumes the challenge, records an `order_receipts` hash with `source = "guest_payment_recovery"`, and returns raw proof only to the trusted storefront proxy so it can set the existing per-order HttpOnly receipt cookie. Public/browser responses must stay no-store and must not expose receipt tokens, token hashes, raw contacts, OTP codes, provider payloads, or receipt PII.

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
| POST | `/payment-recovery/send-otp` | `sendOrderPaymentRecoveryOtp()` | Public, generic response for buyer OTP delivery against an eligible hosted-payment recovery order |
| POST | `/payment-recovery/verify-otp` | `verifyOrderPaymentRecoveryOtp()` | Service-authenticated storefront handoff that verifies OTP and returns raw receipt proof only to the storefront server proxy |
| GET | `/status/:token` | KV/D1 status-token lookup | Poll checkout processing status with a non-bearer `cst_` token; `chk_` receipt proof is rejected in the URL |
| POST | `/` | `createStorefrontOrder()` + `commitStorefrontOrderPayload()` | Synchronous idempotent order placement (returns `201` after D1 commit; `202` only for duplicate in-flight submits) |

## Dependencies

- `@scalius/database` -- `orders`, `orderItems`, `orderSupportRequests`, `orderSupportRequestEvents`, `customers`, `customerHistory`, `products`, `productVariants`, `productMedia`, `media`, `deliveryShipments`, `deliveryProviders`, `deliveryLocations`, `orderDiscountAllocations`, `promotionRedemptions`, `codTracking`
- `inventory` module -- reservation, deduction, release, transitions
- `payments` module -- COD collection/return, refund service
- `delivery` module -- `DeliveryService`, `ShipmentTracker`
- `notifications` module -- `sendOrderNotificationEmail()`, `sendOrderNotification()` (FCM push)
- `@scalius/core/search` -- FTS5 for order search
- `@scalius/core/errors` -- `NotFoundError`, `ValidationError`, `ConflictError`
- `@scalius/shared/money` -- `toMinor`, `fromMinor`, `discountedPriceMinor` (all order money is integer minor units of the order currency)
- `@scalius/shared/order-utils` -- `generateOrderId`
- `@scalius/shared/customer-utils` -- `phoneNumberSchema`, `calculateCustomerStats`
