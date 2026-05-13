# Payment, Refund, Order Math and Concurrency Audit

Date: 2026-05-13
Agent: payment/refund/concurrency sidecar
Scope: backend payment confirmation, refund orchestration, COD collection, payment-session creation, Polar refund webhooks, and related unit tests.

## Executive Summary

The recent local-claim/CAS direction in `processPaymentConfirmed()` and `processRefund()` is the right shape, but several high-risk paths still let external money movement diverge from local order state. The most important gaps are amount bounds, refund allocation across multiple successful payment records, and unchecked post-provider state transitions after a refund has already been sent to a gateway.

## Findings

### Critical: Payment confirmation can overstate `paidAmount` beyond the order total

Evidence:

- `processPaymentConfirmed()` adds the incoming webhook amount to the current `paidAmount` and only clamps `balanceDue` with `Math.max(0, ...)`; it does not reject or quarantine overpayment. See `packages/core/src/modules/payments/process-payment.ts:152-165`.
- The existing test suite treats this as intended behavior: `tests/unit/core/payments/process-payment.test.ts:205-216` expects `paidAmount` to become `3000` for a `2500` order.
- Payment-session routes can create that overpayment: Stripe and SSLCommerz `paymentType: "full"` charge `order.totalAmount` even after a partial/deposit payment exists. See `apps/api/src/routes/payment/stripe-routes.ts:102-117` and `apps/api/src/routes/payment/sslcommerz-routes.ts:103-115`.
- Polar defaults deposit without an explicit `depositAmount` to the full total and has no paid/balance validation in the shown path. See `apps/api/src/routes/payment/polar-routes.ts:98-110`.

Impact:

- Revenue, refund capacity, and customer/order ledgers can show more collected money than the order total.
- A later default refund uses `paidAmount`, so an overpaid local order can attempt to refund more than the intended order value.
- Duplicate active gateway sessions can charge real customer money even if the second webhook is later rejected as "already fully paid".

Reproduction ideas:

- Unit: change the overpayment test to assert rejection when `paidAmount + incomingAmount > totalAmount + epsilon`.
- Integration: create an order for `2500`, apply a `1000` deposit webhook, then create a Stripe `full` intent and process a `2500` webhook. Current expected result is `paidAmount = 3500`, `balanceDue = 0`, `paymentStatus = paid`.
- Route-level: create two distinct Stripe intents for the same unpaid order before either webhook lands; pay both externally and observe the second external charge has no clean local reconciliation path.

Recommended fix:

- Compute `outstanding = roundPrice(totalAmount - paidAmount)` and require `incomingAmount <= outstanding` within a currency-aware tolerance before marking the payment succeeded.
- For `paymentType: "full"` on a partially paid order, either charge only `balanceDue` or reject with a "use balance payment" error.
- Mark overpayments as `pending`/`requires_reconciliation` payment records without mutating `orders.paidAmount`, or add an explicit `overpaidAmount` ledger if the business wants to accept excess.
- Replace the current overpayment unit test with a negative test and add route tests for `full` after partial payment.

### Critical: Refunds are order-level, but gateway refunds are single-payment-record based

Evidence:

- `processRefund()` selects only the latest successful `orderPayments` row, then treats the order-level `paidAmount` as refundable capacity. See `packages/core/src/modules/payments/refund-service.ts:310-343`.
- `dispatchRefund()` sends that order-level refund amount to the selected gateway/payment. For Stripe, a full local refund passes `amount: undefined`, which refunds the selected charge's remaining amount, not necessarily all successful charges. See `packages/core/src/modules/payments/refund-service.ts:220-263`.
- The admin refund route only accepts an optional gateway override; it does not select or allocate across payment records. See `apps/api/src/routes/admin/orders-refund.ts:83-91`.

Impact:

- Deposit/balance flows can have multiple successful payments. A full refund of an order with a `500` deposit and `1500` balance can mark local `paidAmount` as `0` while refunding only the latest payment/charge.
- Gateway override can choose a provider but not the exact captured payment. If there are multiple Stripe charges, full refund with `undefined` amount can refund only the latest charge while local state says the entire order was refunded.
- Multi-gateway orders are especially unsafe: a latest SSLCommerz balance payment could receive a refund request for the combined Stripe + SSLCommerz paid total.

Reproduction ideas:

- Seed two successful `orderPayments` rows for one order: Stripe deposit `500`, Stripe balance `1500`, `orders.paidAmount = 2000`. Call `processRefund()` with no amount. Verify only the latest Stripe charge receives a full refund request while local state drops to zero.
- Repeat with Stripe deposit and SSLCommerz balance. Verify the refund request is sent only to SSLCommerz for the whole `paidAmount`.
- Add a test that a refund amount cannot exceed the selected payment record's unrefunded remainder unless allocation is explicit.

Recommended fix:

- Introduce a refund allocation layer over successful payment records: compute each payment record's remaining refundable amount from original amount minus successful refund records linked to that payment.
- Require full refunds to iterate allocations across all eligible records and only mark order-level payment status after all provider refunds succeed or after a durable saga records partial completion.
- Store `originalPaymentId` / `refundOfPaymentId` on refund records rather than only metadata `refundId`.
- Make gateway override insufficient by itself; require payment-record selection or deterministic allocation by gateway and age.

### High: Refund finalization can silently lose the order-status CAS after the provider refund succeeds

Evidence:

- `processRefund()` claims local paid amount before provider dispatch, then calls the gateway. After the provider succeeds, it updates the refund record and attempts to update order status with `WHERE version = claimedOrder.version`, but it does not inspect the update result. See `packages/core/src/modules/payments/refund-service.ts:404-457`.
- Inventory release for pre-fulfillment full refunds runs after that unchecked status update and is based on the stale `order.status` read before the provider call. See `packages/core/src/modules/payments/refund-service.ts:440-465`.

Impact:

- A concurrent status change after the local refund claim but before final status update can leave `paymentStatus = refunded` while `orders.status` remains `confirmed`, `processing`, or another non-terminal status.
- For pre-fulfillment orders, inventory can be released while the order remains active if the status CAS fails but `applyInventoryForStatusChange(..., cancelled)` still executes.
- Because money already moved externally, retry semantics are hard: a retry may see the order already locally refunded and refuse to repair the order status/inventory.

Reproduction ideas:

- Instrument a fake refund provider that pauses after the local claim. During the pause, update order status/version from another request. Resume the provider and assert that `processRefund()` returns success while status did not transition.
- Add an assertion that the status update returning zero rows throws a reconciliation error and records a repair task instead of continuing to inventory release.

Recommended fix:

- After provider success, require the final status update to return one row. If it returns zero, write a durable reconciliation record and return a conflict/retry-required error that includes the gateway refund ID.
- Consider including the status transition and refund-record finalization in a single post-provider batch, with explicit result checks.
- Do not apply inventory release unless the status transition is confirmed, or make the inventory operation conditional on current order status and version.

### High: COD collection is not idempotent under concurrency and can record cash before delivery status wins CAS

Evidence:

- `recordCODCollection()` checks for an existing successful COD payment, then inserts a new `orderPayments` row without a unique claim key and without an order-version predicate. See `packages/core/src/modules/payments/cod.ts:127-198`.
- `processCodAction()` calls `recordCODCollection()` before the final delivered-status CAS. See `packages/core/src/modules/orders/orders.fulfillment.ts:89-92`.

Impact:

- Two concurrent COD collection requests can both pass the existing-payment check and insert two successful COD payment records. The order row may remain numerically paid once, but the payment ledger and COD attempt count can be duplicated.
- If `recordCODCollection()` succeeds and the delivered-status CAS fails, the order can be `paid` with a COD payment record while not delivered.

Reproduction ideas:

- Run two concurrent `processCodAction(orderId, { action: "collected", collectedAmount: balanceDue })` calls against the same order and assert that only one payment record exists. Current code has no unique constraint to guarantee this.
- Force a version bump after `recordCODCollection()` but before the delivered update and observe paid state without delivered status.

Recommended fix:

- Add a deterministic COD payment claim ID or unique partial index for one successful COD collection per order.
- Move the delivered status/order-version CAS into the same local claim as the COD payment update, or perform the CAS before inserting the payment record and make the payment write conditional on the won version.
- Include `version = observedVersion` in the order payment-state update, and check affected rows.

### High: Polar refund webhooks are not idempotent for cumulative partial refunds

Evidence:

- `processPolarWebhookRefund()` receives Polar's cumulative refunded amount, but subtracts a ratio from the current local `paidAmount`. See `packages/core/src/modules/payments/polar.ts:244-263`.
- The update has no webhook-event idempotency key, no order-version CAS, and no stored "last Polar cumulative refunded amount". See `packages/core/src/modules/payments/polar.ts:269-276`.
- The queue consumer sends Polar refund events straight to this processor. See `apps/api/src/queue-consumer.ts:366-382`.

Impact:

- A redelivered partial refund webhook can subtract the same cumulative refund twice.
- Out-of-order partial refund webhooks can produce an incorrect local paid amount.
- A full Polar refund always calls `applyInventoryForStatusChange(..., "cancelled")`, which can mix payment reconciliation with inventory/status behavior without the same pre-fulfillment checks used by `refund-service.ts`.

Reproduction ideas:

- Start with `paidAmount = 1000`, Polar webhook cumulative `amountRefunded = 250`, `totalAmount = 1000`, status `partially_refunded`. Process it twice. Current math trends toward `562.5` paid instead of stable `750`.
- Process cumulative refund `500` then a delayed cumulative refund `250` and verify local state regresses.

Recommended fix:

- Store Polar refund reconciliation state per order/payment: last cumulative refunded amount in gateway units, last event ID, and computed local refunded amount.
- Compute local paid amount from the original local paid amount or original payment amount minus cumulative refunded amount, not from mutable current `paidAmount`.
- Add CAS/version checks and webhook event dedupe similar to payment confirmation.

### Medium: Return processing knowingly applies inventory before an unchecked CAS, then may auto-refund stale state

Evidence:

- `processReturn()` documents that inventory is applied before the CAS check. See `packages/core/src/modules/payments/refund-service.ts:515-519`.
- The CAS update is executed in a batch, but no returned row count is checked. See `packages/core/src/modules/payments/refund-service.ts:521-534`.
- Auto-refund then runs using the stale pre-CAS order snapshot. See `packages/core/src/modules/payments/refund-service.ts:536-542`.

Impact:

- Concurrent status changes can leave inventory restored without the order being returned.
- Auto-refund can proceed even if the return status update did not win.

Reproduction ideas:

- Pause after inventory restore, bump order version/status, then let `processReturn(autoRefund: true)` continue. Assert it can call `processRefund()` despite not owning the return transition.

Recommended fix:

- Move return status CAS before inventory side effects, or use `buildInventoryStatements()` after winning CAS and check every affected row.
- Do not auto-refund unless the return update is confirmed.

### Medium: Fulfillment shipment creation can apply inventory before an unversioned order update

Evidence:

- `createFulfillmentShipment()` reads the order without version, may call `applyInventoryForStatusChange()` before the final batch, and updates the order with `WHERE id = orderId` only. See `packages/core/src/modules/orders/orders.fulfillment.ts:118-162`.

Impact:

- A concurrent cancel/return/refund can race with fulfillment creation and leave shipped item rows or deducted inventory on an order that should have been terminal.

Reproduction ideas:

- Race final shipment creation against order cancellation. Assert the shipment insert/order item updates cannot occur after the terminal status wins.

Recommended fix:

- Read and require `orders.version`; perform a CAS status/fulfillment update before shipment side effects, or include shipment creation in a transition claim that fails if order status/version changed.

### Medium: Payment-plan status values are inconsistent

Evidence:

- `PaymentPlanStatus` defines `completed`, not `fully_paid`. See `packages/database/src/schema/enums.ts:147-152`.
- `processPaymentConfirmed()` writes `status: "fully_paid"` on balance payment completion. See `packages/core/src/modules/payments/process-payment.ts:200-208`.

Impact:

- Admin/UI filters or future constraints that rely on `completed` can miss fully paid plans.
- If a check constraint is added later, balance payment confirmation can start failing.

Reproduction ideas:

- Create a deposit plan, process deposit then balance, and assert the final status is one of the enum values. Current code writes a non-enum value.

Recommended fix:

- Standardize on one value. Prefer the schema enum `PaymentPlanStatus.COMPLETED`, migrate existing `fully_paid` rows, and update docs/tests.

### Medium: Payment-session routes do not enforce a pending-payment/session claim

Evidence:

- Stripe, SSLCommerz, and Polar create gateway sessions/intents based on the current order snapshot and then overwrite `orders.paymentIntentId`. See `apps/api/src/routes/payment/stripe-routes.ts:136-140`, `apps/api/src/routes/payment/sslcommerz-routes.ts:145-150`, and `apps/api/src/routes/payment/polar-routes.ts:175-183`.

Impact:

- Multiple active gateway sessions can exist for the same order. If customers complete more than one, external charges can exceed the intended balance even if local confirmation rejects the later webhook.

Reproduction ideas:

- Double-click checkout payment initiation or issue two concurrent session requests. Confirm both gateway sessions are payable and only the latest `paymentIntentId` remains on the order.

Recommended fix:

- Add a `pending_payment_sessions` table or explicit order-level payment claim with TTL, amount, gateway, and type.
- Make session creation idempotent for the same outstanding amount and reject or expire older unpaid sessions before creating a new one.

## Existing Strengths

- `processPaymentConfirmed()` now claims a pending payment record before mutating the order and uses an order-version CAS for the paid amount update.
- `processRefund()` claims local refund capacity before gateway dispatch, which is the right way to avoid two concurrent requests both hitting providers.
- Inventory reservation code uses stock-version CAS for normal reservation pressure.

## Recommended Test Additions

- Overpayment rejection for `processPaymentConfirmed()` and each payment-session route.
- Full refund allocation across two payment records of the same gateway.
- Full refund allocation across two gateways, with clear rejection if allocation cannot be completed.
- Provider-success/final-status-CAS-failure refund test with a fake provider pause.
- COD double-submit concurrency test with two collection requests.
- Polar duplicate and out-of-order cumulative partial refund webhook tests.
- Payment-plan final status enum test.
