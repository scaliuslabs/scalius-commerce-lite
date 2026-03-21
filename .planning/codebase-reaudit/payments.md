# Payments Domain Re-Audit

**Date:** 2026-03-21
**Previous Audit:** 2026-03-20
**Scope:** Full vertical: schema, core services, API routes, webhooks, queue consumer, storefront proxies, admin settings.

---

## Previous Findings Status

### Critical Issues

#### 1. TOCTOU Race in `processPaymentConfirmed()` Duplicate Check
**Previous Severity:** High
**Status:** FIXED

Migration `packages/database/migrations/0030_payment-idempotency-indexes.sql` adds unique partial indexes on `order_payments(order_id, stripe_payment_intent_id)`, `(order_id, sslcommerz_tran_id)`, and `(order_id, polar_checkout_id)` -- exactly the fix approach recommended. The migration also cleans up any existing duplicates before creating the indexes.

The comment in `packages/core/src/modules/payments/process-payment.ts` lines 42-45 now explicitly documents that the SELECT check is an optimization, not the primary idempotency guarantee:

```
// SAFETY: Unique partial indexes on orderPayments(orderId, stripePaymentIntentId),
// (orderId, sslcommerzTranId), and (orderId, polarCheckoutId) prevent duplicates
// at the DB level. This SELECT is an optimization to avoid unnecessary batch
// operations, not the primary idempotency guarantee.
```

**Remaining gap:** The `process-payment.ts` code does not wrap the `db.batch()` insert in a try-catch that specifically handles unique constraint violations as idempotent success. If a duplicate insert hits the unique index, the entire batch fails and the outer catch returns `{ success: false, error }`. The queue consumer would then retry, the SELECT check would find the existing row, and it would return success -- so it works, but wastes a retry cycle. Low priority.

#### 2. Refund Route Excludes Polar as Gateway Override
**Previous Severity:** Medium-High
**Status:** FIXED

`apps/api/src/routes/admin/orders-refund.ts` line 72 now reads:
```typescript
gateway: z.enum(["stripe", "sslcommerz", "polar", "cod"]).optional()
```

All four gateways are present. Matches `packages/core/src/modules/payments/refund-service.ts` `RefundRequest.gateway` type (line 25).

#### 3. SSLCommerz Webhook Returns 200 on Validation Network Failure
**Previous Severity:** Medium-High
**Status:** FIXED

`apps/api/src/routes/webhooks/sslcommerz.ts` line 54 now returns:
```typescript
return c.text("RETRY", 503);
```

SSLCommerz will retry IPNs that receive non-2xx responses.

---

### Code Quality Issues

#### 4. Inconsistent Payment Status Type on `orderPayments.status`
**Previous Severity:** Low-Medium
**Status:** STILL OPEN

`packages/database/src/schema/enums.ts` still has no `OrderPaymentStatus` enum. The `orderPayments.status` column (schema line 98) uses raw string literals. Usage sites:
- `packages/core/src/modules/payments/process-payment.ts` line 137: `status: "succeeded"`
- `packages/core/src/modules/payments/refund-service.ts` lines 98, 121: `eq(orderPayments.status, "refunded")`, `eq(orderPayments.status, "succeeded")`
- `packages/core/src/modules/payments/cod.ts` lines 70, 106: `eq(orderPayments.status, "succeeded")`, `status: "succeeded"`

The `PaymentStatus` enum in `enums.ts` covers order-level statuses (`unpaid/partial/paid/refunded/failed`), which are conceptually different from payment-record statuses (`pending/succeeded/failed/refunded/cancelled`). Still no type safety for the latter.

#### 5. `processPaymentFailed()` Does Not Record Polar Gateway ID
**Previous Severity:** Low-Medium
**Status:** FIXED

`packages/core/src/modules/payments/process-payment.ts` line 229 now includes:
```typescript
polarCheckoutId: gateway === "polar" ? (intentId ?? null) : null,
```

All three gateway-specific ID fields are now populated correctly.

#### 6. Inconsistent Storefront Proxy Auth Handling
**Previous Severity:** Low
**Status:** STILL OPEN

The three storefront proxy endpoints still differ in their `requiresAuth` parameter:
- `apps/storefront/src/pages/api/checkout/stripe-intent.ts`: calls `fetchWithRetry()` with default `requiresAuth = true` (default in `client.ts` line 138)
- `apps/storefront/src/pages/api/checkout/sslcommerz-session.ts`: calls `fetchWithRetry()` with explicit `requiresAuth: true` (line 21)
- `apps/storefront/src/pages/api/checkout/polar-session.ts`: calls `fetchWithRetry()` with explicit `requiresAuth: true` (line 21)

Re-reading `client.ts` line 138: `requiresAuth = true` is the default parameter value. So the Stripe proxy is actually passing `requiresAuth = true` via default. All three proxies now use auth. The original audit was wrong about the Stripe proxy missing auth. **Downgrading to informational only -- the behavior is correct, just the explicitness differs.**

**Revised status:** NOT AN ISSUE (default param provides auth)

#### 7. Module-Level Singleton Clients Are Not Isolate-Safe
**Previous Severity:** Low
**Status:** STILL OPEN (by design)

`packages/core/src/modules/payments/stripe.ts` lines 23-31 and `packages/core/src/modules/payments/polar.ts` lines 29-44 still use module-level singleton caching. Acceptable for single-tenant. Documented as a known scaling concern.

---

### Pattern Violations

#### 8. Factory Pattern Exists But Is Unused By API Routes
**Previous Severity:** Architectural
**Status:** STILL OPEN

API routes in `apps/api/src/routes/payment/stripe-routes.ts`, `sslcommerz-routes.ts`, and `polar-routes.ts` still call the legacy standalone functions (`createPaymentIntent()`, `initSSLCommerzSession()`, `createPolarCheckout()`) directly, not the factory `createPaymentProvider()`. The factory at `packages/core/src/modules/payments/factory.ts` and provider implementations exist but are unused in the route layer.

The barrel file `packages/core/src/modules/payments/index.ts` line 73 still marks these as "Legacy function exports (backward compatibility)."

#### 9. SSLCommerz Redirect Handlers Have Massive Duplication
**Previous Severity:** Low-Medium
**Status:** PARTIALLY FIXED

`apps/api/src/routes/payment/sslcommerz-routes.ts` now extracts `extractTranId()` (line 177) and `getStorefrontUrl()` (line 187) as shared helpers. This reduces per-handler boilerplate. However, the 6 handlers (POST/GET for success/fail/cancel, lines 193-257) still each contain the duplicated pattern of:
1. Extract `tran_id`
2. Get storefront URL
3. Validate order exists
4. Redirect

The order-validation + redirect logic is still copy-pasted across all 6 handlers. The helpers reduced it from ~60 lines of duplication to ~40 lines.

#### 10. Inconsistent `updatedAt` Timestamp Patterns
**Previous Severity:** Low
**Status:** STILL OPEN

Still mixing `sql`\`unixepoch()\`` and `new Date()` across the payments domain:

**Uses `new Date()`:**
- `packages/core/src/modules/payments/process-payment.ts` lines 145-146 (`createdAt`/`updatedAt` on insert)
- `packages/core/src/modules/payments/process-payment.ts` lines 230-231 (`createdAt`/`updatedAt` on failed payment insert)
- `packages/core/src/modules/payments/refund-service.ts` lines 242-243 (`createdAt`/`updatedAt` on refund insert)
- `packages/core/src/modules/payments/gateway-settings.ts` line 207 (upsert `set`)
- `apps/api/src/routes/payment/polar-routes.ts` lines 147, 171 (order update, payment plan upsert)
- `apps/api/src/routes/payment/stripe-routes.ts` line 152 (payment plan insert)
- `apps/api/src/routes/payment/sslcommerz-routes.ts` line 163 (payment plan insert)

**Uses `sql\`unixepoch()\``:**
- `packages/core/src/modules/payments/process-payment.ts` line 153 (order update in batch)
- `packages/core/src/modules/payments/process-payment.ts` lines 166, 175 (payment plan updates)
- `packages/core/src/modules/payments/refund-service.ts` line 248 (order update in batch)
- `packages/core/src/modules/payments/cod.ts` lines 95, 150 (codTracking updates)

The pattern is somewhat consistent: inserts use `new Date()` for the initial timestamp, updates use `sql\`unixepoch()\``. But `gateway-settings.ts` uses `new Date()` for an update, and some inserts also set `updatedAt: new Date()` when the schema default (`UNIX_NOW`) would suffice. Not a bug since both produce valid epoch seconds, but muddies the convention.

---

### Maintainability Concerns

#### 11. Large Barrel Export File
**Previous Severity:** Low
**Status:** STILL OPEN

`packages/core/src/modules/payments/index.ts` is now 85 lines (was 84). Still re-exports everything from every payment module including legacy function exports.

#### 12. Dual Admin Settings Components
**Previous Severity:** Low
**Status:** NOT RE-VERIFIED (UI components outside payment domain scope; marking as STILL OPEN pending frontend audit)

#### 13. No Admin Route for COD Operations
**Previous Severity:** Architectural
**Status:** STILL OPEN

`packages/core/src/modules/payments/cod.ts` functions `recordCODCollection()`, `recordCODFailure()`, and `markCODReturned()` still have no corresponding API routes. No new COD routes found in `apps/api/src/routes/`.

#### 14. Payment Plan Status Is Untyped
**Previous Severity:** Low
**Status:** STILL OPEN

`packages/database/src/schema/orders.ts` line 134: `paymentPlans.status` still uses raw string `"pending"`. Code writes `"deposit_paid"`, `"fully_paid"`, `"pending"` as inline strings without an enum.

---

### Performance & Scalability

#### 15. `getActivePaymentMethods()` Sequentially Validates Each Gateway
**Previous Severity:** Low
**Status:** STILL OPEN

`packages/core/src/modules/payments/gateway-settings.ts` lines 275-298 still uses a sequential `for` loop to check each gateway. No `Promise.all()` parallelization. Mitigated by KV caching (5 min TTL), but cold-cache path hits D1 up to 3 times sequentially.

#### 16. Decrypted Credentials Cached in KV
**Previous Severity:** Low (by design)
**Status:** STILL OPEN (acceptable tradeoff, documented)

#### 17. No Rate Limiting on Payment Session Creation Endpoints
**Previous Severity:** Medium
**Status:** STILL OPEN

No rate limiting on `POST /payment/stripe/intent`, `POST /payment/sslcommerz/session`, `POST /payment/polar/session`. The storefront proxies also add no rate limiting.

---

### Robustness Gaps

#### 18. Webhook KV Idempotency Fails Open
**Previous Severity:** Medium
**Status:** PARTIALLY FIXED

The underlying KV fail-open behavior is unchanged -- all three webhook handlers still use optional chaining (`c.env.CACHE?.get(kvKey)`). However, the fix to issue #1 (unique DB indexes) means that even when KV is down, duplicate payment inserts will fail at the DB level. This converts the KV idempotency from a single layer of defense to a true optimization layer. The DB is the authoritative gate.

**Remaining gap:** As noted in the #1 remaining gap, the duplicate insert error is not caught as an idempotent success. The batch will fail, the queue consumer will retry, and the retry will succeed via the SELECT check. Functional but not optimal.

#### 19. `processPaymentFailed()` Swallows All Errors
**Previous Severity:** Medium
**Status:** STILL OPEN

`packages/core/src/modules/payments/process-payment.ts` lines 233-235 still catch and log without re-throwing:
```typescript
} catch (err: unknown) {
    console.error(`[process-payment] Failed payment recording error:`, err);
}
```

The queue consumer will ack the message as successfully processed even if recording the failure throws.

#### 20. `releaseOrderInventory()` Swallows Errors
**Previous Severity:** Medium
**Status:** STILL OPEN

`packages/core/src/modules/payments/process-payment.ts` lines 283-285 still catch and log without re-throwing. Same pattern as #19.

#### 21. Refund Amount Validation Lacks Serializable Isolation
**Previous Severity:** Medium
**Status:** STILL OPEN

`packages/core/src/modules/payments/refund-service.ts` lines 92-110 still read cumulative refunds, then write in a separate `db.batch()` at line 226. No CAS or lock between the read and write. Two concurrent admin refund requests could both pass validation.

Mitigated in practice by the fact that refunds are admin-initiated (not webhook-driven), making concurrent requests unlikely. But not impossible if two admin users process the same order simultaneously.

#### 22. SSLCommerz Redirect Handlers Do Not Validate `tran_id` Format
**Previous Severity:** Low
**Status:** STILL OPEN

`apps/api/src/routes/payment/sslcommerz-routes.ts` `extractTranId()` (line 177) still accepts any string without format validation. The `encodeURIComponent` on redirect URLs prevents injection, but no format guard (e.g., UUID pattern check) limits order enumeration probing.

#### 23. Payment Plan Updates Are Outside the Atomic Batch
**Previous Severity:** Low (cosmetic)
**Status:** STILL OPEN

`packages/core/src/modules/payments/process-payment.ts` lines 159-178 still update payment plans in a separate DB write after the atomic batch.

---

## New Issues Found

### N1. Polar Route Uses `new Date()` for `orders.updatedAt` Instead of `sql\`unixepoch()\``
**Files:** `apps/api/src/routes/payment/polar-routes.ts` line 147
**Severity:** Low

```typescript
.set({
    paymentIntentId: result.checkoutId,
    paymentMethod: PaymentMethod.POLAR,
    updatedAt: new Date()   // Other routes use sql`unixepoch()`
})
```

Both Stripe and SSLCommerz routes use `sql\`unixepoch()\`` for the same `orders.updatedAt` write, but the Polar route uses `new Date()`. This is not a bug (both produce valid epoch seconds), but violates the convention established elsewhere in the payments domain.

### N2. Polar Webhook Idempotency Uses Different KV Key Pattern
**Files:** `apps/api/src/routes/webhooks/polar.ts` line 51
**Severity:** Low

Polar webhook uses `polar_webhook:${eventId}:${eventType}` as the KV key, which includes both event ID and event type. Stripe uses `stripe_wh:${event.id}` (event ID only). SSLCommerz uses `ssl_wh:${tranId}_${valId}`.

The Polar pattern is the most robust (prevents cross-event-type collisions), but the inconsistency means there is no shared KV key convention for webhooks. Not a bug, but a missed opportunity for standardization.

### N3. Polar Webhook Uses `getKv()` While Others Use `c.env.CACHE`
**Files:** `apps/api/src/routes/webhooks/polar.ts` line 24
**Severity:** Low

The Polar webhook handler uses `getKv()` (line 24) to access KV, while the Stripe and SSLCommerz webhook handlers use `c.env.CACHE` (via optional chaining). The `getKv()` function is a module-level store that must be initialized elsewhere. If the KV context is not set, `getKv()` returns undefined (same behavior as `c.env.CACHE` when CACHE is not bound), but the code paths are inconsistent.

### N4. Queue Consumer Does Not Pass `intentId` to `processPaymentFailed()` for Stripe
**Files:** `apps/api/src/queue-consumer.ts` line 254
**Severity:** Low-Medium

```typescript
case "payment.stripe.failed": {
    await processPaymentFailed(db, payload.orderId, "stripe");
    // Missing: payload.paymentIntentId is available but not passed
```

The `processPaymentFailed()` function accepts an optional `intentId` parameter (line 195), which is used to record the gateway-specific ID on the failed payment record. The queue message has `payload.paymentIntentId` available, but the queue consumer does not pass it.

Similarly for SSLCommerz (line 289): `payload.tranId` is available but not passed:
```typescript
case "payment.sslcommerz.failed": {
    await processPaymentFailed(db, payload.orderId, "sslcommerz");
    // Missing: payload.tranId
```

And Polar (line 315): `payload.checkoutId` is available but not passed:
```typescript
case "payment.polar.failed": {
    await processPaymentFailed(db, payload.orderId, "polar");
    // Missing: payload.checkoutId
```

**Impact:** Failed payment records lack gateway-specific IDs for all three gateways, making it harder to cross-reference failed attempts with the gateway's records.

**Fix:** Pass the ID for each:
```typescript
await processPaymentFailed(db, payload.orderId, "stripe", payload.paymentIntentId);
await processPaymentFailed(db, payload.orderId, "sslcommerz", payload.tranId);
await processPaymentFailed(db, payload.orderId, "polar", payload.checkoutId);
```

### N5. `processPaymentConfirmed` Uses `new Date()` for INSERT but `sql\`unixepoch()\`` for UPDATE in Same Batch
**Files:** `packages/core/src/modules/payments/process-payment.ts` lines 145-153
**Severity:** Low

Within the same `db.batch()`:
- Line 145-146: `createdAt: now` / `updatedAt: now` (where `now = new Date()`) for the `orderPayments` INSERT
- Line 153: `updatedAt: sql\`unixepoch()\`` for the `orders` UPDATE

Both work correctly (the schema uses `{ mode: "timestamp" }` which handles both), but mixing two timestamp generation methods in a single atomic batch could produce a 1-second skew between the two records if the request straddles a second boundary. More importantly, it is confusing for maintainers.

### N6. `processReturn` Applies Inventory Then Updates Order Non-Atomically
**Files:** `packages/core/src/modules/payments/refund-service.ts` lines 310-318
**Severity:** Low-Medium

```typescript
const newInventoryAction = await applyInventoryForStatusChange(db, params.orderId, OrderStatus.RETURNED);
await db.batch([
    db.update(orders).set({
        status: OrderStatus.RETURNED,
        inventoryAction: newInventoryAction,
        ...
    }).where(eq(orders.id, params.orderId)),
] as any);
```

`applyInventoryForStatusChange()` is called BEFORE the batch that updates the order status. If the batch fails after inventory has been applied, the inventory is released but the order status is not updated to RETURNED. This is the same class of issue as #23 (non-atomic multi-step operations), but for the return flow.

---

## Summary Scorecard

| # | Issue | Previous | Current | Status |
|---|-------|----------|---------|--------|
| 1 | TOCTOU duplicate payment | High | - | FIXED |
| 2 | Refund route missing Polar/COD | Med-High | - | FIXED |
| 3 | SSLCommerz webhook 200 on failure | Med-High | - | FIXED |
| 4 | Untyped orderPayments.status | Low-Med | Low-Med | STILL OPEN |
| 5 | Missing Polar ID in processPaymentFailed | Low-Med | - | FIXED |
| 6 | Storefront proxy auth inconsistency | Low | - | NOT AN ISSUE |
| 7 | Module-level singleton clients | Low | Low | STILL OPEN (by design) |
| 8 | Factory pattern unused | Arch | Arch | STILL OPEN |
| 9 | SSLCommerz redirect duplication | Low-Med | Low | PARTIALLY FIXED |
| 10 | Mixed updatedAt patterns | Low | Low | STILL OPEN |
| 11 | Large barrel export file | Low | Low | STILL OPEN |
| 12 | Dual admin settings components | Low | Low | STILL OPEN |
| 13 | No admin COD routes | Arch | Arch | STILL OPEN |
| 14 | Untyped payment plan status | Low | Low | STILL OPEN |
| 15 | Sequential gateway settings lookups | Low | Low | STILL OPEN |
| 16 | Decrypted creds in KV | Low | Low | STILL OPEN (by design) |
| 17 | No rate limiting on payment endpoints | Med | Med | STILL OPEN |
| 18 | Webhook KV fails open | Med | Low | PARTIALLY FIXED (DB indexes backstop) |
| 19 | processPaymentFailed swallows errors | Med | Med | STILL OPEN |
| 20 | releaseOrderInventory swallows errors | Med | Med | STILL OPEN |
| 21 | Refund TOCTOU race | Med | Med | STILL OPEN |
| 22 | SSLCommerz tran_id no format validation | Low | Low | STILL OPEN |
| 23 | Payment plan updates non-atomic | Low | Low | STILL OPEN |
| N1 | Polar route updatedAt inconsistency | - | Low | NEW |
| N2 | Polar webhook KV key pattern differs | - | Low | NEW |
| N3 | Polar webhook uses getKv() not c.env.CACHE | - | Low | NEW |
| N4 | Queue consumer omits intentId for failures | - | Low-Med | NEW |
| N5 | Mixed timestamp methods in same batch | - | Low | NEW |
| N6 | processReturn non-atomic inventory+status | - | Low-Med | NEW |

---

## Overall Assessment

**Previous Score:** Not formally rated
**Current Score:** 7.5/10

### What improved:
- **Critical TOCTOU race condition fixed** with unique partial indexes (migration 0030) -- the highest-severity issue from the previous audit
- **Refund route gateway enum fixed** -- all four gateways now supported
- **SSLCommerz webhook 503 on validation failure** -- correct retry behavior
- **Polar gateway ID in failed payments** -- audit trail completeness

### What remains:
- **Error swallowing in processPaymentFailed/releaseOrderInventory** (#19, #20) is the highest-impact remaining issue. Failed payment recordings and inventory releases silently succeed from the queue consumer's perspective.
- **Refund TOCTOU** (#21) is a real race condition but mitigated by admin-only access (low concurrency).
- **No rate limiting** (#17) on payment session endpoints is the biggest security gap.
- **Code quality items** (#4, #10, #14) are low-impact housekeeping.
- **Factory migration** (#8) is the largest architectural debt -- functional but doubles the maintenance surface.

### Recommended next fixes (by effort/impact):

| Priority | # | Issue | Effort |
|----------|---|-------|--------|
| P1 | N4 | Pass intentId to processPaymentFailed in queue consumer | 5 min |
| P1 | 19+20 | Let processPaymentFailed/releaseOrderInventory propagate errors | 10 min |
| P2 | 17 | Add rate limiting to payment session creation endpoints | 1 hr |
| P2 | 21 | Add CAS or constraint-based guard for concurrent refunds | 30 min |
| P3 | 4+14 | Create OrderPaymentStatus and PaymentPlanStatus enums | 30 min |
| P3 | 10 | Standardize updatedAt to sql\`unixepoch()\` | 20 min |
| P4 | 8 | Migrate API routes to use factory (large refactor) | 2-4 hr |
| P4 | 13 | Add admin API routes for COD operations | 1-2 hr |

---

*Re-audit: 2026-03-21*
