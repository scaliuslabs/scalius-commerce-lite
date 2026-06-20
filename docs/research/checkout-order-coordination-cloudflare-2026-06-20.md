# Checkout/order coordination on Cloudflare, 2026-06-20

Scope: add-to-cart, buy-now, checkout, order creation, and inventory reservation for the current Scalius Commerce Lite repo. This is research only; no application code was edited.

Platform claims below are based on current Cloudflare documentation accessed on 2026-06-20:

- [Durable Objects rules and best practices](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/): use DOs for stateful coordination, strong consistency, and per-entity storage; use plain Workers for stateless/high-fanout request handling.
- [Durable Objects storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/) and [SQLite-backed DO storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/): each DO has private transactional strongly consistent storage; new DO namespaces should use SQLite storage.
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/): each object is single-threaded; a single hot object is a throughput bottleneck.
- [Durable Objects alarms](https://developers.cloudflare.com/durable-objects/api/alarms/): one alarm can be scheduled per object; alarm execution is at least once and retryable.
- [D1 Database Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/): `batch()` sends multiple statements in one call; statements run sequentially in a transaction and rollback on statement failure.
- [Workers KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/): KV is eventually consistent, optimized for read-heavy cache/config, and is not ideal for atomic read/write coordination.
- [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) and [Queues behavior](https://developers.cloudflare.com/queues/reference/how-queues-works/): Queues are at-least-once by default; a queue can have one active consumer, and consumers must tolerate duplicate delivery.
- [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) and [HTTP service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/): one Worker can call another via a binding without exposing a public URL.

## Executive conclusion

The best near-term architecture is not "move all checkout state into Durable Objects." Keep D1 as the order, payment, and inventory ledger; make checkout/order creation a D1-first transactional workflow behind the existing API Worker service binding; use Queues only after a durable D1 claim exists; and use a small per-checkout Durable Object only where it adds coordination: idempotency, repeated-click serialization, short-lived checkout status, and reservation-expiry alarms.

Do not reserve inventory on add-to-cart. Cart and buy-now should remain low-friction draft actions. Reserve only when the customer creates an order or explicitly enters a payment commitment step, with a short expiry for unpaid online orders.

Use per-variant or per-inventory-shard Durable Objects only if hot-SKU contention becomes a measured bottleneck. They are a valid Cloudflare-native concurrency primitive for inventory, but they introduce multi-SKU saga complexity and projection/reporting work that D1 already solves.

## Current repo behavior and issues

Strengths to preserve:

- Storefront order creation disables retries for the mutation to avoid duplicate ingestion and uses a longer timeout for the heavy endpoint: `apps/storefront/src/lib/api/orders.ts:37-51`.
- The API revalidates prices, discounts, shipping, partial-payment rules, and product/variant existence server-side before building the order payload: `packages/core/src/modules/orders/orders.storefront.ts:203-323`.
- Payment sessions require the receipt token, re-read gateway allowlists/settings freshly, and validate the order's payable state before provider calls: `apps/api/src/routes/payment/stripe-routes.ts:67-131`, `apps/api/src/routes/payment/sslcommerz-routes.ts:74-160`, `apps/api/src/routes/payment/polar-routes.ts:68-165`, `apps/api/src/routes/payment/payment-method-allowlist.ts:16-31`, `apps/api/src/routes/payment/payment-session-policy.ts:71-148`.
- Inventory mutations already have a D1 stock ledger: variants include `stock`, `reservedStock`, `preorderStock`, and `stockVersion`: `packages/database/src/schema/products.ts:59-99`; movements are logged in `inventory_movements`: `packages/database/src/schema/inventory.ts:15-37`.

Issues to address:

1. Cart and buy-now are only browser state. `cartStore` persists to `localStorage`: `apps/storefront/src/store/cart.ts:48-56`, hydrates from it: `apps/storefront/src/store/cart.ts:150-158`, and add-to-cart just mutates that local store: `apps/storefront/src/store/cart.ts:206-242`. Product add-to-cart/buy-now uses the local store and redirects buy-now to `/cart`: `apps/storefront/src/components/product/scripts/product-controller.ts:393-433`. The `/buy/[slug]` route writes `quickBuyData` to `sessionStorage` and redirects to `/cart`: `apps/storefront/src/pages/buy/[slug].ts:142-187`.

2. Checkout payloads are assembled from hidden/session data. The cart page intercepts multi-gateway checkout, serializes form/cart fields to `sessionStorage`, then redirects to `/checkout`: `apps/storefront/src/pages/cart.astro:686-725`. The checkout page later reads that data from `sessionStorage`: `apps/storefront/src/lib/checkout/index.ts:79-88`. Server validation catches price/shipping manipulation, but the coordination point is late and browser-owned until order creation.

3. The code has a split-brain async/sync order story. `createStorefrontOrder()` still says it returns a payload ready for `ORDER_INGEST_QUEUE`: `packages/core/src/modules/orders/orders.storefront.ts:26-30`, and API Wrangler declares an `ORDER_INGEST_QUEUE`: `apps/api/wrangler.jsonc:64-112`. But the public create route writes KV status/receipt and then calls `commitStorefrontOrderPayload()` synchronously; tests assert the queue is not used: `apps/api/src/routes/orders.ts:364-408`, `apps/api/src/routes/orders-create.test.ts:86-122`. Storefront still has a 202 polling branch for async order ingest: `apps/storefront/src/lib/api/orders.ts:69-107`.

4. KV is used for checkout coordination facts. The create route writes `checkout_status:{token}` and `order_receipt:{token}` before committing the order: `apps/api/src/routes/orders.ts:364-374`. Payment session and receipt reads trust `validateReceiptToken()` from KV: `apps/api/src/utils/order-receipt-token.ts:6-29`. Cloudflare documents KV as eventually consistent and not ideal for atomic/read-write coordination, so receipt/session authorization should move to D1 or a signed token, with KV only as a cache.

5. Inventory reservation and order insertion are separate phases. `commitStorefrontOrderPayload()` resolves/creates the customer, asserts discount usage, reserves stock, then writes the order batch; if the order write throws, it releases reservations: `packages/core/src/modules/orders/orders.ingest.ts:344-371`. If the Worker dies after reservation and before order write or rollback, the cleanup path is cron-based and delayed.

6. Reservation expiry only releases orphaned reservations whose order row does not exist. The sweeper explicitly skips reservations tied to existing orders and says cancellation must go through order transition logic: `packages/core/src/modules/inventory/expiry.ts:95-121`, `packages/core/src/modules/inventory/expiry.ts:149-168`. Online orders created as `incomplete` with reserved stock can therefore hold stock until a payment cancellation/failure/admin transition path explicitly releases it.

7. Failed-payment handling does not itself release reserved stock. `processPaymentFailed()` records a failed payment and may mark `paymentStatus` failed: `packages/core/src/modules/payments/process-payment.ts:329-412`. Inventory release is a separate `releaseOrderInventory()` path: `packages/core/src/modules/payments/process-payment.ts:419-442`, and the queue consumer calls it for Stripe cancellation but not for every failed provider event: `apps/api/src/queue-consumer.ts:270-280`, `apps/api/src/queue-consumer.ts:311-359`.

8. The reservation algorithm is careful but complex. `reserveStockBatch()` preloads variants, checks availability, writes movement claims, CAS-updates variants, verifies zero-row conflicts, rolls back successful updates on conflict, and retries: `packages/core/src/modules/inventory/reserve.ts:266-458`. D1 batches rollback on SQL statement failure, but zero-row CAS results are not SQL failures; correctness depends on application-side verification and compensating updates.

## Recommended architecture

### 1. Keep add-to-cart client-local; make buy-now a checkout-intent shortcut

Add-to-cart should not reserve inventory. It should:

- Keep using local cart state for speed.
- Optionally call a lightweight availability endpoint after variant/quantity selection, but treat it as advisory.
- Show "only N left" from D1/KV-cached availability with clear stale-safe behavior.

Buy-now should become a shortcut that creates a single-item checkout intent, not a reservation. Instead of writing `quickBuyData` to `sessionStorage` and redirecting to `/cart`, it can POST a server checkout-intent draft and route directly to checkout with an idempotency key. The cart can keep the existing UX while sharing the same checkout-intent API.

### 2. Introduce `checkout_attempts` / `checkout_intents` in D1

Move coordination facts out of KV and into D1:

- `id`
- `idempotency_key`
- `cart_hash`
- `customer_id` / guest contact snapshot
- `status`: `draft`, `committing`, `reserved`, `payment_pending`, `completed`, `failed`, `expired`, `cancelled`
- `order_id`
- `receipt_token_hash` or signed receipt-token metadata
- `expires_at`
- `last_error`
- timestamps

KV may mirror `checkout_status:*` after D1 commit for fast polling, but D1/DO must be authoritative. This avoids immediate read-after-write problems for receipt/payment-session validation.

### 3. Use a per-checkout Durable Object as the coordinator, not the database of record

Create a SQLite-backed `CheckoutCoordinator` DO named by a stable idempotency key, for example `checkout:{storeId}:{idempotencyKey}`.

Responsibilities:

- Serialize double-clicks, browser retries, payment-page refreshes, and repeated gateway-session attempts for one checkout.
- Hold a small local state machine: idempotency key, order id, status, and next expiry timestamp.
- Call the API/core D1 code to validate and commit the order.
- Schedule one alarm for the checkout/order expiry deadline; alarm handler is idempotent and calls D1 transition/release logic if the order is still unpaid/incomplete.
- Return the same committed order/receipt result for repeated identical requests.

Non-responsibilities:

- Do not store the canonical order, inventory, or payment ledger only in DO storage.
- Do not create one global checkout/order DO.
- Do not use the checkout DO to serve admin order reports.

Why this fit is good: Cloudflare positions DOs for stateful coordination and per-entity strong consistency. A checkout attempt is a natural coordination atom. It has a bounded lifetime, a small state surface, and repeated calls that must serialize.

### 4. Make D1 the canonical commit path

Refactor the current `reserve then order batch` flow into a D1 commit service that treats reservation, order creation, order items, discount usage, receipt token, and outbox writes as one durable unit as far as D1 allows.

Recommended shape:

1. Pre-read product/variant/shipping/settings rows and compute server prices.
2. Use deterministic idempotency keys for `checkout_attempts`, `orders`, `inventory_movements`, `order_notification_outbox`, and gateway session claims.
3. Convert insufficient-stock/CAS conflicts into explicit failed statements or a clean 409 path before durable partial side effects are exposed.
4. Write order rows only after the reservation claims are known to exist.
5. Record a first-class `expires_at` for unpaid reservations tied to existing orders.
6. Move receipt validation from KV to either:
   - a D1 `checkout_attempts`/`order_receipts` lookup, or
   - a signed, short-lived token whose subject is the order id and whose validity can be checked without KV read-after-write.

If Drizzle/D1 batch semantics make a single transaction hard for zero-row CAS checks, keep the two-phase reservation/write path temporarily, but make the gap explicit: a D1 `reservation_claims` row with `expires_at`, idempotency, and a DO alarm/cron cleanup that releases both orphaned and unpaid-expired reservations.

### 5. Use Queues after durable claims, not as the source of checkout truth

Queues should remain for:

- payment webhooks after webhook idempotency is claimed;
- notifications/outbox delivery;
- cache purge/warming;
- delayed reconciliation and DLQ workflows.

Do not return a successful checkout response merely because a queue message was sent. Since Cloudflare Queues are at-least-once, every queue consumer should continue using deterministic claims and idempotent state transitions.

The existing `ORDER_INGEST_QUEUE` should either be retired from the public checkout path or restored intentionally. A good compromise is:

- public order creation stays synchronous for the D1 commit and returns order id/receipt token;
- heavy side effects use queues/outbox;
- if an async ingest mode is reintroduced, the status endpoint must read D1/DO, not only KV.

### 6. Inventory DOs: optional hot-SKU optimization

Start without inventory DOs. D1 already carries the canonical inventory ledger and is easier for reporting, migrations, admin edits, and OpenAPI-backed API behavior.

Add `InventoryVariant` or `InventoryShard` DOs later only behind a feature flag if load tests show D1 CAS contention or D1 overload on hot SKUs.

If used:

- Name by `storeId:variantId` or a small deterministic shard key, never one global inventory object.
- Route all checkout reservations and admin stock adjustments for that variant/shard through the same DO.
- Persist only coordination state and short-lived counters in DO storage; D1 remains the reporting and audit ledger.
- For multi-variant carts, acquire/reserve in canonical variant-id order and use compensating releases. Accept that cross-DO atomicity is a saga, not a single transaction.

## Why / why not Durable Objects

### Inventory

Use DOs for inventory if:

- the same variant receives enough concurrent order attempts to cause repeated D1 CAS conflicts;
- you need per-variant serialization and immediate wait/queue behavior;
- you can route admin stock adjustments, reservation expiry, and checkout commits through the same variant/shard coordinator.

Do not use DOs as the only inventory database because:

- inventory reports, product listing availability, admin search, and order history already depend on D1;
- a single inventory DO would be a bottleneck;
- per-variant DOs make multi-item carts a distributed saga;
- projections from many DO-local SQLite databases back to D1 add operational complexity.

### Cart

Use DOs for carts if:

- customers need cross-device carts without login;
- multiple browser sessions can edit the same cart;
- cart state must be recovered server-side and expire independently.

Do not use DOs merely for add-to-cart:

- add-to-cart is not a scarce-resource mutation;
- reserving at add-to-cart encourages stock hoarding;
- client-local state is faster and adequate until checkout commitment.

### Order / checkout

Use a per-checkout/order DO for:

- idempotency and repeated submit serialization;
- checkout status without KV consistency risk;
- one alarm per checkout/order to expire unpaid reservations;
- narrow orchestration around D1 commits and gateway-session retries.

Do not use a global order DO or DO-only order storage:

- order listing/search/reporting belongs in D1;
- service bindings plus D1 already fit the API/admin/storefront split;
- Queues/webhooks still require idempotent D1 state transitions.

## Migration plan

1. Stabilize the current contract.
   - Keep `POST /api/v1/orders` response shape.
   - Add tests documenting current sync behavior, receipt token validation, and stock reservation lifecycle.
   - Remove or mark the dead 202 async branch only after the new flow decides whether async ingest is intentionally supported.

2. Move checkout status and receipt authority to D1.
   - Add `checkout_attempts` or `order_receipts`.
   - Store receipt token hashes or signed-token metadata.
   - Change `validateReceiptToken()` to read D1 or verify signed tokens.
   - Continue writing KV as a best-effort cache for old clients during transition.

3. Add first-class reservation expiry for existing unpaid orders.
   - Add `expires_at` to reservation/order checkout state.
   - Extend expiry logic to release reservations for `incomplete`/unpaid expired orders, not only orphaned movements.
   - Decide policy for payment failure: immediate release, retry window, or payment-method-specific hold.

4. Refactor order commit.
   - Centralize D1 order commit in one service.
   - Preserve server price/shipping/discount validation.
   - Ensure repeated idempotency key returns the same order without extra `reservedStock`.
   - Convert partial reservation failures into clean 409/validation errors with no committed order.

5. Introduce `CheckoutCoordinator` DO.
   - Add a SQLite DO binding and migration.
   - Route only checkout commit/status/expiry through it.
   - Keep D1 as source of truth.
   - Use DO alarms for per-checkout expiry and keep cron as a safety net.

6. Roll out gradually.
   - Feature flag by environment or store.
   - Shadow-write `checkout_attempts` while old create route remains authoritative.
   - Compare D1 order counts, inventory movements, reserved totals, and checkout status outcomes.

7. Optional inventory DO pilot.
   - Select one hot variant or shard.
   - Route admin stock adjustments and checkout reservations through the same DO.
   - Require projection/reconciliation checks before broad rollout.

## Risks

- Cross-variant reservations are hard to make atomic across multiple DOs; prefer D1-first until contention demands sharding.
- DO alarms are at least once, so expiry handlers must be idempotent and D1-guarded.
- Queue delivery is at least once, so consumers must keep deterministic claims and terminal statuses.
- KV mirrors can be stale; any client-visible status backed by KV must tolerate stale/missing data and fall back to D1/DO.
- Gateway session creation is an external side effect; use deterministic payment-session claims and provider idempotency where available.
- D1 batch rollback happens on statement failure, not on an application-level "zero rows updated" result. CAS conflicts need explicit handling.
- Local development differs from production service bindings; keep HTTP fallback paths tested.
- Changing reservation expiry behavior affects merchant expectations for unpaid online orders and COD holds.

## Tests to add

- Concurrent checkout for one variant with `stock=1`: exactly one order reserves; the other receives a stock conflict; `reservedStock` ends at 1.
- Multi-variant cart where one variant is insufficient: no order row, no notification outbox row, no discount usage, no net reservation.
- Repeated `POST /orders` with the same idempotency key: same order/receipt returned; no duplicate movements or reserved stock.
- Worker-crash simulation after reservation before order write: expiry releases the reservation and records a deterministic release movement.
- Worker-crash simulation after order commit before KV mirror: receipt/payment-session validation still succeeds via D1/signed token.
- Payment-session retry for Stripe/SSLCommerz/Polar: no duplicate gateway/session claims; same order payment intent/session reused or cleanly superseded.
- Payment failed/cancelled/expired policies: reserved inventory releases exactly once when policy says to release.
- Webhook duplicate/redelivery tests: payment confirmation and failure are idempotent and do not double-adjust stock.
- DO alarm tests with Workers Vitest: alarm can run twice and still release at most once.
- Admin stock adjustment racing checkout reservation: one serialized path wins; availability and movement ledger remain consistent.
- Storefront integration: add-to-cart stays local; buy-now creates a checkout intent; checkout refresh/retry returns stable status.
