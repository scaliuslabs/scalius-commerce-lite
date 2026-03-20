# Orders Domain Audit

**Date:** 2026-03-20

## Summary

The Orders domain is the largest and most complex vertical slice in the codebase, spanning 7 core service files, 3 API route files, a queue consumer, and ~30 admin UI components. The code is generally well-structured with good separation of concerns, a proper state machine for status transitions, CAS-based optimistic locking on writes, and well-documented inventory lifecycle management. However, the audit reveals several concrete issues: a SQL injection vector in location queries, a discount amount trust gap in storefront checkout, missing filter support in the backend list query, UI/schema status enum mismatches, and N+1 patterns in bulk operations.

---

## Critical Issues

### 1. SQL Injection in Location ID Queries

**Severity:** HIGH
**Files:** `packages/core/src/modules/orders/orders.admin.ts` (lines 385, 615)

```typescript
sql`${deliveryLocations.id} IN (${locationIds.join(",")})`
```

The `locationIds` array (derived from `data.city`, `data.zone`, `data.area`) is joined into a raw string and interpolated into the SQL template. While these values pass through Zod validation (`z.string().min(1)`), the Zod schema does not restrict the character set. A `city` value like `"'); DROP TABLE orders; --"` would pass validation and be spliced directly into the query. Drizzle's `sql` template tag only parameterizes `${}` bindings, but the `.join(",")` call produces a single un-parameterized string.

**Fix:** Replace with Drizzle's `inArray()` operator:
```typescript
import { inArray } from "drizzle-orm";
// ...
inArray(deliveryLocations.id, locationIds)
```

This is already used correctly elsewhere in the same file (line 197: `inArray(deliveryShipments.orderId, orderIds)`), making the inconsistency doubly confusing.

### 2. Storefront Discount Amount Trust Gap

**Severity:** HIGH
**Files:** `packages/core/src/modules/orders/orders.storefront.ts` (line 338)

The queue payload for `discountUsage` uses `data.discountAmount` (the client-submitted value) instead of the server-verified `verifiedDiscountAmount`:

```typescript
discountUsage: appliedDiscount && data.discountAmount && data.discountAmount > 0 ? {
    discountId: appliedDiscount.id,
    amountDiscounted: data.discountAmount,  // BUG: uses client value, not verifiedDiscountAmount
} : null,
```

If a client sends `discountAmount: 9999` with a valid code that only yields `verifiedDiscountAmount: 50`, the `discountUsage` record logs 9999 as the discount amount. The `totalAmount` calculation on line 275 correctly uses `verifiedDiscountAmount`, so the order total is correct -- but the discount usage audit trail is wrong.

**Fix:** Change `data.discountAmount` to `verifiedDiscountAmount` on line 338 and 340.

### 3. Storefront Status Logic Dead Code / Contradiction

**Severity:** MEDIUM
**Files:** `packages/core/src/modules/orders/orders.storefront.ts` (lines 319-321)

```typescript
status: (isPartialEnabled && data.paymentMethod === PaymentMethodEnum.COD)
    ? OrderStatusEnum.INCOMPLETE
    : data.paymentMethod === PaymentMethodEnum.COD ? OrderStatusEnum.PENDING : OrderStatusEnum.INCOMPLETE,
```

Line 282-283 already throws a `ValidationError` if `isPartialEnabled && data.paymentMethod === COD`. So the first branch of the ternary (line 319-320) is unreachable dead code. The condition was likely kept from before the validation was added.

**Fix:** Simplify to:
```typescript
status: data.paymentMethod === PaymentMethodEnum.COD
    ? OrderStatusEnum.PENDING
    : OrderStatusEnum.INCOMPLETE,
```

---

## Code Quality Issues

### 1. `any` Type Abuse in API Routes

**Files:** `apps/api/src/routes/admin/orders.ts` (lines 197, 208, 229, 235, 401, 411, 443, 492, 510, 521, 529)

Multiple route handlers are cast to `any` to work around OpenAPIHono type inference:
```typescript
app.openapi(bulkShipRoute, (async (c: any) => { ... }) as any);
```

This defeats type safety for the Hono context, meaning `c.get("db")`, `c.req.valid("param")`, and `c.env` are all untyped. There are 6 handlers with this pattern in `orders.ts` alone.

**Fix:** The root cause is complex response schemas that Hono's type system cannot infer. Extract the handler body into a typed function and use a minimal `as any` only on the return type, or use `satisfies` patterns.

### 2. `z.any()` in Validation Schemas

**Files:**
- `packages/core/src/modules/orders/orders.validation.ts` (line 66): `options: z.any().optional()`
- `apps/api/src/routes/admin/orders.ts` (lines 29, 68, 69): `z.any()` for shipment, createdAt, updatedAt

Using `z.any()` bypasses all validation. The `bulkShipOrderSchema.options` field accepts arbitrary data that flows into delivery provider options unchecked.

### 3. Duplicated Location Resolution Logic

**Files:** `packages/core/src/modules/orders/orders.admin.ts` (lines 378-393 and 608-623)

The `createOrder` and `updateOrder` functions both contain identical location ID resolution logic (query `deliveryLocations`, build map, resolve names). This should be extracted to a helper function.

### 4. Duplicated Schema Definitions

**Files:**
- `packages/core/src/modules/orders/orders.validation.ts` (line 9-45): `createOrderSchema`
- `apps/admin/src/components/admin/order-form/types.ts` (line 51-89): `orderFormSchema`

These are nearly identical Zod schemas with minor differences (`status` optional in client, `discountAmount` uses `z.coerce.number()` in client). The admin form schema should import and extend the core validation schema to prevent drift.

### 5. Queue Payload Uses `Record<string, unknown>` Extensively

**Files:**
- `packages/core/src/modules/orders/orders.queue.ts` (lines 25-27): `orderData: Record<string, unknown>`, `items: Record<string, unknown>[]`
- `packages/core/src/modules/orders/orders.types.ts` (line 108): `queuePayload: Record<string, unknown>`

All queue payload data is untyped. The `handleOrderIngestBatch` function casts every field individually (`od.customerName as string`, `od.totalAmount as number`). A typed interface for the queue payload would prevent runtime errors and improve maintainability.

### 6. Unused Import in `orders.types.ts`

**Files:** `packages/core/src/modules/orders/orders.types.ts` (line 4)

```typescript
import type { Database } from "@scalius/database/client";
```

The `Database` type is imported but never used in the file.

---

## Pattern Violations

### 1. Missing Filter Support in `listOrders` Backend

**Files:**
- Admin UI sends: `paymentStatus`, `paymentMethod`, `fulfillmentStatus` query params
  - `apps/admin/src/components/admin/order-list/hooks/useOrderListApi.ts` (lines 64-66)
- API route does NOT pass them: `apps/api/src/routes/admin/orders.ts` (lines 115-130)
- Core service does NOT accept them: `packages/core/src/modules/orders/orders.admin.ts` (lines 41-62)

The admin UI sends three filter parameters that are silently ignored by the backend. The API route's `request.query` schema does not define them, and `listOrders()` has no parameters for them. Users selecting payment status, payment method, or fulfillment status filters see no actual filtering.

**Fix:** Add `paymentStatus`, `paymentMethod`, and `fulfillmentStatus` to the OpenAPI query schema in `orders.ts`, pass them to `listOrders()`, and add `whereConditions` in the service.

### 2. ORDER_STATUSES UI Array Missing 3 Enum Values

**Files:**
- `apps/admin/src/components/admin/orderview/types.ts` (lines 48-57): `ORDER_STATUSES` array
- `packages/database/src/schema/enums.ts` (lines 4-16): `OrderStatus` enum

The UI `ORDER_STATUSES` array omits `"incomplete"`, `"refunded"`, and `"partially_refunded"`. The `OrderStatusCard` renders a `<Select>` with only 8 options, but the database supports 11 statuses. An order in `partially_refunded` status cannot be changed via the UI dropdown because the status is not in the list. The status selector will show a blank value for those orders.

### 3. Inconsistent Error Types Between API and Core

**Files:**
- `apps/api/src/routes/admin/orders.ts` (line 11): imports `NotFoundError` from `../../utils/api-error`
- `packages/core/src/modules/orders/orders.admin.ts` (line 29): imports `NotFoundError` from `@scalius/core/errors`

The API layer imports error classes from the route-local `api-error.ts`, while the core service layer imports from `@scalius/core/errors`. These are likely the same errors re-exported, but the inconsistency makes it unclear which layer throws which error class. The convention per CLAUDE.md is that core services throw core errors and API routes catch/re-throw API errors. The current code mixes both.

### 4. `codActionResponseSchema` Has Redundant `success` Field

**Files:** `apps/api/src/routes/admin/orders-status.ts` (lines 30-33)

```typescript
const codActionResponseSchema = successEnvelope(z.object({
    success: z.boolean(),   // <-- redundant inside successEnvelope
    message: z.string(),
}));
```

Per CLAUDE.md: "The `T` passed to `ok(c, T)` must be the FINAL payload -- never include redundant `success: true` or `data:` wrapping inside `T`." The `processCodAction` service returns `{ success: true, message: ... }` and this is passed to `ok()`, which wraps it in another `{ success: true, data: { success: true, message: ... } }`.

### 5. Bulk Shipment in UI Does NOT Use the Bulk Endpoint

**Files:**
- `apps/admin/src/components/admin/order-list/hooks/useOrderListApi.ts` (lines 252-289): `handleBulkShipmentSubmit`
- `apps/api/src/routes/admin/orders.ts` (lines 179-208): bulk-ship endpoint

The UI's `handleBulkShipmentSubmit` sends individual `POST /orders/:id/shipments` requests in a for-loop instead of using the `POST /orders/bulk-ship` endpoint. This means N sequential network requests instead of 1.

---

## Maintainability Concerns

### 1. `updateOrder` is 200+ Lines of Mixed Concerns

**Files:** `packages/core/src/modules/orders/orders.admin.ts` (lines 607-798)

The `updateOrder` function handles: location resolution, existing order validation, status transition validation, customer phone change (lookup + create), CAS optimistic locking, order item replacement, inventory adjustment (with 3 different code paths for `reserved`, `deducted`, and no inventory), status-driven inventory transitions, and customer stats recalculation. This is the hardest function to modify safely.

**Suggestion:** Extract inventory adjustment logic into a dedicated helper, and customer resolution into its own function.

### 2. `orders.fulfillment.ts` Uses `Record<string, unknown>` for Body Parameters

**Files:** `packages/core/src/modules/orders/orders.fulfillment.ts` (lines 50, 92)

```typescript
export async function processCodAction(db: Database, orderId: string, body: Record<string, unknown>)
export async function createFulfillmentShipment(db: Database, orderId: string, body: Record<string, unknown>)
```

Both functions accept untyped request bodies. The internal code then casts fields like `body.collectedBy as string`, `body.itemIds as string[]`. Typed interfaces for these parameters would catch misuse at compile time.

### 3. `listOrders` Empty Batch Workaround

**Files:** `packages/core/src/modules/orders/orders.admin.ts` (lines 199-212)

When `results.length === 0`, the shipments batch query uses an elaborate workaround:
```typescript
db.select({ orderId: sql<string>`NULL`.as("orderId"), ... }).from(deliveryShipments).where(sql`1=0`)
```

This is needed because D1's `batch()` requires all elements to be Drizzle query builders. A comment explaining why `[]` cannot be used would help. Alternatively, skip the batch and use two sequential queries when the first returns empty.

---

## Performance & Scalability

### 1. N+1 in `bulkDeleteOrders`

**Files:** `packages/core/src/modules/orders/orders.admin.ts` (lines 882-899)

```typescript
for (const orderId of orderIds) {
    const order = await db.select(...)...get();
    if (...) await applyInventoryForStatusChange(db, orderId, "cancelled");
}
```

Each order in the bulk delete triggers an individual SELECT + potentially multiple inventory operations. For 50 orders, this is 50+ sequential queries. The inventory release should be batched.

### 2. N+1 in `bulkShipOrders`

**Files:** `packages/core/src/modules/orders/orders.fulfillment.ts` (lines 24-48)

```typescript
for (const orderId of orderIds) {
    const order = await db.select(...)...get();
    const shipment = await createShipment(db, orderId, providerId, options);
    // ...
}
```

Each order in the bulk ship triggers sequential DB queries + external API calls. This should at minimum batch the DB reads and parallelize the external shipment creation calls.

### 3. N+1 in Shipment Enhancement

**Files:** `apps/api/src/routes/admin/orders-status.ts` (lines 243-253)

```typescript
const enhancedShipments = await Promise.all(
    shipments.map(async (shipment) => {
        const provider = shipment.providerId ? await getDeliveryProvider(db, shipment.providerId) : null;
        // ...
    })
);
```

For each shipment, a separate `getDeliveryProvider` query is executed. Since most shipments for an order likely use the same provider, this is wasteful. Pre-fetch providers with a single `inArray` query.

### 4. `getOrderDetails` Items Query Produces Duplicate Rows

**Files:** `packages/core/src/modules/orders/orders.admin.ts` (lines 309-331)

The LEFT JOIN on `productImages` (where `isPrimary = true`) can produce multiple rows per item if a product has multiple images marked as primary (a data integrity issue, but possible). The result set is not deduplicated.

### 5. Full Table Scan in `listOrders` Count Query

**Files:** `packages/core/src/modules/orders/orders.admin.ts` (lines 99-107)

The count query and the data query execute the same WHERE clause separately. For complex filters (FTS + status + date range), this runs the same expensive scan twice. Consider using a window function or a CTE to compute count alongside the data query.

---

## Robustness Gaps

### 1. Inventory Race Between Order Update CAS and Inventory Ops

**Files:** `packages/core/src/modules/orders/orders.admin.ts` (lines 684-788)

The `updateOrder` function does CAS on the order row first (line 684), then performs inventory adjustments (lines 730-788). If the server crashes between the CAS success and the inventory completion, the order's `inventoryAction` field will be stale. The order version is incremented but inventory is not adjusted.

The `updateOrderStatus` in `orders.fulfillment.ts` (lines 172-192) has a similar pattern but is slightly better -- it does CAS first, then inventory, then a second UPDATE for `inventoryAction`. But if the second UPDATE fails, `inventoryAction` is stale.

**Mitigation:** The idempotent design of `applyInventoryForStatusChange` means a retry would fix it, but there is no automatic retry mechanism.

### 2. `permanentlyDeleteOrder` Does Not Check `deletedAt`

**Files:** `packages/core/src/modules/orders/orders.admin.ts` (lines 873-880)

```typescript
export async function permanentlyDeleteOrder(db: Database, id: string) {
    const orderToDelete = await db.select({ inventoryAction: orders.inventoryAction }).from(orders).where(eq(orders.id, id)).get();
    // ...
    await db.delete(orders).where(eq(orders.id, id));
}
```

This function deletes any order regardless of its `deletedAt` status. A non-soft-deleted, active order can be permanently deleted. The soft-delete -> permanent-delete two-step safety net is not enforced.

### 3. Queue Batch Rollback May Not Cover All Reserved Entries

**Files:** `packages/core/src/modules/orders/orders.queue.ts` (lines 399-401)

```typescript
await releaseMultiple(db, reservationEntries, "batch-rollback").catch(...)
```

When the DB batch fails, inventory rollback uses `"batch-rollback"` as the orderId for `releaseMultiple`. But `reserveStockBatch` used the actual per-order `orderId` values. If `releaseMultiple` matches on orderId (which CAS-based inventory operations often do), the rollback may fail to find matching reservations.

### 4. Storefront Order Creation Validates Client-Submitted `item.price` But Uses It

**Files:** `packages/core/src/modules/orders/orders.storefront.ts` (lines 330-337)

The server-side price verification (lines 207-236) computes `serverItemTotal` from DB prices, but the queue payload `items[].price` still uses `item.price` from the client input:

```typescript
items: data.items.map(item => ({
    ...
    price: item.price,    // client-submitted, not server-verified
}))
```

The `totalAmount` in `orderData` is correct (uses server prices), but individual item prices stored in `order_items` come from the client. An attacker could submit `price: 0` for each item -- the order total would be correct, but the line-item records would show $0.

### 5. Missing `version` Bump in `deleteOrder` and `restoreOrder`

**Files:** `packages/core/src/modules/orders/orders.admin.ts` (lines 812-871)

Both `deleteOrder` and `restoreOrder` update the order row without incrementing `version`. If two concurrent requests try to delete and update the same order, the CAS check in `updateOrder` could succeed after a delete, creating an inconsistent state.

---

## LLM-Friendliness

### Strengths

1. **Clear file organization**: Each concern has its own file (`orders.admin.ts`, `orders.storefront.ts`, `orders.fulfillment.ts`, `orders.queue.ts`, `order-state-machine.ts`, `orders.types.ts`, `orders.validation.ts`).
2. **Good comments**: The inventory lifecycle is well-documented with inline comments explaining the reserve -> deduct -> restore flow.
3. **State machine is explicit**: The `ORDER_STATUS_TRANSITIONS` record in `order-state-machine.ts` makes allowed transitions immediately visible.
4. **Types file is comprehensive**: `orders.types.ts` provides clear interfaces for all data shapes.
5. **Barrel export with exclusion note**: The `index.ts` barrel file explicitly documents why `orders.queue.ts` is excluded.

### Weaknesses

1. **`updateOrder` is too long**: At 200+ lines with nested conditionals, an LLM would struggle to modify it without introducing bugs. It needs to be decomposed.
2. **Queue payload is untyped**: The `Record<string, unknown>` typing in `orders.queue.ts` forces every consumer to cast fields, making it hard to trace what data flows through the queue.
3. **Two different schema locations for the same concept**: `orders.validation.ts` in core vs `order-form/types.ts` in admin. An LLM adding a field would likely update one but not the other.
4. **`createFulfillmentShipment` uses untyped `body`**: Hard to understand what parameters it accepts without reading the route handler.
5. **Missing JSDoc on key public functions**: `updateOrder`, `bulkDeleteOrders`, `bulkShipOrders`, `processCodAction`, `createFulfillmentShipment` all lack JSDoc.

---

## Recommended Changes

### Priority 1 (Security / Correctness)

| # | Issue | Files | Fix |
|---|-------|-------|-----|
| 1 | SQL injection in location queries | `packages/core/src/modules/orders/orders.admin.ts` L385, L615 | Replace `sql\`IN (${ids.join(",")})\`` with `inArray(deliveryLocations.id, locationIds)` |
| 2 | Discount amount trust gap | `packages/core/src/modules/orders/orders.storefront.ts` L338, L340 | Use `verifiedDiscountAmount` instead of `data.discountAmount` |
| 3 | Client-submitted item prices in queue payload | `packages/core/src/modules/orders/orders.storefront.ts` L334 | Compute server-verified per-item prices and use those in the queue payload |
| 4 | `permanentlyDeleteOrder` no deletedAt check | `packages/core/src/modules/orders/orders.admin.ts` L873 | Add `AND deletedAt IS NOT NULL` guard |

### Priority 2 (Functional Gaps)

| # | Issue | Files | Fix |
|---|-------|-------|-----|
| 5 | Backend ignores paymentStatus/paymentMethod/fulfillmentStatus filters | `apps/api/src/routes/admin/orders.ts` L89-113, `packages/core/src/modules/orders/orders.admin.ts` L41-62 | Add filter params to OpenAPI schema and service function |
| 6 | ORDER_STATUSES missing 3 statuses | `apps/admin/src/components/admin/orderview/types.ts` L48-57 | Add `"incomplete"`, `"refunded"`, `"partially_refunded"` |
| 7 | Dead code in storefront status logic | `packages/core/src/modules/orders/orders.storefront.ts` L319-321 | Remove unreachable `isPartialEnabled && COD` branch |
| 8 | UI bulk ship uses individual requests | `apps/admin/src/components/admin/order-list/hooks/useOrderListApi.ts` L252-289 | Switch to `POST /orders/bulk-ship` endpoint |

### Priority 3 (Code Quality / Maintainability)

| # | Issue | Files | Fix |
|---|-------|-------|-----|
| 9 | Duplicated location resolution | `packages/core/src/modules/orders/orders.admin.ts` L378-393, L608-623 | Extract `resolveLocationNames(db, city, zone, area)` helper |
| 10 | Duplicated Zod schemas | Core `orders.validation.ts` vs Admin `order-form/types.ts` | Admin schema should import and extend core schema |
| 11 | Untyped queue payload | `packages/core/src/modules/orders/orders.queue.ts` L25-27 | Define typed interface for `orderData` and `items` |
| 12 | Untyped function params | `packages/core/src/modules/orders/orders.fulfillment.ts` L50, L92 | Define typed interfaces for `processCodAction` and `createFulfillmentShipment` params |
| 13 | N+1 in `bulkDeleteOrders` | `packages/core/src/modules/orders/orders.admin.ts` L882-899 | Batch-read orders, group inventory operations |
| 14 | N+1 in shipment provider lookup | `apps/api/src/routes/admin/orders-status.ts` L243-253 | Pre-fetch providers with `inArray` |
| 15 | Redundant `success` in COD response | `apps/api/src/routes/admin/orders-status.ts` L30-33, `packages/core/src/modules/orders/orders.fulfillment.ts` L69 | Remove `success` from service return; it is added by `ok()` envelope |
| 16 | `version` not bumped on delete/restore | `packages/core/src/modules/orders/orders.admin.ts` L812-871 | Add `version: sql\`version + 1\`` to delete/restore UPDATEs |
| 17 | Remove unused `Database` import | `packages/core/src/modules/orders/orders.types.ts` L4 | Delete the import |
| 18 | Add JSDoc to public functions | `orders.admin.ts`, `orders.fulfillment.ts` | Document `updateOrder`, `bulkDeleteOrders`, `processCodAction`, `createFulfillmentShipment` |

### Priority 4 (Performance)

| # | Issue | Files | Fix |
|---|-------|-------|-----|
| 19 | Double scan in list count + data | `packages/core/src/modules/orders/orders.admin.ts` L99-162 | Use SQL window function or CTE for combined count+data |
| 20 | N+1 in `bulkShipOrders` | `packages/core/src/modules/orders/orders.fulfillment.ts` L24-48 | Batch DB reads, parallelize external API calls |
