# Audit 08 — Payments Domain

## Overview

The payments domain handles multi-gateway payment processing (Stripe, SSLCommerz, Polar, COD) across a Cloudflare Worker stack with D1/SQLite. It covers session creation, webhook processing, refund orchestration, and admin configuration. Payment events flow through Cloudflare Queues for resilience.

**Files reviewed:**

| File | Purpose |
|------|---------|
| `packages/core/src/modules/payments/provider.ts` | PaymentProvider interface |
| `packages/core/src/modules/payments/types.ts` | Domain types and gateway-specific params |
| `packages/core/src/modules/payments/factory.ts` | Factory function for provider instantiation |
| `packages/core/src/modules/payments/gateway-registry.ts` | Dynamic gateway registry |
| `packages/core/src/modules/payments/gateway-settings.ts` | Credential loading, KV caching, payment methods config |
| `packages/core/src/modules/payments/process-payment.ts` | Shared payment confirmation/failure/release logic |
| `packages/core/src/modules/payments/refund-service.ts` | Gateway-agnostic refund + return orchestrator |
| `packages/core/src/modules/payments/stripe.ts` | Stripe SDK wrapper + PaymentProvider impl |
| `packages/core/src/modules/payments/sslcommerz.ts` | SSLCommerz REST API wrapper + PaymentProvider impl |
| `packages/core/src/modules/payments/polar.ts` | Polar SDK wrapper + webhook refund handler |
| `packages/core/src/modules/payments/cod.ts` | Cash-on-delivery tracking + PaymentProvider impl |
| `packages/core/src/modules/payments/index.ts` | Barrel exports |
| `apps/api/src/routes/payment/stripe-routes.ts` | Stripe payment intent API route |
| `apps/api/src/routes/payment/sslcommerz-routes.ts` | SSLCommerz session API route + redirect handlers |
| `apps/api/src/routes/payment/polar-routes.ts` | Polar checkout session API route |
| `apps/api/src/routes/webhooks/stripe.ts` | Stripe webhook handler |
| `apps/api/src/routes/webhooks/sslcommerz.ts` | SSLCommerz IPN handler |
| `apps/api/src/routes/webhooks/polar.ts` | Polar webhook handler |
| `apps/api/src/routes/admin/settings/payments.ts` | Admin gateway settings CRUD |
| `apps/api/src/queue-consumer.ts` | Queue message dispatcher |
| `packages/database/src/schema/orders.ts` | Payment-related DB tables |

---

## Architecture Summary

```
Storefront/Admin
    |
    v
API Routes (session creation, redirects)
    |
    v                              v
Gateway APIs                 Webhook Endpoints
(Stripe, SSLCommerz, Polar)    (signature verify)
                                   |
                                   v
                             Cloudflare Queue
                                   |
                                   v
                             Queue Consumer
                                   |
                                   v
                          processPaymentConfirmed()
                          (atomic batch: payment + order + inventory)
```

**Key flow:** Webhooks are verified, then enqueued into `PAYMENT_EVENTS_QUEUE`. The queue consumer calls `processPaymentConfirmed()` which atomically records the payment, updates the order, and adjusts inventory in a single D1 batch.

---

## 1. Provider Interface

**Grade: A-**

The `PaymentProvider` interface in `provider.ts` is clean and well-designed:

```typescript
interface PaymentProvider {
  readonly type: PaymentGateway;
  readonly name: string;
  createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult>;
  createRefund(params: RefundParams): Promise<RefundResult>;
  verifyWebhook?(rawBody: string, headers: Record<string, string>): Promise<WebhookPayload>;
}
```

**Strengths:**
- `verifyWebhook` is optional (COD has no webhooks) -- correct modeling
- `CreatePaymentResult` uses a union-like shape (`clientSecret` for Stripe, `redirectUrl` for redirect-based gateways) that works naturally
- All four providers implement the interface consistently
- The `type` property is narrowed to literal types (`"stripe" as const`) on each implementation

**Issues:**

- (P3) `CreatePaymentParams` has SSLCommerz-specific fields (`successUrl`, `failUrl`, `cancelUrl`, `ipnUrl`, `customerName`, `customerPhone`, etc.) at the top level. This works but makes the interface feel SSLCommerz-flavored. A more extensible approach would use `gatewayOptions?: Record<string, unknown>` or per-gateway param types, but the current flat approach avoids indirection and is pragmatically fine for 4 gateways.

---

## 2. Payment Processing (Atomicity & Idempotency)

**Grade: A**

`processPaymentConfirmed()` is the most critical function in the payment domain. It is well-hardened.

**Strengths:**

- **Idempotency gate BEFORE mutations:** Checks for existing `orderPayments` by provider-specific ID (`stripePaymentIntentId`, `sslcommerzTranId`, `polarCheckoutId`) before touching anything. This prevents double-processing on concurrent webhook delivery.
- **Atomic batch writes:** Payment insert + order update + inventory deduction all execute in a single `db.batch()`. The code explicitly comments on fixing the prior "split-write bug" where inventory could be left un-deducted.
- **State machine validation:** Calls `validateTransition()` for both order status and payment status before any writes -- prevents illegal state transitions.
- **Float precision:** Uses `roundPrice()` and `pricesEqual()` from `@scalius/shared/price-utils` to handle floating-point drift.
- **Already-paid guard:** Returns `{ success: true }` if `paymentStatus === PAID`, making the function safe to call multiple times.

**Queue architecture is resilient:**

- Webhook handlers verify signature, then immediately enqueue and return 200.
- Queue consumer processes asynchronously with Cloudflare's built-in retry (up to 3 retries, 30s backoff).
- Each message is independently acked/retried based on processing result.

**Issues:**

- (P2) **TOCTOU on idempotency check:** The duplicate payment check (lines 44-67 of `process-payment.ts`) reads `orderPayments` and then later inserts. Under concurrent webhook delivery, two workers could both pass the check before either inserts. D1's single-writer model mitigates this in practice, but there is no UNIQUE constraint on `stripePaymentIntentId`, `sslcommerzTranId`, or `polarCheckoutId` in the schema. Adding unique partial indexes on these columns would provide a hard database-level guarantee.
- (P3) **Payment plan updates outside atomic batch:** Lines 158-176 update `paymentPlans` after the batch succeeds. If this update fails, the payment is recorded but the plan is stale. Consider including the plan update in the batch.

---

## 3. Refund Flow

**Grade: A-**

`refund-service.ts` is thorough and defensive.

**Strengths:**

- **Cumulative refund validation:** Queries `SUM(amount)` of already-refunded payments and checks that `totalAlreadyRefunded + refundAmount <= paidAmount`. This prevents over-refunding across multiple partial refunds.
- **Gateway-agnostic dispatch:** Determines the correct gateway from the payment record, dispatches to the right API, and handles all four gateways (including COD as a no-op).
- **Currency conversion:** Correctly converts major-unit amounts to smallest-unit for Stripe/Polar using `getDecimalPlaces()`.
- **Inventory handling on full refund:** Calls `applyInventoryForStatusChange(db, orderId, "cancelled")` to release inventory. Partial refunds explicitly do NOT release inventory (with a comment explaining why).
- **Return flow:** `processReturn()` validates the order is in a returnable state, restores inventory, updates status, and optionally triggers a refund.

**Polar webhook refunds:** `processPolarWebhookRefund()` in `polar.ts` handles refunds that originate from Polar's side (dashboard refund, dispute auto-refund). This is a separate code path from admin-initiated refunds, which is correct because the refund has already happened at the gateway level.

**Issues:**

- (P2) **Refund record not persisted:** When a refund succeeds, the code updates `orders.paidAmount` and `orders.paymentStatus` but does NOT insert a new `orderPayments` row with `status: "refunded"`. The cumulative refund check queries `orderPayments WHERE status = "refunded"`, so without inserting a refund record, a second refund request for the same order could potentially exceed the paid amount. The `processRefund()` function queries existing refunds but never writes one.
- (P3) **No gateway-level idempotency on refunds:** If a refund API call succeeds at the gateway but the subsequent DB update fails (e.g., D1 error), retrying the refund would attempt a double refund at the gateway. Stripe handles this gracefully (idempotent refunds), but SSLCommerz may not.
- (P3) **`processReturn` inventory + status not atomic:** The function calls `applyInventoryForStatusChange()` and then separately updates `orders.status`. If the status update fails after inventory was released, the state is inconsistent.

---

## 4. Webhook Security

**Grade: A**

All three gateway webhooks implement proper security measures.

**Stripe:**
- Uses `stripe.webhooks.constructEventAsync()` with HMAC signature verification.
- Returns 400 on invalid signature.
- KV-based replay protection (`stripe_wh:{eventId}` with 24h TTL).

**SSLCommerz:**
- SSLCommerz does not sign IPN payloads (a known limitation of the API).
- Correctly uses server-to-server validation: calls `validateSSLCommerzIPN()` with the `val_id` from the payload to verify against SSLCommerz's validation API. This is the documented best practice.
- KV-based replay protection (`ssl_wh:{tranId}_{valId}` with 24h TTL).

**Polar:**
- Uses `standardwebhooks` library for signature verification (HMAC-SHA256).
- Correctly base64-encodes the webhook secret before verification (Polar-specific requirement).
- KV-based idempotency check (`polar_webhook:{eventId}:{eventType}` with 24h TTL).

**Strengths:**
- All handlers follow the pattern: verify signature -> check idempotency -> enqueue -> return 200. This keeps webhook handlers fast and resilient.
- Raw body is read via `c.req.text()` before any parsing, which is correct for signature verification (signature is over the raw body, not parsed JSON).

**Issues:**

- (P3) **Inconsistent KV key strategy:** Stripe uses `event.id`, SSLCommerz uses `{tranId}_{valId}`, Polar uses `{eventId}:{eventType}`. These work but a consistent format would be cleaner.
- (P3) **SSLCommerz tran_id as orderId:** The code uses `tran_id` (which equals `orderId`) as part of the webhook key. If a malicious actor knows a valid `orderId`, they could craft a fake IPN. However, the server-to-server validation via `val_id` mitigates this since the attacker cannot generate a valid `val_id`.

---

## 5. Gateway Registry

**Grade: B+**

The registry pattern in `gateway-registry.ts` provides dynamic discovery of available gateways:

```typescript
interface GatewayMeta {
  id: string;
  name: string;
  settingsCategory: string;
  getSettings: (db, kv?) => Promise<{ enabled: boolean; ... } | null>;
  getPublicConfig?: (settings) => Record<string, unknown>;
  getCurrencies?: (localCurrency) => string[];
}
```

Gateways self-register at import time via `registerGateway()` calls at the bottom of `gateway-settings.ts`. This means importing `gateway-settings.ts` has the side effect of populating the registry.

**Strengths:**
- Eliminates hardcoded if-blocks when building checkout config for the storefront.
- `getPublicConfig` correctly separates what's safe to expose to the client (e.g., Stripe's `publishableKey`) from secrets.
- `getCurrencies` allows per-gateway currency support.
- `getActivePaymentMethods()` cross-checks that each enabled method actually has valid credentials, with COD as an always-available fallback.

**Issues:**

- (P2) **Module-level singleton Map:** The `registry` is a module-level `Map`. In Cloudflare Workers, each isolate gets its own module scope, and isolates can be recycled. The registry works because `gateway-settings.ts` re-registers on import, but if the import graph somehow does not include `gateway-settings.ts` in a particular code path, the registry would be empty. This coupling is implicit.
- (P3) **No unregister mechanism:** Not needed currently, but if gateways were ever dynamically toggled at runtime, there is no way to remove a gateway from the registry.

---

## 6. COD Handling

**Grade: A**

COD is implemented as a first-class `PaymentProvider` with its own tracking table (`codTracking`) and lifecycle management.

**Strengths:**
- `CODProvider.createPayment()` creates a tracking record, returning a synthetic transaction ID (`COD-{orderId}`). No external gateway call needed.
- `recordCODCollection()` is idempotent: checks for existing successful COD payment before proceeding.
- Collection recording is atomic: `codTracking` update + `orderPayments` insert + `orders` status update all in a single `db.batch()`.
- `recordCODFailure()` tracks delivery attempts and failure reasons.
- `markCODReturned()` handles the case where all delivery attempts are exhausted.
- COD "refund" is correctly modeled as a no-op at the gateway level (returns a synthetic refund ID). The actual cash refund is an operational process.

**Issues:**

- (P4) **No max delivery attempts enforcement:** `recordCODFailure()` increments `deliveryAttempts` but there is no automatic transition to "returned" after N failures. This may be intentional (admin decides when to give up), but the schema supports it.

---

## 7. Configuration (Gateway Settings)

**Grade: A-**

Gateway credentials are stored in the `settings` KV table with per-category grouping and cached in Cloudflare KV with 5-minute TTL.

**Strengths:**
- **Credential masking:** Admin GET endpoints return `MASKED` ("...") for secrets, not the actual values.
- **Masked-value skip:** POST endpoints skip updating a field if the value equals `MASKED`, preventing accidental overwrites.
- **Cache invalidation:** Every save operation invalidates both the gateway-specific cache AND the payment methods cache.
- **Cross-validation:** `getActivePaymentMethods()` verifies that each enabled gateway actually has valid credentials before including it in the active list.
- **COD always available:** If all other gateways fail validation, COD is always added as a fallback.
- **Upsert pattern:** `upsertSetting()` uses `onConflictDoUpdate` for idempotent writes.

**Issues:**

- (P2) **Admin settings route uses module-level `db`:** `apps/api/src/routes/admin/settings/payments.ts` imports `db` directly from `@scalius/database/client` (line 2) instead of getting it from the Hono context via `c.get("db")`. This is inconsistent with other routes that use `c.get("db")` and could cause issues if the database initialization strategy changes.
- (P2) **Credentials stored in plaintext:** Gateway secrets (`secret_key`, `webhook_secret`, `store_password`, `access_token`) are stored as plaintext in the `settings` table. The delivery providers use AES-GCM encryption for credentials (per the CLAUDE.md recent changes). Payment gateway credentials should follow the same pattern.
- (P3) **No validation on save:** The admin save endpoints accept raw JSON with `as Record<string, unknown>` and only check types. There is no validation that a Stripe `secretKey` starts with `sk_`, or that an SSLCommerz `storeId` is non-empty. Invalid credentials would be saved and only discovered when a customer tries to pay.

---

## 8. Error Handling

**Grade: A-**

**Strengths:**
- Gateway functions return `{ success: boolean; error?: string }` result objects rather than throwing. The Provider implementations then convert failures to typed `ServiceUnavailableError` or `ValidationError` throws, allowing the API layer to handle them uniformly.
- `processPaymentConfirmed()` catches all errors and returns `{ success: false, error }` instead of throwing, which prevents queue message processing from crashing.
- Queue consumer uses `Promise.allSettled()` and individually acks/retries each message, so one failed message does not block others.
- SSLCommerz redirect handlers validate the order exists before redirecting, preventing open redirect to order-success for non-existent orders.

**Issues:**

- (P2) **Silent failure in `processPaymentFailed()`:** If the DB insert for the failed payment record throws, the catch block only logs and silently continues. The calling queue consumer would not know the failure was not recorded. Combined with the retry logic, this means a failed payment could be logged but not persisted.
- (P3) **SSLCommerz redirect handlers duplicate code:** The POST and GET handlers for `/success`, `/fail`, and `/cancel` are nearly identical (6 route handlers doing the same thing). These could be consolidated with a shared function.
- (P3) **Webhook handlers return 200 even on configuration errors:** Stripe and SSLCommerz webhooks return `{ received: true, skipped: true }` / `"OK"` when the gateway is not configured. This prevents retries, but also silently drops events. A 503 response would trigger retries, which is preferable if the configuration is temporarily missing.

---

## 9. LLM-Friendliness

**Grade: A**

The codebase is exceptionally well-documented and structured for both human and LLM comprehension.

**Strengths:**
- **Comprehensive header comments:** Every file starts with a comment explaining its purpose, the pattern it follows, and key architectural decisions.
- **Amount convention documentation:** `types.ts` has a 15-line block comment explaining the major-unit vs. smallest-unit conversion strategy across all four gateways. This is critical knowledge that prevents currency bugs.
- **Explicit naming:** `processPaymentConfirmed`, `processPaymentFailed`, `releaseOrderInventory`, `recordWebhookEvent` -- all function names clearly describe what they do.
- **Step-by-step comments:** `processPaymentConfirmed()` has numbered steps (0-4) explaining the flow.
- **Provider pattern consistency:** All four providers follow the same file structure: standalone functions first, then a `class XProvider implements PaymentProvider` adapter at the bottom.
- **Barrel exports:** `index.ts` exports everything with section comments, making imports discoverable.
- **Queue type safety:** `PaymentQueueMessage` is a discriminated union with per-message-type fields, preventing mismatches between producers and consumers.

---

## 10. Currency Conversion

**Grade: A**

Currency handling is one of the most error-prone areas in payment processing. This codebase handles it well.

**Key convention (documented in `types.ts`):**
- DB stores amounts in **major units** (e.g., 150.00 BDT, 29.99 USD)
- Stripe/Polar APIs expect **smallest currency unit** (cents, paisa) -- conversion at route layer
- SSLCommerz expects **major units** with `toFixed(decimals)` -- no conversion needed
- COD: no conversion

**Conversion is correct in all locations:**
- Route layer: `Math.round(chargeAmount * Math.pow(10, decimals))` (stripe-routes.ts:108, polar-routes.ts:105)
- Queue consumer: `payload.amount / Math.pow(10, decimals)` (queue-consumer.ts:239, 301)
- Refund service: `Math.round(refundAmount * Math.pow(10, currencyDecimals))` (refund-service.ts:147, 198)
- `getDecimalPlaces()` from `@scalius/shared/currency` provides ISO 4217 lookup

---

## 11. Schema Design

**Grade: A**

The orders schema is well-structured for multi-gateway payment support.

**`orders` table:** Tracks aggregate payment state (`paymentStatus`, `paidAmount`, `balanceDue`, `paymentIntentId`, `paymentMethod`).

**`orderPayments` table:** Per-payment records with gateway-specific columns (`stripePaymentIntentId`, `stripeChargeId`, `sslcommerzTranId`, `sslcommerzValId`, `sslcommerzBankTranId`, `polarCheckoutId`, `codCollectedBy`, `codCollectedAt`, `codReceiptUrl`). Indexed on all gateway-specific ID columns for efficient idempotency lookups.

**`paymentPlans` table:** Supports deposit/balance split payments with `orderId` uniqueness constraint.

**`codTracking` table:** COD-specific lifecycle with `orderId` uniqueness constraint.

**`webhookEvents` table:** Audit trail for all webhook events with provider, event type, order ID, and processing result.

---

## Issues Summary

### P2 — Should Fix

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 1 | No UNIQUE constraint on gateway-specific payment IDs (`stripePaymentIntentId`, etc.) in `orderPayments` | `packages/database/src/schema/orders.ts:84-115` | TOCTOU race on idempotency check could allow duplicate payment records under extreme concurrency |
| 2 | Refund success does not insert an `orderPayments` row with `status: "refunded"` | `packages/core/src/modules/payments/refund-service.ts:216-225` | Cumulative refund tracking queries `SUM(amount) WHERE status = "refunded"` but no refund rows exist; over-refund protection is partially broken for multi-refund scenarios |
| 3 | Admin settings route uses module-level `db` import instead of `c.get("db")` | `apps/api/src/routes/admin/settings/payments.ts:2` | Inconsistent with other routes; could break if DB initialization strategy changes |
| 4 | Gateway credentials stored in plaintext (delivery providers use AES-GCM encryption) | `packages/core/src/modules/payments/gateway-settings.ts` | Stripe secret keys, SSLCommerz passwords, and Polar access tokens sit unencrypted in D1 |
| 5 | Silent failure in `processPaymentFailed()` catch block | `packages/core/src/modules/payments/process-payment.ts:230-232` | Failed payment may not be persisted, and caller is not informed of the DB error |

### P3 — Minor / Improvement

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 6 | Payment plan update outside atomic batch | `process-payment.ts:158-176` | Payment recorded but plan stale if plan update fails |
| 7 | `processReturn` inventory + status updates not atomic | `refund-service.ts:283-292` | Inventory released but order status not updated on partial failure |
| 8 | SSLCommerz redirect handlers have 6 nearly identical route handlers | `sslcommerz-routes.ts:182-246` | Code duplication; consolidate POST/GET pairs |
| 9 | No credential validation on admin save | `admin/settings/payments.ts` | Invalid credentials accepted silently; only discovered at payment time |
| 10 | Webhook handlers return 200 when gateway unconfigured | `webhooks/stripe.ts:22`, `webhooks/sslcommerz.ts:21` | Events silently dropped instead of retried |
| 11 | `CreatePaymentParams` has SSLCommerz-specific fields at top level | `provider.ts:16-38` | Interface feels gateway-specific rather than gateway-agnostic |
| 12 | Module-level singleton clients for Stripe and Polar | `stripe.ts:23-31`, `polar.ts:29-44` | Works in CF Workers but credential rotation requires isolate restart or key-change detection (key-change detection is implemented, so this is a minor concern) |

### P4 — Nit

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 13 | No max delivery attempts enforcement for COD | `cod.ts:138-160` | Admin must manually decide when to mark as returned |
| 14 | Inconsistent KV key format across webhook handlers | Various webhook files | Works but inconsistent naming convention |

---

## Positive Patterns Worth Preserving

1. **Webhook-to-queue-to-processor pipeline:** Webhooks verify and enqueue immediately, processing happens asynchronously with built-in retry. This is the correct architecture for payment webhooks.

2. **Atomic batch for payment confirmation:** `db.batch()` ensures payment recording, order update, and inventory adjustment all succeed or all fail. This was explicitly hardened from a prior split-write bug.

3. **Dual-layer idempotency:** KV replay protection at the webhook layer + duplicate payment check at the processor layer. Defense in depth.

4. **Currency conversion discipline:** Conversion happens at well-defined boundaries (route layer for outgoing, queue consumer for incoming) with ISO 4217 lookup. The convention is documented in a header comment in `types.ts`.

5. **Provider + factory + registry pattern:** Clean separation between the provider interface, concrete implementations, factory instantiation, and dynamic discovery. Adding a new gateway requires implementing `PaymentProvider`, adding a factory case, and calling `registerGateway()`.

6. **COD as a first-class provider:** COD is not a special case scattered through if-blocks; it implements the same `PaymentProvider` interface with appropriate no-ops.

7. **Refund cumulative validation:** Checking total already-refunded before allowing a new refund prevents over-refunding (once the refund record gap in P2-#2 is fixed).
