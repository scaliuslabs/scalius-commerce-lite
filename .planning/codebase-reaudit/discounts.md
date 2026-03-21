# Discounts Domain Re-Audit

**Re-Audit Date:** 2026-03-21
**Previous Audit Date:** 2026-03-20

---

## Previous Finding Status

### Critical Issues

#### 1. `updateDiscount()` returns `{ success: true }` -- envelope violation
**Status: FIXED**

`packages/core/src/modules/discounts/discounts.service.ts:285` now returns `{ id }` instead of `{ success: true }`, consistent with `createDiscount()`.

#### 2. Missing `POST /discounts/usage` endpoint
**Status: STILL OPEN**

`apps/storefront/src/lib/api/discounts.ts:75-115` still exports `recordDiscountUsage()` which calls `POST /discounts/usage`. This endpoint still does not exist in `apps/api/src/routes/discounts.ts` (the only route is `GET /validate`).

Worse: `apps/storefront/src/lib/cart/server.ts:277` actively calls `recordDiscountUsage()` after order creation. This call silently fails (404 from API, function returns `false`). Usage recording works only via the queue path (`packages/core/src/modules/orders/orders.queue.ts:228-240`), so no data loss occurs, but the dead call wastes a network round-trip with 2 retries on every discount-bearing order.

**Impact:** On every COD order with a discount, the storefront makes 3 failed HTTP requests (1 + 2 retries) to a nonexistent endpoint before giving up. This adds latency and noise to logs.

**Fix:** Delete `recordDiscountUsage()` from `apps/storefront/src/lib/api/discounts.ts` and remove the call site at `apps/storefront/src/lib/cart/server.ts:275-283`.

#### 3. Race condition between validation and usage recording
**Status: STILL OPEN (accepted risk)**

The architecture is unchanged: HTTP handler validates, queue re-checks in Phase 1b (`packages/core/src/modules/orders/orders.queue.ts:252-317`), then writes in Phase 3. The Phase 1b guard narrows the window but cannot eliminate it under batched concurrent processing. Given D1 single-writer semantics, the practical risk remains negligible.

No action needed -- the previous audit already documented this as acceptable.

---

### Code Quality Issues

#### 4. Untyped `Record<string, unknown>` parameters in service layer
**Status: STILL OPEN**

`packages/core/src/modules/discounts/discounts.service.ts:153` (`createDiscount`) and line 213 (`updateDiscount`) still accept `data: Record<string, unknown>`. All field accesses still use `as` casts (e.g., `data.code as string`, `data.discountValue as number`). The exported `CreateDiscountInput` and `UpdateDiscountInput` types exist in `packages/core/src/modules/discounts/discounts.validation.ts:59-60` but are not used.

**Fix:** Change parameter types from `Record<string, unknown>` to `CreateDiscountInput` / `UpdateDiscountInput` and remove ~30 `as` casts per method.

#### 5. `as any` casts on route handlers
**Status: PARTIALLY FIXED**

The try/catch wrapping has been removed from the admin route handlers. The handlers no longer manually catch errors and re-wrap them with `new ApiError(...)`. However, `as any` casts remain on four handlers:

- `apps/api/src/routes/admin/discounts.ts:68` -- create handler `(async (c: any) => { ... }) as any`
- `apps/api/src/routes/admin/discounts.ts:152` -- getById handler `(async (c: any) => { ... }) as any`
- `apps/api/src/routes/admin/discounts.ts:177` -- update handler `(async (c: any) => { ... }) as any`

The `as any` casts disable type checking on the context parameter. The other handlers in the same file (list, bulkDelete, bulkRestore, delete, permanentDelete, toggleStatus, restore) do NOT need these casts.

**Root cause:** The `createDiscountSchema` and `updateDiscountSchema` use Zod `.refine()`, which produces a `ZodEffects` type that the OpenAPIHono handler type cannot infer. The getById handler has the cast for unknown reasons.

**Fix:** The `as any` on getById can likely be removed. For create/update, wrapping the refined schema in a way compatible with OpenAPIHono would fix the type inference, but this is a framework limitation -- the casts are the pragmatic approach.

#### 6. Inconsistent error handling between create/update and other routes
**Status: FIXED**

The try/catch blocks with manual `ApiError` construction have been removed from the create and update handlers at `apps/api/src/routes/admin/discounts.ts:68-73, 177-183`. Core errors (`NotFoundError`, `ConflictError`) now propagate to the global error handler.

#### 7. Timestamp conversion duplication
**Status: STILL OPEN**

`packages/core/src/modules/discounts/discounts.service.ts:108-112` (`listDiscounts`) and lines `143-148` (`getDiscountById`) still contain identical 5-line timestamp conversion blocks:

```typescript
createdAt: discount.createdAt ? new Date(Number(discount.createdAt) * 1000).toISOString() : null,
updatedAt: discount.updatedAt ? new Date(Number(discount.updatedAt) * 1000).toISOString() : null,
deletedAt: discount.deletedAt ? new Date(Number(discount.deletedAt) * 1000).toISOString() : null,
startDate: discount.startDate ? new Date(Number(discount.startDate) * 1000).toISOString() : null,
endDate: discount.endDate ? new Date(Number(discount.endDate) * 1000).toISOString() : null,
```

The schema declares `{ mode: "timestamp" }` on these columns, but the service manually converts anyway. Both methods have identical logic with no shared helper.

**Fix:** Extract a `formatDiscountTimestamps()` helper, or investigate whether removing the manual conversion works (Drizzle `mode: "timestamp"` should return JS Date objects, but D1 may return raw integers).

---

### Pattern Violations

#### 8. Toggle status route has inline DB logic
**Status: STILL OPEN**

`apps/api/src/routes/admin/discounts.ts:260` still directly uses `db.update(discounts).set(...)` instead of delegating to a core service function. The `discounts` table and `sql` imports at lines 6-7 exist solely for this handler.

**Fix:** Add a `toggleDiscountStatus(db, id, isActive)` function to `packages/core/src/modules/discounts/discounts.service.ts`.

#### 9. Three separate form components with duplicated validation schemas
**Status: FIXED**

A shared validation module has been created at `apps/admin/src/components/admin/discount/shared-validation.ts` which exports:
- `discountCodeSchema` -- standardized 3-50 char, alphanumeric+underscore+hyphen regex
- `sharedDiscountFields` -- common fields (minPurchaseAmount, maxUsesPerOrder, maxUses, limitOnePerCustomer, startDate, endDate, isActive)
- `refineEndDateAfterStart()` -- reusable date range validation

All three forms now import from this shared module:
- `apps/admin/src/components/admin/discount/amount-off-products/types.ts:2` -- imports `discountCodeSchema` and `sharedDiscountFields`
- `apps/admin/src/components/admin/discount/AmountOffOrderForm.tsx:50` -- imports all three exports
- `apps/admin/src/components/admin/discount/FreeShippingForm.tsx:41` -- imports `discountCodeSchema` and `sharedDiscountFields`

Code validation is now consistent: 3-char minimum, same regex, same field definitions across all three types.

**Remaining gap:** The `refineEndDateAfterStart()` refinement is applied by `AmountOffOrderForm` but NOT by `AmountOffProductsContainer` or `FreeShippingForm`. This means:
- AmountOffOrder: validates endDate > startDate (correct)
- AmountOffProducts: no endDate vs startDate cross-check (gap)
- FreeShipping: no endDate vs startDate cross-check (gap)

#### 10. `applicationType` always `"get"` -- phantom BOGO infrastructure
**Status: STILL OPEN**

`packages/core/src/modules/discounts/discounts.service.ts:60-61` still initializes `{ buy: [], get: [] }` buckets. Lines 93-101 still cast `applicationType` as `'buy' | 'get'` even though the schema at `packages/database/src/schema/marketing.ts:67` only allows `["get"]`. The `buy` array is always empty.

**Fix:** Simplify the response to use `string[]` instead of `{ buy: string[], get: string[] }`. Only change when willing to update the admin UI that consumes this shape.

---

### Maintainability Concerns

#### 11. Heavy coupling between eligibility, calculation, and collection expansion
**Status: FIXED**

`packages/core/src/modules/discounts/discounts.eligibility.ts` now computes `applicableProductIds` during validation (lines 221-263) and returns them in the validation result (line 280). The calculation function `calculateDiscountAmount()` accepts an optional `precomputedProductIds` parameter (line 301) and skips re-querying when provided.

The public validation route at `apps/api/src/routes/discounts.ts:91-98` passes the pre-computed IDs:
```typescript
const discountAmount = await calculateDiscountAmount(
  db,
  validationResult.discount,
  total || 0,
  cartItems,
  shippingCost || 0,
  validationResult.applicableProductIds,
);
```

This eliminates the duplicate DB queries in the validate-then-calculate flow.

#### 12. Collection expansion parses JSON config -- fragile coupling
**Status: STILL OPEN**

`packages/core/src/modules/discounts/discounts.eligibility.ts:52-68` still directly parses `collection.config` JSON and accesses `config.categoryIds` and `config.productIds` arrays. The discounts module still knows collection config internals.

**Fix:** The collections module should export a `getProductIdsForCollections(db, collectionIds)` function. The discounts module would call that instead of parsing collection config directly.

#### 13. Admin UI has no shared discount form framework
**Status: PARTIALLY FIXED**

The shared validation module (`shared-validation.ts`) addresses the schema duplication. The AmountOffProducts form is well-decomposed into section components. However, each discount type still has its own fully independent:
- Submit handler (fetch + navigate + toast)
- Date picker rendering
- Form initialization logic (defaultValues coercion from strings to Dates)

Adding a common field still requires editing 3 files, though the validation is now consistent.

#### 14. No discount usage analytics beyond raw count/total
**Status: STILL OPEN**

Feature gap, unchanged. `listDiscounts()` returns `usageCount` and `totalDiscountAmount` per discount but no per-order breakdown, time-series, or conversion tracking.

---

### Performance & Scalability

#### 15. N+3 query pattern in `listDiscounts()`
**Status: STILL OPEN**

`packages/core/src/modules/discounts/discounts.service.ts:64-83` still executes three sequential queries (discountProducts, discountCollections, discountUsage) after the main select. These are independent reads that could run in parallel with `db.batch()`.

#### 16. Duplicate product expansion in validate-then-calculate flow
**Status: FIXED**

See item 11. The `precomputedProductIds` parameter eliminates redundant queries.

#### 17. Missing index on `discountUsage.orderId`
**Status: STILL OPEN**

`packages/database/src/schema/marketing.ts:106-108` has no index on `discountUsage.orderId`. The existing indexes are only `(discountId, customerId)`. Searching for a "discount_usage_order_id_idx" in the migration snapshots returns zero results -- only the FK constraint exists, not an index.

The eligibility check at `packages/core/src/modules/discounts/discounts.eligibility.ts:188-200` joins `discountUsage` with `orders` on `orderId` for the per-customer phone lookup, and the queue re-check at `packages/core/src/modules/orders/orders.queue.ts:271-282` does the same join.

**Fix:** Add `index("discount_usage_order_id_idx").on(table.orderId)` to the schema and generate a migration.

---

### Robustness Gaps

#### 18. Soft-deleted discounts can still be restored with duplicate codes
**Status: STILL OPEN**

`packages/core/src/modules/discounts/discounts.service.ts:300-302` (`restoreDiscounts`) still blindly sets `deletedAt = null` without checking if an active discount with the same code exists. This could create two active discounts with the same code.

**Fix:** Before restoring, check for code conflicts with existing active discounts.

#### 19. Error swallowing in eligibility checks
**Status: FIXED**

`packages/core/src/modules/discounts/discounts.eligibility.ts:177-180` and `209-211` now return `{ valid: false, error: "Unable to validate discount at this time" }` on DB errors instead of silently continuing. The discount no longer passes validation when DB queries fail.

#### 20. `limitOnePerCustomer` bypassed for anonymous users
**Status: STILL OPEN (acceptable)**

`packages/core/src/modules/discounts/discounts.eligibility.ts:212-216` still skips the per-customer check when no `customerPhone` is provided. The queue Phase 1b guard at `packages/core/src/modules/orders/orders.queue.ts:270-291` checks `customerPhone` from the order payload, so the final guard exists.

This is acceptable UX: the discount appears valid during browsing, and the definitive check happens at order processing time.

#### 21. `calculateDiscountAmount()` fallback to full subtotal is dangerous
**Status: FIXED**

`packages/core/src/modules/discounts/discounts.eligibility.ts:376-380` now correctly handles the case:

```typescript
if (applicableProductIds.size === 0) {
    applicableProductsTotal = subTotal;
} else if (applicableProductsTotal === 0) {
    return 0;
}
```

When products are specified (`applicableProductIds.size > 0`) but none match the cart (`applicableProductsTotal === 0`), the function returns 0 instead of falling back to the full subtotal. The subtotal fallback only applies when no product/collection restrictions exist at all.

---

## New Issues Found

### N1. FreeShippingForm sends `valueType: "free"` but schema accepts it differently

**Files:** `apps/admin/src/components/admin/discount/FreeShippingForm.tsx:110-111`

```typescript
const payload = {
    ...ensuredValues,
    type: "free_shipping",
    valueType: "free",
    discountValue: 100,
    ...
};
```

The `discountValue: 100` is arbitrary -- for `free_shipping` discounts, `calculateDiscountAmount()` at `packages/core/src/modules/discounts/discounts.eligibility.ts:303-305` ignores the value and returns the full `shippingCost`. The hardcoded `100` works but is misleading -- it appears to mean "100%" but is never used in any calculation.

**Impact:** Low. The value is stored but never read during calculation. If a future developer looks at the stored data, they might incorrectly infer the discount is "100% off" rather than "free shipping."

**Fix:** Consider using `discountValue: 0` to clearly signal the value is unused, or add a comment explaining the convention.

### N2. FreeShippingForm does not apply `refineEndDateAfterStart` validation

**Files:** `apps/admin/src/components/admin/discount/FreeShippingForm.tsx:43-48`

```typescript
const formSchema = z.object({
  code: discountCodeSchema,
  ...sharedDiscountFields,
  combineWithProductDiscounts: z.boolean(),
  combineWithOrderDiscounts: z.boolean(),
});
```

The form imports `discountCodeSchema` and `sharedDiscountFields` from `shared-validation.ts` but does NOT import or apply `refineEndDateAfterStart()`. The `AmountOffOrderForm` correctly uses `refineEndDateAfterStart(z.object({...}))`, but FreeShippingForm does not. A user can set an end date before the start date and the form will submit without error.

Similarly, the `AmountOffProductsContainer` form schema at `apps/admin/src/components/admin/discount/amount-off-products/types.ts:18-42` also does not apply the `refineEndDateAfterStart` refinement.

**Impact:** Medium. Two of three discount forms allow invalid date ranges. The API-side validation in `packages/core/src/modules/discounts/discounts.validation.ts` does NOT have an endDate-after-startDate refinement either, so the invalid dates will be stored in the database.

**Fix:** Apply `refineEndDateAfterStart()` to all three form schemas AND add the same refinement to the server-side `createDiscountSchema` / `updateDiscountSchema` in `discounts.validation.ts`.

### N3. `discounts` table has a unique index on `code` -- but soft-delete creates conflicts

**Files:** `packages/database/src/schema/marketing.ts:55`

```typescript
uniqueIndex("discounts_code_unique_idx").on(table.code),
```

The unique index on `code` is unconditional -- it applies to both active and soft-deleted rows. This means:
1. Soft-deleting a discount with code "SUMMER10" still occupies the unique constraint
2. Creating a new discount with code "SUMMER10" will fail at the DB level, even though the service's `createDiscount()` at `discounts.service.ts:154-158` only checks `isNull(discounts.deletedAt)`

The service correctly filters out deleted discounts in its uniqueness check, but the DB-level unique index will reject the insert before the service logic matters.

**Impact:** High. An admin cannot reuse a discount code after soft-deleting the original. They must permanently delete it first. This is a confusing UX -- the code appears available (passes the service-level check) but the DB rejects the insert.

**Fix:** Either (a) change the unique index to a partial index `WHERE deleted_at IS NULL` (SQLite supports this: `CREATE UNIQUE INDEX ... WHERE deleted_at IS NULL`), or (b) document that permanently deleting is required to reuse codes. Note: Drizzle ORM may not support partial unique indexes natively, so a raw SQL migration may be needed.

### N4. `as any` on `db.batch()` calls -- Drizzle D1 typing workaround

**Files:**
- `packages/core/src/modules/discounts/discounts.service.ts:209`
- `packages/core/src/modules/discounts/discounts.service.ts:284`

Both `createDiscount` and `updateDiscount` build a `batchOps: unknown[]` array and cast it `as any` when calling `db.batch()`. The comments note "Drizzle D1 batch() requires specific tuple types" as the reason.

**Impact:** Low. This is a known Drizzle limitation (batch requires exact tuple typing for return type inference). The `eslint-disable` comments are present. This is the standard workaround across the codebase.

No fix needed -- this is framework-imposed.

### N5. `FreeShippingForm` sends dates as Date objects, not ISO strings

**Files:** `apps/admin/src/components/admin/discount/FreeShippingForm.tsx:112-113`

```typescript
const payload = {
    ...ensuredValues,
    startDate: ensuredValues.startDate,
    endDate: values.endDate,
};
```

The `AmountOffOrderForm` at lines 190-191 converts dates to ISO strings before sending:
```typescript
startDate: values.startDate.toISOString(),
endDate: values.endDate ? values.endDate.toISOString() : null,
```

The `FreeShippingForm` sends raw Date objects. When `JSON.stringify()` serializes a Date, it calls `.toISOString()` implicitly, so the result is the same. However, this inconsistency could cause bugs if the serialization behavior changes or if additional middleware processes the payload.

**Impact:** Low. Works today due to `JSON.stringify` behavior, but is fragile.

**Fix:** Consistently convert dates to ISO strings in all form submit handlers, matching the `AmountOffOrderForm` pattern.

### N6. `FreeShippingForm` mutates `startDate` via `setHours()` on a form value

**Files:** `apps/admin/src/components/admin/discount/FreeShippingForm.tsx:299-301`

```typescript
disabled={(date) =>
    date < new Date(form.getValues("startDate")?.setHours(0, 0, 0, 0) || new Date().setHours(0, 0, 0, 0))
}
```

`setHours()` is a **mutating** method -- it modifies the Date object in place and returns the new timestamp. Calling `form.getValues("startDate")?.setHours(0, 0, 0, 0)` mutates the form's `startDate` value to midnight. This runs on every render of the calendar popover, so the startDate is silently zeroed out to midnight on first calendar interaction.

The `AmountOffOrderForm` at line 586 avoids this by using `form.getValues("startDate") || new Date()` without `setHours()`.

**Impact:** Medium. The startDate time component is silently zeroed out when the admin opens the endDate calendar picker. Since dates are stored as unix timestamps, the time-of-day matters.

**Fix:** Use `new Date(form.getValues("startDate")?.getTime() ?? Date.now()).setHours(0, 0, 0, 0)` to create a copy instead of mutating in place.

---

## Scoring

| Category | Score | Notes |
|----------|-------|-------|
| Data integrity | 6/10 | N3 (unique index vs soft-delete) is a real usability bug; #18 (restore duplicate codes) compounds it. Error handling on eligibility checks is now fixed. |
| Code quality | 5/10 | `Record<string, unknown>` params with ~60 `as` casts across create/update (#4), phantom BOGO infrastructure (#10), duplicated timestamp conversion (#7), inline DB logic in route (#8). |
| Type safety | 5/10 | `as any` on 3 route handlers (#5), untyped service parameters (#4), `as 'buy' \| 'get'` casts on a single-value enum (#10). |
| Consistency | 7/10 | Form validation schema unification is a clear improvement (#9 fixed). Date handling inconsistency between forms (N2, N5, N6) remains. |
| Robustness | 7/10 | Error swallowing fixed (#19), subtotal fallback fixed (#21), fail-open on DB errors fixed. Remaining: dead endpoint calls (#2), restore code conflict (#18). |
| Performance | 6/10 | Duplicate product expansion eliminated (#16 fixed). Sequential queries in list (#15) and missing orderId index (#17) unchanged. |
| Maintainability | 6/10 | Shared validation module is a win. Collection config parsing coupling (#12) and lack of shared form framework (#13) remain. |

**Overall: 6/10** (previous audit equivalent: ~5/10)

Key improvements: envelope violation fixed, error swallowing fixed, subtotal fallback fixed, form validation unified, duplicate queries eliminated. The domain moved from "concerning" to "functional with known debt."

---

## Recommended Changes (Updated Priorities)

### Priority 1 (Bug fixes)

| # | Issue | File(s) | Fix |
|---|-------|---------|-----|
| N3 | Unique index on `code` blocks reuse after soft-delete | `packages/database/src/schema/marketing.ts:55` | Change to partial unique index `WHERE deleted_at IS NULL` via raw migration |
| N2 | FreeShippingForm and AmountOffProducts allow endDate before startDate | `FreeShippingForm.tsx:43-48`, `types.ts:18-42`, `discounts.validation.ts:55-57` | Apply `refineEndDateAfterStart()` to all form schemas and server-side validation |
| N6 | FreeShippingForm mutates startDate via `setHours()` | `FreeShippingForm.tsx:299-301` | Create copy of Date before calling setHours |

### Priority 2 (Dead code / correctness)

| # | Issue | File(s) | Fix |
|---|-------|---------|-----|
| 2 | Dead `recordDiscountUsage()` calling nonexistent endpoint, actively called on every discount-bearing order | `apps/storefront/src/lib/api/discounts.ts:75-115`, `apps/storefront/src/lib/cart/server.ts:275-283` | Delete function and call site |
| 18 | Restoring soft-deleted discount can create duplicate code | `packages/core/src/modules/discounts/discounts.service.ts:300-302` | Add code uniqueness check before restoring |

### Priority 3 (Code quality)

| # | Issue | File(s) | Fix |
|---|-------|---------|-----|
| 4 | Untyped `Record<string, unknown>` service parameters | `packages/core/src/modules/discounts/discounts.service.ts:153,213` | Type as `CreateDiscountInput` / `UpdateDiscountInput` |
| 7 | Duplicated timestamp conversion in list and getById | `packages/core/src/modules/discounts/discounts.service.ts:108-112,143-148` | Extract shared helper |
| 8 | Inline DB logic in toggle status route | `apps/api/src/routes/admin/discounts.ts:260` | Move to `toggleDiscountStatus()` in service |
| 10 | Phantom BOGO `buy`/`get` buckets | `packages/core/src/modules/discounts/discounts.service.ts:60-101` | Simplify to `string[]` |

### Priority 4 (Performance)

| # | Issue | File(s) | Fix |
|---|-------|---------|-----|
| 15 | Sequential queries in `listDiscounts()` | `packages/core/src/modules/discounts/discounts.service.ts:64-83` | Use `db.batch()` for parallel reads |
| 17 | Missing index on `discountUsage.orderId` | `packages/database/src/schema/marketing.ts:106-108` | Add index, generate migration |

### Priority 5 (Maintainability)

| # | Issue | File(s) | Fix |
|---|-------|---------|-----|
| 12 | Collection config parsing in eligibility | `packages/core/src/modules/discounts/discounts.eligibility.ts:52-68` | Move to collections module |
| N5 | Inconsistent date serialization in form submit handlers | `FreeShippingForm.tsx:112-113` vs `AmountOffOrderForm.tsx:190-191` | Always use `.toISOString()` |
