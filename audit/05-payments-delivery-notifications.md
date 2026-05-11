# Audit 05: Payments, Delivery, Notifications, Fraud Checker

Date: 2026-04-22

## Scope

- Payments: `packages/core/src/modules/payments/**`, payment provider abstractions, webhook handlers, refund flow, queue consumer payment cases, and payment-related API routes.
- Delivery: `packages/core/src/modules/delivery/**`, delivery webhook auth, courier webhook routes, shipment refresh/status flows, and order side effects from courier state.
- Notifications: `packages/core/src/modules/notifications/**`, `ORDER_NOTIFICATIONS_QUEUE` handling, admin push, customer email/SMS/WhatsApp fan-out, and notification coverage from payment/delivery/admin flows.
- Fraud checker: `packages/core/src/modules/fraud-checker/**` and `apps/api/src/routes/admin/fraud-checker.ts`.
- Runtime review: checked this slice against the requested `workers-best-practices` and `hono-cf` guidance, plus current Cloudflare Queues and Hono docs.

## End-to-End Flows

1. Storefront/admin payment flow
   Browser or server-side proxy calls `apps/api/src/routes/payment/*`.
   Those routes create a Stripe intent, SSLCommerz session, or Polar checkout, then persist the gateway transaction/session ID on the order.

2. Gateway webhook flow
   Gateway webhooks hit `apps/api/src/routes/webhooks/*`.
   Webhooks verify auth/signature, build a `PAYMENT_EVENTS_QUEUE` message, and the queue consumer dispatches to `processPaymentConfirmed()`, `processPaymentFailed()`, `releaseOrderInventory()`, or `processPolarWebhookRefund()`.

3. Refund/return flow
   Admin refund and return APIs call `packages/core/src/modules/payments/refund-service.ts`, which resolves a gateway provider, performs the external refund, then writes refund/payment/order state locally.

4. Delivery flow
   Admin shipment creation and refresh routes call `packages/core/src/modules/delivery/delivery.service.ts`.
   Courier webhooks update `delivery_shipments`, then call `updateOrderStatusFromShipment()` to synchronize order state and sometimes enqueue customer notifications.

5. Notification flow
   Order lifecycle events enqueue `ORDER_NOTIFICATIONS_QUEUE` messages.
   `apps/api/src/queue-consumer.ts` then calls `sendOrderNotificationEmail()` for customer channels and `sendOrderNotification()` for admin push.

6. Fraud checker flow
   Fraud-checker providers are configured in admin, stored in `settings`, and used only by the admin lookup route.
   There is no checkout/order/payment pipeline integration in the current code.

## Workers / Hono Runtime Notes

- `apps/api/wrangler.jsonc:46-95` is in decent shape operationally: all relevant queues have explicit `max_retries` and DLQs, and the worker has `nodejs_compat` plus observability enabled.
- Current webhook routes generally follow the right Hono raw-body pattern by reading `c.req.text()` before parsing the body, which is the safe pattern for signature verification.
- The main Cloudflare runtime constraint for this slice is queue delivery semantics: Queues are at-least-once, and un-acked messages are retried. That makes any code path that logs a business failure but still returns successfully a real data-loss risk, not just a logging problem.

## Findings Ordered by Severity

### P0

1. Failed payment records can block or discard later successful confirmations for the same gateway transaction.

   Refs: `packages/core/src/modules/payments/process-payment.ts:41-69`, `packages/core/src/modules/payments/process-payment.ts:190-231`, `packages/database/src/schema/orders.ts:127-130`, `apps/api/src/routes/webhooks/stripe.ts:81-93`

   `processPaymentFailed()` inserts a failed `order_payments` row with the gateway transaction ID, while `processPaymentConfirmed()` treats any existing row with that ID as "already processed" without checking `status`. For Stripe especially, `payment_intent.payment_failed` can be followed by a later successful confirmation on the same PaymentIntent. In that case the success path is skipped, and the order remains locally unpaid/failed even though the customer eventually paid.

2. SSLCommerz IPN handling trusts unsigned request fields after validation and can credit the wrong order or poison refund data.

   Refs: `apps/api/src/routes/webhooks/sslcommerz.ts:36-90`, `packages/core/src/modules/payments/sslcommerz.ts:119-139`

   The webhook validates only `val_id`, but still takes `tran_id`, `bank_tran_id`, `currency`, and `paymentType` from the posted form body instead of using the validator response as the source of truth. If a valid `val_id` is replayed or mismatched with a tampered body, the wrong order can be marked paid and later refunds can target the wrong `bank_tran_id`.

### P1

3. Payment confirmations are acknowledged even when core business logic reports failure.

   Refs: `packages/core/src/modules/payments/process-payment.ts:179-182`, `apps/api/src/queue-consumer.ts:249-341`

   `processPaymentConfirmed()` converts errors into `{ success: false }`, but the queue consumer does not check that result and does not throw or `retry()` on failure. Under Cloudflare Queues semantics, that means state-machine errors, unique-index failures, or inventory-side failures are silently acked and lost instead of retried or dead-lettered.

4. Successful payment processing has a lost-update race on `orders.paidAmount`, `balanceDue`, and `paymentStatus`.

   Refs: `packages/core/src/modules/payments/process-payment.ts:71-156`

   Payment confirmation reads the current order totals, computes new monetary fields, and writes them back without a CAS guard on `orders.version`. Two distinct successful payments landing close together can both insert `order_payments` rows while the final order totals only reflect the last write.

5. Payment-initiation routes allow overcharges and invalid payment-plan states.

   Refs: `apps/api/src/routes/payment/stripe-routes.ts:95-123`, `apps/api/src/routes/payment/sslcommerz-routes.ts:96-115`, `apps/api/src/routes/payment/polar-routes.ts:78-145`

   All three routes still allow `paymentType="full"` on partially paid orders, which charges the full order total instead of the remaining balance. SSLCommerz and Polar also allow deposits that are `>= totalAmount`, which can create zero/negative `balanceDue`. Polar additionally does not block already-paid, cancelled, or returned orders at route level.

6. Refund orchestration is unsafe under concurrency and incorrect for split-payment orders.

   Refs: `packages/core/src/modules/payments/refund-service.ts:250-337`, `packages/core/src/modules/payments/refund-service.ts:41-63`

   Two separate problems stack here:
   `processRefund()` calls the external gateway refund before it has safely claimed the local order version. A concurrent refund can therefore succeed at the gateway and then be locally rolled back as a CAS loser.
   The refund path always selects the latest successful payment record and derives a single gateway transaction ID from that one row. Deposit+balance or multi-gateway orders are therefore refunded against one transaction instead of being apportioned across the payments that actually collected the money.

7. Partial-refund bookkeeping is mathematically wrong and leaves order monetary fields inconsistent.

   Refs: `packages/core/src/modules/payments/refund-service.ts:227-245`, `packages/core/src/modules/payments/refund-service.ts:312-318`

   Cumulative refund validation compares `alreadyRefunded + refundAmount` against the current `paidAmount`, so a legitimate second partial refund can be rejected after the first partial refund already reduced `paidAmount`. The order update also never recomputes `balanceDue`, so refunded orders can end up with stale financial fields.

8. Polar dashboard refunds over-apply cumulative refund amounts and do not fully synchronize order state.

   Refs: `packages/core/src/modules/payments/polar.ts:244-283`, `apps/api/src/queue-consumer.ts:351-366`

   `processPolarWebhookRefund()` treats Polar's cumulative `refunded_amount` as if it were a delta against the current `order.paidAmount`. After multiple partial refunds, the second and later webhooks subtract too much. It also updates only `paidAmount` and `paymentStatus`, leaving `balanceDue` and `orders.status` out of sync with the admin refund path.

9. Steadfast webhook replay protection is too coarse and suppresses legitimate later status changes.

   Refs: `apps/api/src/routes/webhooks/steadfast.ts:48-54`, `apps/api/src/routes/webhooks/steadfast.ts:210-214`

   The dedupe key uses only `consignment_id` plus `notification_type`. Because every lifecycle push uses `notification_type = "delivery_status"`, the first delivery-status webhook for a consignment suppresses all later ones for 24 hours, including the eventual `delivered`, `cancelled`, or `partial_delivered` update.

10. Delivery status mapping and shipment-to-order propagation use different vocabularies.

   Refs: `packages/core/src/modules/delivery/status-mapper.ts:6-20`, `packages/core/src/modules/delivery/status-mapper.ts:48-95`, `packages/core/src/modules/delivery/status-mapper.ts:115-127`, `packages/core/src/modules/delivery/tracking.ts:47-103`

   The mapper emits canonical states such as `out_for_delivery`, `partial_delivered`, `delivery_failed`, and `pickup_failed`, but `updateOrderStatusFromShipment()` never handles those states. Real provider updates therefore stop at the shipment row and do not propagate to the order or downstream notifications.

11. Customer notification fan-out breaks for phone-only customers and for encrypted SMS credentials.

   Refs: `apps/api/src/queue-consumer.ts:372-383`, `packages/core/src/modules/notifications/notifications.service.ts:143-255`, `packages/core/src/modules/notifications/notifications.service.ts:226-237`, `packages/core/src/integrations/sms/sms-settings.ts:212-243`

   Two issues combine here:
   The queue consumer only calls `sendOrderNotificationEmail()` when `customerEmail` exists, but that helper is also where SMS and WhatsApp are dispatched. Phone-only customers therefore receive no customer notification even if SMS is enabled.
   The notification service resolves SMS providers with `getActiveSmsProvider(db)` and does not pass the encryption key, unlike OTP delivery. Encrypted SMS credentials can work for OTPs and still fail for order notifications.

12. Refund, return, and some shipment-driven status changes do not enqueue the customer notifications the module claims to support.

   Refs: `apps/api/src/routes/admin/orders-refund.ts:44-51`, `apps/api/src/routes/admin/orders-refund.ts:83-91`, `apps/api/src/routes/admin/orders-status.ts:242-247`, `apps/api/src/routes/admin/orders-status.ts:500-542`, `packages/core/src/modules/orders/orders.fulfillment.ts:141-147`, `packages/core/src/modules/notifications/notifications.service.ts:134-200`

   `order_refunded`, `order_returned`, and shipment-driven `order_shipped` templates exist, but the admin refund/return route never enqueues notifications. The manual fulfillment route can also move an order to `shipped` without sending a queue message, and the shipment refresh route updates order state without any notification enqueue.

13. A cancelled Stripe intent always restores inventory, even if the order was later paid another way.

   Refs: `apps/api/src/queue-consumer.ts:273-275`, `packages/core/src/modules/payments/process-payment.ts:242-282`

   The queue consumer unconditionally calls `releaseOrderInventory()` for `payment_intent.canceled`. That function does not verify the current order status or whether inventory was already re-committed by a later successful payment, so a cancelled attempt can restore stock for an order that is already paid.

14. Courier polling can overwrite a healthy shipment with synthetic `unknown/error` after transient provider failures.

   Refs: `packages/core/src/modules/delivery/providers/pathao.ts:332-340`, `packages/core/src/modules/delivery/providers/steadfast.ts:257-265`, `packages/core/src/modules/delivery/delivery.service.ts:347-356`

   Both provider adapters convert transient request/parsing failures into `{ status: "unknown", rawStatus: "error" }`, and `checkShipmentStatus()` persists that as the new shipment state. A temporary courier outage can therefore erase the last known good shipment status.

### P2

15. Admin push notifications are mislabeled for every non-created event.

   Refs: `packages/core/src/modules/notifications/notifications.service.ts:71-75`, `apps/api/src/queue-consumer.ts:385-397`

   `sendOrderNotification()` always sends `"New Order Created!"`, but the queue consumer invokes it for any enabled `order.notification` type. A shipped, cancelled, returned, completed, or refunded event therefore still produces a "new order" push.

16. Fraud-checker provider secrets are stored plaintext, type resolution falls back silently, and the feature is not integrated into checkout/order decisions.

   Refs: `packages/core/src/modules/fraud-checker/fraud-checker.service.ts:108-138`, `packages/core/src/modules/fraud-checker/provider.ts:105-110`, `apps/api/src/routes/admin/fraud-checker.ts:195-200`, `packages/core/src/modules/fraud-checker/README.md:3`

   Fraud-checker `apiKey` values are written straight into `settings.value` as JSON. Provider resolution silently falls back to `"default"` if `providerType` is wrong, which can hide misconfiguration. The admin lookup route also returns only the raw data object and drops `riskLevel`, and the module is explicitly admin-only instead of feeding checkout/order review logic.

17. Payment plans are written with an unsupported terminal status.

   Refs: `packages/core/src/modules/payments/process-payment.ts:168-176`, `packages/database/src/schema/enums.ts:118-123`

   The payment confirmation path writes `paymentPlans.status = "fully_paid"`, but the schema enum defines `completed`. This is a low-severity data-integrity bug that can break admin/UI assumptions around payment-plan status values.

## External Integration Risks

1. Stripe external refunds are not synchronized back into local order state.

   Refs: `apps/api/src/routes/webhooks/stripe.ts:107-121`, `apps/api/src/queue-consumer.ts:279-283`

   The Stripe webhook builds `payment.stripe.refunded`, but the queue consumer treats it as audit-only and does not update `orders`, `order_payments`, `balanceDue`, or inventory. Any manual Stripe dashboard refund or provider-side dispute refund will drift the local system.

2. Polar replay protection uses checkout/object identity, not a unique webhook event identity, and marks processed before queue send succeeds.

   Refs: `apps/api/src/routes/webhooks/polar.ts:46-59`, `apps/api/src/routes/webhooks/polar.ts:70-127`

   Multiple `checkout.updated` events for the same checkout can collide, and a transient `queue.send()` failure after the KV write can permanently suppress the retried webhook.

3. SSLCommerz session creation lets the caller supply callback hostnames.

   Refs: `apps/api/src/routes/payment/sslcommerz-routes.ts:19-25`, `apps/api/src/routes/payment/sslcommerz-routes.ts:117-131`

   A client-supplied `baseUrl` is used to construct success, fail, cancel, and IPN URLs. That makes callback routing a client-controlled concern instead of a server-controlled one, which is both an availability and security problem.

4. WhatsApp order notifications are advertised as a channel but remain placeholder-only.

   Refs: `packages/core/src/modules/notifications/notifications.service.ts:252-255`, `packages/core/src/modules/notifications/README.md:3`

   Enabling WhatsApp for order notifications currently only produces a log line. Operators can think a customer channel exists when it does not.

## Prioritized Follow-Ups

1. Fix payment idempotency and queue failure handling first.
   Only treat succeeded confirmations as duplicates, stop storing failed attempts under the same unique gateway ID, make payment processors throw on business failure, and add CAS on `orders.version` for payment-confirmed writes.

2. Lock down payment initiation and refund correctness.
   Enforce remaining-balance semantics, reject invalid deposits, block paid/cancelled/returned orders across all routes, and redesign refunds to allocate across successful payments instead of assuming a single latest gateway transaction.

3. Harden webhook trust boundaries and replay protection.
   For SSLCommerz, treat validator output as authoritative and verify all identifiers before crediting an order. For Polar and Steadfast, use stronger per-event dedupe keys and only mark processed after downstream side effects succeed.

4. Repair delivery-to-order and notification coverage.
   Unify shipment status vocabularies, stop suppressing real Steadfast updates, always fan out customer notifications regardless of email presence, pass the SMS encryption key in order notifications, and enqueue refund/return/manual shipment notifications.

5. Upgrade the fraud-checker from admin tool to deliberate control point.
   Encrypt provider secrets, remove silent adapter fallback, return `riskLevel` to callers, and decide whether the fraud score should block checkout, flag orders for review, or stay purely diagnostic.
