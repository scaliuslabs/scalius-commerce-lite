# Core Business Logic Audit

## Executive Summary

The `@scalius/core` package is a well-structured domain service layer with **strong fundamentals** in its most critical areas (inventory management, payment processing, order state machine) and **meaningful gaps** in its secondary domains (discounts, products) where type safety and domain rigor decline. The codebase has clearly benefited from multiple rounds of hardening -- optimistic locking with CAS retries, atomic D1 batch operations, idempotent payment processing, and a proper state machine for order transitions are all genuinely well-implemented. However, the architecture still carries structural debt: function-export-based modules without dependency injection, `Record<string, unknown>` parameters in discount mutations, and a dual provider system (legacy per-module + universal registry) that creates confusion about which abstraction to use.

The package serves its current mandate well: a single-tenant Cloudflare D1-backed commerce platform. However, several design choices (module-level Maps for the provider/gateway registry, hardcoded provider switch statements, no multi-tenant isolation) would require significant rework to scale beyond that scope.

---

## Ratings

| Dimension | Score | Summary |
|---|---|---|
| **Maintainability** | 7/10 | Good module boundaries, consistent naming. Degraded by untyped discount params, some 600+ line files, and lack of DI. |
| **Robustness** | 8/10 | State machine, CAS locking, idempotent payments, atomic batches are genuinely strong. Gaps in discount race conditions and missing validation on some paths. |
| **Code Quality** | 6/10 | Solid in inventory/payments/orders. Undercut by `Record<string, unknown>` types in discounts, excessive `as any` casts (D1 batch workaround), and `unknown[]` batch arrays. |
| **Scalability** | 4/10 | Single-tenant only. No multi-currency at the domain level (single currency config). Module-level Maps for registries reset on isolate restart. No event sourcing or CQRS hooks. |
| **Performance** | 7/10 | Good use of `db.batch()` for atomic multi-statement operations. `Promise.all` for parallel reads. KV caching with 5-minute TTL. N+1 avoided in collection batch resolution. Sequential inventory ops under contention could bottleneck. |
| **Feature Readiness** | 7/10 | Payment gateway registry is well-designed for adding new gateways. Order state machine is extensible. Discount types would need refactoring to add BOGO or tiered discounts cleanly. |

---

## Detailed Findings

### Strengths

#### 1. Order State Machine (Excellent)
**File**: `packages/core/src/modules/orders/order-state-machine.ts`

The state machine is one of the best-designed components in the codebase:
- Complete transition maps for all three dimensions (order, payment, fulfillment)
- Typed enum values from the database schema (single source of truth)
- Clear public API: `canTransitionTo()`, `validateTransition()`, `getAvailableTransitions()`
- Error messages include the list of valid transitions for debugging
- Admin-only transitions (cancelled -> pending/confirmed) are documented inline
- No-op on identity transitions (`currentStatus === newStatus`)

#### 2. Inventory System (Very Strong)
**Files**: `packages/core/src/modules/inventory/` (8 files)

The inventory subsystem is the most thoroughly engineered part of the core:
- **Optimistic locking** via `stockVersion` column with CAS retries (3 attempts, exponential backoff)
- **Multi-pool support**: regular, preorder, and backorder pools with different semantics
- **Atomic batch reservation** (`reserveStockBatch`) with Phase 1-5 pipeline: read all, validate all, batch CAS, verify, rollback on partial failure
- **Movement audit log** (`recordMovement`) for every stock change -- best-effort, non-blocking
- **Low-stock alerts** with create/reactivate/resolve lifecycle
- **Single source of truth** for status-driven transitions (`applyInventoryForStatusChange`)
- **Idempotent**: reads current `inventoryAction` before deciding what to do
- Separate `stockVersion` from `version` (entity version) prevents cross-concern CAS conflicts

#### 3. Payment Processing (Strong)
**Files**: `packages/core/src/modules/payments/process-payment.ts`, `refund-service.ts`, `gateway-settings.ts`

- **Idempotent confirmation**: checks for existing `orderPayments` by gateway-specific ID before any writes
- **Atomic batch**: payment insert + order update + inventory statements in one `db.batch()`
- **Amount conventions** thoroughly documented in `types.ts` (major vs smallest unit, per-gateway)
- **Refund safety**: validates refund amount <= paid amount, checks cumulative refunds, prevents double-refund
- **Currency-aware**: uses `getDecimalPlaces()` from ISO 4217 lookup for gateway conversions
- **Credential encryption**: AES-256-GCM with graceful degradation for unencrypted legacy values
- **Gateway registry** with self-registration pattern and credential cross-validation

#### 4. Error Hierarchy (Clean)
**File**: `packages/core/src/errors/index.ts`

Simple, well-designed error classes that map cleanly to HTTP status codes:
- `AppError` base with `status`, `code`, `message`, `details`
- Concrete subclasses: `ValidationError(400)`, `NotFoundError(404)`, `UnauthorizedError(401)`, `ForbiddenError(403)`, `ConflictError(409)`, `RateLimitError(429)`, `ServiceUnavailableError(503)`
- Consumed consistently across all domain services

#### 5. FTS5 Search (Solid)
**File**: `packages/core/src/search/fts5.ts`

- Input sanitization strips FTS5 special characters
- Table name allowlist prevents SQL injection (compile-time + runtime validation)
- Prefix matching with `*` suffix for autocomplete behavior
- Parameterized match values

#### 6. CAS-Protected Order Updates
**File**: `packages/core/src/modules/orders/orders.admin.ts` (updateOrder), `orders.fulfillment.ts` (updateOrderStatus)

Both order update paths use optimistic locking:
- Read `version`, write with `WHERE version = $read_version`, bump version on success
- Throw `ConflictError` on version mismatch with user-friendly message
- CAS check runs BEFORE inventory mutations to prevent irreversible side effects on conflict

#### 7. Queue-Based Architecture
**File**: `packages/core/src/modules/orders/orders.queue.ts`

- Storefront orders are validated synchronously, then dispatched to a queue for async processing
- Batch processing with rollback: if DB writes fail, inventory reservations are released
- KV-based checkout status polling for frontend UX
- COD tracking initialization happens after successful order creation

---

### Weaknesses

#### 1. Untyped Discount Mutations (Critical)
**File**: `packages/core/src/modules/discounts/discounts.service.ts`

`createDiscount()` and `updateDiscount()` accept `Record<string, unknown>` as their data parameter:
```typescript
export async function createDiscount(db: Database, data: Record<string, unknown>) {
```
This is the weakest type safety in the entire core package. The function uses `data.code as string`, `data.type as typeof discounts.$inferInsert.type`, etc. throughout -- runtime casts with no compile-time verification. The validation schema exists in `discounts.validation.ts` but the service function does not reference it in its signature.

**Risk**: Silent data corruption if the API route passes incorrect fields. The Zod validation at the route layer catches user input errors, but nothing prevents a developer from calling the service directly with bad data.

#### 2. Dual Provider Registry System (Architectural Debt)
**Files**: `packages/core/src/providers/registry.ts` vs `packages/core/src/modules/payments/gateway-registry.ts`

Two competing registry abstractions exist:
- **Universal provider registry** (`providers/registry.ts`): generic, Zod-validated, supports payment/email/delivery/SMS
- **Payment gateway registry** (`modules/payments/gateway-registry.ts`): payment-specific, manually wired

The CLAUDE.md acknowledges this: "delivery and SMS have type definitions with zero registered implementations in the new system." The universal registry is well-designed but underutilized -- actual payment processing still goes through hardcoded `if/else` chains in `refund-service.ts`:
```typescript
if (gateway === "stripe") { ... }
else if (gateway === "sslcommerz") { ... }
else if (gateway === "polar") { ... }
else if (gateway === "cod") { ... }
```

#### 3. No Dependency Injection
All service functions are standalone exports that receive `db: Database` as their first parameter. While pragmatic for the current scale, this creates:
- No way to mock at the service boundary without patching modules
- No lifecycle management (the auth module works around this with `getAuth()` caching)
- Cross-service calls via direct imports create hidden coupling (e.g., `orders.admin.ts` imports from `inventory/`, `shared/`, and `search/`)

#### 4. Sequential Inventory Operations Under Contention
**File**: `packages/core/src/modules/inventory/reserve.ts` (`reserveMultiple`)

The non-batch `reserveMultiple()` processes entries sequentially with rollback:
```typescript
for (const entry of entries) {
    const result = await reserveStock(db, entry.variantId, ...);
    // ...if failed, rollback all previous
}
```
For an order with many unique variants, this creates a waterfall of DB round-trips. The batch version (`reserveStockBatch`) exists but is not used everywhere -- `orders.admin.ts` still calls `reserveMultiple`.

#### 5. Inconsistent Database Type Usage
**File**: `packages/core/src/modules/products/products.admin.ts`

This file uses `DrizzleD1Database<typeof schema>` directly while most other modules use the `Database` type from `@scalius/database/client`. Line 22 even re-declares: `type Database = DrizzleD1Database<typeof schema>;`. This inconsistency could cause type mismatches if the `Database` export ever diverges.

#### 6. Discount Eligibility Race Condition
**File**: `packages/core/src/modules/discounts/discounts.eligibility.ts`

The discount usage limit check (`maxUses`) reads the current count, then a separate write records usage later (in the queue handler). Between the check and the write, concurrent checkouts could exceed the limit. The CLAUDE.md mentions "discount usage race condition narrowed" but the fundamental TOCTOU window remains.

#### 7. Missing Pagination Limit Guards
Most `listX()` functions accept a `limit` parameter from the caller with no upper bound enforcement:
```typescript
// orders.admin.ts
const { limit = 10 } = options;
```
A malicious or buggy client could pass `limit=100000` and cause D1 resource exhaustion. Only `collections.service.ts` has a `maxProducts` cap (`Math.min(Math.max(..., 1), 24)`).

---

### Critical Issues

#### 1. Decrypted Credentials Cached in KV
**File**: `packages/core/src/modules/payments/gateway-settings.ts`

After decrypting gateway credentials (Stripe secret key, SSLCommerz store password), the plaintext values are cached in Cloudflare KV:
```typescript
if (kv) {
    await kv.put(STRIPE_CACHE_KEY, JSON.stringify(stripeSettings), {
        expirationTtl: CACHE_TTL,
    });
}
```
The comment says "KV is ephemeral, not at-rest" but KV values persist across Worker restarts and are readable by anyone with KV access. This is a security concern -- credentials should be cached in-memory only, not in a persistent store.

#### 2. Bulk Order Delete Has No Transaction Guarantee
**File**: `packages/core/src/modules/orders/orders.admin.ts` (`bulkDeleteOrders`)

The function loops through orders one at a time for inventory release, then does a single bulk DB update:
```typescript
for (const orderId of orderIds) {
    // ... applyInventoryForStatusChange(db, orderId, "cancelled")
}
if (permanent) {
    await db.delete(orderItems).where(...)
    await db.delete(orders).where(...)
}
```
If the bulk delete fails after some inventory has been released, those releases cannot be rolled back. The inventory is in an inconsistent state.

#### 3. Order Update Replaces Items Without Inventory Atomicity
**File**: `packages/core/src/modules/orders/orders.admin.ts` (`updateOrder`)

When order items change, the function:
1. Deletes all existing items
2. Inserts new items
3. Adjusts inventory (release old, reserve new)

Step 3 happens AFTER steps 1-2 have already committed. If the inventory re-reservation fails (insufficient stock), the items are already replaced but inventory is inconsistent. The old reservations were released but new ones failed.

---

### File-by-File Notes

| File | Lines | Notes |
|---|---|---|
| `orders/order-state-machine.ts` | 138 | Excellent. Clean, complete, well-documented. |
| `orders/orders.admin.ts` | 903 | Too long. Mixes CRUD, inventory, and customer stats. Should be split. CAS on update is good. Reservation-before-insert pattern is correct. |
| `orders/orders.fulfillment.ts` | 213 | Solid. COD action handling, shipment creation, status updates with notification payload. |
| `orders/orders.storefront.ts` | ~250 | Well-structured queue preparation. Server-side price verification is important. |
| `orders/orders.queue.ts` | ~200 | Queue batch processing with rollback. Good use of KV for checkout status. |
| `orders/orders.types.ts` | 166 | Good separation. Queue payload type is well-defined. |
| `orders/orders.validation.ts` | 69 | Clean Zod schemas. `z.any()` for bulk ship options is a gap. |
| `inventory/reserve.ts` | 524 | Excellent. Both sequential and batch reservation with CAS. Thorough rollback logic. |
| `inventory/deduct.ts` | 194 | Solid. CAS-based deduction with rollback. |
| `inventory/release.ts` | 119 | Correct. Best-effort release (continues on individual failure). |
| `inventory/restore.ts` | 135 | Correct. Pool-aware stock restoration. |
| `inventory/inventory-transitions.ts` | 301 | Excellent. Single source of truth for status-driven inventory changes. Idempotent. |
| `inventory/stock-adjustment.ts` | 294 | Well-designed scanner workflow. CAS-protected adjustments. |
| `inventory/movements.ts` | 35 | Clean. Non-fatal audit logging. |
| `inventory/alerts.ts` | 166 | Good lifecycle: create, reactivate, resolve. |
| `inventory/types.ts` | 33 | Clean shared types. |
| `payments/process-payment.ts` | 316 | Strong. Idempotent, atomic batch, webhook event recording. |
| `payments/refund-service.ts` | 331 | Thorough validation. Cumulative refund tracking. Gateway dispatch could use registry pattern. |
| `payments/gateway-settings.ts` | 378 | Well-structured. Caching pattern is consistent. Decrypted-KV caching is the security concern. |
| `payments/gateway-registry.ts` | 29 | Simple but effective. Module-level Map. |
| `payments/types.ts` | 189 | Excellent documentation of amount conventions per gateway. |
| `payments/stripe.ts` | ~150 | Standard Stripe SDK wrapper. |
| `payments/sslcommerz.ts` | ~200 | HTTP-based integration with validation. |
| `payments/polar.ts` | ~150 | SDK-based integration. |
| `payments/cod.ts` | ~100 | Simple COD tracking with status transitions. |
| `discounts/discounts.service.ts` | 330 | `Record<string, unknown>` parameters are the biggest type safety gap. |
| `discounts/discounts.eligibility.ts` | 393 | Good eligibility logic. Race condition on usage limits. |
| `products/products.admin.ts` | 731 | Inconsistent DB type. Good use of batching for counts/images. |
| `products/products.storefront.ts` | 540 | Complex but well-optimized. Attribute filtering via subquery is clever. |
| `products/products.variants.ts` | ~200 | Standard variant CRUD. |
| `categories/categories.service.ts` | 363 | Clean. Good referential integrity checks on delete. |
| `collections/collections.service.ts` | 491 | Excellent batch resolution to avoid N+1. |
| `settings/settings.service.ts` | 270 | Clean abstraction over two settings tables. KV caching throughout. |
| `notifications/notifications.service.ts` | 207 | Channel-aware dispatch. FCM token cleanup on failure. |
| `delivery/delivery.service.ts` | 385 | Insert-first pattern for shipments is a good resilience strategy. |
| `auth/auth.ts` | 227 | Well-configured Better Auth. Rate limiting, IP detection, XSS-safe email templates. |
| `auth/rbac/api-protection.ts` | 215 | Clean HOF pattern for route protection. |
| `providers/registry.ts` | 170 | Well-designed universal registry. Underutilized. |
| `errors/index.ts` | 69 | Clean error hierarchy. |
| `search/fts5.ts` | 65 | Solid input sanitization and table allowlisting. |
| `utils/credential-encryption.ts` | 69 | Correct AES-256-GCM implementation. Graceful degradation for migration. |

---

### Domain Modeling Assessment

**What the model gets right:**
- Order lifecycle is well-modeled: status, payment status, fulfillment status as three independent dimensions
- Inventory pools (regular/preorder/backorder) add real flexibility
- Payment plans (deposit/balance) support partial payment workflows
- Discount types (amount_off_order, amount_off_products, free_shipping) cover common e-commerce patterns
- Soft-delete with restore across all entities is consistent

**What the model is missing:**
- **No value objects**: prices are raw `number` types everywhere. A `Money` type with currency code would prevent currency mixing
- **No aggregate roots**: orders and their items have no transactional boundary concept -- items can be modified independently
- **No domain events**: state changes produce side effects via direct function calls, not an event bus
- **No temporal modeling**: discount start/end dates are stored but there's no concept of "scheduled activation" or time-based business rules beyond the simple comparison

---

## Recommendations

### High Priority

1. **Type the discount mutation parameters**: Replace `Record<string, unknown>` in `createDiscount()` and `updateDiscount()` with the Zod-inferred types from `discounts.validation.ts`. This is the single highest-ROI change for type safety.

2. **Stop caching decrypted credentials in KV**: Cache gateway settings in an in-memory `Map` with TTL instead of KV. The auth module already does this pattern with `cachedAuth`.

3. **Add pagination limit guards**: Cap all `listX()` functions at a reasonable maximum (e.g., 100 or 200). Return an error if the requested limit exceeds it.

4. **Make bulk operations atomic**: `bulkDeleteOrders` should collect all inventory statements first, then execute them along with the delete in a single `db.batch()`.

### Medium Priority

5. **Consolidate provider registries**: Either commit to the universal registry for all provider types (including payment) or remove it. The current dual system creates confusion.

6. **Use `reserveStockBatch` everywhere**: Replace `reserveMultiple` calls in `orders.admin.ts` with `reserveStockBatch` for better atomicity and fewer round-trips.

7. **Split `orders.admin.ts`**: At 903 lines, it contains read queries, write mutations, inventory logic, and customer stat updates. Extract customer stats into `customers.service.ts` and inventory delta logic into a helper.

8. **Standardize DB type imports**: All modules should use `Database` from `@scalius/database/client`, not re-declare it.

### Lower Priority

9. **Introduce a `Money` value object**: Even a simple `{ amount: number; currency: string }` type would prevent accidental currency mixing as multi-currency support is added.

10. **Add domain events**: The notification/queue pattern already exists -- formalize it so that `updateOrderStatus` emits an event rather than returning a notification payload for the caller to dispatch.

11. **Discount usage atomicity**: Consider using a database-level counter (e.g., `UPDATE discounts SET usageCount = usageCount + 1 WHERE usageCount < maxUses`) to close the TOCTOU window on discount limits.

12. **Extract order update item-replacement into an atomic operation**: The current delete-all/insert-all/adjust-inventory sequence should be wrapped in a single atomic batch to prevent partial states.
