# Backend Correctness Audit - 2026-05-13

Scope: read-only production-hardening audit of backend order, payment, refund, inventory, queue, settings, auth/RBAC, and cache paths. This audit uses implementation code, not stale markdown. No source files were edited.

## Executive Priority

The highest production risks are concentrated around authorization fail-open behavior, split money/inventory state transitions, refund idempotency, and stale checkout/layout caches. These can corrupt revenue state, inventory state, admin permissions, or customer-facing checkout behavior.

## Findings

### P0 - Admin RBAC Fails Open For Unmapped Admin Routes

Evidence:
- `apps/api/src/middleware/admin-auth.ts:115-130` only requires a user to have any RBAC permission, then enforces fine-grained permission only when `getRoutePermission()` returns a mapping.
- `apps/api/src/app.ts:317` mounts real settings routes under `/admin/settings`.
- `packages/core/src/auth/rbac/route-permissions.ts:414-455` maps stale `/api/settings/*` paths instead of `/api/v1/admin/settings/*`.

Impact: a low-privilege admin with any permission can potentially write sensitive settings such as payment gateway secrets, auth settings, Firebase, SMS, currency, media, and storefront configuration.

Concrete fix:
- Make `/api/v1/admin/*` deny-by-default when no route permission is found.
- Add exact permission mappings for every mounted admin route, especially `/api/v1/admin/settings/*`, `/api/v1/admin/ai/*`, `/api/v1/admin/ai-prompts/*`, `/api/v1/admin/fraud-checker/*`, and system utilities.
- Add a route coverage test that enumerates mounted admin routes and fails if any write route lacks RBAC mapping.

### P0 - Payment Confirmation Can Split Order Money State From Payment Ledger

Evidence:
- `packages/core/src/modules/payments/process-payment.ts:101-118` inserts or resumes a local `orderPayments` claim.
- `packages/core/src/modules/payments/process-payment.ts:161-171` updates the order paid amount/status first.
- `packages/core/src/modules/payments/process-payment.ts:177-180` marks the payment row `succeeded` in a later write.
- `packages/core/src/modules/payments/process-payment.ts:148-149` rejects a retry once the order is already fully paid, so a crash after the order update but before the ledger update can strand a pending payment row.

Impact: orders can show paid while the payment ledger remains pending. Refunds, reconciliation, reports, and future webhooks can become inconsistent.

Concrete fix:
- Update the order row and the payment row in one `db.batch()` after the CAS condition wins.
- If an already-paid order is seen, reconcile by checking whether the same gateway ID, amount, and order ID already has a pending local claim, then mark it succeeded instead of returning manual-reconciliation failure.
- Add tests that inject failure between order update and payment update.

### P0 - Payment Idempotency Is Inconsistent And Failed Rows Can Block Later Success

Evidence:
- `packages/core/src/modules/payments/process-payment.ts:55-95` looks up existing gateway IDs globally but does not verify that the existing row belongs to `params.orderId`.
- `packages/database/migrations/0030_payment-idempotency-indexes.sql:29-38` creates unique indexes on `(order_id, gateway_id)`, allowing the same gateway ID on different orders even though service logic treats IDs as globally meaningful.
- `packages/core/src/modules/payments/process-payment.ts:248-263` records failed attempts with amount `0` and the gateway intent ID.
- `packages/core/src/modules/payments/process-payment.ts:61-63`, `75-77`, and `89-91` reject existing gateway rows when the later successful webhook has a real amount.

Impact: a failed Stripe/SSLCommerz/Polar intent followed by a later success for the same intent can fail reconciliation. Cross-order gateway ID collisions are also possible at the DB layer.

Concrete fix:
- Make gateway ID unique indexes global per provider, or hard-fail if an existing gateway ID belongs to a different order.
- Do not store provider intent IDs on failed ledger rows, or allow same-order failed rows to be upgraded to pending/succeeded after validating provider amount and order ownership.

### P0 - COD Delivered/Completed Can Mark Paid Without Cash Ledger

Evidence:
- `packages/core/src/modules/orders/orders.fulfillment.ts:196-210` auto-sets COD orders to `paymentStatus: PAID` when status becomes delivered/completed.
- That path does not call `recordCODCollection()`, does not insert an `orderPayments` row, and does not update `paidAmount` or `balanceDue`.
- The correct collection flow exists in `packages/core/src/modules/payments/cod.ts:107-198`, but generic status changes bypass it.

Impact: COD revenue can be overstated with no payment ledger, collector, receipt, paid amount, or balance update. Refund/accounting/reporting correctness breaks.

Concrete fix:
- Remove generic status-driven COD auto-pay.
- Require explicit COD collection with amount/collector, or route delivered/completed COD transitions through `recordCODCollection()` atomically.
- Add a DB invariant/test: COD `paymentStatus = PAID` must imply a succeeded COD payment row and `balanceDue = 0`.

### P0 - Order Status, Shipments, Returns, And Inventory Are Not One Atomic Transition

Evidence:
- `packages/core/src/modules/orders/orders.fulfillment.ts:32-48` creates a shipment, then CAS-updates order status, then applies inventory in separate statements.
- `packages/core/src/modules/orders/orders.fulfillment.ts:205-225` updates order status/version first, then applies inventory, then writes `inventoryAction`.
- `packages/core/src/modules/orders/orders.fulfillment.ts:515-533` explicitly applies return inventory before the CAS batch and notes that a failed CAS leaves inventory already changed.
- `packages/core/src/modules/payments/refund-service.ts:449-466` updates refund/order status and applies inventory release as separate operations.

Impact: crashes, transient D1 errors, or concurrent writes can produce shipped orders without stock deduction, restored stock without returned status, orphan shipments, or stale `inventoryAction`.

Concrete fix:
- Introduce a durable order transition table/outbox keyed by `orderId + fromStatus + toStatus + version`.
- Put order status, inventory operation record, shipment linkage, and notification enqueue intent into one transactional claim.
- Make inventory operations idempotent by `orderId + variantId + operation`, then process side effects from the durable transition.

### P1 - Refund Flow Can Over-Target One Payment And Strand Pending Claims

Evidence:
- `packages/core/src/modules/payments/refund-service.ts:78-93` blocks new refunds if any pending refund claim exists.
- `packages/core/src/modules/payments/refund-service.ts:312-324` defaults refund amount to the whole current `paidAmount`.
- `packages/core/src/modules/payments/refund-service.ts:326-337` chooses only the latest succeeded payment row.
- `packages/core/src/modules/payments/refund-service.ts:359-386` locally reduces `orders.paidAmount` before calling the provider.
- `packages/core/src/modules/payments/refund-service.ts:409-438` dispatches the provider refund and only then marks the refund row `refunded`; a crash after provider success leaves a permanent pending claim.

Impact: mixed/deposit/balance payments can attempt a full refund against one charge. Provider success can leave the local system blocked by a pending refund and already-reduced paid amount.

Concrete fix:
- Allocate refunds across succeeded payment rows by remaining refundable capacity.
- Use deterministic provider idempotency keys based on `refundPaymentId`.
- Add a resumable pending-refund reconciler that queries the provider and finalizes or releases claims.

### P1 - Polar Payment And Refund Paths Have Terminal-State And Cumulative-Amount Bugs

Evidence:
- `apps/api/src/routes/payment/polar-routes.ts:78-93` reads order status/paymentStatus but does not reject already-paid, cancelled, or returned orders before checkout creation.
- `apps/api/src/routes/payment/polar-routes.ts:99-110` can charge `order.totalAmount` for a full payment even if the order is partially paid.
- `packages/core/src/modules/payments/polar.ts:192-195` documents Polar refund amount as cumulative.
- `packages/core/src/modules/payments/polar.ts:255-257` applies that cumulative refund ratio to the current remaining `paidAmount`, causing repeated partial webhooks to over-subtract.
- `packages/core/src/modules/payments/polar.ts:269-276` updates `paidAmount` and `paymentStatus` but not `balanceDue`, order status, or a refund ledger row.

Impact: Polar can create live checkout links for invalid orders and can drift paid/refund totals downward after multiple partial refund webhooks.

Concrete fix:
- Add the same terminal-state guards as Stripe/SSLCommerz before creating Polar checkout.
- For full payments, charge remaining balance unless `paidAmount = 0`.
- Store provider cumulative refunded amount or compute local refund deltas against original gateway payment amount; update order, balance, status, and refund ledger in one path.

### P1 - Online Payment Session Creation Allows Duplicate Live Sessions And Over-Collection

Evidence:
- `apps/api/src/routes/payment/stripe-routes.ts:95-99` rejects paid/cancelled/returned, but not an existing active intent.
- `apps/api/src/routes/payment/stripe-routes.ts:115-117` charges full `order.totalAmount` for `paymentType = "full"` even after a partial payment.
- `apps/api/src/routes/payment/stripe-routes.ts:124-140` creates a new provider intent, then overwrites `orders.paymentIntentId`.
- `apps/api/src/routes/payment/polar-routes.ts:150-158` creates a new Polar checkout without a reuse/idempotency check.

Impact: customers can open multiple live sessions for the same order. Later successful webhooks can over-collect or race against each other.

Concrete fix:
- Persist active payment sessions with provider, order, amount, currency, type, status, and expiry.
- Reuse an active session when the order amount/type has not changed.
- Reject `full` payment on partially-paid orders, or treat it as `balance`.

### P1 - Webhook Deduplication Can Drop Events Before They Reach Queues

Evidence:
- `apps/api/src/routes/webhooks/polar.ts:50-58` writes the idempotency KV key before checking queue availability and before queue send.
- `apps/api/src/routes/webhooks/polar.ts:46-51` keys dedupe on `payload.data.id` plus event type, not a webhook delivery/event ID.
- `apps/api/src/routes/webhooks/steadfast.ts:48-53` dedupes delivery webhooks by `consignmentId_notificationType`, which can collapse later legitimate status updates of the same type.

Impact: if queue send fails after dedupe, retries are skipped. Delivery/payment state can become permanently stale.

Concrete fix:
- Write idempotency only after durable queue/outbox claim succeeds.
- Deduplicate by provider event/delivery ID when available; otherwise include status, timestamp/version, and payload hash.
- Keep a durable webhook event table for critical payment/delivery events instead of relying only on short-lived KV.

### P1 - Checkout, Payment, Layout, And Storefront Cache Invalidation Is Incomplete

Evidence:
- `apps/api/src/routes/checkout.ts:32-39` caches `/checkout/config` under `api:checkout:config:`.
- `apps/api/src/utils/cache-invalidation.ts:123-135` defines the checkout invalidation group but omits `api:checkout:config:`.
- `apps/api/src/routes/admin/settings/payments.ts:125-132` and `183-198` invalidate gateway/payment-method caches but not the checkout config cache or storefront checkout cache.
- `apps/api/src/routes/admin/settings/site.ts:204` and `251` only clear `gw:site_settings` after header/footer writes, while layout data is separately API/storefront cached.

Impact: admins can save checkout, auth, payment, header, footer, or layout settings and production storefront/admin users can continue seeing stale values.

Concrete fix:
- Add `api:checkout:config:` to the checkout invalidation group.
- Centralize settings invalidation: payment/auth/currency/shipping/location/language writes should call checkout group invalidation and storefront purge; header/footer/theme/SEO/storefront URL writes should call layout group invalidation and storefront purge.
- Add integration tests that save settings then immediately fetch public endpoints and assert fresh values.

### P1 - Authenticated Customer/Order Data Is Too Cacheable

Evidence:
- `apps/api/src/routes/customer-auth.ts:230` and `408` return customer/session/order data without explicit `Cache-Control: private, no-store` or `Vary: Cookie`.
- `apps/storefront/src/pages/api/customer-auth/[...path].ts:72` passes response headers through unchanged.
- `apps/api/src/middleware/cache.ts:62` uses a 32-bit non-cryptographic hash for `Authorization` when `varyByAuth` is enabled.
- `apps/api/src/routes/orders.ts:33` and `68` use auth-varying cache middleware on order detail responses that contain customer PII.

Impact: private order/customer data has unnecessary shared-cache exposure risk and weak auth cache key separation.

Concrete fix:
- Set `Cache-Control: private, no-store, max-age=0` and `Vary: Cookie, Authorization` for customer-auth and order-detail routes.
- Avoid shared KV caching for order detail responses unless keyed by verified subject and a cryptographic HMAC/SHA-256 key.

### P2 - Monetary Values Use SQLite REAL Across Core Money Tables

Evidence:
- `packages/database/src/schema/orders.ts:34` and `100` use `real` for order/payment/refund amounts.
- `packages/database/src/schema/products.ts:15` uses `real` for product price.
- `packages/database/src/schema/system.ts:98` uses `real` for setting-backed monetary values.

Impact: binary floating point can accumulate rounding drift in paid amount, balance due, discounts, shipping, refunds, and reports.

Concrete fix:
- Migrate money to integer minor units (`amountMinor`) with currency decimals, or store decimal strings with strict parser helpers and DB-level validation.
- Centralize conversions at API boundaries and payment provider boundaries.

### P2 - Payment Plan Status Enum And Service Writes Disagree

Evidence:
- `packages/database/src/schema/enums.ts:147` defines `PaymentPlanStatus.COMPLETED` as `"completed"`.
- `packages/core/src/modules/payments/process-payment.ts:200-208` writes `"fully_paid"` for completed balance payment plans.

Impact: admin/API code expecting enum values can miss completed payment plans or display incorrect state.

Concrete fix:
- Write `PaymentPlanStatus.COMPLETED`, or deliberately migrate schema/API/UI to include `"fully_paid"` everywhere.

## Recommended Fix Order

1. RBAC deny-by-default and settings route permission coverage.
2. Payment confirmation/idempotency ledger atomicity.
3. COD collection/payment ledger invariant.
4. Order transition + inventory side-effect durability.
5. Refund allocation/resumability.
6. Checkout/layout cache invalidation and private auth cache headers.
7. Polar-specific guards and cumulative refund correction.
8. Money representation migration plan.
