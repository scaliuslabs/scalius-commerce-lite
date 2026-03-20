# Discounts Domain Audit

**Analysis Date:** 2026-03-20

## Summary

The discounts domain is a complete vertical slice spanning schema, core services, eligibility engine, API routes (admin + public), queue-based usage recording, storefront SDK client, and admin UI. The architecture cleanly separates admin CRUD (`discounts.service.ts`), storefront validation/calculation (`discounts.eligibility.ts`), and usage recording (`orders.queue.ts`). However, the domain carries significant vestiges of planned-but-unimplemented features (BOGO, multi-discount stacking, customer segments), has a genuine race condition window between validation and usage recording, and contains several envelope/type inconsistencies that could cause subtle bugs.

**Files analyzed:**
- Schema: `packages/database/src/schema/marketing.ts`
- Enums: `packages/database/src/schema/enums.ts`
- Core service: `packages/core/src/modules/discounts/discounts.service.ts`
- Validation schemas: `packages/core/src/modules/discounts/discounts.validation.ts`
- Eligibility engine: `packages/core/src/modules/discounts/discounts.eligibility.ts`
- Admin API routes: `apps/api/src/routes/admin/discounts.ts`
- Public API routes: `apps/api/src/routes/discounts.ts`
- Order queue handler: `packages/core/src/modules/orders/orders.queue.ts`
- Storefront order creation: `packages/core/src/modules/orders/orders.storefront.ts`
- Storefront SDK: `apps/storefront/src/lib/api/discounts.ts`
- Storefront checkout: `apps/storefront/src/lib/checkout/create-order.ts`
- Admin UI: `apps/admin/src/components/admin/discount/` (22 files)

---

## Critical Issues

### 1. `updateDiscount()` returns `{ success: true }` -- envelope violation

**Files:** `packages/core/src/modules/discounts/discounts.service.ts:285`

```typescript
// Line 285
return { success: true };
```

The `ok(c, T)` helper wraps `T` in `{ success: true, data: T }`. This means the actual API response becomes:
```json
{ "success": true, "data": { "success": true } }
```

This violates the documented convention: "The `T` passed to `ok(c, T)` must be the FINAL payload -- never include redundant `success: true`". The admin UI does not appear to read the update response body (it navigates away on success), so this is not actively broken, but any future consumer would get a misleading double-wrapped response.

**Fix:** Return `{ id }` instead (consistent with `createDiscount()`), or return the updated discount object.

### 2. Missing `POST /discounts/usage` endpoint

**Files:** `apps/storefront/src/lib/api/discounts.ts:81-82`, `apps/api/src/routes/discounts.ts` (no matching route)

The storefront's `recordDiscountUsage()` function calls `POST /discounts/usage`, but this endpoint does not exist in the API. The function will always get a 404. Usage recording happens exclusively via the order queue (`orders.queue.ts:229-239`), so this is a dead code path. However, it creates confusion: the storefront `discounts.ts` file exports this function, and any code that calls it (silently failing) might believe usage is being tracked when it is not.

**Fix:** Either add the endpoint or delete the dead storefront function.

### 3. Race condition between validation and usage recording

**Files:**
- Validation: `packages/core/src/modules/discounts/discounts.eligibility.ts:161-179` (maxUses check)
- Recording: `packages/core/src/modules/orders/orders.queue.ts:229-239` (usage insert)
- Re-check: `packages/core/src/modules/orders/orders.queue.ts:252-317` (Phase 1b)

The flow is: HTTP handler validates discount (check-then-act), enqueues order, queue handler re-checks before writing. The queue re-check (Phase 1b) narrows the race window but does not eliminate it. Between Phase 1b's `SELECT COUNT(*)` and the `db.batch()` write at Phase 3, another queue batch could commit a concurrent usage record. On D1 (single-writer SQLite), the race window is extremely narrow but theoretically exists under batched processing.

**Impact:** A discount with `maxUses: 100` could be used 101 times under concurrent load. Acceptable for most commerce scenarios, but worth documenting.

**Mitigation already in place:** The queue's Phase 1b re-check catches the vast majority of cases. True atomicity would require a CHECK constraint or a trigger, which SQLite supports but D1 may not.

---

## Code Quality Issues

### 4. Untyped `Record<string, unknown>` parameters in service layer

**Files:** `packages/core/src/modules/discounts/discounts.service.ts:153, 213`

Both `createDiscount(db, data)` and `updateDiscount(db, id, data)` accept `data: Record<string, unknown>` and cast every field individually:

```typescript
code: data.code as string,
type: data.type as typeof discounts.$inferInsert.type,
discountValue: data.discountValue as number,
```

This bypasses all TypeScript type-checking. The Zod schema validates the input at the API layer, but the service method has no type guarantee. If the Zod schema changes (e.g., a field is removed), the service will still compile and silently insert `undefined`.

**Fix:** Type the `data` parameter as `CreateDiscountInput` / `UpdateDiscountInput` from `discounts.validation.ts`. This would eliminate ~30 `as` casts.

### 5. `as any` casts on route handlers

**Files:** `apps/api/src/routes/admin/discounts.ts:68, 78, 182, 193`

The create and update route handlers use double `as any` casts:

```typescript
app.openapi(createDiscountRoute, (async (c: any) => { ... }) as any);
```

This disables all type checking on the handler function. The other routes in the same file do not need this cast. The `as any` is needed because the handler catches errors manually instead of letting the OpenAPI error handler do it.

**Fix:** Remove the try/catch and let the global error handler convert `AppError` subclasses to HTTP responses (consistent with all other routes in the codebase).

### 6. Inconsistent error handling between create/update and other routes

**Files:** `apps/api/src/routes/admin/discounts.ts:74-77, 189-191`

Create and update wrap errors manually:
```typescript
catch (error: unknown) {
    const err = error as { message?: string; statusCode?: number };
    throw new ApiError(err.statusCode || 400, "ERROR", err.message || "Unknown error");
}
```

This casts to a plain object and reads `statusCode`, but the core service throws `ConflictError` and `NotFoundError` which have a `status` property (not `statusCode`). The `statusCode` will be `undefined`, defaulting to 400 for all errors including 404s and 409s.

**Fix:** Remove the try/catch entirely. The core errors extend `AppError` which the global error handler already maps to HTTP status codes.

### 7. Timestamp conversion duplication

**Files:** `packages/core/src/modules/discounts/discounts.service.ts:108-112, 143-148`

Both `listDiscounts()` and `getDiscountById()` have identical timestamp conversion blocks:
```typescript
createdAt: discount.createdAt ? new Date(Number(discount.createdAt) * 1000).toISOString() : null,
updatedAt: discount.updatedAt ? new Date(Number(discount.updatedAt) * 1000).toISOString() : null,
// ... repeated for 5 fields
```

This logic is duplicated across both methods and is inconsistent with the schema's `{ mode: "timestamp" }` which should handle this automatically. Other domains use raw Drizzle timestamp handling.

**Fix:** Extract a `formatDiscountDates()` helper, or investigate why `mode: "timestamp"` is not handling the conversion (it may be that D1 returns raw integers).

---

## Pattern Violations

### 8. Toggle status route has inline DB logic

**Files:** `apps/api/src/routes/admin/discounts.ts:264-272`

The toggle status handler directly imports and uses `discounts` table + Drizzle `eq`/`sql` instead of delegating to the core service:

```typescript
await db.update(discounts).set({ isActive, updatedAt: sql`unixepoch()` }).where(eq(discounts.id, id));
```

This violates the "thin HTTP layer" convention: routes should delegate to `@scalius/core` services. The `discounts` and `sql` imports at `apps/api/src/routes/admin/discounts.ts:6-7` are only used for this one route.

**Fix:** Add a `toggleDiscountStatus(db, id, isActive)` function to `discounts.service.ts`.

### 9. Three separate form components with duplicated validation schemas

**Files:**
- `apps/admin/src/components/admin/discount/amount-off-products/types.ts` (formSchema)
- `apps/admin/src/components/admin/discount/AmountOffOrderForm.tsx:51-106` (inline formSchema)
- `apps/admin/src/components/admin/discount/FreeShippingForm.tsx:42-53` (inline formSchema)

Each discount type has its own Zod schema defined inline in the component file. These schemas overlap significantly (code, dates, usage limits, combinations) but diverge in small ways:

| Field | AmountOffProducts | AmountOffOrder | FreeShipping |
|-------|------------------|----------------|--------------|
| code min length | 1 | 3 (with regex) | 3 (no regex) |
| discountValue | `z.number()` | `z.coerce.number()` | not present |
| minQuantity | present | not present | not present |
| endDate < startDate check | not present | present | not present |
| combineWithOrderDiscounts | present | not present | present |
| combineWithShippingDiscounts | not present | present | not present |

The inconsistencies are subtle enough to cause bugs: entering a 1-character code works for AmountOffProducts but would fail for the other two.

**Fix:** Create a shared base schema in a common file, then extend per type with discriminated union or simple `.extend()`.

### 10. `applicationType` always `"get"` -- phantom BOGO infrastructure

**Files:**
- Schema: `packages/database/src/schema/marketing.ts:67, 84` (enum `["get"]`)
- Service: `packages/core/src/modules/discounts/discounts.service.ts:93-101` (casts to `'buy' | 'get'`)

The schema only allows `"get"` as a value, but the service casts to `'buy' | 'get'` and initializes `{ buy: [], get: [] }` buckets. The `buy` array will always be empty. This is documented dead BOGO infrastructure that adds confusion without value.

**Fix:** Remove the `buy` bucket from the service response. Change the cast from `'buy' | 'get'` to just `'get'`. If BOGO is planned, add the `"buy"` enum value to the schema first.

---

## Maintainability Concerns

### 11. Heavy coupling between eligibility, calculation, and collection expansion

**Files:** `packages/core/src/modules/discounts/discounts.eligibility.ts`

The eligibility file contains three distinct responsibilities:
1. `isDiscountValid()` -- checks all eligibility rules (dates, usage, applicability)
2. `calculateDiscountAmount()` -- computes the monetary discount
3. `expandCollectionsToProductIds()` -- resolves collection configs to product IDs

Both `isDiscountValid()` and `calculateDiscountAmount()` independently query `discountProducts` and `discountCollections`, then independently call `expandCollectionsToProductIds()`. For an `amount_off_products` discount, the public validate route calls both functions sequentially, resulting in 4+ redundant DB queries for the same data.

**Fix:** Extract a shared `getApplicableProductIds(db, discountId)` helper and call it once, passing the result to both functions.

### 12. Collection expansion parses JSON config -- fragile coupling

**Files:** `packages/core/src/modules/discounts/discounts.eligibility.ts:52-68`

`expandCollectionsToProductIds()` directly parses the `collection.config` JSON and knows about its internal structure (`categoryIds`, `productIds` arrays). If the collection config schema changes, this function silently breaks with a caught error.

```typescript
const config = JSON.parse(collection.config);
if (Array.isArray(config.categoryIds)) { ... }
if (Array.isArray(config.productIds)) { ... }
```

**Fix:** The collection module should export a typed `getProductIdsForCollections(db, collectionIds)` function rather than having the discounts module parse collection internals.

### 13. Admin UI has no shared discount form framework

**Files:** `apps/admin/src/components/admin/discount/`

Each discount type is a fully independent component with its own form, submit handler, date handling, error handling, and navigation. Adding a new field common to all types (e.g., a "description" field) requires editing 3 separate files. The `AmountOffProductsContainer` is well-decomposed into sections, but the other two forms are monolithic.

**Fix:** Extract a shared `DiscountFormShell` that handles common fields, submit logic, and navigation. Each type would provide only its type-specific fields.

### 14. No discount usage analytics beyond raw count/total

**Files:** `packages/core/src/modules/discounts/discounts.service.ts:75-90`

The list endpoint returns `usageCount` and `totalDiscountAmount` per discount, but there is no ability to:
- View which orders used a discount
- See usage over time
- Track conversion rate (views vs. redemptions)
- Export discount usage reports

This is a feature gap, not a bug, but it limits the admin's ability to evaluate discount effectiveness.

---

## Performance & Scalability

### 15. N+3 query pattern in `listDiscounts()`

**Files:** `packages/core/src/modules/discounts/discounts.service.ts:15-126`

`listDiscounts()` executes 4 sequential queries per page load:
1. `SELECT COUNT(*)` for total
2. `SELECT * FROM discounts` with pagination
3. `SELECT * FROM discountProducts WHERE discountId IN (...)`
4. `SELECT * FROM discountCollections WHERE discountId IN (...)`
5. `SELECT discountId, COUNT(*), SUM(amountDiscounted) FROM discountUsage WHERE discountId IN (...)` grouped

For a page of 10 discounts, this is fine. For 100 discounts with many associations, queries 3-4 could return large result sets. The `inArray()` clause for D1/SQLite is safe up to SQLite's 999-parameter limit.

**Optimization:** Use `db.batch()` to parallelize queries 3-5 (they are independent reads).

### 16. Duplicate product expansion in validate-then-calculate flow

**Files:**
- `packages/core/src/modules/discounts/discounts.eligibility.ts:217-258` (isDiscountValid)
- `packages/core/src/modules/discounts/discounts.eligibility.ts:322-349` (calculateDiscountAmount)

For `amount_off_products` discounts, both functions independently:
1. Query `discountProducts` for the discount
2. Query `discountCollections` for the discount
3. Call `expandCollectionsToProductIds()` which queries `collections` and `products`

The public `/discounts/validate` route calls both, resulting in 6+ DB queries where 3 would suffice. Under high traffic (Black Friday coupon usage), this doubles the DB load for every discount validation.

**Fix:** The validate route should pass the expanded product IDs from validation into calculation:
```typescript
const { applicableProductIds } = await isDiscountValid(db, code, ...);
const amount = await calculateDiscountAmount(db, discount, total, cartItems, shipping, applicableProductIds);
```

### 17. No index on `discountUsage.orderId`

**Files:** `packages/database/src/schema/marketing.ts:93-108`

The `discountUsage` table has an index on `(discountId, customerId)` but not on `orderId`. The eligibility check joins `discountUsage` with `orders` on `orderId` to find customer phone:

```sql
LEFT JOIN orders ON discountUsage.orderId = orders.id
WHERE discountUsage.discountId = ? AND orders.customerPhone = ?
```

Without an `orderId` index, this join scans the `discountUsage` table for each eligibility check. At low volume this is fine; at 100k+ usage records, it becomes a bottleneck.

**Fix:** Add `index("discount_usage_order_id_idx").on(table.orderId)` to the schema.

---

## Robustness Gaps

### 18. Soft-deleted discounts can still be validated

**Files:** `packages/core/src/modules/discounts/discounts.eligibility.ts:114-126`

The `isDiscountValid()` query filters on `isNull(discounts.deletedAt)`, so this is correctly handled. However, the code uniqueness check in `createDiscount()` also correctly filters on `isNull(discounts.deletedAt)`:

```typescript
// discounts.service.ts:154-158
.where(and(eq(discounts.code, data.code as string), isNull(discounts.deletedAt)))
```

This means a soft-deleted discount's code can be reused for a new discount, which is correct behavior but could be surprising: restoring the old discount would then create a duplicate code.

**Fix:** Add a check in `restoreDiscounts()` to verify no active discount has the same code before restoring.

### 19. Error swallowing in eligibility checks

**Files:** `packages/core/src/modules/discounts/discounts.eligibility.ts:177-179, 207-209`

Usage limit and per-customer checks catch all errors and `console.error` them:

```typescript
} catch (error: unknown) {
    console.error("Error checking discount usage count:", error);
}
```

If the DB query fails, the discount passes validation (fails open). A customer could use an expired-maxUses discount if the usage count query throws.

**Fix:** Re-throw the error or return `{ valid: false, error: "Unable to validate discount at this time" }` on DB errors.

### 20. `limitOnePerCustomer` bypassed for anonymous users

**Files:** `packages/core/src/modules/discounts/discounts.eligibility.ts:210-214`

When `limitOnePerCustomer` is true but no `customerPhone` is provided, the check is skipped entirely:

```typescript
} else if (discount.limitOnePerCustomer && !customerPhone) {
    console.log("One-use-per-customer discount, but no phone provided...");
}
```

This means anonymous cart validation (before the customer enters their phone) will pass, and the discount appears valid. If guest checkout is enabled, the customer might complete checkout without ever having their phone checked (depending on whether the queue's Phase 1b catches it).

The queue's Phase 1b checks `customerPhone` from `payload.orderData`, which IS set by the order creation flow, so the final guard does exist. But the storefront UX shows the discount as valid before checkout.

### 21. `calculateDiscountAmount()` fallback to full subtotal is dangerous

**Files:** `packages/core/src/modules/discounts/discounts.eligibility.ts:359-361`

For `amount_off_products` discounts, if no cart items match the applicable products but the discount has product/collection associations:

```typescript
if (applicableProductsTotal === 0 || applicableProductIds.size === 0) {
    applicableProductsTotal = subTotal;
}
```

This means a "10% off Product X" discount, when Product X is NOT in the cart, applies to the entire cart subtotal. The eligibility check (`isDiscountValid`) would reject this case, but if `calculateDiscountAmount` is called directly (or the eligibility check is bypassed), this fallback grants unintended discounts.

**Fix:** Return 0 when `applicableProductsTotal === 0` and `applicableProductIds.size > 0` (products are specified but none match).

---

## LLM-Friendliness

### Strengths

1. **Clear file organization**: Each concern has its own file (`service`, `validation`, `eligibility`). The index barrel re-exports everything cleanly.
2. **Consistent naming**: Files follow `{domain}.{concern}.ts` pattern. Functions are descriptive (`isDiscountValid`, `calculateDiscountAmount`, `expandCollectionsToProductIds`).
3. **Good README**: `packages/core/src/modules/discounts/README.md` documents the full domain including known gaps. An LLM reading this file gets immediate context.
4. **Schema comments**: The `combineWith*` flags have inline comments explaining they are reserved for future use.
5. **Prefixed IDs**: `disc_`, `dp_`, `dc_`, `du_` prefixes make IDs self-documenting in logs and DB queries.

### Weaknesses

1. **`Record<string, unknown>` parameters**: An LLM modifying `createDiscount()` or `updateDiscount()` has no type information about what fields are expected. It must cross-reference the Zod schema manually.
2. **Three separate form schemas**: An LLM asked to "add a field to discount forms" would need to identify and modify 3 independent schemas in 3 different files.
3. **Scattered discount logic**: Validation is in `eligibility.ts`, CRUD is in `service.ts`, usage recording is in `orders.queue.ts`, and the validate endpoint is in `routes/discounts.ts`. An LLM tracing "what happens when a discount is applied" must read 4+ files.
4. **Implicit knowledge about `applicationType`**: The `'buy' | 'get'` cast with only `'get'` ever being written is confusing without reading the README. An LLM might try to implement BOGO logic using the existing `buy` bucket.
5. **No JSDoc on public functions**: `isDiscountValid()`, `calculateDiscountAmount()`, `listDiscounts()` etc. have no JSDoc describing parameters, return types, or error cases. The file-level comments help but function-level docs would improve navigation.

---

## Recommended Changes

### Priority 1 (Bug fixes)

| # | Issue | File(s) | Fix |
|---|-------|---------|-----|
| 1 | `updateDiscount()` returns `{ success: true }` violating envelope | `discounts.service.ts:285` | Return `{ id }` |
| 6 | Error handler reads `statusCode` instead of `status` | `admin/discounts.ts:76,191` | Remove try/catch, let global handler map core errors |
| 19 | Eligibility checks fail open on DB errors | `discounts.eligibility.ts:177,207` | Return `{ valid: false }` on error instead of swallowing |
| 21 | Fallback to full subtotal when no products match | `discounts.eligibility.ts:359-361` | Return 0 when products are specified but none match cart |

### Priority 2 (Correctness)

| # | Issue | File(s) | Fix |
|---|-------|---------|-----|
| 2 | Dead `recordDiscountUsage()` function calling nonexistent endpoint | `storefront/lib/api/discounts.ts:74-114` | Delete the function |
| 18 | Restoring soft-deleted discount can create duplicate code | `discounts.service.ts:300-302` | Add code uniqueness check in `restoreDiscounts()` |
| 9 | Inconsistent code validation (min length 1 vs 3, regex vs none) | Three form schemas | Unify into shared base schema |

### Priority 3 (Code quality)

| # | Issue | File(s) | Fix |
|---|-------|---------|-----|
| 4 | Untyped `Record<string, unknown>` service parameters | `discounts.service.ts:153,213` | Type as `CreateDiscountInput` / `UpdateDiscountInput` |
| 5 | `as any` casts on route handlers | `admin/discounts.ts:68,78,182,193` | Remove try/catch, let global error handler work |
| 7 | Duplicated timestamp conversion | `discounts.service.ts:108-112,143-148` | Extract helper or fix `mode: "timestamp"` handling |
| 8 | Inline DB logic in toggle status route | `admin/discounts.ts:270` | Move to core service |
| 10 | Phantom BOGO buy/get infrastructure | `discounts.service.ts:60-101` | Remove `buy` bucket, simplify to string arrays |

### Priority 4 (Performance)

| # | Issue | File(s) | Fix |
|---|-------|---------|-----|
| 15 | Sequential queries in `listDiscounts()` | `discounts.service.ts:64-83` | Use `db.batch()` for parallel reads |
| 16 | Duplicate product expansion in validate+calculate | `discounts.eligibility.ts` + `routes/discounts.ts` | Pass expanded IDs from validation to calculation |
| 17 | Missing index on `discountUsage.orderId` | `marketing.ts:106-108` | Add index, generate migration |

### Priority 5 (Maintainability)

| # | Issue | File(s) | Fix |
|---|-------|---------|-----|
| 12 | Collection config parsing in eligibility | `discounts.eligibility.ts:52-68` | Extract to collections module |
| 13 | No shared discount form framework | Admin discount components | Create shared `DiscountFormShell` |
| 11 | No shared `getApplicableProductIds()` helper | `discounts.eligibility.ts` | Extract helper, use in both validation and calculation |
