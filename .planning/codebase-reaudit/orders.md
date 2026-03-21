# Orders Domain Re-Audit

**Date:** 2026-03-21
**Previous Audit:** 2026-03-20
**Quality Score:** 6.5 / 10 (up from ~5.5)

---

## Previous Findings Status

| # | Finding | Severity | Status | Notes |
|---|---------|----------|--------|-------|
| C1 | SQL injection in location ID queries | HIGH | **STILL OPEN** | `orders.admin.ts` L385, L615 still use `sql\`IN (${locationIds.join(",")})\``. `inArray()` is used correctly elsewhere in the same file (L197) but not here. |
| C2 | Storefront discount amount trust gap | HIGH | **STILL OPEN** | `orders.storefront.ts` L338-340 still uses `data.discountAmount` (client value) instead of `verifiedDiscountAmount` in the queue payload `discountUsage` object. |
| C3 | Storefront status logic dead code | MEDIUM | **STILL OPEN** | `orders.storefront.ts` L319-321 still has the unreachable `isPartialEnabled && COD` ternary branch. L282-283 throws before this code can run. |
| Q1 | `any` type abuse in API routes | MEDIUM | **STILL OPEN** | `orders.ts` has 4 `as any` handler casts (L208, L235, L411, L529). `orders-status.ts` has 2 (L121, L406). Total: 6 handler casts remain. |
| Q2 | `z.any()` in validation schemas | MEDIUM | **STILL OPEN** | `orders.validation.ts` L66: `bulkShipOrderSchema.options` still uses `z.any().optional()`. |
| Q3 | Duplicated location resolution logic | LOW | **STILL OPEN** | `orders.admin.ts` L378-393 and L608-623 still have identical location ID resolution code. |
| Q4 | Duplicated Zod schemas | LOW | **STILL OPEN** | Core `orders.validation.ts` and admin `order-form/types.ts` define near-identical schemas independently. Admin schema does not import/extend core schema. |
| Q5 | Untyped queue payload (`Record<string, unknown>`) | MEDIUM | **STILL OPEN** | `orders.queue.ts` L24-26 still uses `Record<string, unknown>` for `orderData` and `items[]`. All field access still uses `as` casts (e.g., `od.customerName as string`). |
| Q6 | Unused `Database` import in `orders.types.ts` | LOW | **STILL OPEN** | `orders.types.ts` L4 still imports `Database` but never uses it. |
| P1 | Missing filter support (paymentStatus, paymentMethod, fulfillmentStatus) | MEDIUM | **STILL OPEN** | Admin UI sends these params (`useOrderListApi.ts` L64-66), API route query schema does not define them (`orders.ts` L95-105), `listOrders()` does not accept them. Filters are silently ignored. |
| P2 | ORDER_STATUSES UI array missing 3 enum values | MEDIUM | **STILL OPEN** | `orderview/types.ts` L48-57 has 8 statuses. DB enum has 11. Missing: `incomplete`, `refunded`, `partially_refunded`. |
| P3 | Inconsistent error types between API and Core | LOW | **STILL OPEN** | API imports `NotFoundError` from `../../utils/api-error` (orders.ts L11, orders-status.ts L7). Core imports from `@scalius/core/errors` (orders.admin.ts L29). Both exist separately. |
| P4 | Redundant `success` field in COD/fulfillment response schemas | LOW | **STILL OPEN** | `orders-status.ts` L30-33 `codActionResponseSchema` and L35-40 `fulfillmentResultSchema` both wrap `success: z.boolean()` inside `successEnvelope()`, yielding double-wrapped `{ success: true, data: { success: true, ... } }`. |
| P5 | Bulk shipment UI uses individual requests | LOW | **STILL OPEN** | `useOrderListApi.ts` L252-289 `handleBulkShipmentSubmit` loops with individual `POST /orders/:id/shipments` calls instead of using `POST /orders/bulk-ship`. |
| M1 | `updateOrder` is 200+ lines | LOW | **STILL OPEN** | `orders.admin.ts` L607-798 (191 lines). Still mixes location resolution, customer lookup, CAS, item replacement, inventory adjustment (3 code paths), status-driven transitions, and customer stats recalculation. |
| M2 | Untyped `Record<string, unknown>` function params | MEDIUM | **STILL OPEN** | `orders.fulfillment.ts` L50 `processCodAction` and L92 `createFulfillmentShipment` still accept `body: Record<string, unknown>` and cast fields internally. |
| M3 | `listOrders` empty batch workaround | LOW | **STILL OPEN** | `orders.admin.ts` L199-212 still has the elaborate `sql\`1=0\`` fallback for empty results. Comment would help, or restructure. |
| N1 | N+1 in `bulkDeleteOrders` | MEDIUM | **STILL OPEN** | `orders.admin.ts` L884-889 still loops per-order with individual SELECT + inventory ops. |
| N2 | N+1 in `bulkShipOrders` | MEDIUM | **STILL OPEN** | `orders.fulfillment.ts` L24-48 still loops per-order with individual DB reads + external API calls. |
| N3 | N+1 in shipment provider lookup | LOW | **STILL OPEN** | `orders-status.ts` L244-246 still calls `getDeliveryProvider(db, shipment.providerId)` per-shipment in a `Promise.all` loop. |
| N4 | `getOrderDetails` duplicate image rows | LOW | **STILL OPEN** | `orders.admin.ts` L324-330 LEFT JOIN on `productImages` with `isPrimary = true` can produce duplicate rows if multiple primary images exist. No deduplication. |
| N5 | Double scan in list count + data | LOW | **STILL OPEN** | `orders.admin.ts` L99-162 runs WHERE conditions twice (count query + data query). |
| R1 | Inventory race between CAS and inventory ops | MEDIUM | **STILL OPEN** | `orders.admin.ts` L684-788: CAS succeeds, then inventory ops follow non-atomically. Crash between them leaves `inventoryAction` stale. Same pattern in `orders.fulfillment.ts` L172-196. |
| R2 | `permanentlyDeleteOrder` no `deletedAt` check | MEDIUM | **STILL OPEN** | `orders.admin.ts` L873-879: deletes any order by ID without verifying `deletedAt IS NOT NULL`. An active order can be permanently deleted, bypassing soft-delete safety. |
| R3 | Queue batch rollback uses "batch-rollback" orderId | LOW | **DOWNGRADED** | `orders.queue.ts` L401: uses `"batch-rollback"` as orderId for `releaseMultiple`. Upon inspection, `releaseReservation` does NOT match on orderId for stock operations -- orderId is only used for movement record notes. Rollback succeeds functionally; the only impact is misleading audit trail entries. |
| R4 | Client-submitted item prices in queue payload | MEDIUM | **STILL OPEN** | `orders.storefront.ts` L334: queue payload `items[].price` still uses `item.price` from client input, not server-verified prices. The `totalAmount` is correct (uses server prices), but `order_items` rows in the DB get the client price. |
| R5 | Missing version bump on delete/restore | LOW | **STILL OPEN** | `orders.admin.ts` L818, L863-868: `deleteOrder` and `restoreOrder` update the order row without incrementing `version`. A concurrent `updateOrder` could CAS-succeed after a delete. |

**Summary:** 0 of 25 findings fixed. 1 downgraded (R3 less severe than originally assessed). All other issues remain open.

---

## New Issues Found

### N-1. `fulfillmentResultSchema` also has redundant `success` field

**Severity:** LOW
**File:** `apps/api/src/routes/admin/orders-status.ts` L35-40

Same pattern as the COD response schema. `createFulfillmentShipment()` in `orders.fulfillment.ts` L138 returns `{ success: true, shipmentId, ... }`, and `created()` wraps it in `{ success: true, data: { success: true, ... } }`. This was not called out in the original audit (only `codActionResponseSchema` was mentioned).

### N-2. `queuePayload` type in `orders.types.ts` is `Record<string, unknown>`

**Severity:** LOW
**File:** `packages/core/src/modules/orders/orders.types.ts` L108

The `CreateStorefrontOrderResult.queuePayload` return type is `Record<string, unknown>`, even though the actual payload built in `orders.storefront.ts` L299-343 has a well-defined shape. This forces all consumers to use `as` casts when reading queue payload fields.

### N-3. Dynamic import of schema enums inside `createStorefrontOrder`

**Severity:** LOW
**File:** `packages/core/src/modules/orders/orders.storefront.ts` L141, L280, L296

Three dynamic `import()` calls inside the function body:
- L141: `await import("@scalius/database/schema")` for `siteSettings`, `shippingMethods`, `discounts`
- L280: `await import("@scalius/database/schema")` for `PaymentMethod`, `PaymentStatus`, `OrderStatus`, `FulfillmentStatus`
- L296: `await import("nanoid")`

These modules are available statically. The dynamic imports add unnecessary await overhead on every storefront order creation. The top of the file already imports several symbols from `@scalius/database/schema` statically (L5-13), so the dynamic imports appear to be an oversight or a workaround for an earlier bundling issue.

### N-4. `returnResultSchema` also has redundant `success` in refund routes

**Severity:** LOW
**File:** `apps/api/src/routes/admin/orders-refund.ts` L21-25

```
const returnResultSchema = successEnvelope(z.object({
    success: z.boolean(),
    ...
}));
```

Same double-`success` wrapping pattern. `processReturn` returns `{ success: true, ... }` which gets wrapped by `ok()`.

### N-5. Missing JSDoc on `deleteOrder`, `restoreOrder`, `permanentlyDeleteOrder`

**Severity:** LOW
**File:** `packages/core/src/modules/orders/orders.admin.ts` L812, L821, L873

The `createOrder` (L370) and `listOrders` (L37) functions have JSDoc, but `deleteOrder`, `restoreOrder`, `permanentlyDeleteOrder`, and `bulkDeleteOrders` do not. Given the complex inventory semantics (auto-release on delete, re-reserve on restore), these functions especially need documentation.

---

## Remaining Technical Debt

### Critical (should fix before next deploy)

1. **SQL injection in location queries** -- `orders.admin.ts` L385, L615. Replace `locationIds.join(",")` with `inArray(deliveryLocations.id, locationIds)`. This is the same pattern already used correctly at L197.

2. **Storefront discount amount trust gap** -- `orders.storefront.ts` L338-340. Change `data.discountAmount` to `verifiedDiscountAmount`. The order total is calculated correctly but the discount usage audit trail records the wrong amount.

3. **Client item prices in queue payload** -- `orders.storefront.ts` L334. Use server-computed unit prices instead of `item.price`. Currently `order_items` rows can contain attacker-submitted per-item prices.

### High (functional correctness)

4. **Missing backend filter support** -- The admin UI sends `paymentStatus`, `paymentMethod`, `fulfillmentStatus` filter params that the API route and service silently ignore. Users see filter dropdowns that do nothing.

5. **ORDER_STATUSES missing 3 values** -- Orders in `incomplete`, `refunded`, or `partially_refunded` status show a blank dropdown in the admin UI and cannot be transitioned.

6. **`permanentlyDeleteOrder` lacks `deletedAt` guard** -- Active orders can be permanently deleted, bypassing the soft-delete safety net.

### Medium (robustness)

7. **No version bump on delete/restore** -- Concurrent operations can conflict.

8. **Untyped function parameters** -- `processCodAction` and `createFulfillmentShipment` accept `Record<string, unknown>` and cast internally. Type errors are caught at runtime, not compile time.

9. **Untyped queue payload** -- `OrderIngestQueueMessage.orderData` and `items` are `Record<string, unknown>`, requiring extensive `as` casts throughout `orders.queue.ts`.

### Low (quality / maintainability)

10. **Duplicated location resolution** (2 copies in `orders.admin.ts`)
11. **Duplicated Zod schemas** (core vs admin)
12. **6 `as any` handler casts** in API route files
13. **Dead code** in storefront status ternary
14. **N+1 patterns** in bulk delete, bulk ship, shipment provider lookup
15. **Redundant `success` in response schemas** (3 occurrences across routes)
16. **Dynamic imports** that should be static in storefront order creation
17. **Unused `Database` import** in `orders.types.ts`

---

## Dimension Scores

| Dimension | Score | Notes |
|-----------|-------|-------|
| **Correctness** | 5 | SQL injection vector remains. Client prices stored in DB. Discount audit trail uses wrong amount. Missing filter support gives false UI feedback. |
| **Security** | 5 | SQL injection in `locationIds.join(",")`. Client-submitted prices and discount amounts flow to DB records. `permanentlyDeleteOrder` has no soft-delete guard. |
| **Type Safety** | 5 | 6 `as any` handler casts. `Record<string, unknown>` for queue payloads and fulfillment params. `z.any()` in bulk ship schema. Unused type import. |
| **Error Handling** | 7 | State machine validation is solid. CAS optimistic locking properly implemented. NotFoundError/ValidationError/ConflictError used consistently within each layer. |
| **Performance** | 6 | N+1 in bulk operations (delete, ship, provider lookup). Double WHERE scan for list count+data. Duplicate image rows possible. Dynamic imports add latency. |
| **Maintainability** | 6 | Good file organization (7 files by concern). State machine is explicit and well-documented. But `updateOrder` is 191 lines, location resolution is duplicated, schemas are duplicated, and JSDoc is missing on delete/restore/bulk functions. |
| **Robustness** | 6 | CAS locking works well for concurrent edits. Inventory reservation with rollback on batch failure. But non-atomic CAS-then-inventory pattern can leave stale `inventoryAction`. Delete/restore skip version bump. |
| **API Design** | 7 | OpenAPI routes properly defined. `successEnvelope` used consistently. Sub-routers for status and refund. Good separation. Marred by redundant `success` fields in 3 response schemas and missing filter params. |
| **Convention Adherence** | 6 | Follows CLAUDE.md patterns (thin HTTP layer, `ok()`/`created()`, service delegation). But violates response envelope contract (redundant `success` in `T`), mixes error import sources, and has inconsistent `inArray` vs raw SQL usage. |
| **LLM-Friendliness** | 7 | Clear file naming. Good barrel export with exclusion note. State machine transitions immediately readable. Weakened by untyped params (`Record<string, unknown>`) and 191-line `updateOrder` mixing concerns. |

**Overall: 6.0 / 10**

---

## Files Analyzed

| File | Path | Lines |
|------|------|-------|
| orders.admin.ts | `packages/core/src/modules/orders/orders.admin.ts` | 901 |
| orders.storefront.ts | `packages/core/src/modules/orders/orders.storefront.ts` | 353 |
| orders.fulfillment.ts | `packages/core/src/modules/orders/orders.fulfillment.ts` | 213 |
| orders.queue.ts | `packages/core/src/modules/orders/orders.queue.ts` | 417 |
| order-state-machine.ts | `packages/core/src/modules/orders/order-state-machine.ts` | 138 |
| orders.types.ts | `packages/core/src/modules/orders/orders.types.ts` | 126 |
| orders.validation.ts | `packages/core/src/modules/orders/orders.validation.ts` | 69 |
| index.ts | `packages/core/src/modules/orders/index.ts` | 9 |
| orders.ts (API) | `apps/api/src/routes/admin/orders.ts` | 531 |
| orders-status.ts (API) | `apps/api/src/routes/admin/orders-status.ts` | 473 |
| orders-refund.ts (API) | `apps/api/src/routes/admin/orders-refund.ts` | 97 |
| queue-consumer.ts | `apps/api/src/queue-consumer.ts` | 369 |
| orderview/types.ts (Admin) | `apps/admin/src/components/admin/orderview/types.ts` | 57 |
| useOrderListApi.ts (Admin) | `apps/admin/src/components/admin/order-list/hooks/useOrderListApi.ts` | 402 |
| order-form/types.ts (Admin) | `apps/admin/src/components/admin/order-form/types.ts` | 91 |
| release.ts (Inventory) | `packages/core/src/modules/inventory/release.ts` | ~100 |
