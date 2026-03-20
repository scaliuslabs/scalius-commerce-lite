# Inventory Domain Audit

**Date:** 2026-03-20
**Scope:** Complete vertical slice -- schema, core services, API routes, admin UI

## Summary

The inventory domain is one of the most well-engineered modules in the codebase. It has a clean separation of concerns across 10 focused files, consistent CAS (compare-and-swap) patterns for stock operations, a well-documented state machine in `inventory-transitions.ts`, and thorough audit logging. The README at `packages/core/src/modules/inventory/README.md` is excellent and accurately documents the current implementation.

There are, however, several concrete issues ranging from an envelope contract violation (Critical) to inconsistent CAS usage across release/restore operations (significant robustness gap), dead movement types, and a UI that duplicates server-side sorting. The module is highly LLM-friendly due to its modular file structure and comprehensive README.

**Files analyzed:**
- `packages/database/src/schema/inventory.ts` -- inventoryMovements, productLowStockAlerts tables
- `packages/database/src/schema/products.ts` -- productVariants table (stock columns)
- `packages/core/src/modules/inventory/*.ts` -- 10 service files + README
- `apps/api/src/routes/admin/inventory.ts` -- 7 OpenAPI routes
- `apps/admin/src/components/admin/InventoryManager.tsx` -- Admin UI (638 lines)

---

## Critical Issues

### 1. Response Envelope Violation in `adjustInventory()` Return

**Files:** `packages/core/src/modules/inventory/inventory.service.ts` (line 241-247), `apps/api/src/routes/admin/inventory.ts` (line 80-86, 259)

The `adjustInventory()` service function returns `{ success: true, variantId, previousStock, newStock, delta }`. This `success: true` field is redundant and violates the project's envelope contract documented in CLAUDE.md:

> The `T` passed to `ok(c, T)` must be the FINAL payload -- never include redundant `success: true` or `data:` wrapping inside `T`.

The API route at line 259 does `return ok(c, result)`, which wraps it in `{ success: true, data: { success: true, ... } }`. The `adjustResultSchema` at line 80-86 even declares `success: z.boolean()` in the OpenAPI spec, codifying this violation.

**Impact:** Double-nested `success` field. While not currently causing parse failures (the admin UI only checks the HTTP status), any future consumer reading `data.success` would get the inner value, not the envelope. This is the #1 production bug pattern per CLAUDE.md.

**Fix:**
- Remove `success: true` from the return object in `adjustInventory()` (line 242)
- Remove `success: z.boolean()` from `adjustResultSchema` in the route file (line 81)
- The `StockAdjustResult` and `StockSetResult` types in `stock-adjustment.ts` are correct -- they do NOT include `success`

### 2. `release.ts` and `restore.ts` Skip CAS -- Race Window on Concurrent Releases

**Files:** `packages/core/src/modules/inventory/release.ts` (lines 48-58), `packages/core/src/modules/inventory/restore.ts` (lines 69-71)

The comment in `release.ts` (line 17) says:

> Does NOT use optimistic locking because releasing is always safe to apply (we use MAX(0, ...) to guard against underflow, and a missed release never causes overselling -- it only over-reserves).

This reasoning is sound for the `reservedStock` decrement. However, both `release.ts` and `restore.ts` also increment `stockVersion` without checking it. If two concurrent releases hit the same variant, both will succeed but the `stockVersion` will only increment by 1 instead of 2. This means a subsequent CAS-protected operation (reserve, deduct, adjust) will read a `stockVersion` that does not reflect all preceding mutations.

**Scenario:**
1. Thread A reads variant: `stockVersion=5, reservedStock=10`
2. Thread B reads variant: `stockVersion=5, reservedStock=10`
3. Thread A releases 3 units: `UPDATE SET reservedStock=MAX(0, 10-3), stockVersion=6`
4. Thread B releases 2 units: `UPDATE SET reservedStock=MAX(0, 7-2), stockVersion=7` (but Thread B calculated from stale `reservedStock=10`)
5. Result: `reservedStock=5` -- Thread B's MAX(0, ...) uses the column value so the actual SQL is `MAX(0, reservedStock - 2)` which correctly yields 5.

Wait -- re-reading the SQL, the `reservedStock` decrement uses `${productVariants.reservedStock} - ${quantity}`, which is a column reference, not the read value. So the concurrent case actually works correctly for the stock counter itself. The `stockVersion` double-increment is a minor inconsistency but does not cause data corruption because no operation reads the version before writing it in the non-CAS path.

**Revised assessment:** This is NOT a data corruption bug. The non-CAS approach in release/restore is intentionally correct. However, the `stockVersion` bump without CAS means:
- The version counter is "best effort" for non-CAS operations
- Movement logs may record slightly stale `previousStock` values (read-before-write gap)

**Impact:** Low. Movement audit log accuracy only. No overselling risk.

---

## Code Quality Issues

### 3. Duplicate Validation Logic in `reserve.ts`

**Files:** `packages/core/src/modules/inventory/reserve.ts` (lines 57-108 vs 458-492)

The stock availability validation logic is duplicated between `reserveStock()` (inline checks at lines 57-108) and `validateStockAvailability()` (helper function at lines 458-492). The `reserveStock()` function does NOT call `validateStockAvailability()` -- only `reserveStockBatch()` uses the extracted helper. The logic is identical but maintained in two places.

**Fix:** Refactor `reserveStock()` to call `validateStockAvailability()` instead of inlining the checks.

### 4. Two `any` Casts in API Route for Alerts

**File:** `apps/api/src/routes/admin/inventory.ts` (lines 185-197)

```typescript
app.openapi(alertsRoute, (async (c: any) => {
    ...
    return ok(c, result);
}) as any);
```

The alerts route handler casts both the function and its parameter to `any` to work around a Hono/OpenAPI typing issue. The other 6 route handlers in the same file do not need this cast.

**Fix:** The root cause is likely a mismatch between the route definition's response schema and the actual return type. The handler reuses `getInventoryOverview()` with `section: "alerts"` which returns `{ alerts }`, but the route schema declares `{ alerts: z.array(inventoryAlertSchema) }` wrapped in `successEnvelope()`. Aligning the types should eliminate the cast.

### 5. `createdAt: z.any()` in Movement Schema

**File:** `apps/api/src/routes/admin/inventory.ts` (line 50)

The `inventoryMovementSchema` uses `z.any()` for `createdAt` and `alertSentAt` / `acknowledgedAt` / `resolvedAt` fields. This defeats OpenAPI type documentation -- consumers cannot determine whether the field is a number (unix timestamp) or a string (ISO date).

Since Drizzle returns `Date` objects that serialize to ISO strings, the correct schema is `z.string()` (or `z.number()` if the column mode is `number`).

### 6. `passthrough()` Overuse in Route Schemas

**File:** `apps/api/src/routes/admin/inventory.ts` (lines 29, 53, 69, 78, 86, 108, 117)

Seven of the inline response schemas use `.passthrough()`, which allows arbitrary additional fields. This weakens the OpenAPI contract and can leak internal fields to consumers. Only use `.passthrough()` when the shape is genuinely dynamic.

### 7. Unused Import `ArrowUpDown` in Admin UI

**File:** `apps/admin/src/components/admin/InventoryManager.tsx` (line 6)

`ArrowUpDown` is imported from `lucide-react` but only used once in the Adjust button. This is minor but worth noting.

---

## Pattern Violations

### 8. `adjustInventory()` Uses Error Strings Instead of Typed Errors

**File:** `packages/core/src/modules/inventory/inventory.service.ts` (lines 195-197)

The function throws a plain `Error("Variant not found")` which the API route catches by string matching:

```typescript
if (error instanceof Error && error.message === "Variant not found") throw new NotFoundError(error.message);
```

Meanwhile, `stock-adjustment.ts` (lines 52-53) correctly uses typed errors:

```typescript
throw new NotFoundError("Variant not found");
```

This is inconsistent. The `adjustInventory()` function already imports `NotFoundError` and `ConflictError` from `@scalius/core/errors` (line 7) -- it uses `ConflictError` on line 257 but not `NotFoundError` on line 196.

**Fix:** Replace `throw new Error("Variant not found")` with `throw new NotFoundError("Variant not found")` in `inventory.service.ts` line 196. Then the API route can remove the string-matching catch and just let it propagate.

Wait -- re-reading line 196: it actually does `throw new NotFoundError("Variant not found")`. Let me re-check.

Looking at `inventory.service.ts` line 195-197 more carefully: it already throws `NotFoundError`. But the API route at lines 260-261 still does string matching:

```typescript
if (error instanceof Error && error.message === "Variant not found") throw new NotFoundError(error.message);
```

This is redundant -- the service already throws `NotFoundError`, and the global error handler would catch it. The API route is re-wrapping it unnecessarily. Same pattern on lines 333-334 and 375-376 for the scanner routes.

**Fix:** Remove the try/catch wrapping in the API route handlers for `adjustRoute`, `stockAdjustRoute`, and `stockSetRoute`. The service layer already throws the correct error types.

### 9. `getInventoryOverview()` Is a God Function

**File:** `packages/core/src/modules/inventory/inventory.service.ts` (lines 9-170)

This single function handles 3 completely different query shapes based on the `section` parameter (variants, movements, alerts). It returns a polymorphic `{ variants?, movements?, alerts?, pagination?, stats? }` object. This makes it hard for TypeScript to narrow the return type and forces the API route to declare a loose schema with all fields optional.

**Impact:** The caller must know which fields are present based on the `section` argument. TypeScript cannot enforce this at the type level.

**Fix:** Split into `getVariantsOverview()`, `getMovementsOverview()`, and `getAlertsOverview()` with distinct return types. This would also allow separate API routes instead of the current "one route, many shapes" design.

### 10. Alert Route Reuses `getInventoryOverview()` Instead of Direct Query

**File:** `apps/api/src/routes/admin/inventory.ts` (lines 185-197)

The dedicated `/alerts` GET endpoint calls `getInventoryOverview(db, { section: "alerts", ... })` with hardcoded dummy parameters (`search: "", status: "all", page: 1, limit: 50`). This is wasteful and confusing -- a dedicated alert query function would be cleaner.

---

## Maintainability Concerns

### 11. `inventory.service.ts` Has Competing Responsibilities

**File:** `packages/core/src/modules/inventory/inventory.service.ts`

This file contains two unrelated concerns:
1. `getInventoryOverview()` -- read-only dashboard data fetching (lines 9-170)
2. `adjustInventory()` -- write operation with CAS retry (lines 172-260)

Meanwhile, `stock-adjustment.ts` also contains write operations (`adjustStock()`, `setStock()`) that do similar CAS logic. The naming distinction between "adjustInventory" (in `inventory.service.ts`) and "adjustStock" (in `stock-adjustment.ts`) is subtle and confusing.

**Differences:**
- `adjustInventory()` supports `pool` parameter (stock vs preorderStock), has a `reason` enum, and returns `{ success: true, ... }`
- `adjustStock()` is scanner-specific, only operates on `stock` pool, and returns `StockAdjustResult` (no `success` field)

These should ideally be unified or more clearly differentiated.

### 12. Movement Log `previousStock`/`newStock` Accuracy

**Files:** Multiple

Several operations record inaccurate `previousStock` and `newStock` in movement logs:

- `reserve.ts` line 140-142: For regular pool, `newStock` is set to `variant.stock` (unchanged), but the actual available stock has decreased. The movement log does not reflect the `reservedStock` change, only the `stock` change.
- `release.ts` internal rollback (line 520-521): Records `previousStock: 0, newStock: 0` as "approximate -- not critical for rollback logs"
- `deduct.ts` internal rollback (lines 187-188): Same `previousStock: 0, newStock: 0` pattern

These are best-effort audit logs, but they reduce the value of the movement history for debugging.

### 13. README States `restored` Movement Type Is Never Written -- But It Is

**File:** `packages/core/src/modules/inventory/README.md` (line 244)

The README says: "Movement type `restored` is defined in `MovementEntry.type` but never written by any operation -- `restoreDeductedStock()` logs as `adjusted` instead"

But `restore.ts` line 83 actually writes `type: "restored"`. The README is stale.

---

## Performance & Scalability

### 14. Stats Query Scans Full Table on Every Variants Page Load

**File:** `packages/core/src/modules/inventory/inventory.service.ts` (lines 68-79)

Every request to the variants section runs a full-table aggregate query to compute stats:

```typescript
const statsResult = await db
    .select({
        totalVariants: sql<number>`count(*)`,
        totalOnHand: sql<number>`COALESCE(SUM(${productVariants.stock}), 0)`,
        ...
    })
    .from(productVariants)
    .where(isNull(productVariants.deletedAt))
    .get();
```

This query has no LIMIT and scans all non-deleted variants. For a store with thousands of variants, this will be slow. The stats are computed on every page navigation, not cached.

**Fix:** Consider caching stats with a short TTL (e.g., 60 seconds) or computing them only when the stats card is explicitly requested via a separate parameter.

### 15. Count Query Duplicates Filter Logic

**File:** `packages/core/src/modules/inventory/inventory.service.ts` (lines 61-66)

The count query duplicates the exact same WHERE conditions and JOIN as the main query. D1/SQLite does not support `SQL_CALC_FOUND_ROWS`, so this is necessary, but the conditions array could be extracted to avoid duplication.

### 16. Client-Side Sorting Defeats Pagination

**File:** `apps/admin/src/components/admin/InventoryManager.tsx` (lines 213-228)

The UI sends `sort` and `order` parameters in the API request (lines 157-158) but then re-sorts the results client-side:

```typescript
const displayVariants = [...variants].sort((a, b) => { ... });
```

The comment says "Sort function applied client-side if API doesn't support all sorts yet." The API route does NOT pass sort/order to the service -- `getInventoryOverview()` always orders by `available ASC`. This means:
- Page 1 with server sort `available ASC` + client sort `sku DESC` = wrong results
- Variants on page 2 might sort before variants on page 1 by client criteria

**Fix:** Either implement server-side sorting in `getInventoryOverview()` or remove client-side sorting to avoid misleading results.

### 17. Movements Query Lacks Count Filtering

**File:** `packages/core/src/modules/inventory/inventory.service.ts` (line 101)

The movements count query runs `count(*)` on the entire `inventoryMovements` table with no filtering. The data query also has no search/filter capability. Over time, this table will grow unbounded (every stock operation creates a row). Count queries on large tables are expensive in SQLite.

### 18. Expiry Sweep Has No Batch Limit

**File:** `packages/core/src/modules/inventory/expiry.ts`

`releaseExpiredReservations()` processes ALL expired reservations in a single invocation. If 10,000 reservations expire simultaneously (e.g., after a flash sale timeout), the function will:
1. Run a complex subquery-based SELECT
2. Issue N individual UPDATE + INSERT pairs (not batched)

This could easily exceed Cloudflare Worker CPU limits (50ms for free, 30s for paid). The README acknowledges this gap.

**Fix:** Add a `batchLimit` parameter (e.g., 100) and paginate the sweep. Return a flag indicating whether more work remains.

---

## Robustness Gaps

### 19. `deductMultiple()` Rollback Cannot Fail Gracefully

**File:** `packages/core/src/modules/inventory/deduct.ts` (lines 129-163)

If deduction of variant C fails after variants A and B succeeded, the function rolls back A and B using `restoreDeductedStock()`. But `restoreDeductedStock()` (the internal one at line 166) does NOT use CAS and has no retry logic. If the rollback fails:
- No error is thrown (it's fire-and-forget)
- Stock will be permanently decremented without a matching reservation
- The caller receives `success: false` but cannot determine rollback status

This contrasts with `reserveStockBatch()` which uses a batch rollback with proper error handling.

### 20. `inventory-transitions.ts` CAS Operations Outside of Caller's Batch

**File:** `packages/core/src/modules/inventory/inventory-transitions.ts` (lines 44-124)

The `buildInventoryStatements()` function performs CAS operations (deduct/release/reserve) eagerly via their own DB calls, then returns only the `inventoryAction` UPDATE statement for the caller to include in their batch. This means:

- The stock changes are NOT atomic with the order status change
- If the caller's batch fails (e.g., CAS conflict on the order version), the stock changes are already committed
- The function comment acknowledges this: "The CAS-based stock operations still execute internally"

**Impact:** If an order update fails after inventory was already deducted, the stock is gone but the order status is unchanged. The idempotency guard (`inventoryAction` check) prevents double-deduction on retry, but the first deduction is orphaned until the retry succeeds.

This is documented and appears to be an accepted trade-off given D1's batch limitations (batch is all-or-nothing but individual CAS operations cannot be expressed as batch queries).

### 21. `reserveMultiple()` Rollback Is Not Atomic

**File:** `packages/core/src/modules/inventory/reserve.ts` (lines 177-205)

When variant C fails to reserve, the rollback of variants A and B happens sequentially via `releaseReservationInternal()`. If the rollback of variant A fails, variant B's rollback is never attempted (the loop exits). This could leave orphaned reservations.

`reserveStockBatch()` (line 221) was created specifically to address this limitation, but `reserveMultiple()` is still used by admin order creation and `inventory-transitions.ts`.

### 22. Alert Check Missing After Release Operations

**File:** `packages/core/src/modules/inventory/release.ts`, `packages/core/src/modules/inventory/restore.ts`

`checkAndAlertLowStock()` is called after:
- `adjustInventory()` (negative delta only) -- `inventory.service.ts` line 238
- `adjustStock()` (negative delta only) -- `stock-adjustment.ts` line 85
- `setStock()` (negative delta only) -- `stock-adjustment.ts` line 168
- `deductOrderStock()` -- `inventory-transitions.ts` line 185

But NOT called after:
- `releaseReservation()` -- stock availability increases, should auto-resolve alerts
- `restoreDeductedStock()` -- stock increases, should auto-resolve alerts
- `releaseExpiredReservations()` -- reservedStock decreases (available increases)

The `checkAndAlertLowStock()` function already handles resolution (lines 128-139), so adding calls after positive stock changes would auto-resolve alerts. The README documents this gap.

---

## LLM-Friendliness

### Strengths

1. **Excellent README**: `packages/core/src/modules/inventory/README.md` is 248 lines of accurate, well-structured documentation including ASCII diagrams, tables, and known gaps. An LLM could navigate this module using the README alone.

2. **Single-responsibility files**: Each file handles one concern (reserve, deduct, release, restore, alerts, movements, expiry, types, validation). An LLM can read one file without needing context from others.

3. **Consistent function signatures**: All stock operations follow `(db, variantId, quantity, orderId?, pool?) -> Result` pattern.

4. **TypeScript types for everything**: `StockOperationResult`, `ReservationEntry`, `MovementEntry`, `InventoryAction` -- all well-typed and exported.

5. **Clear state machine**: The `InventoryAction` type and `inventory-transitions.ts` make the lifecycle obvious.

### Weaknesses

1. **`getInventoryOverview()` polymorphic return**: An LLM would need to understand the `section` parameter to know which fields are present. Split functions would be more discoverable.

2. **Two adjustment functions with similar names**: `adjustInventory()` vs `adjustStock()` are confusingly named. An LLM might choose the wrong one.

3. **`inventory.service.ts` vs `stock-adjustment.ts` split**: The boundary between these two files is not obvious from names alone. An LLM would need to read both to understand which to call.

4. **README has one stale item**: The `restored` movement type claim (line 244) is incorrect -- `restore.ts` does use it. Stale docs mislead LLMs.

---

## Recommended Changes

### Priority 1 (Critical -- Fix Now)

| # | Issue | File | Fix |
|---|-------|------|-----|
| 1 | `success: true` in `adjustInventory()` return violates envelope contract | `packages/core/src/modules/inventory/inventory.service.ts` line 242 | Remove `success: true` from return object; remove `success: z.boolean()` from `adjustResultSchema` in route file |

### Priority 2 (High -- Fix Soon)

| # | Issue | File | Fix |
|---|-------|------|-----|
| 8 | API route re-wraps typed errors unnecessarily | `apps/api/src/routes/admin/inventory.ts` lines 257-263, 330-336, 374-378 | Remove try/catch -- service already throws `NotFoundError`/`ConflictError` |
| 16 | Client-side sorting defeats pagination | `apps/admin/src/components/admin/InventoryManager.tsx` lines 213-228 | Implement server-side sorting in `getInventoryOverview()` or remove client-side sort |
| 22 | Alerts not auto-resolved after release/restore | `release.ts`, `restore.ts`, `expiry.ts` | Add `checkAndAlertLowStock()` calls after positive stock changes |

### Priority 3 (Medium -- Next Refactor)

| # | Issue | File | Fix |
|---|-------|------|-----|
| 3 | Duplicated validation logic in `reserveStock()` | `reserve.ts` lines 57-108 | Refactor to call `validateStockAvailability()` |
| 4 | Double `any` cast on alerts route handler | `apps/api/src/routes/admin/inventory.ts` lines 185-197 | Align response schema types |
| 5 | `z.any()` for timestamp fields | `apps/api/src/routes/admin/inventory.ts` lines 50, 62-64 | Replace with `z.string()` or `z.number()` |
| 9 | `getInventoryOverview()` god function | `inventory.service.ts` | Split into 3 focused query functions |
| 13 | README claims `restored` type unused | `README.md` line 244 | Update to note `restore.ts` line 83 uses it |
| 18 | Expiry sweep has no batch limit | `expiry.ts` | Add `batchLimit` parameter |

### Priority 4 (Low -- Polish)

| # | Issue | File | Fix |
|---|-------|------|-----|
| 6 | `.passthrough()` on 7 schemas | `apps/api/src/routes/admin/inventory.ts` | Remove where not needed |
| 11 | `adjustInventory` vs `adjustStock` naming confusion | `inventory.service.ts`, `stock-adjustment.ts` | Rename or consolidate |
| 14 | Stats query scans full table every page load | `inventory.service.ts` lines 68-79 | Cache with short TTL or make optional |
| 17 | Movements count query is unfiltered | `inventory.service.ts` line 101 | Add date range or search filtering |
