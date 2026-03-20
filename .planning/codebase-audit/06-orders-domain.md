# Orders Domain Audit

**Date:** 2026-03-20
**Scope:** Full end-to-end orders domain -- core services, state machine, queue processing, API routes, admin UI, storefront client
**Branch:** mono-repo

---

## 1. Architecture Overview

The orders domain spans all layers of the monorepo:

```
packages/database/src/schema/orders.ts          -- 7 tables: orders, orderItems, orderPayments, paymentPlans, codTracking, webhookEvents, abandonedCheckouts
packages/database/src/schema/enums.ts           -- OrderStatus (11), PaymentStatus (5), FulfillmentStatus (3), ItemFulfillmentStatus (5), InventoryPool (3)
packages/core/src/modules/orders/
  order-state-machine.ts                        -- Transition maps for order/payment/fulfillment status
  orders.admin.ts                               -- Admin CRUD: list, get, create, update, delete, restore, bulk ops
  orders.storefront.ts                          -- Storefront checkout validation + queue payload builder
  orders.fulfillment.ts                         -- Shipment creation, status updates, COD actions, notifications
  orders.queue.ts                               -- Queue consumer: batch DB writes, inventory reservation, KV status
  orders.types.ts                               -- Shared TypeScript interfaces
  orders.validation.ts                          -- Zod schemas for admin create/update
  index.ts                                      -- Barrel re-exports (excludes queue -- Cloudflare types)
apps/api/src/routes/admin/orders.ts             -- 20+ admin OpenAPI routes
apps/api/src/routes/orders.ts                   -- Storefront: GET /:id, GET /status/:token, POST /
apps/api/src/routes/checkout.ts                 -- GET /config (payment gateways)
apps/api/src/queue-consumer.ts                  -- Thin dispatcher: order.ingest, payment.*, order.notification, auth.send_otp
apps/admin/src/components/admin/order-form/     -- 9 files: form context, sections, product search, types
apps/admin/src/components/admin/order-list/     -- 14 files: table, toolbar, filters, pagination, bulk ops
apps/admin/src/components/admin/orderview/      -- 7 files: header, status, payment, shipment, items, notes
apps/admin/src/loaders/admin/orders.ts          -- SSR data loaders
apps/admin/src/store/orderStore.ts              -- Nanostores for client-side calculation
apps/storefront/src/lib/api/orders.ts           -- Storefront API client with polling
```

---

## 2. State Machine Analysis

### 2.1 Order Status Transitions

The state machine in `order-state-machine.ts` is explicit and well-structured. All 11 OrderStatus values have defined transition maps:

```
incomplete  -> pending, cancelled
pending     -> processing, confirmed, cancelled
processing  -> confirmed, cancelled
confirmed   -> shipped, cancelled
shipped     -> delivered, returned, cancelled
delivered   -> completed, returned, refunded, partially_refunded
completed   -> returned, refunded, partially_refunded
cancelled   -> pending, confirmed       (admin reactivation)
returned    -> refunded
refunded    -> (terminal)
partially_refunded -> refunded
```

**Strengths:**
- Three separate dimensions (order, payment, fulfillment) each with their own transition map
- `validateTransition()` provides clear error messages listing allowed transitions
- No-op for same-status transitions (prevents spurious errors)
- Admin reactivation from cancelled is explicitly documented with inventory re-reservation

**Issues:**

**[S-SM-1] Incomplete status missing from UI.** `OrderStatus.INCOMPLETE` (used for online payment checkout flows) is present in the state machine and database enum, but the admin orderview `ORDER_STATUSES` constant in `apps/admin/src/components/admin/orderview/types.ts` only lists 8 statuses and omits `incomplete`, `refunded`, and `partially_refunded`:
```typescript
export const ORDER_STATUSES = [
  "pending", "processing", "confirmed", "shipped",
  "delivered", "completed", "cancelled", "returned",
] as const;
```
This means admin users cannot see or transition orders that are in `incomplete`, `refunded`, or `partially_refunded` state via the OrderStatusCard dropdown. The order form's `SummarySection.tsx` imports a separate `OrderStatus` enum from `@/types/api-responses` which may have the full set, but the view page dropdown is incomplete. **Severity: Medium.** These orders exist in production (storefront online payment creates them as `incomplete`).

**[S-SM-2] Status dropdown allows invalid transitions.** The `OrderStatusCard` renders ALL statuses as selectable options regardless of the current order status. There is no client-side filtering based on `getAvailableTransitions()`. The server will reject invalid transitions (the API route calls `validateTransition`), but users get a confusing error rather than seeing only valid options. **Severity: Low** (server validates, but UX is poor).

**[S-SM-3] Fulfillment status transitions not wired through updateOrder.** The `updateOrder` function in `orders.admin.ts` handles order status transitions and inventory but does not validate or update fulfillment status. Fulfillment status is only updated through `createFulfillmentShipment`. The `updateOrder` route does not accept fulfillment status as a parameter, so the admin edit form cannot change it. This is arguably correct by design (fulfillment tracks actual shipping), but it means a fulfillment stuck in "partial" has no admin override path. **Severity: Low.**

### 2.2 Payment Status Transitions

```
unpaid  -> partial, paid, failed
partial -> paid, unpaid, refunded, failed
paid    -> partial, refunded
refunded -> (terminal)
failed  -> unpaid, partial, paid
```

Well-structured. The auto-sync in `updateOrderStatus` (COD orders automatically marked paid on delivery/completion) is a good pattern. However, `validateTransition` for payment status is never called in the codebase -- only order status transitions are validated through `validateTransition("order", ...)`. Payment status changes happen implicitly through payment processing code. **Severity: Info** -- the transition map exists but is defensive-only.

### 2.3 Fulfillment Status Transitions

```
pending  -> partial, complete
partial  -> complete, pending
complete -> pending
```

Clean and minimal. `complete -> pending` enables recovery from shipping errors.

---

## 3. Queue Processing

### 3.1 Order Ingest Queue (`orders.queue.ts`)

**Architecture:** Batched processing -- accumulates DB statements across all messages in a batch, then executes in one `db.batch()` call.

**Strengths:**
- Clear 4-phase architecture: prepare statements -> verify discounts -> reserve inventory -> atomic DB write
- Rollback on DB failure releases inventory reservations
- KV checkout status updates at each phase for storefront polling
- Per-pool inventory reservation (groups entries by regular/preorder/backorder)
- Discount usage re-check narrows race window between HTTP validation and queue processing
- COD tracking initialization is fire-and-forget (`.catch()`) -- correct, non-critical

**Issues:**

**[S-QU-1] Batch-level inventory reservation failure marks ALL orders as failed.** If one order's variants have insufficient stock, `reserveStockBatch` fails for the entire pool, which triggers retry of ALL messages in the batch and sets ALL checkout tokens to "failed". This means one out-of-stock item in a batch of 10 orders causes all 10 to fail. The code comments "Hard fail the entire batch" but this is a poor strategy for multi-order batches. **Severity: Medium.**

**[S-QU-2] Inventory rollback uses wrong orderId.** On DB write failure, `releaseMultiple` is called with `"batch-rollback"` as the orderId:
```typescript
await releaseMultiple(db, reservationEntries, "batch-rollback")
```
If `releaseMultiple` uses the orderId for any CAS check or logging, this will either fail silently or produce misleading audit trails. The reservations were made with per-order IDs during phase 2. **Severity: Low-Medium** (depends on releaseMultiple implementation).

**[S-QU-3] Failed messages retried but also marked as failed in KV.** When a message fails during preparation (Phase 1), the code both sets the KV status to "failed" AND retries the message. If the retry succeeds on the next attempt, the KV status is "failed" from the first attempt but "completed" from the second. This is fine because `setCheckoutStatus` preserves existing fields and overwrites status, but the storefront poll loop might see "failed" transiently before "completed". **Severity: Low.**

**[S-QU-4] Discount re-check looks up customerId from orderData which doesn't have it yet.** At line 256, the code reads `payload.orderData.customerId`, but the storefront order creation doesn't set `customerId` in the queue payload -- it's determined during queue processing (either from `existingCustomer.id` or newly created). For existing customers, the customerId is in `payload.existingCustomer.id`, not `payload.orderData.customerId`. For new customers, there's no customerId at all yet. This means the discount re-check always gets `undefined` for `customerId`, making the WHERE clause on `discountUsage.customerId` match nothing, and the guard never fires. **Severity: Medium** -- discount usage-per-customer limits are not enforced at queue time.

### 3.2 Queue Consumer Dispatcher (`queue-consumer.ts`)

**Strengths:**
- Clean routing by `batch.queue` name or message `type`
- Independent message processing with `Promise.allSettled` for payment/notification messages
- Per-message ack/retry with backoff (30s delay)
- ISO 4217 currency conversion for Stripe/Polar amounts
- Polar refund handling distinguishes external vs internal refund initiation

**Issues:**

**[S-QU-5] Queue name detection is fragile.** The dispatcher checks:
```typescript
batch.queue === "order-ingest-queue" || batch.messages.some(m => m.body.type === "order.ingest")
```
The first condition depends on the Cloudflare queue binding name matching exactly. The second is a content-based fallback but requires iterating all messages. If the queue name changes in wrangler config without updating this code, the fallback still works but adds latency. **Severity: Info.**

---

## 4. Checkout Flow

### 4.1 Storefront Order Creation (`orders.storefront.ts` -> `routes/orders.ts`)

**Flow:**
1. Storefront POST `/orders` with cart data
2. Route validates via Zod schema
3. `createStorefrontOrder` executes batched reads (variants, locations, customer, discount, products, settings, shipping method)
4. Server-side price verification (recalculates from DB prices, applies product/variant discounts)
5. Discount validation via injected callback functions
6. Partial payment security check
7. Builds queue payload with computed order ID and checkout token
8. Route dispatches to `ORDER_INGEST_QUEUE`
9. Route writes initial "processing" status to KV
10. Returns 202 with checkout token

**Strengths:**
- Server-side price verification prevents client-side price manipulation
- Discount validation is injected as a function parameter (good for testability)
- Batched reads in a single `db.batch()` call (7 queries in one round-trip)
- Shipping charge verified against shipping method record
- Free delivery product detection
- Checkout token enables async polling

**Issues:**

**[S-CO-1] Client-submitted prices are ignored but still stored.** The storefront validation schema accepts `price` per item, and the queue payload includes `item.price` from the client input (line 333: `price: item.price`). The server recalculates `serverItemTotal` and `totalAmount` correctly, but the per-item prices stored in `orderItems` come from the client payload, not the server-verified prices. If a client submits manipulated per-item prices, the `totalAmount` will be correct (server-calculated) but the line item prices will be wrong. This causes the admin order view to show incorrect per-item prices while the total is correct. **Severity: Medium.**

**[S-CO-2] Partial payment COD check has unreachable code.** Lines 319-321:
```typescript
status: (isPartialEnabled && data.paymentMethod === PaymentMethodEnum.COD)
    ? OrderStatusEnum.INCOMPLETE
    : data.paymentMethod === PaymentMethodEnum.COD ? OrderStatusEnum.PENDING : OrderStatusEnum.INCOMPLETE,
```
But earlier at line 282-284, if `isPartialEnabled && data.paymentMethod === COD`, a `ValidationError` is thrown. So the first branch of the ternary is dead code -- it can never execute. **Severity: Low** (no runtime impact, just confusing).

**[S-CO-3] Discount amount from payload used instead of verified amount.** At line 338:
```typescript
discountUsage: appliedDiscount && data.discountAmount && data.discountAmount > 0 ? {
    discountId: appliedDiscount.id,
    amountDiscounted: data.discountAmount,  // <-- client-submitted
} : null,
```
This uses `data.discountAmount` (the client-submitted value) rather than `verifiedDiscountAmount` (the server-calculated value). The `totalAmount` uses the correct `verifiedDiscountAmount`, but the discount usage record may store the wrong amount. **Severity: Medium.**

### 4.2 Storefront Polling (`storefront/src/lib/api/orders.ts`)

**Strengths:**
- Zero retries on creation (prevents double submission)
- Polling with 1.5s interval, 30 attempts (45s max wait)
- Handles both envelope formats (wrapped and raw 202)
- Timeout produces user-friendly message
- Retries on status check (2 retries with 5s timeout)

---

## 5. Layer Separation

### 5.1 Core Service Layer

**Strengths:**
- Clean separation: `orders.admin.ts` (admin CRUD), `orders.storefront.ts` (checkout), `orders.fulfillment.ts` (shipping/status), `orders.queue.ts` (async processing)
- All functions accept `db: Database` as first parameter (dependency injection)
- Validation schemas in dedicated file
- Types in dedicated file
- State machine is pure logic (no DB dependency)
- Barrel index excludes queue module (Cloudflare types don't belong in general barrel)

**Issues:**

**[S-LS-1] `orders.admin.ts` updateOrder does too much.** The `updateOrder` function handles: status validation, inventory adjustment (reserved/deducted), item diffing with stock management, location resolution, customer lookup/creation, optimistic locking, order+items write, and customer stats update. This is ~200 lines with complex branching. The inventory management in the "deducted" branch (lines 666-697) manually manages stock without CAS protection, unlike the reservation path which uses `reserveMultiple`/`releaseMultiple`. **Severity: Medium.**

**[S-LS-2] Inventory management in updateOrder (deducted path) lacks atomicity.** When `inventoryAction === "deducted"`, the code does individual `db.update(productVariants)` calls for each item, reads the variant stock, checks availability, then updates. These are not batched or protected by CAS -- a concurrent update between the read and write could cause overselling:
```typescript
const variant = await db.select()...get();
if (variant.stock < quantityDiff) throw ...
await db.update(productVariants).set({ stock: variant.stock - quantityDiff })...
```
**Severity: Medium** -- TOCTOU race condition. The reservation path correctly uses CAS-based `reserveMultiple`, but the deducted path does not.

### 5.2 API Route Layer

**Strengths:**
- Thin routes that delegate to core services
- OpenAPI schema definitions with Zod validation
- Consistent use of `ok()`, `created()`, `noContent()` response helpers
- Notification queueing after status update (fire-and-forget with error logging)
- Proper 202 response for async checkout

**Issues:**

**[S-LS-3] Admin orders GET /:id/cod uses inline require().** Line 268:
```typescript
const tracking = await c.get("db").select().from(require("@scalius/database/schema").codTracking)...
```
This is the only route that uses `require()` instead of static imports. It works but is inconsistent, not tree-shakeable, and harder to type-check. **Severity: Low.**

**[S-LS-4] Duplicate order items query.** The admin route `GET /:id/items` duplicates the items query logic from `getOrderDetails` in the core service. Both fetch order items with product/variant joins. The route could delegate to the service. **Severity: Low** (redundancy, not a bug).

### 5.3 Admin UI Layer

**Strengths:**
- Well-decomposed components (form split into context, sections, product search, items table)
- `OrderFormContext` provides centralized ref management for keyboard navigation
- Nanostores for real-time calculation updates (subtotal, shipping, discount, total)
- `OrderListContainer` with proper hook extraction (`useOrderListState`, `useOrderListApi`)
- Shift-click multi-select in order list
- Comprehensive payment card with COD tracking, refund dialog, transaction history

**Issues:**

**[S-UI-1] OrderFormContext calculation differs from server.** The `orderStore.ts` calculates total as:
```typescript
const total = subtotal + shipping - (discount || 0);
```
While the server uses `subtractPrice(addPrices(...), discountAmount)` which applies rounding at each step. The client-side calculation does not round, so the displayed total may differ from the server-calculated total by a few cents on certain inputs. **Severity: Low** (cosmetic only -- server total is authoritative).

**[S-UI-2] Product discount calculation only handles percentage discounts.** In `OrderItemsSection.tsx`, `calculateDiscountedPrice` only checks `product.discountPercentage`:
```typescript
if (product.discountPercentage && product.discountPercentage > 0) {
    const discountAmount = basePrice * (product.discountPercentage / 100);
    return (basePrice - discountAmount).toFixed(2);
}
```
But the database schema and storefront support both `discountType: "percentage"` and `discountType: "flat"` with `discountAmount`. Admin order creation ignores flat discounts on products/variants. **Severity: Medium** -- admin-created orders will use wrong prices for flat-discounted products.

**[S-UI-3] OrderViewHeader computes grandTotal differently.** Line 64-65:
```typescript
const grandTotal = order.totalAmount + order.shippingCharge - (order.discountAmount ?? 0);
```
But `order.totalAmount` from the API already includes shipping and discount (it's the final total). This double-counts shipping and discount. Looking at the admin API route: `getOrderDetails` returns `totalAmount` from the `orders` table, and `createOrder` computes `totalAmount = subtractPrice(addPrices(itemsTotal, shipping), discount)`. So `totalAmount` IS the grand total already. The header's formula adds shipping again and subtracts discount again. **Severity: High** -- this displays an incorrect grand total to the admin user. The `PaymentCard` has the same issue at line 132.

---

## 6. Fulfillment Logic

### 6.1 Shipment Creation (`orders.fulfillment.ts`)

**Strengths:**
- `createFulfillmentShipment` handles partial/final shipment logic correctly
- Atomic batch write for shipment + item status updates + order status update
- Prevents double-fulfillment of already-shipped items
- Auto-promotes order to SHIPPED when final shipment is created for CONFIRMED orders
- Inventory deduction on shipment is fire-and-forget (`.catch(console.error)`) -- acceptable since it's already tracked

**Issues:**

**[S-FU-1] bulkShipOrders skips optimistic locking.** The function updates order status to SHIPPED without version checking:
```typescript
await db.update(orders).set({
    status: OrderStatus.SHIPPED,
    fulfillmentStatus: FulfillmentStatus.COMPLETE,
    ...
}).where(eq(orders.id, orderId));
```
Compare with `updateOrderStatus` which uses CAS. A concurrent status change during bulk ship would be silently overwritten. **Severity: Medium.**

**[S-FU-2] bulkShipOrders does not validate order status before shipping.** It calls `createShipment` but doesn't check if the order is in a shippable state (e.g., it would try to ship a cancelled order). The delivery provider might reject it, but the state machine is bypassed. **Severity: Medium.**

**[S-FU-3] COD processCodAction "collected" sets status to DELIVERED without state machine validation.** Line 51:
```typescript
await db.update(orders).set({ status: OrderStatus.DELIVERED, ... })
```
This bypasses `validateTransition` entirely. If the order is in "confirmed" state (not yet shipped), marking COD collected would jump to DELIVERED, skipping the SHIPPED state. **Severity: Medium.**

### 6.2 Status Update Notifications

The `updateOrderStatus` function builds a notification payload for `shipped` and `delivered` statuses. The API route then enqueues this to `ORDER_NOTIFICATIONS_QUEUE`. This is well-designed -- the service returns the notification intent, and the route handles the queue binding.

Missing: No notification for `confirmed` or `completed` status changes. `order_created` notification type exists in the queue consumer but is never triggered from the status update path. **Severity: Info** -- may be intentional.

---

## 7. Type Safety

### 7.1 Type Flow Analysis

**Core -> API:** Types flow cleanly. `OrderDetails`, `OrderListItem`, `StatusUpdateResult` from `orders.types.ts` are used by both service and route layers. Zod schemas (`createOrderSchema`, `updateOrderSchema`) enforce validation at API boundaries.

**API -> Admin:** The admin loaders (`loaders/admin/orders.ts`) import `OrderListItem` from core and use API response types from `@/types/api-responses`. There's a Date conversion layer in the loader (API returns epoch numbers, loader converts to Date objects).

**Queue payload:** The `OrderIngestQueueMessage` type uses `Record<string, unknown>` for both `orderData` and `items`, losing type safety at the queue boundary. The queue handler then casts everything with `as`:
```typescript
od.customerName as string,
od.totalAmount as number,
```
This means a change to the storefront order structure won't be caught at compile time.

**Issues:**

**[S-TS-1] Queue message payload types are stringly typed.** `OrderIngestQueueMessage.orderData` is `Record<string, unknown>` and `items` is `Record<string, unknown>[]`. A proper typed interface matching `CreateStorefrontOrderResult.queuePayload` would catch breaking changes at compile time. **Severity: Medium.**

**[S-TS-2] Admin orderview types diverge from core types.** `apps/admin/src/components/admin/orderview/types.ts` defines its own `Order` interface with optional fields (`paymentMethod?: string | null`) that don't match the core `OrderDetails` type. This creates a shadow type system. **Severity: Low** -- works due to duck typing but fragile.

**[S-TS-3] Storefront API client uses `any`.** In `storefront/src/lib/api/orders.ts`:
```typescript
export async function createOrder(payload: CreateOrderPayload):
    Promise<{ success: boolean; orderId?: string; error?: any }>
```
The `error?: any` and multiple internal `as any` casts reduce type safety. **Severity: Low.**

---

## 8. Concurrency

### 8.1 Optimistic Locking

**Strengths:**
- `orders.version` column used for CAS (compare-and-swap) in `updateOrder` and `updateOrderStatus`
- `ConflictError` thrown with user-friendly message when version mismatch
- `updateOrderStatus` applies CAS BEFORE side effects (inventory, notifications), preventing the race where two callers both apply inventory

**Issues:**

**[S-CC-1] updateOrder inventory adjustment happens BEFORE CAS check.** In `orders.admin.ts` `updateOrder`, the inventory adjustment (`applyInventoryForStatusChange`) at line 731 happens BEFORE the optimistic locking check at line 735. If the CAS fails (version mismatch), inventory has already been modified:
```typescript
// Line 731: This executes first
newInventoryAction = await applyInventoryForStatusChange(db, id, data.status);
// Line 735: CAS check -- may fail AFTER inventory was changed
const updateResult = await db.update(orders).set({...})
    .where(and(eq(orders.id, id), eq(orders.version, existingOrder.version)))
    .returning();
```
There's no rollback of the inventory change if the CAS fails. Compare with `updateOrderStatus` which correctly does CAS first, then inventory. **Severity: High** -- concurrent admin edits can cause inventory inconsistency.

**[S-CC-2] createOrder reserve-then-batch has a small window.** Between `reserveMultiple` (line 433) and `db.batch` (line 552), another request could modify the same variants. The reservation is properly rolled back on batch failure, but the window exists. This is a fundamental limitation of D1's lack of true transactions. **Severity: Low** (mitigated by rollback).

**[S-CC-3] updateOrder deducted-path stock check is not atomic.** As described in S-LS-2, the stock read-check-update in the deducted inventory path is not protected by CAS or batch. **Severity: Medium** (overlaps with S-LS-2).

---

## 9. Admin vs Storefront Separation

**Strengths:**
- Completely separate service files: `orders.admin.ts` vs `orders.storefront.ts`
- Storefront only imports `@scalius/shared` and `@scalius/api-client` (not core or database directly)
- Storefront cannot access admin routes (different service binding, auth middleware)
- Admin has full CRUD including soft delete, restore, permanent delete, bulk operations
- Storefront only creates orders (no update/delete) and polls status
- Admin order creation bypasses queue (synchronous), storefront goes through queue (async)
- Different price calculation: admin trusts submitted prices, storefront verifies against DB

**Issues:**

**[S-AS-1] Storefront GET /orders/:id exposes shipments and delivery providers.** The storefront order route returns `shipments` and `deliveryProviders` alongside the order. While useful for order tracking, delivery provider credentials and internal IDs may be more than the storefront should see. **Severity: Low** -- the `getActiveDeliveryProviders` presumably filters sensitive fields.

---

## 10. File Organization & LLM-Friendliness

### 10.1 Strengths

- **Clear naming convention**: `orders.admin.ts`, `orders.storefront.ts`, `orders.fulfillment.ts`, `orders.queue.ts` immediately communicates purpose
- **Single responsibility**: each file has one concern (admin ops, checkout, shipping, queue)
- **Barrel export with exclusion**: `index.ts` re-exports everything except `orders.queue.ts` (which has Cloudflare-specific types), with a comment explaining why
- **Type colocation**: `orders.types.ts` groups all interfaces, `orders.validation.ts` groups all Zod schemas
- **State machine is standalone**: `order-state-machine.ts` has no side effects, pure logic with clear transition maps
- **Inline documentation**: JSDoc comments explain inventory flow in `createOrder`, queue strategy in `handleOrderIngestBatch`
- **Comment headers**: Files start with purpose comments explaining what the module does

### 10.2 Suggestions

**[S-LF-1] `UpdateOrderData` interface is inline.** Lines 589-605 of `orders.admin.ts` define `UpdateOrderData` as a local interface. It should be in `orders.types.ts` alongside `CreateOrderInput` for discoverability. **Severity: Low.**

**[S-LF-2] Admin route file is 860 lines.** `apps/api/src/routes/admin/orders.ts` has 20+ routes in a single file. It would benefit from splitting into sub-routers (e.g., `orders-shipments.ts`, `orders-payments.ts`, `orders-cod.ts`). **Severity: Low** -- still readable but approaching the limit.

---

## 11. Issues Summary

### Critical / High

| ID | Description | Location |
|----|-------------|----------|
| S-UI-3 | OrderViewHeader and PaymentCard double-count shipping/discount in grand total display | `orderview/OrderViewHeader.tsx:64`, `orderview/PaymentCard.tsx:132` |
| S-CC-1 | updateOrder applies inventory BEFORE CAS check; no rollback on version conflict | `orders.admin.ts:731-755` |

### Medium

| ID | Description | Location |
|----|-------------|----------|
| S-SM-1 | Admin status dropdown missing incomplete, refunded, partially_refunded | `orderview/types.ts:48-57` |
| S-QU-1 | One out-of-stock item fails entire batch of orders | `orders.queue.ts:299-307` |
| S-QU-4 | Discount re-check reads undefined customerId from payload | `orders.queue.ts:256` |
| S-CO-1 | Client-submitted per-item prices stored in DB instead of server-verified prices | `orders.storefront.ts:330-337` |
| S-CO-3 | Client discountAmount used in discount usage record instead of verifiedDiscountAmount | `orders.storefront.ts:338` |
| S-LS-1 | updateOrder is 200 lines with complex branching; deducted path lacks CAS | `orders.admin.ts:607-787` |
| S-LS-2 | TOCTOU race in deducted inventory path (read-check-write without CAS) | `orders.admin.ts:666-697` |
| S-FU-1 | bulkShipOrders skips optimistic locking | `orders.fulfillment.ts:31-36` |
| S-FU-2 | bulkShipOrders does not validate order status before shipping | `orders.fulfillment.ts:27` |
| S-FU-3 | COD collected action bypasses state machine validation | `orders.fulfillment.ts:51` |
| S-UI-2 | Admin order form only handles percentage discounts, ignores flat discounts | `order-form/OrderItemsSection.tsx:99-103` |
| S-TS-1 | Queue message payload uses Record<string, unknown> instead of typed interface | `orders.queue.ts:25-27` |
| S-QU-2 | Inventory rollback uses "batch-rollback" as orderId instead of per-order IDs | `orders.queue.ts:352` |

### Low / Info

| ID | Description | Location |
|----|-------------|----------|
| S-SM-2 | Status dropdown shows all statuses, not just valid transitions | `orderview/OrderStatusCard.tsx:141-149` |
| S-SM-3 | No admin override path for stuck fulfillment status | Design gap |
| S-CO-2 | Dead code in partial payment status ternary | `orders.storefront.ts:319-321` |
| S-LS-3 | Inline require() in admin COD route | `routes/admin/orders.ts:268` |
| S-LS-4 | Duplicate items query in route vs service | `routes/admin/orders.ts:416-444` |
| S-UI-1 | Client-side total calculation doesn't match server rounding | `store/orderStore.ts:60` |
| S-TS-2 | Shadow Order type in orderview diverges from core types | `orderview/types.ts` |
| S-TS-3 | any types in storefront API client | `storefront/src/lib/api/orders.ts:15,30` |
| S-QU-3 | Failed messages both retried and KV-marked as failed (transient inconsistency) | `orders.queue.ts:339-342` |
| S-QU-5 | Queue name detection is fragile | `queue-consumer.ts:138` |
| S-LF-1 | UpdateOrderData interface is inline instead of in types file | `orders.admin.ts:589-605` |
| S-LF-2 | Admin route file is 860 lines | `routes/admin/orders.ts` |
| S-AS-1 | Storefront order endpoint exposes delivery provider data | `routes/orders.ts:116-117` |

---

## 12. Recommendations

### Immediate Fixes (High Priority)

1. **Fix grand total display** (S-UI-3): In `OrderViewHeader.tsx` and `PaymentCard.tsx`, `order.totalAmount` already IS the grand total (shipping included, discount subtracted). The formula `totalAmount + shippingCharge - discountAmount` double-counts. Fix: use `order.totalAmount` directly.

2. **Fix CAS ordering in updateOrder** (S-CC-1): Move the `applyInventoryForStatusChange` call to AFTER the optimistic locking check succeeds, matching the pattern in `updateOrderStatus`. If CAS fails, skip inventory adjustment entirely.

### Short-term Improvements

3. **Store server-verified item prices** (S-CO-1): In `orders.storefront.ts`, compute the server-verified unit price for each item and include it in the queue payload, replacing the client-submitted `item.price`.

4. **Fix discount usage amount** (S-CO-3): Change `data.discountAmount` to `verifiedDiscountAmount` in the discount usage record.

5. **Add valid transitions to status dropdown** (S-SM-1, S-SM-2): Import `getAvailableTransitions` and filter the dropdown options based on current order status. Add the missing statuses to `ORDER_STATUSES`.

6. **Type the queue message payload** (S-TS-1): Replace `Record<string, unknown>` with a proper typed interface for `OrderIngestQueueMessage.orderData`.

7. **Fix discount re-check customerId** (S-QU-4): Use `payload.existingCustomer?.id` instead of `payload.orderData.customerId`.

### Medium-term Improvements

8. **Per-order inventory reservation in batch** (S-QU-1): Process inventory reservations per-order instead of per-pool. When one order fails reservation, fail only that order and continue with the rest.

9. **Add CAS to bulkShipOrders** (S-FU-1): Use version-based optimistic locking like `updateOrderStatus`.

10. **Add state machine validation to COD actions** (S-FU-3): Call `validateTransition("order", ...)` before updating order status in `processCodAction`.

11. **Handle flat discounts in admin form** (S-UI-2): Support both percentage and flat discount types in `calculateDiscountedPrice`.

12. **Extract updateOrder inventory logic** (S-LS-1): Move the deducted-path stock management to use the same CAS-based `deductMultiple`/`releaseMultiple` helpers, eliminating the TOCTOU race.
