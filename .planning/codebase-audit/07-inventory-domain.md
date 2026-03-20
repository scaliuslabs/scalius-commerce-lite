# Audit 07 -- Inventory Domain

**Date**: 2026-03-20
**Module**: `packages/core/src/modules/inventory/` (14 files) + API route + admin UI
**Auditor**: Claude Opus 4.6

---

## 1. Architecture Overview

The inventory module is the largest domain module at 14 files. It manages stock levels for product variants across three pools (regular, preorder, backorder) using a **two-phase reservation model**:

1. **Reserve** -- checkout increments `reservedStock` (stock still on-hand, but spoken for)
2. **Deduct** -- payment confirmation decrements both `stock` and `reservedStock` (permanently removed)
3. **Release** -- cancellation/failure decrements `reservedStock` (frees the hold)

All stock-mutating operations use **CAS (Compare-And-Swap) via `stockVersion`** for optimistic concurrency control, with exponential backoff retries (3 attempts, 50/100/200ms).

### File Map

| File | Responsibility | Lines |
|------|---------------|-------|
| `reserve.ts` | Single + batch reservation with CAS | ~525 |
| `release.ts` | Single + batch release (no CAS needed) | ~115 |
| `deduct.ts` | Single + batch deduction with CAS | ~195 |
| `movements.ts` | Audit log writer (best-effort) | ~36 |
| `alerts.ts` | Low-stock threshold check/create/resolve/acknowledge | ~166 |
| `expiry.ts` | Cron-driven orphaned reservation cleanup | ~172 |
| `inventory-transitions.ts` | Order status -> inventory action state machine | ~247 |
| `inventory.service.ts` | Admin overview queries (variants/movements/alerts) | ~261 |
| `inventory.validation.ts` | Zod schema for adjust API | ~9 |
| `stock-adjustment.ts` | Scanner workflow: adjust/set/barcode lookup | ~250 |
| `validation.ts` | Guards: non-negative, positive quantity, price calc | ~131 |
| `types.ts` | Shared interfaces | ~33 |
| `index.ts` | Public barrel export | ~24 |
| `apps/api/.../inventory.ts` | API routes (6 endpoints) | ~251 |

---

## 2. Stock Operations: Reserve / Release / Deduct

### 2.1 Reserve (`reserve.ts`)

**Three implementations**, each for a different use case:

1. **`reserveStock()`** -- single-variant, sequential CAS. Used by `reserveMultiple()`.
2. **`reserveMultiple()`** -- multi-variant, sequential with compensating rollback on failure.
3. **`reserveStockBatch()`** -- multi-variant, `db.batch()` atomic CAS with full validation-before-write.

**Strengths:**
- `reserveStockBatch()` deduplicates same-variantId entries before processing, preventing double-counting.
- Batch validates ALL variants before writing ANY, preventing partial reservation orphans.
- On CAS conflict in batch, rolls back successful updates and retries the entire batch.
- Three-pool support (regular/preorder/backorder) with distinct validation logic per pool.

**Issue P2 -- `reserveStock()` newStock is misleading for regular pool:**
In `reserveStock()` line 140-142, for regular pool, `newStock` is set to `variant.stock` (unchanged physical stock), which is technically correct (reservation does not change on-hand stock), but the movement log records `previousStock = variant.stock` and `newStock = variant.stock` for regular reservations. This makes the movement's previousStock/newStock indistinguishable from a no-op. The movement `quantity` field carries the real information, but the stock columns are misleading in audit queries.

**Issue P3 -- `releaseReservationInternal()` uses stale stock values in movement:**
At lines 519-522, rollback movements record `previousStock: 0, newStock: 0` with a comment "Approximate -- not critical for rollback logs." While pragmatic, this pollutes the audit trail with zeros. Since this is a compensation path, reading fresh state would add latency under contention but would preserve audit accuracy.

### 2.2 Release (`release.ts`)

**Correctly skips CAS** -- the comments explain why: releasing is always safe to apply. Uses `MAX(0, ...)` to guard against underflow, and a missed release only over-reserves (never oversells). This is the right trade-off.

**`releaseMultiple()` is best-effort:** continues even if individual releases fail, logging errors. This is correct -- partial release is better than none during cancellation.

### 2.3 Deduct (`deduct.ts`)

**Uses CAS with retry** -- correct, since deduction permanently removes stock and must be serialized.

**Pool-aware deduction:**
- Regular: decrements both `stock` and `reservedStock`
- Preorder/backorder: decrements only `reservedStock` (physical stock was already handled at reservation)

**`deductMultiple()` has compensating rollback** via `restoreDeductedStock()`, which re-adds stock and re-reserves. Same zero-stock-in-movement issue as reserve rollback.

---

## 3. CAS Pattern Analysis

### 3.1 Dual Version Columns

The schema has TWO version columns on `productVariants`:
- `version` (general optimistic lock for variant metadata)
- `stockVersion` (stock-specific CAS)

All inventory operations correctly use `stockVersion`, not `version`. This separation prevents stock operations from conflicting with metadata updates (e.g., editing SKU or price), which is a well-designed decision for a system where stock changes frequently while metadata changes rarely.

### 3.2 CAS Correctness

All CAS operations follow the same pattern:
1. `SELECT ... WHERE id = ?` to read current state + `stockVersion`
2. Validate business rules against read state
3. `UPDATE ... SET stockVersion = stockVersion + 1 WHERE id = ? AND stockVersion = ?`
4. Check `RETURNING` result -- empty means conflict, retry with backoff

This is textbook optimistic locking and is correct for D1/SQLite where transactions serialize at the database level.

### 3.3 Backoff Strategy

All operations use the same constants: `MAX_RETRIES = 3`, `BASE_BACKOFF_MS = 50`, exponential (`50, 100, 200ms`). This is defined independently in each file rather than shared.

**Issue P3 -- duplicated retry constants:**
`MAX_RETRIES` and `BASE_BACKOFF_MS` are defined in `reserve.ts`, `deduct.ts`, and `inventory.service.ts` separately. A shared constant or utility would be cleaner, though the current duplication is not a bug risk since they all use the same values.

---

## 4. Movement Tracking / Audit Trail

### 4.1 Completeness

Every stock mutation records a movement via `recordMovement()`:
- `reserve.ts`: records `reserved` / `preorder_reserved`
- `release.ts`: records `released`
- `deduct.ts`: records `deducted` / `preorder_deducted`
- `inventory.service.ts` (`adjustInventory`): records `adjusted`
- `stock-adjustment.ts`: records `adjusted`
- `expiry.ts`: records `released` with "expired reservation" note

**Movement types** (from `types.ts`): `reserved | deducted | released | adjusted | restored | preorder_reserved | preorder_deducted`

Note: The `restored` type is defined in `MovementEntry` but never actually used in any `recordMovement()` call. Stock restorations are tracked via `released` (for reservation release) or `adjusted` (for deduction rollback). This is slightly confusing but functionally correct since the `inventoryAction` field on the order tracks the high-level state.

### 4.2 Best-Effort Logging

`recordMovement()` wraps in try/catch and logs errors without throwing. This means a failed movement log never rolls back a stock change. This is the correct design -- audit gaps are preferable to stock operation failures.

### 4.3 Schema Indexes

The `inventoryMovements` table has three indexes:
- `variant_idx` on `variantId` -- for per-variant history
- `order_idx` on `orderId` -- for per-order lookups
- `created_at_idx` on `createdAt` -- for chronological queries

These cover the main query patterns. The expiry query also benefits from `order_idx` for its NOT EXISTS subqueries.

**Issue P3 -- no composite index for expiry query:**
The `releaseExpiredReservations()` query filters on `(type, createdAt, orderId)` with NOT EXISTS subqueries. A composite index on `(type, created_at)` would improve the expiry sweep performance under high movement volume, though for a single-tenant system this is unlikely to be a bottleneck.

---

## 5. Alert System

### 5.1 Lifecycle

`checkAndAlertLowStock()` implements a full alert lifecycle:
1. **Create** -- first time stock drops below threshold
2. **Reactivate** -- stock drops below threshold again after previous resolution
3. **Update** -- stock changes while already alerted (updates `currentQty`)
4. **Resolve** -- stock rises above threshold

The `productLowStockAlerts` table enforces one alert per variant via `UNIQUE(variant_id)`, preventing duplicate alerts.

### 5.2 Admin Workflow

Admins can `acknowledge` an alert (marking it as seen). The state machine is: `active -> acknowledged -> resolved -> active` (can cycle).

### 5.3 Integration Points

`checkAndAlertLowStock()` is called from:
- `inventory.service.ts` (`adjustInventory`) -- on negative delta
- `stock-adjustment.ts` (`adjustStock`, `setStock`) -- on negative delta
- `inventory-transitions.ts` (`deductOrderStock`) -- after each variant deduction

**Not called** on reservation (correct -- reservations do not change physical stock for regular pool).

**Issue P3 -- alerts not checked on stock replenishment via positive adjustment:**
When stock is added (positive delta), `checkAndAlertLowStock` is not called, so an existing alert will not auto-resolve until the next negative adjustment triggers a check. The `adjustInventory` function only calls it on `delta < 0` (line 237). The alert will eventually self-correct when any future stock change triggers a check, but a merchant who adds stock and expects the alert to clear immediately will be confused.

---

## 6. Inventory Transitions (State Machine)

### 6.1 Design

`inventory-transitions.ts` is the centralized controller for order-status-driven inventory changes. It reads `order.inventoryAction` and determines what to do based on the new status:

| Current Action | New Status | Result |
|---|---|---|
| `reserved` | cancelled/returned/refunded | Release reservations -> `restored` |
| `reserved` | shipped | Deduct stock -> `deducted` |
| `restored` | pending/confirmed (reactivation) | Re-reserve -> `reserved` |
| `deducted` | cancelled/returned/refunded | **No-op** |
| `none` | anything | **No-op** |

### 6.2 Idempotency

The function is idempotent by design: it only acts on valid state transitions. Calling `applyInventoryForStatusChange(orderId, "cancelled")` twice on a `reserved` order will: first call releases and sets to `restored`, second call sees `restored` and does nothing (not a restore status since it is already restored).

### 6.3 Missing Transition: `deducted` -> `restored`

**Issue P2 -- No stock restoration after shipment cancellation/return:**

When an order is `deducted` (shipped) and then transitions to `cancelled` or `returned`, the condition `needsRestore && currentAction === "reserved"` does NOT match (currentAction is `deducted`). There is no handler for `needsRestore && currentAction === "deducted"`.

This means: if a shipped order is returned, the physical stock that was deducted is **never added back**. The `inventoryAction` stays at `deducted`, and the stock is permanently lost from the system.

The `orders.admin.ts` `softDeleteOrder` handles this by checking for `deducted` and calling `applyInventoryForStatusChange(db, id, "cancelled")`, but that call hits the same no-op path in the transitions module.

Examining the order admin code at line 804: `if (orderToDelete.inventoryAction === "reserved" || orderToDelete.inventoryAction === "deducted")` -- it calls `applyInventoryForStatusChange` for deducted orders, but the transitions module silently does nothing for `deducted -> cancelled`.

This is likely **intentional** for some flows (e.g., returns might be handled through a separate returns/restocking process), but it is not documented and could lead to silent stock loss if an admin expects automatic restocking on return.

**Recommendation:** Either add a `deducted -> restored` path that re-adds physical stock, or add explicit documentation and a separate "restock" action for returns.

---

## 7. File Organization

### 7.1 Assessment: Well-Organized

The 14-file split follows **single-responsibility** cleanly:

- **Operation files** (`reserve.ts`, `release.ts`, `deduct.ts`) -- one file per stock mutation type
- **Support files** (`movements.ts`, `alerts.ts`, `expiry.ts`) -- one file per cross-cutting concern
- **Orchestration** (`inventory-transitions.ts`) -- state machine, no direct stock mutation
- **Query files** (`inventory.service.ts`) -- read-only admin queries
- **Scanner workflow** (`stock-adjustment.ts`) -- self-contained scanner use case
- **Validation** (`validation.ts`, `inventory.validation.ts`) -- input guards and Zod schemas
- **Types** (`types.ts`) -- shared interfaces
- **Barrel** (`index.ts`) -- public API

This is NOT over-fragmented. Each file has a clear, non-overlapping purpose. The barrel export in `index.ts` provides a clean public API. A developer looking for "how does reserve work" goes to `reserve.ts`; "what happens on order status change" goes to `inventory-transitions.ts`.

### 7.2 Minor Organizational Issues

**Issue P4 -- `calculateFinalPrice` lives in inventory `validation.ts`:**
`calculateFinalPrice()` is a pricing function that computes discounted prices. It has nothing to do with inventory. It imports `roundPrice` from `@scalius/shared/price-utils`. It is exported from the inventory barrel. It should live in `@scalius/shared/price-utils` or a dedicated pricing module. Currently only used by a duplicate function in `apps/api/src/routes/admin/ai-context.ts` (which defines its own copy rather than importing from inventory).

**Issue P4 -- two validation files:**
`validation.ts` has domain guards (non-negative stock, positive quantity, etc.) while `inventory.validation.ts` has the Zod schema for the adjust API. The naming is confusing -- `validation.ts` vs `inventory.validation.ts`. Consider renaming `validation.ts` to `guards.ts` or `invariants.ts` to distinguish it from the Zod schema file.

---

## 8. Type Safety

### 8.1 Shared Types

`types.ts` defines three interfaces used across all operation files:
- `StockOperationResult` -- uniform success/failure return type
- `ReservationEntry` -- input for multi-variant operations
- `MovementEntry` -- audit log entry shape

All operation functions use these types consistently. The `MovementEntry.type` field is a string union covering all seven movement types.

### 8.2 Pool Type

The pool type `"regular" | "preorder" | "backorder"` is defined inline in function signatures rather than as a shared type alias. The schema uses `InventoryPool` enum from `packages/database/src/schema/enums.ts`. The transition module casts `order.inventoryPool` to the inline union type. A shared `PoolType` alias exported from `types.ts` would improve consistency.

### 8.3 InventoryAction Type

`InventoryAction` is defined and exported from `inventory-transitions.ts` as `"none" | "reserved" | "deducted" | "restored"`. The database column `orders.inventoryAction` stores this as a plain text field with no enum constraint. The transition module casts `order.inventoryAction as InventoryAction`. This is safe given the module is the single writer, but a Drizzle enum or check constraint would add defense-in-depth.

---

## 9. Concurrency Safety

### 9.1 Race Conditions -- Well Handled

The CAS pattern with retry effectively prevents:
- **Lost updates**: two concurrent reservations for the same variant will serialize via stockVersion
- **Overselling**: stock availability is checked against the same read that provides the CAS version
- **Double-deduction**: deduction checks stockVersion, so concurrent deductions will serialize

### 9.2 Race Condition Risk: `stock-adjustment.ts`

**Issue P2 -- `adjustStock()` and `setStock()` lack CAS protection:**

`adjustStock()` (line 54-61) does a read-then-write without version checking:
```
SELECT stock FROM productVariants WHERE id = ?
UPDATE productVariants SET stock = MAX(0, stock + delta), stockVersion = stockVersion + 1 WHERE id = ?
```

The UPDATE uses SQL expressions (`stock + delta`) which is safe against concurrent adjustments (SQLite serializes writes), BUT the `previousStock` recorded in the movement log could be stale if another operation modified stock between the SELECT and UPDATE. The actual stock change is correct; only the audit log entry would have an inaccurate `previousStock`.

Compare with `adjustInventory()` in `inventory.service.ts` which DOES use CAS (`WHERE id = ? AND stockVersion = ?`). There are now two adjust paths with different safety levels:
- `adjustInventory()` -- CAS-protected, used by admin inventory adjust API
- `adjustStock()` -- no CAS, used by scanner workflow

`setStock()` has the same issue: read-then-absolute-write without CAS. If a concurrent reservation changes `reservedStock` between the read and write, the recorded previousStock/delta in the movement will be wrong.

**Recommendation:** Add CAS to `adjustStock()` and `setStock()`, or at minimum read stock values within the UPDATE's RETURNING clause to get accurate post-write state for the movement log.

### 9.3 Expiry Sweep Concurrency

`releaseExpiredReservations()` does not use CAS for decrementing `reservedStock`. This is acceptable for the same reason as `release.ts`: releasing is always safe, MAX(0, ...) prevents underflow, and the sweep is designed to be idempotent (it checks for existing `released` movements before acting).

---

## 10. Batch Operations

### 10.1 Three Levels of Batching

1. **`reserveStockBatch()`** -- true D1 batch atomic operation. Validates all, writes all in one `db.batch()`, rolls back all on any CAS conflict. Used by the queue consumer for storefront checkout.

2. **`reserveMultiple()` / `deductMultiple()`** -- sequential with compensating rollback. Processes variants one-by-one; if any fails, rolls back previous successes. Used by admin order creation and inventory transitions.

3. **`releaseMultiple()`** -- sequential best-effort. Continues on failure. Used by cancellation flows.

The queue consumer correctly uses `reserveStockBatch()` (the most atomic option) for storefront checkout, and the sequential versions for admin operations where partial visibility is acceptable.

### 10.2 Batch Size Limits

There are no explicit batch size limits. `reserveStockBatch()` will build one query per variant in the batch. D1 batches have a limit of 100 statements per `db.batch()` call. For orders with more than ~100 unique variants, this would fail.

**Issue P4 -- no batch size guard:** In practice, orders rarely have more than a handful of line items, so this is not a realistic concern for the current use case. But a guard or chunking logic would be prudent for future-proofing (e.g., bulk import scenarios).

---

## 11. API Layer (`apps/api/src/routes/admin/inventory.ts`)

### 11.1 Endpoints

| Method | Path | Handler |
|--------|------|---------|
| GET | `/` | `getInventoryOverview` -- variants/movements/alerts by section param |
| GET | `/alerts` | `getInventoryOverview` (section=alerts wrapper) |
| PATCH | `/alerts` | `acknowledgeLowStockAlert` |
| POST | `/{variantId}/adjust` | `adjustInventory` (CAS-protected) |
| GET | `/scanner/lookup` | `lookupByBarcodeOrSku` |
| POST | `/stock-adjust` | `adjustStock` (no CAS) |
| POST | `/stock-set` | `setStock` (no CAS) |

### 11.2 Thin Route Layer

Routes correctly delegate all business logic to core services. Error mapping is minimal (NotFoundError, ValidationError re-throws). Auth is handled by middleware (`c.get("user")`).

### 11.3 Response Schema Gaps

**Issue P4 -- OpenAPI responses lack schemas:**
All route responses use `{ description: "..." }` without specifying response body schemas. This means the OpenAPI spec / Swagger UI will not document the response shapes. Not a runtime issue, but reduces API discoverability.

---

## 12. Admin UI (`InventoryManager.tsx`)

### 12.1 Functionality

Three-tab dashboard: Variants (with stats cards), Movements (audit log), and Alerts tab (defined but not rendered in the tab nav -- only variants and movements tabs are shown in the JSX).

**Issue P3 -- Alerts tab not wired in UI:**
The `activeTab` type includes `"alerts"` but the tab navigation only renders buttons for `variants` and `movements`. The alerts section from the API is queryable but not accessible from the inventory dashboard.

### 12.2 Client-Side Sorting

The component sends `sort` and `order` params to the API, but `getInventoryOverview` ignores them (it always sorts by available stock ASC). The component then applies client-side sort on the returned page. This means sorting only works within the current page, not across the full dataset.

**Issue P3 -- sort/order params ignored by API:**
The API `getInventoryOverview` function does not accept or use sort parameters. Sorting is hardcoded to `(stock - reservedStock) ASC`. The client sends sort params that are silently ignored, then re-sorts the page locally, giving incorrect cross-page sort behavior.

### 12.3 Modal Adjustment

The adjust modal correctly sends to `POST /{variantId}/adjust` with delta/reason/notes. It uses the CAS-protected path (`adjustInventory`), not the scanner path. Preview calculation (`newStock`, `newAvailable`) matches the server-side `MAX(0, stock + delta)` logic.

---

## 13. Summary of Issues

### P2 -- Should Fix

| # | Issue | File(s) | Impact |
|---|-------|---------|--------|
| 1 | `deducted` -> `cancelled/returned` does not restore physical stock | `inventory-transitions.ts:66` | Silent stock loss on post-ship returns |
| 2 | `adjustStock()` and `setStock()` lack CAS protection | `stock-adjustment.ts:54,114` | Stale previousStock in audit log under concurrency |
| 3 | `reserveStock()` records misleading previousStock/newStock for regular pool | `reserve.ts:140-142` | Confusing audit trail -- movements show no stock change |

### P3 -- Worth Improving

| # | Issue | File(s) | Impact |
|---|-------|---------|--------|
| 4 | Alerts not checked on positive stock adjustment | `inventory.service.ts:237`, `stock-adjustment.ts:73` | Existing alerts do not auto-resolve on restock |
| 5 | Rollback movements record `previousStock: 0, newStock: 0` | `reserve.ts:520-521`, `deduct.ts:189-190` | Audit trail has placeholder zeros for compensation entries |
| 6 | Alerts tab not wired in admin UI | `InventoryManager.tsx` | Alerts accessible via API but not visible in dashboard |
| 7 | Client-side sort params ignored by API | `inventory.service.ts`, `InventoryManager.tsx` | Sort only works within current page |
| 8 | Duplicated retry constants across files | `reserve.ts`, `deduct.ts`, `inventory.service.ts` | Maintenance burden if values need changing |
| 9 | No composite index for expiry sweep query | `schema/inventory.ts` | Performance under high movement volume |

### P4 -- Minor / Cosmetic

| # | Issue | File(s) | Impact |
|---|-------|---------|--------|
| 10 | `calculateFinalPrice` does not belong in inventory module | `validation.ts:86` | Confusing module boundaries |
| 11 | Two similarly-named validation files | `validation.ts`, `inventory.validation.ts` | Naming confusion |
| 12 | Pool type defined inline rather than shared alias | `reserve.ts`, `release.ts`, `deduct.ts` | Minor type consistency |
| 13 | OpenAPI response schemas missing | `routes/admin/inventory.ts` | Reduced API discoverability |
| 14 | No batch size guard for `reserveStockBatch` | `reserve.ts` | Theoretical D1 batch limit issue |

---

## 14. What Works Well

1. **CAS pattern is correct and consistent.** The `stockVersion` column, separate from the general `version`, is a smart design that avoids false conflicts between stock and metadata updates. The read-validate-CAS-retry loop is implemented correctly across all critical paths.

2. **Two-phase reservation model is sound.** Reserve-then-deduct cleanly separates "intent to purchase" from "payment confirmed." This prevents overselling while allowing concurrent checkouts.

3. **`reserveStockBatch()` is genuinely atomic.** The validate-all-then-batch-write approach with full rollback on any CAS failure is the best possible implementation given D1's constraints. The deduplication of same-variant entries within a batch is a nice touch.

4. **Release operations deliberately skip CAS.** The reasoning is documented in comments and correct: releasing is monotonically decreasing and bounded by MAX(0), so concurrent releases cannot cause overselling.

5. **Expiry sweep is idempotent.** The NOT EXISTS subqueries prevent double-release, and the movement log with "expired reservation" notes provides a paper trail for automated cleanup.

6. **File organization is clean.** Each file has one responsibility. The barrel export provides a clean public API. A developer can navigate the module by filename alone.

7. **Inventory transitions are centralized.** `inventory-transitions.ts` is the single source of truth for order-status-driven inventory changes, preventing scattered stock manipulation across the codebase.

8. **Movement audit trail is comprehensive.** Every stock mutation is logged with variant, order, type, quantity, before/after stock, notes, and actor. The best-effort logging design prevents audit failures from blocking stock operations.

9. **Alert lifecycle is complete.** Create/reactivate/update/resolve/acknowledge covers the full admin workflow. The UNIQUE constraint on `variant_id` prevents duplicate alerts.

10. **Scanner workflow is self-contained.** `stock-adjustment.ts` encapsulates barcode lookup, relative adjust, and absolute set in one file with its own result types, cleanly separated from the order-driven inventory flows.
