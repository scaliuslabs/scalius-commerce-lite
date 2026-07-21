# Payments Module

Multi-gateway payment processing with a unified provider interface, gateway registry, queue-based async processing, and partial payment (deposit/balance) support.

## Architecture Overview

```
Storefront (browser)
  |
  |  1. User selects payment method on /checkout
  |  2. Browser calls storefront proxy endpoint
  v
Storefront (SSR proxy)               apps/storefront/src/pages/api/checkout/*
  |
  |  3. Proxy calls API worker via service binding
  v
API Worker                            apps/api/src/routes/payment/*
  |
  |  4. Creates payment session/intent via gateway SDK
  |  5. Returns clientSecret (Stripe) or redirectUrl (SSLCommerz/Polar)
  v
Payment Gateway (Stripe / SSLCommerz / Polar)
  |
  |  6. Customer pays on gateway
  |  7. Gateway sends webhook to API worker
  v
API Webhook Handler                   apps/api/src/routes/webhooks/*
  |
  |  8. Verifies signature, enqueues message to PAYMENT_EVENTS_QUEUE
  v
Queue Consumer                        apps/api/src/queue-consumer.ts
  |
  |  9. Processes message: calls processPaymentConfirmed() or processPaymentFailed()
  v
Process Payment (core)                packages/core/src/modules/payments/process-payment.ts
  |
  | 10. Atomically (db.batch): insert orderPayment + update order + apply inventory
```

COD is the exception: no external gateway, no webhook, no queue. Order is placed directly and payment is recorded when courier collects cash.

## Files

### Core (`packages/core/src/modules/payments/`)

| File | Exports | Purpose |
|------|---------|---------|
| `types.ts` | `PaymentGateway`, `PaymentType`, `PaymentResult`, gateway-specific param/result types | Shared type definitions for all gateways. Header comment documents the amount convention: DB stores major units; Stripe/Polar expect smallest units via `getDecimalPlaces()`; SSLCommerz expects major units with `toFixed(decimals)`. |
| `provider.ts` | `PaymentProvider` interface, `CreatePaymentParams`, `CreatePaymentResult`, `RefundParams`, `RefundResult`, `WebhookPayload` | Unified gateway abstraction |
| `factory.ts` | `createPaymentProvider()`, `GatewayConfig` | Factory function returning the correct `PaymentProvider` for a gateway type; checks `enabled` flag, throws `ServiceUnavailableError` if disabled. Uses discriminated union `GatewayConfig` with exhaustive switch. |
| `gateway-registry.ts` | `registerGateway()`, `getRegisteredGateways()`, `getGatewayMeta()`, `GatewayMeta` | Runtime registry for dynamic gateway discovery (used by checkout config endpoint). `GatewayMeta` includes `getSettings()`, `getPublicConfig()`, `getCurrencies()`. |
| `gateway-settings.ts` | `getStripeSettings()`, `getSSLCommerzSettings()`, `getPolarSettings()`, `getActivePaymentMethods()`, `upsertSetting()`, `upsertEncryptedSetting()`, `invalidate*Cache()` | Reads gateway credentials from `settings` DB table, caches decrypted/configured results in memory only (5 min TTL), encrypts new provider-secret writes with the dedicated credential key, best-effort cleans legacy KV keys, registers all 4 gateways in the registry via side-effect on import |
| `stripe.ts` | `StripeProvider` class, `createPaymentIntent()`, `capturePaymentIntent()`, `cancelPaymentIntent()`, `createRefund()`, `retrieveStripeRefund()`, `listStripeRefundsForCharge()`, `verifyStripeWebhook()`, `getStripe()` | Stripe SDK wrapper; module-level singleton with key rotation detection |
| `sslcommerz.ts` | `SSLCommerzProvider` class, `initSSLCommerzSession()`, `validateSSLCommerzIPN()`, `validateSSLCommerzPayment()`, `initiateSSLCommerzRefund()`, `querySSLCommerzRefundStatus()` | SSLCommerz REST API wrapper; no SDK, uses native `fetch`; sandbox/production URL switching. Uses `getDecimalPlaces()` for ISO 4217-aware amount formatting. |
| `polar.ts` | `PolarProvider` class, `createPolarCheckout()`, `createPolarRefund()`, `listPolarRefunds()`, `verifyPolarWebhook()`, `processPolarWebhookRefund()` | Polar SDK wrapper; uses `@polar-sh/sdk` + `standardwebhooks` for signature verification. External Polar refunds reconcile cumulative provider snapshots into local refund-payment deltas. |
| `cod.ts` | `CODProvider` class, `initCODTracking()`, `recordCODCollection()`, `recordCODFailure()`, `markCODReturned()` | Cash on Delivery tracking; DB-only operations, no external gateway |
| `process-payment.ts` | `processPaymentConfirmed()`, `processPaymentFailed()`, `releaseOrderInventory()`, `recordWebhookEvent()` | Shared post-payment business logic called by queue consumer |
| `payment-state.ts` | `computeOrderPaymentState()`, `computePaymentStateAfterPayment()`, `computePaymentStateAfterRefund()` | Canonical order payment-state arithmetic for `paidAmount`, `balanceDue`, and `paymentStatus` |
| `refund-service.ts` | `processRefund()`, `finalizeAcceptedRefundAttemptIds()` | Gateway-agnostic refund orchestrator; detects gateway from payment records, validates cumulative refund amounts, and owns local accepted-refund finalization. Returns are an independent order workflow. |
| `refund-reconciliation.ts` | `reconcileDueRefundAttempts()`, `reconcileRefundAttemptById()` | Scheduled bounded recovery for stale/ambiguous refund attempts. Claims due rows, probes providers where possible, finalizes accepted attempts through `refund-service.ts`, fails stale pre-dispatch attempts, and defers unknown outcomes without duplicate refunds. |
| `refund-attempt-visibility.ts` | `listOrderRefundAttempts()`, `formatRefundAttemptForVisibility()`, `summarizeActiveRefundOperation()` | Sanitized admin/customer read model for refund attempts. Admin receives operational references and safe errors; customers receive buyer-safe progress copy. Raw request/response payloads, request hashes, provider idempotency keys, claim fields, and payment metadata stay private. |
| `payment-session-attempts.ts` | `buildPaymentSessionAttemptIdentity()`, `claimPaymentSessionAttempt()`, created/failed markers, active setup guards | Durable D1 idempotency for Stripe/SSLCommerz/Polar session creation across receipt-token checkout recovery and customer-account post-sale recovery, plus the shared active hosted-payment setup lock for admin/post-sale mutations |
| `index.ts` | Barrel re-exports | All public exports from the module |

### API Routes (`apps/api/src/routes/`)

| File | Route Mount | Endpoints |
|------|-------------|-----------|
| `payment/payment-session-create.ts` | Shared helper | Common Stripe/SSLCommerz/Polar session creator used by checkout receipt-token routes and customer-account owned-order recovery |
| `payment/stripe-routes.ts` | `/api/v1/payment/stripe` | `POST /intent` -- Create PaymentIntent |
| `payment/sslcommerz-routes.ts` | `/api/v1/payment/sslcommerz` | `POST /session` -- Create payment session; `POST /success`, `GET /success` -- redirect handler; `POST /fail`, `GET /fail` -- redirect handler; `POST /cancel`, `GET /cancel` -- redirect handler |
| `payment/polar-routes.ts` | `/api/v1/payment/polar` | `POST /session` -- Create checkout session; `GET /success` -- redirect handler; `GET /cancel` -- redirect handler |
| `customer-auth.ts` | `/api/v1/customer-auth` | `GET /orders/{id}` includes policy-backed `paymentRecovery`; `POST /orders/{id}/payment-session` creates a strict customer-owned retry/pay-balance session |
| `webhooks/stripe.ts` | `/api/v1/webhooks/stripe` | `POST /` -- Stripe webhook receiver |
| `webhooks/sslcommerz.ts` | `/api/v1/webhooks/sslcommerz` | `POST /` -- SSLCommerz IPN receiver |
| `webhooks/polar.ts` | `/api/v1/webhooks/polar` | `POST /` -- Polar webhook receiver |
| `checkout.ts` | `/api/v1/checkout` | `GET /config` -- Storefront checkout configuration (available gateways, auth settings, partial payment config, currency with decimalPlaces, allowedCountries) |
| `admin/settings/payments.ts` | `/api/v1/admin/settings` | `GET /payment-methods`, `POST /payment-methods` -- Enabled methods + default; `GET /stripe`, `POST /stripe`; `GET /sslcommerz`, `POST /sslcommerz`; `GET /polar`, `POST /polar` |

### Storefront (`apps/storefront/`)

| File | Purpose |
|------|---------|
| `src/lib/api/checkout.ts` | `getCheckoutConfig()` -- fetches gateway config from API, uses L1+L2 edge cache; `isCodOnly()` helper |
| `src/lib/checkout/index.ts` | `initCheckoutPage()` -- client-side checkout page controller; registers all gateway handlers, manages selection state, orchestrates payment flow |
| `src/lib/checkout/types.ts` | `GatewayHandler`, `PaymentContext`, `PaymentResult`, `CheckoutConfig` -- client-side gateway abstraction |
| `src/lib/checkout/registry.ts` | `registerGateway()`, `getGateway()` -- client-side gateway handler registry |
| `src/lib/checkout/create-order.ts` | `createOrder()` -- shared order creation via `/api/checkout/create-order` proxy |
| `src/lib/checkout/handlers/cod.ts` | COD handler: creates order, redirects to `/order-success` |
| `src/lib/checkout/handlers/stripe.ts` | Stripe handler: creates order, fetches PaymentIntent, dynamically loads Stripe.js, mounts card element, confirms card payment client-side |
| `src/lib/checkout/handlers/sslcommerz.ts` | SSLCommerz handler: creates order, fetches session, redirects to `gatewayUrl` |
| `src/lib/checkout/handlers/polar.ts` | Polar handler: creates order, fetches session, redirects to `gatewayUrl` |
| `src/lib/account-payment-recovery.ts` | Pure account-order payment recovery copy/action helpers plus hosted URL normalization |
| `src/pages/account/orders/[id].astro` | Private customer order detail page; renders retry/pay-balance UI, Stripe card form, and hosted-gateway redirects without receipt tokens |
| `src/pages/api/checkout/create-order.ts` | SSR proxy: calls API to create order (API_TOKEN server-side only) |
| `src/pages/api/checkout/stripe-intent.ts` | SSR proxy: calls `POST /payment/stripe/intent`, unwraps `{success, data}` envelope |
| `src/pages/api/checkout/sslcommerz-session.ts` | SSR proxy: calls `POST /payment/sslcommerz/session`, unwraps envelope, 15s timeout |
| `src/pages/api/checkout/polar-session.ts` | SSR proxy: calls `POST /payment/polar/session`, unwraps envelope, 15s timeout |
| `src/pages/checkout.astro` | Checkout page: injects `__CHECKOUT_CONFIG__`, imports `initCheckoutPage` |

### Admin (`apps/admin-v2/src/components/admin/settings/`)

| File | Purpose |
|------|---------|
| `PaymentGatewaysManager.tsx` | Main payment settings UI. 2x2 accordion grid. Lazy-loads credentials per-gateway on expand. Manages enabled/disabled toggles, default method selector, save per-gateway. |
| `PolarSettingsForm.tsx` | `PolarForm` (credentials form) + `PolarSetupGuide` (5-step setup dialog) |
| `payment-gateway-utils.tsx` | Shared types (`StripeData`, `SSLCommerzData`, `PolarData`, `MethodKey`), reusable components (`PasswordInput`, `SaveBtn`, `SandboxToggle`, `LiveWarning`, `ExtLink`), gateway logo SVGs, `META` lookup |

### Database Schema (`packages/database/src/schema/orders.ts`)

| Table | Purpose |
|-------|---------|
| `orders` | Main order table. Payment fields: `paymentMethod` (stripe/sslcommerz/polar/cod), `paymentStatus` (unpaid/partial/paid/refunded/failed), `paymentIntentId` (stores Stripe PI ID, SSLCommerz session key, or Polar checkout ID), `paidAmount`, `balanceDue` |
| `orderPayments` | Individual payment records. Per-gateway columns: `stripePaymentIntentId`, `stripeChargeId`, `sslcommerzTranId`, `sslcommerzValId`, `sslcommerzBankTranId`, `polarCheckoutId`, `codCollectedBy`, `codCollectedAt`, `codReceiptUrl`. Status: `pending`/`succeeded`/`failed`/`refunded`. Indexed on gateway-specific ID columns for idempotency lookups. |
| `refundAttempts` | Durable refund operation ledger. One row per refund allocation/payment row, with request hash, source/refund payment IDs, provider idempotency/reference keys, provider refund ID/status, probe scheduling, and active statuses (`pending`, `processing`, `provider_unknown`, `reconcile_required`) that block duplicate refund attempts until reconciliation completes. |
| `paymentPlans` | Partial payment tracking. `orderId` (unique), `totalAmount`, `depositAmount`, `balanceDue`, `depositPaidAt`, `balancePaidAt`, `status` (pending/deposit_paid/completed/cancelled) |
| `codTracking` | COD-specific tracking. `orderId` (unique), `deliveryAttempts`, `lastAttemptAt`, `codStatus` (pending/collected/failed/returned), `failureReason`, `collectedBy`, `collectedAmount`, `collectedAt`, `receiptUrl` |
| `webhookEvents` | Webhook event log for auditing and admin reconciliation. `provider`, `eventType`, `orderId`, `status` (`processing`/`queued`/`processed`/`failed`/`manual_reconciliation`), `result`. Payment queue DLQ evidence is stored here under `reason: "payment_events_dlq"` with compact queue/payment references, not raw provider payloads. |

### Enums (`packages/database/src/schema/enums.ts`)

- `PaymentMethod`: `stripe | sslcommerz | polar | cod`
- `PaymentStatus`: `unpaid | partial | paid | refunded | failed`
- `OrderStatus`: includes `incomplete` (pre-payment) and `pending` (post-payment)

### Queue Consumer (`apps/api/src/queue-consumer.ts`)

Dispatches `PaymentQueueMessage` types:

Payment webhook handlers attach the source `webhookEventId` to queued payment messages. The consumer closes that durable event only after the queued side effects finish: `processed` for successful side effects, `manual_reconciliation` for non-retryable business-state conflicts, and `failed` only on the terminal payment queue delivery attempt before DLQ/deletion.

`payment-events-dlq` is consumed as an evidence archive, not a replay queue. The DLQ branch runs before normal message dispatch, writes compact `payment_events_dlq` evidence to `webhook_events`, preserves prior results, avoids downgrading rows already marked `processed` or `manual_reconciliation`, and acks only after the D1 write succeeds. It must not call `processPaymentConfirmed()`, `processPaymentFailed()`, provider APIs, notification dispatch, or cache invalidation.

| Message Type | Handler | Action |
|------|---------|--------|
| `payment.stripe.confirmed` | `processPaymentConfirmed()` | Converts amount from smallest unit to major unit (via `getDecimalPlaces()`), records payment, updates order, applies inventory |
| `payment.stripe.failed` | `processPaymentFailed()` | Marks order as failed if no prior payments; stale incomplete hosted-payment cleanup handles later archive/release after the scheduled grace period |
| `payment.stripe.canceled` | `releaseOrderInventory()` | Releases reserved inventory |
| `payment.stripe.refunded` | (audit only) | Logs refund event; actual refund handled synchronously |
| `payment.sslcommerz.confirmed` | `processPaymentConfirmed()` | Amount already in major unit (no conversion), records payment |
| `payment.sslcommerz.failed` | `processPaymentFailed()` | Marks order as failed; scheduled stale cleanup handles later archive/release |
| `payment.polar.confirmed` | `processPaymentConfirmed()` | Converts amount from smallest unit to major unit (via `getDecimalPlaces()`) |
| `payment.polar.failed` | `processPaymentFailed()` | Marks order as failed; scheduled stale cleanup handles later archive/release |
| `payment.polar.refunded` | `processPolarWebhookRefund()` | Requires the matching `polarCheckoutId`, imports only the newly observed delta from Polar's cumulative `refunded_amount`, writes a local `orderPayments` refund row, CAS-updates the order from the payment ledger, releases inventory on pre-fulfillment full-order refund, and returns a post-commit buyer notification fact |

## Provider Details

### Stripe

- **SDK**: `stripe` v17+ (Web Fetch API native, works on CF Workers)
- **Client singleton**: Module-level `_stripe` with key rotation detection (`_stripeKey` comparison)
- **Session creation**: `createPaymentIntent()` creates a Stripe PaymentIntent; returns `clientSecret` for client-side confirmation via Stripe.js. Public checkout routes pass the durable payment-session attempt key as Stripe's provider idempotency key.
- **Capture modes**: Provider code supports automatic (default) or manual (`manualCapture: true` -- authorize now, capture later via `capturePaymentIntent()`). Public checkout session routes currently force `manualCapture: false`.
- **Cancel**: `cancelPaymentIntent()` cancels uncaptured intents
- **Webhook verification**: `verifyStripeWebhook()` uses `constructEventAsync` (Web Crypto compatible)
- **Webhook events handled**: `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`
- **Replay protection**: Durable `webhook_events` claim `stripe:{event.type}:{event.id}` before queueing
- **Refund**: `createRefund()` refunds by charge ID; supports explicit partial/full allocation amounts, reason codes (`duplicate`, `fraudulent`, `requested_by_customer`), and Stripe request idempotency keys from refund allocation metadata.
- **Settings**: `secret_key`, `publishable_key`, `webhook_secret`, `enabled` (stored in `settings` table, category `stripe`)
- **Currency**: Amount in smallest currency unit. API route converts via `getDecimalPlaces(currency)`: `amount * Math.pow(10, decimals)` (e.g. USD/BDT: x100, JPY: x1, BHD: x1000). Queue consumer reverses: `amount / Math.pow(10, decimals)`.

### SSLCommerz

- **SDK**: None -- raw `fetch` calls to SSLCommerz REST API v4
- **Base URLs**: `sandbox.sslcommerz.com` (sandbox) / `securepay.sslcommerz.com` (production)
- **Session creation**: `initSSLCommerzSession()` POSTs to `/gwprocess/v4/api.php`; returns `GatewayPageURL` (redirect) + `sessionkey`
- **Amount formatting**: Uses `totalAmount.toFixed(getDecimalPlaces(currency))` for ISO 4217-aware decimal formatting. e.g. BDT: `toFixed(2)`, JPY: `toFixed(0)`, BHD: `toFixed(3)`. No smallest-unit multiplication -- SSLCommerz always receives the display amount.
- **Session params**: Uses a unique merchant `tran_id` per payment attempt (`{orderId}_{paymentType}_{suffix}`), includes `value_a` for payment type, and includes `value_b` for the canonical order id. Public checkout routes derive the suffix from the durable payment-session attempt hash, so retries for the same canonical attempt reuse the same merchant transaction id.
- **Redirect handlers**: API has POST + GET handlers for `/success`, `/fail`, `/cancel`; each validates order exists before redirecting to storefront. Trusted callback URLs include `order_id`; legacy callbacks can still derive the order id by parsing scoped `tran_id`. `STOREFRONT_URL` from env determines redirect target.
- **IPN validation**: SSLCommerz does NOT sign webhooks. `validateSSLCommerzIPN()` makes a server-to-server API call to `/validator/api/validationserverAPI.php` using `val_id`. Only `VALID`/`VALIDATED` statuses are accepted.
- **Transaction validation**: `validateSSLCommerzPayment()` validates by `tran_id` via `/validator/api/merchantTransIDvalidationAPI.php`
- **Replay protection**: Durable `webhook_events` claim `sslcommerz:ipn:{tran_id}:{val_id}` before queueing. Confirmed payment idempotency uses canonical `val_id`; `tran_id` remains a merchant attempt/correlation field.
- **Refund**: `initiateSSLCommerzRefund()` uses `bank_tran_id` (from original payment). Refund amount formatted with `toFixed(2)` (SSLCommerz only supports BDT for refunds). Production requires IP whitelisting. `querySSLCommerzRefundStatus()` checks refund progress (refunded/processing/cancelled). Admin refunds pass a deterministic per-allocation `refund_trans_id` through provider metadata instead of generating a new timestamp id on retry.
- **Settings**: `store_id`, `store_password`, `sandbox`, `enabled` (stored in `settings` table, category `sslcommerz`)

### Polar

- **SDK**: `@polar-sh/sdk` (`Polar` class) + `standardwebhooks` (`Webhook` class for signature verification)
- **Client singleton**: Module-level `_cachedClient` keyed by access token and sandbox/production server so credential or environment rotation takes effect in warm isolates
- **Session creation**: `createPolarCheckout()` uses ad-hoc pricing -- a Polar Product must exist but the actual amount is set per-checkout via `prices` override. Returns `checkoutUrl` (redirect) + `checkoutId`, and forwards trusted success/cancel URLs from the API route.
- **Webhook verification**: `verifyPolarWebhook()` base64-encodes the webhook secret before passing to `standardwebhooks`. Synchronous verification (not async).
- **Webhook events handled**: `checkout.updated` (status failed/expired -> enqueue failed), `order.paid` (enqueue confirmed), `order.refunded` (enqueue refund -> update payment and allowed order status + pre-fulfillment inventory)
- **Replay protection**: Durable `webhook_events` claim before queueing
- **External refund semantics**: Polar `order.refunded.refunded_amount` is cumulative for the Polar checkout. The queue payload must preserve `polarCheckoutId`; `processPolarWebhookRefund()` resolves the local succeeded Polar payment row, calculates the target refunded amount against that source payment, records only the new local delta as a refund payment row, and derives full-vs-partial order state from the whole local payment ledger. Repeated or larger cumulative events converge instead of compounding against current `orders.paidAmount`, and a fully-refunded Polar deposit remains a partial merchant-order refund if other captured payments remain.
- **Refund**: `createPolarRefund()` refunds by Polar order ID. Reason codes: `fraudulent`, `customer_request`, `duplicate`, `other`, `service_disruption`, and `satisfaction_guarantee`. Omitted reasons use `customer_request`.
- **Settings**: `access_token`, `webhook_secret`, `product_id`, `sandbox`, `enabled` (stored in `settings` table, category `polar`)
- **Currency**: Amount in smallest currency unit. API route converts via `getDecimalPlaces(currency)`: `amount * Math.pow(10, decimals)`. Queue consumer reverses: `amount / Math.pow(10, decimals)`.

### COD (Cash on Delivery)

- **No external gateway**: All operations are DB-only
- **Tracking lifecycle**: `pending` -> `collected` (success) or `failed` (delivery attempt failed) -> `returned` (all attempts exhausted)
- **Order-creation invariant**: Every COD order commits its initial `codTracking`
  row in the same D1 batch as the order, items, money/tax snapshots,
  idempotency result, and inventory reservation. Manual admin creation and
  storefront ingestion both use `createCODTrackingInsertValues()`; a committed
  COD order without tracking is invalid state, not a recoverable UI default.
- **`initCODTracking()`**: Idempotently ensures the same initial tracking row
  for provider-oriented compatibility paths. It uses
  `onConflictDoNothing(orderId)` and must not be used as a post-commit order
  lifecycle side effect.
- **`recordCODCollection()`**: Idempotent only when both the succeeded COD payment and collected tracking evidence exist. New collection fails closed if the COD tracking row is missing; otherwise it atomically via `db.batch()`: updates `codTracking` (collected status + details), inserts `orderPayments` (status: succeeded), updates `orders` (paymentStatus: PAID, paidAmount, balanceDue: 0). Amounts and the payment-ledger currency come from the immutable order currency snapshot; a mismatched existing payment row fails before mutation. Admin COD collection records this evidence before inventory reconciliation so retries can safely repair stock/status without duplicating payment rows.
- **`recordCODFailure()`**: Increments `deliveryAttempts`, sets `codStatus: "failed"`, records `failureReason` (not_home/refused/no_cash/wrong_address/other)
- **`markCODReturned()`**: Sets `codStatus: "returned"` and fails closed if no COD tracking row is updated; admin COD return records this marker before inventory restoration and rolls back the visible returned status claim if the marker or restoration step fails before `inventoryAction` changes.
- **CODProvider.createPayment()**: Calls `initCODTracking()`, returns `transactionId: "COD-{orderId}"` (no clientSecret or redirectUrl)
- **CODProvider.createRefund()**: Returns a marker ID `COD-REFUND-{timestamp}` (no gateway API call; refund is manual)
- **No verifyWebhook**: Intentionally not implemented

## Key Patterns

### processPaymentConfirmed() Atomicity

The critical payment processing function uses `db.batch()` to atomically execute:
1. Insert into `orderPayments` (payment record)
2. Update `orders` (paidAmount, balanceDue, paymentStatus, status)
3. Inventory action flag updates (from `buildInventoryStatements()`)

If any statement fails, all roll back. This prevents the prior split-write bug where a payment could be recorded but inventory left un-deducted.

Uses `resolveOrderCurrencySnapshot()`, `roundOrderMoney()`, and `orderMoneyEqual()` from `order-currency.ts`, so zero- and three-decimal historical orders are never reinterpreted using current store settings. Only wholly legacy-null currency snapshots fall back to BDT.

### Idempotency

Four layers of duplicate prevention:

1. **Session creation level**: Public Stripe, SSLCommerz, and Polar routes claim `payment_session_attempts` before provider calls using a canonical key derived from order id, receipt token hash or customer-account proof, gateway, payment type, server-derived amount/currency, and route-owned callback/customer context. Volatile caller retry metadata is not part of the identity. Created attempts store the replay payload (`clientSecret`/redirect URL/session id) so identical proof/return-target retries return the original session without touching the provider again. Live in-flight attempts are single-flight per order/gateway/payment type through a D1 partial unique index and return a retryable `202 processing` response instead of creating a duplicate or surfacing a hard conflict. Storefront payment handlers and post-sale recovery retry only those explicit processing responses through a bounded client helper: respect `retryAfterSeconds`/`Retry-After`, wait at least 2s, and give up within 25s/12 attempts so provider setup never becomes a hot loop. Failed or stale attempts are reclaimable. Receipt-token recovery can rotate a failed unpaid online order between SSLCommerz and Polar only after target gateway readiness, current-gateway failed-payment evidence, no unsafe payment rows, no active setup lease, and a guarded order CAS. Active unexpired setup leases are also the shared mutation lock for admin order edit/restore/delete/status, shipment create/refresh/delete, COD collection/failure/return, refunds, and returns, so local order/payment/inventory changes cannot race a hosted gateway setup. Stripe also receives the same durable attempt key as its provider idempotency key.
2. **Webhook level**: Durable `webhook_events` claims prevent re-enqueuing the same payment webhook before side effects. Queue-send failures mark the event `failed` so provider retries can reclaim it. Queued payment messages carry the source `webhookEventId`, and the queue consumer marks it `processed`, `manual_reconciliation`, or terminal `failed` after the actual side effects finish. Fresh `processing` claims dedupe in-flight work, while stale `processing` claims are lease-reclaimable so isolate failures before queue send do not black-hole provider retries. Scheduled maintenance marks payment-provider `queued` rows older than six hours as `failed` in bounded batches so provider retries or admin/manual recovery can reclaim genuinely stranded events. Valid late SSLCommerz success callbacks after gateway rotation are accepted only while the order is still failed/unpaid with no captured amount; conflicting callbacks become `manual_reconciliation` evidence and return `OK` so deterministic business conflicts do not create provider retry storms. Admin order payment history reads sanitized failed/manual webhook issues from this table.
3. **Queue level**: Cloudflare Queue retries with ack/retry per message (30s delay on normal payment retry). With `max_retries = 3`, payment webhook rows stay `queued` through transient failures and are marked failed only on the fourth delivery attempt. If Cloudflare moves a payment message to `payment-events-dlq`, the DLQ consumer records evidence and retries only the evidence write (`300s` delay); it never auto-replays payment side effects.
4. **processPaymentConfirmed() level**: Checks for existing `orderPayments` by gateway-specific ID (Stripe payment intent, SSLCommerz validation id with transaction-id fallback for legacy failed attempts, Polar checkout id) before any writes. Also checks `paymentStatus === PAID` to short-circuit fully-paid orders. When a provider success is applied, the order summary `paymentMethod` is updated to the gateway that actually captured the payment; `orderPayments` remains the detailed audit ledger.

COD collection (`recordCODCollection()`) has its own idempotency: queries for existing succeeded payment with `paymentMethod: "cod"`.

### State Machine Validation

Before any writes, `processPaymentConfirmed()` calls `validateTransition()` for both order status and payment status transitions. Invalid transitions throw errors.

- Order: `incomplete -> pending` (on first payment)
- Payment: `unpaid -> partial` or `unpaid -> paid` (depending on whether balance reaches zero)

Failed or abandoned hosted-payment orders are not force-cancelled in webhook handlers. The scheduled API maintenance path calls `archiveStaleIncompleteOrders()` after the 60-minute grace period; it skips active payment/session/shipment claims, releases inventory through the normal order transition helper, conditionally cancels pending payment plans only after order finalization wins, archives the abandoned-checkout snapshot, and invalidates affected product availability caches.

### Public Session Policy

Public Stripe, SSLCommerz, and Polar checkout session routes require the order receipt token before gateway settings/provider calls. The API validates the token against the stored `order_receipt:{sha256(token)}` proof or D1 checkout-attempt fallback, but receipt proof validation repairs the KV receipt hint only for committed attempts and never stores raw receipt proof in KV keys; the shared session creator remains the order/payment authority before provider work. The API rejects non-payable orders, derives trusted callback URLs from runtime config, ignores caller currency, derives payment type/amount from order state and fresh checkout settings, and keeps public Stripe sessions on automatic capture. Authenticated customer-account recovery uses the same shared session creator but swaps the proof to `{ kind: "customer_account" }`, requires the order to belong to the signed-in `customerId`, accepts a strict empty body, and returns hosted gateways to `/account/orders/{id}` instead of `/order-success`. Receipt-token recovery may switch failed unpaid online orders between SSLCommerz and Polar, but the switch happens only after the target gateway survives the current checkout allowlist/settings/policy checks and before provider work starts. The switch also requires current-gateway failed evidence, rejects pending/confirmed/succeeded payment evidence, refuses active setup leases, and uses an order-version CAS with the same evidence predicates. Account-owned recovery intentionally does not switch gateways because the private order page is a pay-balance/current-gateway flow, not a public receipt repair flow. Both paths first read raw `payment_methods.enabled_methods` plus `siteSettings.checkoutMode`/partial-payment fields, then fresh-read only the selected target gateway credentials with `FRESH_GATEWAY_SETTINGS_READ_OPTIONS`; this blocks stale checkout tabs or account pages from creating new external sessions after a merchant disables/rotates a gateway or switches to Fast COD Only without reading unrelated gateway credentials. Full storefront checkout config still uses `getActivePaymentMethods()` because it must evaluate every selected buyer-visible method. Customer order-detail `paymentRecovery` previews may pass the already-loaded customer-owned order header into the recovery helper to avoid a second order read, but payment-session POSTs must still use request-local fresh authority. The account-owned POST path uses `createCustomerAccountPaymentSession()` so it loads the order once, derives the gateway/balance intent once, and then reuses the same internal provider-session creation code. After those checks and before the provider call, routes claim `payment_session_attempts`; created attempts replay only for the same proof/return-target context, while live processing attempts for the same order/gateway/payment type return `202 processing` with `Retry-After`/`no-store` instead of double-creating gateway sessions. Exact duplicate attempts with a fresh processing lease return from the first selected row and do not issue a reclaim update or second state read.

### Partial Payments (Deposit/Balance)

Payment types: `full`, `deposit`, `balance`.

- **Deposit flow**: API route requires partial payments to be enabled and the requested deposit to match the configured `siteSettings.partialPaymentAmount` for the order. It creates a `paymentPlans` record, creates intent/session for the server-derived deposit amount only, and `processPaymentConfirmed()` sets payment plan status to `deposit_paid`.
- **Full payment under partial mode**: When partial payment is enabled and the configured deposit is positive and below the order total, public session routes reject caller-selected `full` payments; buyers must start with the server-derived deposit.
- **Balance flow**: API route computes `balanceDue` from order, creates intent/session for remaining amount. `processPaymentConfirmed()` sets payment plan status to `completed` when balance reaches zero.
- **Storefront**: When `partialPaymentEnabled` is true in checkout config, COD is hidden and button labels change to "Pay Advance via {gateway}". Advance amount is `min(partialPaymentAmount, totalAmount)`.

### Payment State Arithmetic

`payment-state.ts` is the single authority for order-level `paidAmount`, `balanceDue`, and `paymentStatus` arithmetic. Payment confirmations, COD collection, admin manual order create/edit, admin refunds, and Polar refund webhooks should call it instead of recomputing totals inline.

Admin-created manual orders are unpaid by definition, so they must insert `paidAmount = 0`, `balanceDue = totalAmount`, and `paymentStatus = unpaid`. Admin order edits recalculate balance from the new total and existing paid amount, preserving terminal `failed`/`refunded` payment statuses while still refreshing `balanceDue`.

COD collection validates against computed outstanding balance when a stored `balanceDue` is stale, so old/manual orders with an incorrect zero balance do not block legitimate courier collection.

### Refund Flow

`processRefund()` in `refund-service.ts`:

1. Validates: order exists, has payments, not already fully refunded
2. Validates amount: positive, does not exceed current `paidAmount`
3. Loads all successful source payments newest-first, subtracts previous refunded rows by `metadata.sourcePaymentId` (with old unattributed rows applied newest-first), and allocates the requested refund across the remaining capacity. `params.gateway` filters eligible source payments and fails closed if that gateway cannot cover the request.
4. Claims one pending `orderPayments` refund row and one `refundAttempts` ledger row per allocation in the same local claim batch. Each payment row stores `sourcePaymentId`, `sourcePaymentType`, `refundGroupId`, `allocationIndex`, provider idempotency/reference metadata, and source transaction details in `metadata`; each attempt row stores normalized operation identity for duplicate blocking, probing, and admin recovery.
5. Dispatches each allocation to its source gateway after fresh-reading gateway settings with `FRESH_GATEWAY_SETTINGS_READ_OPTIONS`. Stripe always receives an explicit smallest-unit amount for each source charge; SSLCommerz receives a deterministic `refund_trans_id`; Polar receives a per-source amount using that source payment metadata for currency conversion; COD returns an operational marker only. Online-gateway calls run behind a bounded provider deadline.
6. Moves `refundAttempts` through `pending` -> `processing`; marks provider-successful allocations `refunded` only after local order payment-state reconciliation succeeds; marks pre-provider/local failures `failed`; and marks ambiguous online-provider failures `provider_unknown`. If a provider accepted money movement but local order reconciliation loses a CAS or inventory/status step, the attempt becomes `reconcile_required` instead of returning a false clean success. Active attempt statuses block duplicate refund attempts until scheduled reconciliation or admin recovery resolves them.
7. Updates `orders.status` to `REFUNDED` (full refund) or `PARTIALLY_REFUNDED` (partial), subject to state machine validation via `canTransitionTo()`
8. On pre-fulfillment full refund: calls `applyInventoryForStatusChange(db, orderId, "cancelled")` to release inventory. Same-status retries repair already-cancelled, non-deducted orders; fulfilled/deducted refunds do NOT auto-restock inventory.

After local provider acceptance and order/payment finalization succeeds, `processRefund()` returns a private `refundNotification` fact for direct admin refunds. Full refunds use `order_refunded` with `refund:${orderId}:${refundGroupId}:full`; partial refunds use `order_partially_refunded` with `refund:${orderId}:${refundGroupId}:partial`. API routes enqueue those facts through the durable order-notification outbox and strip them from public responses.

If a split direct refund partially succeeds before a later allocation fails or has an unknown provider outcome, `processRefund()` throws `PartialRefundProcessedError` only after the accepted allocations have been reconciled locally. The error carries affected order IDs plus private notification facts from the committed finalizer and a group-deduped `refund_processing`/`refund_failed` fact for the unresolved remainder. Admin refund and return routes catch that specific error, invalidate affected availability caches, enqueue the carried facts through the durable outbox, then rethrow so operators still see the refund action needs review. Auto-refunded returns may also carry the committed `order_returned` status change on the same error so the buyer is not left without a return notification.

Polar dashboard/dispute refund webhooks are handled separately by `processPolarWebhookRefund()`. After the local CAS update or idempotent already-refunded check succeeds, it returns a private notification fact for the payment queue consumer. Full Polar refunds use `order_refunded` with `polar-refund:${orderId}:full`; partial Polar refunds use `order_partially_refunded` with `polar-refund:${orderId}:partial:${amountRefunded}:${totalAmount}:${currency}` so repeated cumulative webhooks dedupe while later larger partial refunds can notify again.

Stripe dashboard refunds stay audit-only in the webhook queue. `payment.stripe.refunded` marks the durable webhook row as `manual_reconciliation` with charge/refund evidence, and scheduled maintenance calls `reconcileStripeExternalRefundWebhooks()` to list provider refunds by charge, import each new succeeded refund into deterministic local `order_payments`/`refund_attempts` rows, and finalize through `finalizeAcceptedRefundAttemptIds()`. Buyer notifications are emitted only from those committed finalizer facts, never directly from the raw Stripe webhook.

Active refund attempts also block conflicting post-sale order mutations. Status updates, bulk/manual shipment creation, COD collection/return, admin order edits, trash/restore/delete flows, and shipment-driven order-status sync call the shared `refund-attempt-guard.ts` helper before changing order/payment/inventory state. COD failure logging remains allowed because it records delivery evidence only and does not collect money, return stock, or change order status.

Scheduled maintenance calls `reconcileDueRefundAttempts()` in small batches. `reconcile_required` attempts are finalized locally without another provider call. Expired `pending` attempts are failed as not dispatched and do not notify buyers because no provider-side refund was started. Expired `processing`/`provider_unknown` attempts probe Stripe by refund id or charge metadata, SSLCommerz by `refund_ref_id`, and Polar by refund/order metadata; accepted proof finalizes the local order/payment/inventory state, rejected proof fails the refund row, and missing/uncertain proof releases the claim with a later `nextProbeAt`. Accepted reconciled attempts return private `order_refunded`/`order_partially_refunded` notification facts derived from the recomputed ledger state. Provider-pending probes return a group-deduped `refund_processing` fact, provider-rejected probes return a group-deduped `refund_failed` fact, and scheduled maintenance records all of them through the durable order-notification outbox after the local state change. Stripe and Polar refund creation now send the platform refund reference/idempotency metadata to make future no-response provider probes deterministic.

`refund-attempt-visibility.ts` is the only refund-attempt projection that admin/customer surfaces should use. Admin order detail and payment history expose sanitized refund attempts plus `activeRefundOperation` so operators can see why status, COD, shipment, fulfillment, edit, and refund actions are locked during recovery. Admin order lists may expose only the compact active-refund lock summary, not the raw attempt rows or provider/debug evidence, so bulk delete/shipment/status controls can fail closed before operators hit API rejections. Customer order detail maps internal statuses such as `provider_unknown` and `reconcile_required` to buyer-safe progress states and timeline copy; it must not expose provider payloads, request hashes, idempotency keys, claim state, raw metadata, or raw gateway error names.

Returns do not run through the refund orchestrator. Item request, approval,
warehouse receipt/disposition, and receipt recovery live in the orders module;
refund timing remains an independent merchant action.

### Gateway Settings Storage

All gateway credentials are stored in the `settings` DB table with a `category` column:

| Category | Keys |
|----------|------|
| `stripe` | `secret_key`, `publishable_key`, `webhook_secret`, `enabled` |
| `sslcommerz` | `store_id`, `store_password`, `sandbox`, `enabled` |
| `polar` | `access_token`, `webhook_secret`, `product_id`, `sandbox`, `enabled` |
| `payment_methods` | `enabled_methods` (JSON array), `default_method` |

Settings are cached in memory only (`gw:stripe`, `gw:sslcommerz`, `gw:polar`, `gw:payment_methods` are in-memory cache keys, not persistent credential storage). New Stripe, SSLCommerz, and Polar secret writes require `CREDENTIAL_ENCRYPTION_KEY`, store `enc:`-prefixed AES-GCM values, and fail before settings writes or cache invalidation if the dedicated key is missing. Gateway runtime/readiness reads use strict credential resolution: legacy plaintext remains readable, old bare AES-GCM rows remain readable with the dedicated key, but missing/wrong credential keys return explicit readiness errors and never count ciphertext as configured. Checkout readiness is provider-specific: Stripe requires provider enabled + secret key + publishable key + webhook secret; SSLCommerz requires provider enabled + store ID + store password; Polar requires provider enabled + access token + product ID + webhook secret. Admin save operations clear the specific gateway cache, clear the payment methods cache, best-effort delete any legacy KV entries with the same keys, invalidate API checkout config cache (`api:checkout:config:` plus legacy `v2` and current `v3` prefixes), and purge storefront checkout prefixes. Public checkout config assembly, public session creation, webhook auth/IPN validation, admin payment-method status reads, and refund dispatch pass `FRESH_GATEWAY_SETTINGS_READ_OPTIONS` / `bypassMemoryCache: true` plus the dedicated `CREDENTIAL_ENCRYPTION_KEY` to gateway reads because these provider-boundary decisions must honor recent merchant settings across warm Cloudflare Worker isolates. Public payment-session creation intentionally resolves the selected payment-method preference separately and reads only the target gateway settings, while checkout config/status surfaces may use `getActivePaymentMethods()` to evaluate the whole buyer-visible method list.

### Gateway Registry

`gateway-settings.ts` side-effect registers all 4 gateways on import:

- Each registration includes: `id`, `name`, `settingsCategory`, `getSettings()` (async DB lookup), `getPublicConfig()` (safe fields to expose), `getCurrencies()` (supported currencies)
- `checkout.ts` route imports `gateway-settings.ts` for the side-effect, reads `payment_methods.enabled_methods` as the outer allowlist, then calls `getRegisteredGateways()` to dynamically build the checkout config response. Online gateway registry `getSettings()` functions return `null` unless the gateway is checkout-usable, so future registry callers inherit the same fail-closed behavior.
- `checkoutMode` controls gateway visibility and backend order/session policy: `all` (show everything), `gateways_only` (hide/reject COD), `guest_cod_only` (hide/reject online gateways)

### Checkout Config Response

The `GET /checkout/config` endpoint returns:
- `gateways[]` -- buyer-visible gateways after raw allowlist, provider readiness, checkout mode, and partial-payment filtering, with public config only (publishable key for Stripe, provider-neutral `testMode`, and the transitional `sandbox` flag for SSLCommerz/Polar)
- `currency` -- `{ code, symbol, decimalPlaces }` using `getDecimalPlaces()` for ISO 4217 lookup
- `allowedCountries` + `allowedCountriesMode` -- phone number country restrictions (include/exclude list)
- `guestCheckoutEnabled`, `authVerificationMethod`, `checkoutMode`, `partialPaymentEnabled`, `partialPaymentAmount`
- Cached 60 seconds via `cacheMiddleware` under `api:checkout:config:v3:`
- On assembly/read error: returns a non-cacheable `503 CHECKOUT_CONFIG_UNAVAILABLE`; the storefront fails closed with a temporary checkout-unavailable state instead of guessing COD availability

### Storefront Proxy Pattern

Storefront SSR pages at `apps/storefront/src/pages/api/checkout/` act as proxies:

1. Browser calls storefront proxy (e.g., `POST /api/checkout/stripe-intent`) after order creation returns a committed `orderId` and receipt proof
2. Proxy calls API worker via service binding (e.g., `POST /payment/stripe/intent`) using the server-side `API_TOKEN`
3. Proxy unwraps the `{success, data}` envelope before returning to browser
4. Browser receives flat response (e.g., `{clientSecret, paymentIntentId, ...}`)

This keeps the API_TOKEN server-side and handles the envelope unwrapping for checkout page consumers.

### Storefront Client-Side Gateway Handler Registry

Mirrors the server-side pattern. `apps/storefront/src/lib/checkout/` has:

- A `GatewayHandler` interface with `id`, `meta` (label/icon/desc), `getButtonText()`, optional `onSelect()`, and `processPayment()`
- A `registry.ts` with `registerGateway()` / `getGateway()`
- Handler implementations per gateway that each: call `createOrder()`, then call their respective proxy endpoint, then either redirect (SSLCommerz/Polar) or confirm client-side (Stripe)
- All handlers are registered in `index.ts` on import

Normal checkout order creation does not request an attached `initialPaymentSession`; this keeps the authoritative order commit response independent from provider latency. The same-origin create-order proxy keeps an explicit opt-in `initialPaymentSession: true` branch for covered diagnostics/experiments, but the default browser flow creates Stripe/SSLCommerz/Polar sessions through the gateway-specific proxies with only `orderId` and receipt proof. API payment-session routes must await the durable `payment_session_attempts` created row before returning, while scheduling only the best-effort `orders.paymentIntentId` recovery hint through `executionCtx.waitUntil()` when available. Gateway-specific storefront proxies preserve API `202 processing` responses instead of flattening them to `200`; hosted checkout handlers send already-committed orders to receipt recovery, Stripe stays on checkout with retryable copy, account recovery shows the same processing message without treating it as a usable session, and hosted retry payloads no longer include a retry key that can fragment durable replay. The receipt page fetches fresh checkout config before rendering retry buttons: callback-only fail/cancel returns expose only the current hosted gateway, while durable payment-issue states can offer currently visible alternate hosted gateways. Stripe sends the D1 attempt key as the provider idempotency key, SSLCommerz derives a deterministic `tran_id` from it, and Polar stores it in checkout metadata; reclaimed Polar attempts must query recent open Polar checkouts by product/customer filter and exact metadata before creating another checkout.

## API Endpoints Summary

### Public (storefront-facing, no admin auth)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/v1/checkout/config` | Checkout configuration (cached 60s) |
| `POST` | `/api/v1/payment/stripe/intent` | Create Stripe PaymentIntent |
| `POST` | `/api/v1/payment/sslcommerz/session` | Create SSLCommerz session |
| `POST` | `/api/v1/payment/polar/session` | Create Polar checkout session |
| `GET` | `/api/v1/customer-auth/orders/{id}` | Private customer order detail with `paymentRecovery` preview |
| `POST` | `/api/v1/customer-auth/orders/{id}/payment-session` | Private customer-owned retry/pay-balance session creation |

### Redirect handlers (called by gateways, not consumers)

| Method | Path | Purpose |
|--------|------|---------|
| `POST/GET` | `/api/v1/payment/sslcommerz/success` | SSLCommerz success redirect |
| `POST/GET` | `/api/v1/payment/sslcommerz/fail` | SSLCommerz failure redirect |
| `POST/GET` | `/api/v1/payment/sslcommerz/cancel` | SSLCommerz cancel redirect |
| `GET` | `/api/v1/payment/polar/success` | Polar success redirect |
| `GET` | `/api/v1/payment/polar/cancel` | Polar cancel redirect |

### Webhooks (signature verification IS the auth)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/v1/webhooks/stripe` | Stripe webhook receiver |
| `POST` | `/api/v1/webhooks/sslcommerz` | SSLCommerz IPN receiver |
| `POST` | `/api/v1/webhooks/polar` | Polar webhook receiver |

### Admin (requires admin auth)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/v1/admin/settings/payment-methods` | Get enabled methods + gateway status |
| `POST` | `/api/v1/admin/settings/payment-methods` | Save enabled methods + default |
| `GET` | `/api/v1/admin/settings/stripe` | Get Stripe settings (secrets masked) |
| `POST` | `/api/v1/admin/settings/stripe` | Save Stripe settings |
| `GET` | `/api/v1/admin/settings/sslcommerz` | Get SSLCommerz settings (password masked) |
| `POST` | `/api/v1/admin/settings/sslcommerz` | Save SSLCommerz settings |
| `GET` | `/api/v1/admin/settings/polar` | Get Polar settings (token/secret masked) |
| `POST` | `/api/v1/admin/settings/polar` | Save Polar settings |

## Dependencies

- `stripe` -- Stripe SDK v17+ (Web Fetch API native)
- `@polar-sh/sdk` -- Polar SDK
- `standardwebhooks` -- Polar webhook signature verification
- `@scalius/database` -- `orders`, `orderItems`, `orderPayments`, `paymentPlans`, `codTracking`, `webhookEvents`, `settings`, `siteSettings` tables
- `@scalius/core/errors` -- `ValidationError`, `ServiceUnavailableError`, `NotFoundError`, `ConflictError`
- `@scalius/core/modules/payments/order-currency` -- immutable order currency/precision resolution, ledger-currency assertions, and snapshot-aware rounding
- `@scalius/core/modules/inventory/release` -- `releaseMultiple()` for inventory release on cancel/refund
- `@scalius/core/modules/inventory/inventory-transitions` -- `buildInventoryStatements()`, `applyInventoryForStatusChange()`
- `@scalius/core/modules/orders/order-state-machine` -- `validateTransition()` for state machine checks
- `@scalius/shared/price-utils` -- precision-aware currency.js arithmetic used behind the order-currency boundary
- `@scalius/shared/currency` -- supported ISO currency normalization and decimal lookup (used by order snapshots, route-layer provider conversions, SSLCommerz formatting, and checkout config)

## Known Gaps

1. **Stripe `charge.refunded` queue message**: Exists in the queue consumer but is audit-only at webhook time. External/dashboard refunds are imported later by scheduled reconciliation before any order state change or buyer notification.
2. **SSLCommerz refund IP whitelisting**: Production refunds require the server's public IP to be registered with SSLCommerz. Sandbox works without this.
3. **COD refund**: `CODProvider.createRefund()` returns a marker ID only. Actual cash refund is a manual operational process.
4. **No capture endpoint exposed**: `capturePaymentIntent()` and `cancelPaymentIntent()` exist in `stripe.ts` but have no API route. They would need to be called from an admin fulfillment flow.
5. **Factory not used by API routes**: API routes call legacy wrapper functions (`createPaymentIntent()`, `initSSLCommerzSession()`, etc.) directly rather than going through `createPaymentProvider()` factory. The factory/provider pattern is implemented but not yet the primary code path for session creation.
6. **SSLCommerz refund amount hardcoded to 2 decimals**: `initiateSSLCommerzRefund()` uses `toFixed(2)` for the refund amount because the currency is not passed to the refund function and SSLCommerz only supports BDT refunds (which has 2 decimals).
