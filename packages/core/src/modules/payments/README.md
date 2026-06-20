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
| `stripe.ts` | `StripeProvider` class, `createPaymentIntent()`, `capturePaymentIntent()`, `cancelPaymentIntent()`, `createRefund()`, `verifyStripeWebhook()`, `getStripe()` | Stripe SDK wrapper; module-level singleton with key rotation detection |
| `sslcommerz.ts` | `SSLCommerzProvider` class, `initSSLCommerzSession()`, `validateSSLCommerzIPN()`, `validateSSLCommerzPayment()`, `initiateSSLCommerzRefund()`, `querySSLCommerzRefundStatus()` | SSLCommerz REST API wrapper; no SDK, uses native `fetch`; sandbox/production URL switching. Uses `getDecimalPlaces()` for ISO 4217-aware amount formatting. |
| `polar.ts` | `PolarProvider` class, `createPolarCheckout()`, `createPolarRefund()`, `verifyPolarWebhook()` | Polar SDK wrapper; uses `@polar-sh/sdk` + `standardwebhooks` for signature verification |
| `cod.ts` | `CODProvider` class, `initCODTracking()`, `recordCODCollection()`, `recordCODFailure()`, `markCODReturned()` | Cash on Delivery tracking; DB-only operations, no external gateway |
| `process-payment.ts` | `processPaymentConfirmed()`, `processPaymentFailed()`, `releaseOrderInventory()`, `recordWebhookEvent()` | Shared post-payment business logic called by queue consumer |
| `refund-service.ts` | `processRefund()`, `processReturn()` | Gateway-agnostic refund orchestrator; detects gateway from payment records, validates cumulative refund amounts |
| `payment-session-attempts.ts` | `buildPaymentSessionAttemptIdentity()`, `claimPaymentSessionAttempt()`, created/failed markers | Durable D1 idempotency for Stripe/SSLCommerz/Polar session creation across receipt-token checkout recovery and customer-account post-sale recovery |
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
| `paymentPlans` | Partial payment tracking. `orderId` (unique), `totalAmount`, `depositAmount`, `balanceDue`, `depositPaidAt`, `balancePaidAt`, `status` (pending/deposit_paid/completed/cancelled) |
| `codTracking` | COD-specific tracking. `orderId` (unique), `deliveryAttempts`, `lastAttemptAt`, `codStatus` (pending/collected/failed/returned), `failureReason`, `collectedBy`, `collectedAmount`, `collectedAt`, `receiptUrl` |
| `webhookEvents` | Webhook event log for auditing. `provider`, `eventType`, `orderId`, `status` (processed/failed), `result` |

### Enums (`packages/database/src/schema/enums.ts`)

- `PaymentMethod`: `stripe | sslcommerz | polar | cod`
- `PaymentStatus`: `unpaid | partial | paid | refunded | failed`
- `OrderStatus`: includes `incomplete` (pre-payment) and `pending` (post-payment)

### Queue Consumer (`apps/api/src/queue-consumer.ts`)

Dispatches `PaymentQueueMessage` types:

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
| `payment.polar.refunded` | `processPolarWebhookRefund()` | CAS-updates payment and allowed order status transitions; releases inventory on pre-fulfillment full refund |

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
- **Refund**: `createRefund()` refunds by charge ID; supports partial amount and reason codes (`duplicate`, `fraudulent`, `requested_by_customer`)
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
- **Refund**: `initiateSSLCommerzRefund()` uses `bank_tran_id` (from original payment). Refund amount formatted with `toFixed(2)` (SSLCommerz only supports BDT for refunds). Production requires IP whitelisting. `querySSLCommerzRefundStatus()` checks refund progress (refunded/processing/cancelled).
- **Settings**: `store_id`, `store_password`, `sandbox`, `enabled` (stored in `settings` table, category `sslcommerz`)

### Polar

- **SDK**: `@polar-sh/sdk` (`Polar` class) + `standardwebhooks` (`Webhook` class for signature verification)
- **Client singleton**: Module-level `_cachedClient` keyed by access token and sandbox/production server so credential or environment rotation takes effect in warm isolates
- **Session creation**: `createPolarCheckout()` uses ad-hoc pricing -- a Polar Product must exist but the actual amount is set per-checkout via `prices` override. Returns `checkoutUrl` (redirect) + `checkoutId`, and forwards trusted success/cancel URLs from the API route.
- **Webhook verification**: `verifyPolarWebhook()` base64-encodes the webhook secret before passing to `standardwebhooks`. Synchronous verification (not async).
- **Webhook events handled**: `checkout.updated` (status failed/expired -> enqueue failed), `order.paid` (enqueue confirmed), `order.refunded` (enqueue refund -> update payment and allowed order status + pre-fulfillment inventory)
- **Replay protection**: Durable `webhook_events` claim before queueing
- **Refund**: `createPolarRefund()` refunds by Polar order ID. Reason codes: `fraudulent`, `customer_request`, `duplicate`, `other`, `service_disruption`, `satisfaction_guarantee`, `dispute_prevention`.
- **Settings**: `access_token`, `webhook_secret`, `product_id`, `sandbox`, `enabled` (stored in `settings` table, category `polar`)
- **Currency**: Amount in smallest currency unit. API route converts via `getDecimalPlaces(currency)`: `amount * Math.pow(10, decimals)`. Queue consumer reverses: `amount / Math.pow(10, decimals)`.

### COD (Cash on Delivery)

- **No external gateway**: All operations are DB-only
- **Tracking lifecycle**: `pending` -> `collected` (success) or `failed` (delivery attempt failed) -> `returned` (all attempts exhausted)
- **`initCODTracking()`**: Creates a `codTracking` record with `deliveryAttempts: 0`, `codStatus: "pending"`
- **`recordCODCollection()`**: Idempotent (checks for existing succeeded payment). Atomically via `db.batch()`: updates `codTracking` (collected status + details), inserts `orderPayments` (status: succeeded), updates `orders` (paymentStatus: PAID, paidAmount, balanceDue: 0). Fetches `getCurrencyConfig()` for currency code before batch.
- **`recordCODFailure()`**: Increments `deliveryAttempts`, sets `codStatus: "failed"`, records `failureReason` (not_home/refused/no_cash/wrong_address/other)
- **`markCODReturned()`**: Sets `codStatus: "returned"`
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

Uses `roundPrice()` and `pricesEqual()` from `@scalius/shared/price-utils` for float-safe balance calculations.

### Idempotency

Four layers of duplicate prevention:

1. **Session creation level**: Public Stripe, SSLCommerz, and Polar routes claim `payment_session_attempts` before provider calls using a canonical key derived from order id, receipt token hash, gateway, payment type, server-derived amount/currency, and route-owned callback/customer context. Created attempts store the replay payload (`clientSecret`/redirect URL/session id) so identical retries return the original session without touching the provider again. In-flight attempts return a conflict instead of creating a duplicate. Failed attempts are reclaimable. Stripe also receives the same durable attempt key as its provider idempotency key.
2. **Webhook level**: Durable `webhook_events` claims prevent re-enqueuing the same payment webhook before side effects. Queue failures mark the event `failed` so provider retries can reclaim it. Fresh `processing` claims dedupe in-flight work, while stale `processing` claims are lease-reclaimable so isolate failures before queue send do not black-hole provider retries.
3. **Queue level**: Cloudflare Queue retries with ack/retry per message (30s delay on retry)
4. **processPaymentConfirmed() level**: Checks for existing `orderPayments` by gateway-specific ID (Stripe payment intent, SSLCommerz validation id with transaction-id fallback for legacy failed attempts, Polar checkout id) before any writes. Also checks `paymentStatus === PAID` to short-circuit fully-paid orders.

COD collection (`recordCODCollection()`) has its own idempotency: queries for existing succeeded payment with `paymentMethod: "cod"`.

### State Machine Validation

Before any writes, `processPaymentConfirmed()` calls `validateTransition()` for both order status and payment status transitions. Invalid transitions throw errors.

- Order: `incomplete -> pending` (on first payment)
- Payment: `unpaid -> partial` or `unpaid -> paid` (depending on whether balance reaches zero)

Failed or abandoned hosted-payment orders are not force-cancelled in webhook handlers. The scheduled API maintenance path calls `archiveStaleIncompleteOrders()` after the 60-minute grace period; it skips active payment/session/shipment claims, releases inventory through the normal order transition helper, conditionally cancels pending payment plans only after order finalization wins, archives the abandoned-checkout snapshot, and invalidates affected product availability caches.

### Public Session Policy

Public Stripe, SSLCommerz, and Polar checkout session routes require the order receipt token before gateway settings/provider calls. The API validates the token against the stored `order_receipt:{token}` proof, rejects non-payable orders, derives trusted callback URLs from runtime config, ignores caller currency, derives payment type/amount from order state and fresh checkout settings, and keeps public Stripe sessions on automatic capture. Authenticated customer-account recovery uses the same shared session creator but swaps the proof to `{ kind: "customer_account" }`, requires the order to belong to the signed-in `customerId`, accepts a strict empty body, and returns hosted gateways to `/account/orders/{id}` instead of `/order-success`. Both paths fresh-read `payment_methods.enabled_methods`, `siteSettings.checkoutMode`/partial-payment fields, and gateway credentials with `FRESH_GATEWAY_SETTINGS_READ_OPTIONS`; this blocks stale checkout tabs or account pages from creating new external sessions after a merchant disables/rotates a gateway or switches to Fast COD Only. After those checks and before the provider call, routes claim `payment_session_attempts`; created attempts replay the original response, and concurrent processing attempts fail fast instead of double-creating gateway sessions.

### Partial Payments (Deposit/Balance)

Payment types: `full`, `deposit`, `balance`.

- **Deposit flow**: API route requires partial payments to be enabled and the requested deposit to match the configured `siteSettings.partialPaymentAmount` for the order. It creates a `paymentPlans` record, creates intent/session for the server-derived deposit amount only, and `processPaymentConfirmed()` sets payment plan status to `deposit_paid`.
- **Full payment under partial mode**: When partial payment is enabled and the configured deposit is positive and below the order total, public session routes reject caller-selected `full` payments; buyers must start with the server-derived deposit.
- **Balance flow**: API route computes `balanceDue` from order, creates intent/session for remaining amount. `processPaymentConfirmed()` sets payment plan status to `completed` when balance reaches zero.
- **Storefront**: When `partialPaymentEnabled` is true in checkout config, COD is hidden and button labels change to "Pay Advance via {gateway}". Advance amount is `min(partialPaymentAmount, totalAmount)`.

### Refund Flow

`processRefund()` in `refund-service.ts`:

1. Validates: order exists, has payments, not already fully refunded
2. Validates amount: positive, does not exceed `paidAmount`, cumulative refunds (existing refunded `orderPayments` + new) do not exceed `paidAmount`
3. Finds latest successful payment record to determine gateway
4. Dispatches to gateway-specific refund API after fresh-reading gateway settings with `FRESH_GATEWAY_SETTINGS_READ_OPTIONS` (Stripe: by charge ID with `Math.round(refundAmount * 100)`; SSLCommerz: by bank_tran_id; Polar: by checkout ID with `Math.round(refundAmount * 100)`; COD: marker ID only). If fresh settings are missing/unavailable after the local refund claim, the claim is released and the prior order payment state is restored before the error surfaces.
5. Updates `orders.paidAmount` (subtracts refund) and `orders.paymentStatus` (REFUNDED for full, PARTIAL for partial)
6. Updates `orders.status` to `REFUNDED` (full refund) or `PARTIALLY_REFUNDED` (partial), subject to state machine validation via `canTransitionTo()`
7. On pre-fulfillment full refund: calls `applyInventoryForStatusChange(db, orderId, "cancelled")` to release inventory. Same-status retries repair already-cancelled, non-deducted orders; fulfilled/deducted refunds do NOT auto-restock inventory.

`processReturn()`: Sets order status to `RETURNED`, restores inventory via `applyInventoryForStatusChange()`, optionally triggers auto-refund. Orders in `delivered`, `completed`, or `shipped` status can be returned; an already-`returned` retry is accepted only to resume inventory reconciliation and optional auto-refund.

### Gateway Settings Storage

All gateway credentials are stored in the `settings` DB table with a `category` column:

| Category | Keys |
|----------|------|
| `stripe` | `secret_key`, `publishable_key`, `webhook_secret`, `enabled` |
| `sslcommerz` | `store_id`, `store_password`, `sandbox`, `enabled` |
| `polar` | `access_token`, `webhook_secret`, `product_id`, `sandbox`, `enabled` |
| `payment_methods` | `enabled_methods` (JSON array), `default_method` |

Settings are cached in memory only (`gw:stripe`, `gw:sslcommerz`, `gw:polar`, `gw:payment_methods` are in-memory cache keys, not persistent credential storage). New Stripe, SSLCommerz, and Polar secret writes require `CREDENTIAL_ENCRYPTION_KEY`, store `enc:`-prefixed AES-GCM values, and fail before settings writes or cache invalidation if the dedicated key is missing. Gateway runtime/readiness reads use strict credential resolution: legacy plaintext remains readable, old bare AES-GCM rows remain readable with the dedicated key, but missing/wrong credential keys return explicit readiness errors and never count ciphertext as configured. Checkout readiness is provider-specific: Stripe requires provider enabled + secret key + publishable key + webhook secret; SSLCommerz requires provider enabled + store ID + store password; Polar requires provider enabled + access token + product ID + webhook secret. Admin save operations clear the specific gateway cache, clear the payment methods cache, best-effort delete any legacy KV entries with the same keys, invalidate API checkout config cache (`api:checkout:config:` and the current `api:checkout:config:v2:` prefix), and purge storefront checkout prefixes. Public checkout config assembly, public session creation, webhook auth/IPN validation, admin payment-method status reads, and refund dispatch pass `FRESH_GATEWAY_SETTINGS_READ_OPTIONS` / `bypassMemoryCache: true` plus the dedicated `CREDENTIAL_ENCRYPTION_KEY` to payment-method and gateway reads because these provider-boundary decisions must honor recent merchant settings across warm Cloudflare Worker isolates.

### Gateway Registry

`gateway-settings.ts` side-effect registers all 4 gateways on import:

- Each registration includes: `id`, `name`, `settingsCategory`, `getSettings()` (async DB lookup), `getPublicConfig()` (safe fields to expose), `getCurrencies()` (supported currencies)
- `checkout.ts` route imports `gateway-settings.ts` for the side-effect, reads `payment_methods.enabled_methods` as the outer allowlist, then calls `getRegisteredGateways()` to dynamically build the checkout config response. Online gateway registry `getSettings()` functions return `null` unless the gateway is checkout-usable, so future registry callers inherit the same fail-closed behavior.
- `checkoutMode` controls gateway visibility and backend order/session policy: `all` (show everything), `gateways_only` (hide/reject COD), `guest_cod_only` (hide/reject online gateways)

### Checkout Config Response

The `GET /checkout/config` endpoint returns:
- `gateways[]` -- buyer-visible gateways after raw allowlist, provider readiness, checkout mode, and partial-payment filtering, with public config only (publishableKey for Stripe, sandbox flag for SSLCommerz/Polar)
- `currency` -- `{ code, symbol, decimalPlaces }` using `getDecimalPlaces()` for ISO 4217 lookup
- `allowedCountries` + `allowedCountriesMode` -- phone number country restrictions (include/exclude list)
- `guestCheckoutEnabled`, `authVerificationMethod`, `checkoutMode`, `partialPaymentEnabled`, `partialPaymentAmount`
- Cached 60 seconds via `cacheMiddleware` under `api:checkout:config:v2:`
- On assembly/read error: returns a non-cacheable `503 CHECKOUT_CONFIG_UNAVAILABLE`; the storefront fails closed with a temporary checkout-unavailable state instead of guessing COD availability

### Storefront Proxy Pattern

Storefront SSR pages at `apps/storefront/src/pages/api/checkout/` act as proxies:

1. Browser calls storefront proxy (e.g., `POST /api/checkout/stripe-intent`)
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
- `@scalius/core/modules/settings/settings.service` -- `getCurrencyConfig()` for currency code
- `@scalius/core/modules/inventory/release` -- `releaseMultiple()` for inventory release on cancel/refund
- `@scalius/core/modules/inventory/inventory-transitions` -- `buildInventoryStatements()`, `applyInventoryForStatusChange()`
- `@scalius/core/modules/orders/order-state-machine` -- `validateTransition()` for state machine checks
- `@scalius/shared/price-utils` -- `roundPrice()`, `pricesEqual()` for float-safe comparisons
- `@scalius/shared/currency` -- `getDecimalPlaces()` for ISO 4217 decimal lookup (used by route-layer amount conversions, SSLCommerz session formatting, and checkout config response)

## Known Gaps

1. **Stripe `charge.refunded` queue message**: Exists in the queue consumer but is audit-only (no DB mutation). Refunds are handled synchronously via the admin refund endpoint.
2. **SSLCommerz refund IP whitelisting**: Production refunds require the server's public IP to be registered with SSLCommerz. Sandbox works without this.
3. **COD refund**: `CODProvider.createRefund()` returns a marker ID only. Actual cash refund is a manual operational process.
4. **No capture endpoint exposed**: `capturePaymentIntent()` and `cancelPaymentIntent()` exist in `stripe.ts` but have no API route. They would need to be called from an admin fulfillment flow.
5. **Factory not used by API routes**: API routes call legacy wrapper functions (`createPaymentIntent()`, `initSSLCommerzSession()`, etc.) directly rather than going through `createPaymentProvider()` factory. The factory/provider pattern is implemented but not yet the primary code path for session creation.
6. **SSLCommerz refund amount hardcoded to 2 decimals**: `initiateSSLCommerzRefund()` uses `toFixed(2)` for the refund amount because the currency is not passed to the refund function and SSLCommerz only supports BDT refunds (which has 2 decimals).
