# Payments Domain Audit

**Date:** 2026-03-20
**Scope:** Complete vertical slice from schema through core services, API routes, webhooks, queue consumer, storefront checkout, and admin settings.

## Summary

The payments domain is the most critical and complex slice of the codebase. It spans 4 gateway integrations (Stripe, SSLCommerz, Polar, COD), a unified provider interface, queue-based async processing, partial payment (deposit/balance) support, and a refund orchestrator. The architecture is sound: webhook handlers are thin (verify + enqueue), processing is atomic (`db.batch()`), and idempotency is layered (KV + DB checks). The codebase has clearly been through a hardening pass. However, several real issues remain -- most notably around TOCTOU race conditions in the duplicate-check-then-write path, inconsistency between the factory pattern and actual route usage, and a refund route that silently excludes Polar as a valid gateway override.

**Files analyzed:** 35+ files across `packages/database/src/schema/orders.ts`, `packages/core/src/modules/payments/*`, `apps/api/src/routes/payment/*`, `apps/api/src/routes/webhooks/*`, `apps/api/src/queue-consumer.ts`, `apps/api/src/routes/admin/orders-refund.ts`, `apps/api/src/routes/admin/settings/payments.ts`, `apps/api/src/routes/checkout.ts`, `apps/storefront/src/pages/api/checkout/*`, `apps/storefront/src/lib/checkout/*`.

---

## Critical Issues

### 1. TOCTOU Race in `processPaymentConfirmed()` Duplicate Check
**Files:** `packages/core/src/modules/payments/process-payment.ts` (lines 44-67)
**Severity:** High

The idempotency gate queries for an existing `orderPayments` row by gateway-specific ID (stripePaymentIntentId, sslcommerzTranId, polarCheckoutId), then proceeds to insert a new row in a `db.batch()`. Between the SELECT and the INSERT, a second concurrent queue consumer processing the same webhook (e.g., from a retry) could pass the check. D1 does NOT run `db.batch()` as a serializable transaction with automatic conflict detection against the prior SELECT.

```typescript
// Line 44-50: SELECT to check for duplicates
const existing = await db
  .select({ id: orderPayments.id })
  .from(orderPayments)
  .where(eq(orderPayments.stripePaymentIntentId, params.stripePaymentIntentId))
  .get();
if (existing) return { success: true };

// ... later at line 127: INSERT in batch -- gap between read and write
await db.batch([
  db.insert(orderPayments).values({ ... }),
  // ...
]);
```

**Impact:** A double-processed webhook could result in duplicate `orderPayments` rows and double inventory deduction. The KV-level idempotency in the webhook handler (24h TTL) is the primary defense, but KV is eventually consistent and could miss rapid retries.

**Fix approach:** Add a unique constraint on `(orderId, stripePaymentIntentId)`, `(orderId, sslcommerzTranId)`, and `(orderId, polarCheckoutId)` to the `orderPayments` table. Wrap the insert in a try-catch that treats unique constraint violations as idempotent success. This converts the TOCTOU window into a database-enforced guarantee.

### 2. Refund Route Excludes Polar as Gateway Override
**Files:** `apps/api/src/routes/admin/orders-refund.ts` (line 73)
**Severity:** Medium-High

The refund endpoint's Zod schema only allows `gateway: z.enum(["stripe", "sslcommerz"]).optional()`. Polar is missing. If an admin tries to override the gateway for a Polar order, the request will be rejected by validation before reaching `processRefund()`.

```typescript
// Line 69-73
gateway: z.enum(["stripe", "sslcommerz"]).optional()
// Missing "polar" and "cod"
```

**Impact:** Manual gateway override is impossible for Polar orders. Auto-detection from the payment record still works for the normal flow, but the explicit override path is broken.

**Fix:** Change to `z.enum(["stripe", "sslcommerz", "polar", "cod"]).optional()` to match `refund-service.ts` which handles all four gateways.

### 3. SSLCommerz Webhook Returns 200 on Validation Network Failure
**Files:** `apps/api/src/routes/webhooks/sslcommerz.ts` (lines 50-55)
**Severity:** Medium-High

When `validateSSLCommerzIPN()` returns `null` (network error contacting SSLCommerz validation API), the webhook handler logs an error but returns `c.text("OK")` (HTTP 200). SSLCommerz will NOT retry the IPN because it received a 200.

```typescript
const validation = await validateSSLCommerzIPN(ssl.storeId, ssl.storePassword, ssl.sandbox, valId);
if (!validation) {
  console.error(`[ssl-webhook] IPN validation API call failed for order ${tranId}`);
  return c.text("OK"); // <-- Should return 5xx to trigger retry
}
```

**Impact:** A transient network failure between the API worker and SSLCommerz validation API silently drops the payment confirmation. The customer has paid but the order stays in INCOMPLETE/PENDING with paymentStatus UNPAID.

**Fix:** Return `c.text("RETRY", 503)` instead of `c.text("OK")` when validation is null. SSLCommerz retries IPNs that get non-2xx responses.

---

## Code Quality Issues

### 4. Inconsistent Payment Status Type on `orderPayments.status`
**Files:** `packages/database/src/schema/orders.ts` (line 98), `packages/core/src/modules/payments/process-payment.ts` (line 135)
**Severity:** Low-Medium

The `orderPayments.status` column uses raw string literals (`"pending"`, `"succeeded"`, `"failed"`, `"refunded"`, `"cancelled"`) rather than the `PaymentStatus` enum. The `orders.paymentStatus` column properly uses the enum. This creates a dual status vocabulary:

- `orders.paymentStatus`: `unpaid | partial | paid | refunded | failed` (enum)
- `orderPayments.status`: `pending | succeeded | failed | refunded | cancelled` (string literals)

These are conceptually different (order-level vs. individual payment record), but having the record statuses as untyped strings invites typo bugs. For example, `process-payment.ts` line 135 writes `status: "succeeded"` as a string literal. The refund service queries `eq(orderPayments.status, "refunded")` and `eq(orderPayments.status, "succeeded")` as raw strings.

**Fix approach:** Create an `OrderPaymentStatus` enum in `enums.ts` and use it consistently.

### 5. `processPaymentFailed()` Does Not Record Polar Gateway ID
**Files:** `packages/core/src/modules/payments/process-payment.ts` (lines 216-229)
**Severity:** Low-Medium

The failed payment recording only sets `stripePaymentIntentId` or `sslcommerzTranId` based on gateway type. There is no branch for `polar`:

```typescript
stripePaymentIntentId: gateway === "stripe" ? (intentId ?? null) : null,
sslcommerzTranId: gateway === "sslcommerz" ? (intentId ?? null) : null,
// Missing: polarCheckoutId for polar failures
```

**Impact:** Failed Polar payment attempts lack the checkout ID for audit trails and debugging.

**Fix:** Add `polarCheckoutId: gateway === "polar" ? (intentId ?? null) : null`.

### 6. Inconsistent Storefront Proxy Auth Handling
**Files:**
- `apps/storefront/src/pages/api/checkout/stripe-intent.ts` - calls `fetchWithRetry` WITHOUT `requiresAuth` parameter
- `apps/storefront/src/pages/api/checkout/sslcommerz-session.ts` - calls `fetchWithRetry` WITH `requiresAuth: true`
- `apps/storefront/src/pages/api/checkout/polar-session.ts` - calls `fetchWithRetry` WITH `requiresAuth: true`

The Stripe proxy does not pass `requiresAuth: true` while SSLCommerz and Polar do. If the backend requires auth tokens on payment session endpoints, Stripe requests could fail. If it does not require them, the SSLCommerz/Polar calls pass unnecessary auth overhead.

**Fix:** Audit whether `/payment/stripe/intent` requires auth, then make all three proxies consistent.

### 7. Module-Level Singleton Clients Are Not Isolate-Safe
**Files:** `packages/core/src/modules/payments/stripe.ts` (lines 23-31), `packages/core/src/modules/payments/polar.ts` (lines 29-44)
**Severity:** Low

Both Stripe and Polar use module-level singleton patterns (`let _stripe`, `let _cachedClient`) with credential-change detection. In Cloudflare Workers, module-level state persists within a single isolate but is NOT shared across isolates. This means:

1. Different isolates may have different cached clients (fine, just wastes one initialization per isolate).
2. Credential rotation takes effect on the next request per-isolate (acceptable).
3. In multi-tenant scenarios (not current), this would be a correctness bug since credentials would bleed between tenants.

**Current impact:** Negligible for single-tenant. Documented as a scaling concern.

---

## Pattern Violations

### 8. Factory Pattern Exists But Is Unused By API Routes
**Files:** `packages/core/src/modules/payments/factory.ts`, `apps/api/src/routes/payment/stripe-routes.ts`, `apps/api/src/routes/payment/sslcommerz-routes.ts`, `apps/api/src/routes/payment/polar-routes.ts`

The `createPaymentProvider()` factory and `PaymentProvider` interface were implemented but API routes call legacy wrapper functions directly (`createPaymentIntent()`, `initSSLCommerzSession()`, `createPolarCheckout()`). This is documented in the README's Known Gaps section (gap #8).

The dual code paths mean:
- The factory enforces `enabled` checks; the route handlers do their own checks
- The provider interface handles errors by throwing; the legacy functions return `{ success, error }` objects
- Adding a new gateway requires updating both paths

**Impact:** Maintenance burden. New developers may not know which path to use.

**Fix approach:** Migrate API routes to use `createPaymentProvider()`. This is a significant refactor but removes ~60% of duplicated validation logic.

### 9. SSLCommerz Redirect Handlers Have Massive Duplication
**Files:** `apps/api/src/routes/payment/sslcommerz-routes.ts` (lines 193-257)

Six nearly identical redirect handlers (POST and GET for success, fail, cancel) each:
1. Extract `tran_id`
2. Look up `STOREFRONT_URL`
3. Validate order exists
4. Redirect to storefront

This is copy-paste code with slight URL differences.

```typescript
// Lines 193-202 (POST /success) is nearly identical to:
// Lines 204-213 (GET /success)
// Lines 215-224 (POST /fail)
// Lines 226-235 (GET /fail)
// Lines 237-246 (POST /cancel)
// Lines 248-257 (GET /cancel)
```

**Fix:** Extract a single `handleSSLCommerzRedirect(c, type: "success"|"fail"|"cancel")` function and have all 6 routes delegate to it.

### 10. Inconsistent `updatedAt` Timestamp Patterns
**Files:** Multiple across `packages/core/src/modules/payments/`
**Severity:** Low

Three different patterns are used for setting `updatedAt`:

1. `updatedAt: sql`unixepoch()`\` -- Drizzle SQL expression (used in `process-payment.ts`, `refund-service.ts`)
2. `updatedAt: new Date()` -- JavaScript Date object (used in `cod.ts` line 95, `polar-routes.ts` line 148)
3. `updatedAt: now` where `now = new Date()` (used in `cod.ts` line 111, `process-payment.ts` line 144)

The schema uses `integer("updated_at", { mode: "timestamp" })` which maps JavaScript `Date` to unix epoch seconds. Both `sql\`unixepoch()\`` and `new Date()` produce the same result, but mixing them is confusing for maintainers.

**Fix:** Standardize on `sql\`unixepoch()\`` for all update operations (it is the schema convention per `UNIX_NOW` constant).

---

## Maintainability Concerns

### 11. Large Barrel Export File
**Files:** `packages/core/src/modules/payments/index.ts` (84 lines)

The barrel file re-exports everything from every payment module, including legacy function exports that duplicate the provider interface. The comment on line 73 (`// --- Legacy function exports (backward compatibility) ---`) confirms this is technical debt. Any change to any payment file can trigger recompilation cascades through this barrel.

### 12. Dual Admin Settings Components
**Files:** `apps/admin/src/components/admin/settings/PaymentGatewaysManager.tsx`, `apps/admin/src/components/admin/settings/PaymentMethodSettings.tsx`

Two separate admin UI components for payment settings. `PaymentMethodSettings.tsx` is the older version that only supports Stripe + SSLCommerz + COD. `PaymentGatewaysManager.tsx` supports all four gateways. If both are reachable, they could set conflicting configuration.

### 13. No Admin Route for COD Operations
**Files:** `packages/core/src/modules/payments/cod.ts`

The functions `recordCODCollection()`, `recordCODFailure()`, and `markCODReturned()` exist in the core module but have no corresponding API routes in `apps/api/src/routes/`. These operations can only be triggered by code that directly imports the core module. If the admin dashboard needs COD management UI (mark cash collected, record failed delivery), API routes are needed.

### 14. Payment Plan Status Is Untyped
**Files:** `packages/database/src/schema/orders.ts` (line 134), `packages/core/src/modules/payments/process-payment.ts` (lines 159-175)

The `paymentPlans.status` column uses raw string literals (`"pending"`, `"deposit_paid"`, `"fully_paid"`) without an enum. The `process-payment.ts` writes these as inline strings. No validation prevents invalid values.

---

## Performance & Scalability

### 15. `getActivePaymentMethods()` Sequentially Validates Each Gateway
**Files:** `packages/core/src/modules/payments/gateway-settings.ts` (lines 273-298)

The cross-check loop calls `getStripeSettings()`, `getSSLCommerzSettings()`, and `getPolarSettings()` sequentially in a `for` loop. Each makes a DB query (if not cached). With 3 gateways enabled, this is 3 sequential DB reads.

```typescript
for (const method of enabledMethods) {
  if (method === "stripe") {
    const stripe = await getStripeSettings(db, undefined, encryptionKey);
    // ...
  }
  if (method === "sslcommerz") {
    const ssl = await getSSLCommerzSettings(db, undefined, encryptionKey);
    // ...
  }
  // ...
}
```

**Fix:** Use `Promise.all()` to parallelize the gateway settings lookups. The KV cache TTL (5 min) mitigates this for cached scenarios, but the cold-cache path hits D1 three times sequentially.

### 16. Decrypted Credentials Cached in KV
**Files:** `packages/core/src/modules/payments/gateway-settings.ts` (lines 86-91)

Gateway settings are encrypted at rest in D1 but cached decrypted in KV:

```typescript
// Cache in KV (decrypted — KV is ephemeral, not at-rest)
if (kv) {
  await kv.put(STRIPE_CACHE_KEY, JSON.stringify(stripeSettings), {
    expirationTtl: CACHE_TTL,
  });
}
```

The comment acknowledges this tradeoff. KV data is not encrypted at rest by Cloudflare. For a single-tenant SaaS this is acceptable, but for multi-tenant or compliance-sensitive deployments, this is a security concern.

### 17. No Rate Limiting on Payment Session Creation Endpoints
**Files:** `apps/api/src/routes/payment/stripe-routes.ts`, `apps/api/src/routes/payment/sslcommerz-routes.ts`, `apps/api/src/routes/payment/polar-routes.ts`

The `POST /intent`, `POST /session` endpoints that create payment sessions have no rate limiting. An attacker could spam these endpoints to:
- Create thousands of Stripe PaymentIntents (each costs Stripe API calls)
- Flood SSLCommerz with session requests
- Create abandoned Polar checkouts

The storefront proxy adds no rate limiting either.

---

## Robustness Gaps

### 18. Webhook KV Idempotency Fails Open
**Files:** `apps/api/src/routes/webhooks/stripe.ts` (lines 42-45), `apps/api/src/routes/webhooks/sslcommerz.ts` (lines 44-48), `apps/api/src/routes/webhooks/polar.ts` (lines 52-58)

All three webhook handlers use optional chaining on `c.env.CACHE?.get(kvKey)`. If KV is unavailable, the check silently returns `undefined` and the webhook proceeds. This is fail-open by design.

```typescript
const alreadyProcessed = await c.env.CACHE?.get(kvKey);
if (alreadyProcessed) {
  return c.json({ received: true, skipped: true });
}
```

Combined with the TOCTOU issue in `processPaymentConfirmed()` (Critical Issue #1), KV failure opens the door to duplicate processing. The DB-level duplicate check is the last line of defense, and as noted in Issue #1, it is not atomic.

**Impact:** When KV is down, the same webhook can be processed multiple times.

### 19. `processPaymentFailed()` Swallows All Errors
**Files:** `packages/core/src/modules/payments/process-payment.ts` (lines 230-232)

The function wraps everything in a try-catch that logs and returns void:

```typescript
} catch (err: unknown) {
  console.error(`[process-payment] Failed payment recording error:`, err);
}
```

If recording the failed payment throws (e.g., DB write failure), the error is silently swallowed. The queue consumer will ack the message as successfully processed because `processPaymentFailed()` does not throw.

**Fix:** Let errors propagate so the queue consumer can retry failed messages.

### 20. `releaseOrderInventory()` Swallows Errors
**Files:** `packages/core/src/modules/payments/process-payment.ts` (lines 280-282)

Same pattern as #19. If inventory release fails, the error is logged but swallowed. The order's `inventoryAction` is set to `"restored"` even if the actual stock restoration failed.

### 21. Refund Amount Validation Lacks Serializable Isolation
**Files:** `packages/core/src/modules/payments/refund-service.ts` (lines 92-110)

The cumulative refund check reads existing refunded amounts, then computes whether the new refund would exceed the paid amount. But between the read and the subsequent `db.batch()` write (line 226), a concurrent refund request could also pass the check.

```typescript
// Line 92-103: Read cumulative refunds
const alreadyRefundedRow = await db
  .select({ total: sql<number>`COALESCE(SUM(${orderPayments.amount}), 0)` })
  .from(orderPayments)
  .where(and(eq(orderPayments.orderId, params.orderId), eq(orderPayments.status, "refunded")))
  .get();

// Line 226-251: Write refund -- gap between read and write
await db.batch([...]);
```

**Impact:** Two concurrent admin refund requests for the same order could both pass validation and together exceed the paid amount.

**Fix:** Use a CAS (compare-and-swap) pattern on `orders.paidAmount` in the batch update, or use a pessimistic lock via D1 transaction isolation.

### 22. SSLCommerz Redirect Handlers Do Not Validate `tran_id` Format
**Files:** `apps/api/src/routes/payment/sslcommerz-routes.ts` (lines 177-257)

The `extractTranId()` function accepts any string from POST body or query params without validation. A crafted `tran_id` value could be used to:
- Inject into redirect URLs (open redirect if `encodeURIComponent` is bypassed)
- Probe for order IDs via timing attacks on the DB lookup

The `encodeURIComponent` on the redirect URL mitigates XSS but does not prevent order enumeration.

### 23. Payment Plan Updates Are Outside the Atomic Batch
**Files:** `packages/core/src/modules/payments/process-payment.ts` (lines 158-176)

The payment plan status update (`deposit_paid`, `fully_paid`) happens after the atomic batch, in a separate DB write:

```typescript
// Line 127: Atomic batch
await db.batch([...]);

// Line 158-176: Non-atomic follow-up
if (params.paymentType === "deposit") {
  await db.update(paymentPlans).set({ status: "deposit_paid", ... })
    .where(eq(paymentPlans.orderId, params.orderId));
}
```

If the batch succeeds but the payment plan update fails (e.g., worker crashes between the two), the order will be marked as paid but the payment plan will remain in `"pending"` status.

**Impact:** Cosmetic -- the payment plan status is advisory, not load-bearing. The order's `paidAmount` and `paymentStatus` are the source of truth.

---

## LLM-Friendliness

### Strengths

1. **Excellent README:** `packages/core/src/modules/payments/README.md` is a 357-line comprehensive reference with architecture diagrams, file maps, endpoint tables, and detailed per-gateway documentation. This is one of the best internal docs in the codebase.

2. **Amount convention documentation:** `packages/core/src/modules/payments/types.ts` has a detailed header comment explaining the major-unit vs. smallest-unit convention and which gateway uses which. This prevents the #1 payments bug (wrong amount denomination).

3. **Discriminated union types:** `GatewayConfig` in `factory.ts` uses TypeScript discriminated unions with exhaustive switch/default. Type errors immediately surface if a new gateway is added without updating the factory.

4. **Consistent file structure:** Each gateway has the same pattern: standalone functions + `PaymentProvider` class in one file. The naming is consistent: `stripe.ts`, `sslcommerz.ts`, `polar.ts`, `cod.ts`.

5. **Clear separation of concerns:** Webhook handlers are thin (verify + enqueue), queue consumer is a dispatcher, and business logic lives in `process-payment.ts` and `refund-service.ts`.

### Weaknesses

1. **Dual API surfaces:** The legacy standalone functions and the provider interface coexist. An LLM reading the code needs to understand both and know that routes use the legacy path while the provider interface is "future state."

2. **Amount conversion happens at 3 different layers:** API route (major -> smallest), queue consumer (smallest -> major), and `refund-service.ts` (major -> smallest for gateway calls). An LLM modifying one layer needs to trace the conversion chain end-to-end.

3. **Implicit gateway registration:** `gateway-settings.ts` registers gateways as a side effect of import. The checkout route uses a comment-import (`import "@scalius/core/modules/payments/gateway-settings"`) to trigger this. This is non-obvious.

---

## Recommended Changes

### Priority 1 (Bug Fixes)

| # | Issue | File | Effort |
|---|-------|------|--------|
| 2 | Add `"polar"` and `"cod"` to refund route gateway enum | `apps/api/src/routes/admin/orders-refund.ts` line 73 | 5 min |
| 3 | Return 503 on SSLCommerz IPN validation failure | `apps/api/src/routes/webhooks/sslcommerz.ts` line 54 | 5 min |
| 5 | Add `polarCheckoutId` to `processPaymentFailed()` | `packages/core/src/modules/payments/process-payment.ts` line 225 | 5 min |

### Priority 2 (Robustness)

| # | Issue | File | Effort |
|---|-------|------|--------|
| 1 | Add unique constraints on gateway-specific IDs in `orderPayments` | `packages/database/src/schema/orders.ts`, new migration | 30 min |
| 19 | Let `processPaymentFailed()` propagate errors | `packages/core/src/modules/payments/process-payment.ts` | 10 min |
| 20 | Let `releaseOrderInventory()` propagate errors | `packages/core/src/modules/payments/process-payment.ts` | 10 min |
| 23 | Move payment plan updates into the atomic batch | `packages/core/src/modules/payments/process-payment.ts` | 20 min |

### Priority 3 (Code Quality)

| # | Issue | File | Effort |
|---|-------|------|--------|
| 4 | Create `OrderPaymentStatus` enum | `packages/database/src/schema/enums.ts` | 30 min |
| 6 | Align storefront proxy auth handling | `apps/storefront/src/pages/api/checkout/stripe-intent.ts` | 10 min |
| 9 | Deduplicate SSLCommerz redirect handlers | `apps/api/src/routes/payment/sslcommerz-routes.ts` | 30 min |
| 10 | Standardize `updatedAt` to `sql\`unixepoch()\`` | Multiple files | 20 min |

### Priority 4 (Architectural)

| # | Issue | File | Effort |
|---|-------|------|--------|
| 8 | Migrate API routes to use `createPaymentProvider()` factory | `apps/api/src/routes/payment/*` | 2-4 hours |
| 13 | Add admin API routes for COD operations | `apps/api/src/routes/admin/` | 1-2 hours |
| 15 | Parallelize gateway settings lookups | `packages/core/src/modules/payments/gateway-settings.ts` | 15 min |
| 17 | Add rate limiting to payment session endpoints | `apps/api/src/routes/payment/*` | 1 hour |
