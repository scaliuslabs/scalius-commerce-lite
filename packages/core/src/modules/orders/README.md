# Orders

The order record and everything staff and buyers do with it: lists and detail, manual orders and COD
amendments, edits, archive, the status lifecycle, returns, invoices, receipts, account orders, order
lookup and payment recovery. The primitives other domains share (state machine, shipment, payment-session
and refund locks, app facts) live below it in `order-kernel`; storefront checkout is `checkout`; hand-over
actions are `fulfilment`. The status table and the inventory effect of each move are in
`docs/ARCHITECTURE.md` ("Order lifecycle"). This file keeps the invariants code alone does not explain.

## Admin order creation (synchronous, idempotent, reserve until fulfillment)

1. **Admin POST /admin/orders** -- the browser submits a UUID `requestKey`. It persists only a submitted opaque key in tab-local storage for lost-response recovery and clears it after success or explicit discard. Customer and order facts never enter the key or storage entry.
2. **Claim before mutable validation** -- `buildAdminOrderCreateAttemptIdentity()` scopes the key to the authenticated actor and hashes a canonical request projection. `claimAdminOrderCreateAttempt()` owns one stable order ID and reservation identity. A committed same-payload retry replays before catalog, delivery, customer, currency, or inventory validation; stale or failed same-payload work reclaims the same identity.
3. **Changed-payload recovery** -- a key never silently changes meaning. If the earlier payload committed, the typed conflict returns its actor-scoped order ID so the dashboard opens that order instead of risking a duplicate. A fresh processing lease keeps the edited form and asks the operator to retry shortly. A failed lease permits exactly one browser-generated replacement key; an expired processing lease is first fenced to `failed` behind its old request hash so an overdue worker cannot commit after that replacement is authorized.
4. **SKU authority** -- `resolveAdminOrderItemInventory()` requires every item to use a concrete SKU, joins it to its parent product, and rejects missing/deleted SKUs, product/SKU mismatches, inactive products, and soft-deleted products before any inventory or order write starts. The returned `inventoryTracked` flag is trusted only after this validation.
5. **Reserve stock** -- `commitOrder()` (`commit-order.ts`) prepares the ledger-v2 reservation of the validated tracked SKUs (fresh mode: a new order id holds none) under the attempt's stable reservation key. Insufficient stock fails before the order write.
6. **Atomic commit** -- `commitOrder()` runs one guarded batch: the attempt guard, the reservation, the customer, order, items, tax snapshots, COD state, app discount facts, the `prices_set` event and the replay response on `admin_order_create_attempts`. The attempt guard prevents an expired worker from committing after another worker reclaims or fences its lease. Each line freezes its product's warranty revision, as a checkout line does.
7. **On preparation or batch failure** -- the batch rolls back as a whole, so no reservation needs releasing. A batch that committed despite the error replays; otherwise the attempt is marked failed unless another worker owns it. A guest record created concurrently and moving stock are retried by the kernel.
8. **Fulfillment owns deduction** -- the committed confirmed order intentionally keeps `inventoryAction = "reserved"`. Shipment/final-fulfillment commands later call `applyInventoryForStatusChange()` with deterministic movement claims, stock CAS, and guarded `inventoryAction` convergence. There is no post-commit creation step that can leave a newly created manual order half-converted.

## Order money

All order money is integer minor units. `currency_code` is the presentment currency: what the buyer sees and pays. The money chain (migration 0111, MARKETS-DESIGN D3) records the conversion into the shop currency: `shop_currency`, `fx_rate` (a decimal string, shop units per presentment unit), `fx_source`, `fx_as_of`, `fx_locked_until`, and the shop totals `subtotal_shop_minor`, `shipping_shop_minor`, `discount_shop_minor`, `tax_shop_minor` and `total_shop_minor`. A same-currency order has rate "1", source `same_currency`, no quote times, and shop amounts equal to the presentment amounts. A market-presentment order carries the FX snapshot checkout prepared (`presentmentFx()` in `prepare.ts`): `commitOrder()` persists the supplied locked rate, source and quote times with the converted shop totals.

- The checkout commit and `createOrder()` write the chain in the order insert (`orderMoneyChainColumns()`, `@scalius/shared/money-chain`). An amendment rewrites the shop amounts at the order's own rate (`orderShopAmounts()`).
- Dashboard revenue sums `total_shop_minor`. Reports read the orders whose `shop_currency` is the report currency and convert foreign-presentment amounts at each order's saved rate.
- `customer_order_stats` and order lines still hold presentment amounts only. They move to shop amounts before a second currency is enabled (Markets step 6).
- Staff amounts (delivery charge, discount) are on the store's price increment (`toStoreMinor()`). A staff order is cash on delivery, so `prepareManualOrderQuote()` refuses a total that COD cannot collect exactly (`details.reason = "cash_on_delivery_amount"`). The quote, the create and the amendment all run it.

## Editing an order

`buildOrderEditReadiness()` decides what can still change, with a reason code the dashboard words:
- **Details** (name, phone, email, delivery address) until the order ships: `updateOrderDetails()` (PUT `/:id/details`) CAS-updates them; a changed phone links the order to that phone's customer. Money, items and tax snapshots are untouched.
- **Items** (products, quantities, discount, delivery charge) on an unpaid, unshipped cash-on-delivery order without a discount code — dashboard or checkout orders alike — through the quote-backed amendment (`previewManualOrderAmendment()` / `confirmManualOrderAmendment()`), which keeps before/after snapshots in `order_amendments`. Kept lines keep the price the buyer agreed to; added lines use today's catalog price.

## Archive

- **Archive** is admin-list visibility only. It sets `archivedAt` with the browser-loaded order-version CAS and never changes status, inventory, payment, fulfillment, items, buyer access, invoices, returns, refunds, or support evidence.
- Only `cancelled`, `completed`, `returned`, and `refunded` orders are eligible. Active shipment claims, refund attempts, return receipts, and hosted-payment setup block archive.
- **Restore** clears `archivedAt` with the current version CAS. No inventory reservation or lifecycle transition is required because archive never released stock or changed the order.
- Bulk archive accepts 1–90 unique `{ id, expectedVersion }` records and applies one guarded D1 batch. Ordinary admin APIs expose no order hard-delete endpoint.
- `deletedAt` remains a separate legacy cleanup marker for stale incomplete hosted-payment checkout cleanup. It is not merchant archive state.

## Stale hosted-payment cleanup

`archiveStaleIncompleteOrders()` is the only scheduled path that may move an existing stale checkout order. It handles online payment methods only (every registered gateway), requires `status = incomplete`, `paymentStatus` of `unpaid` or `failed`, `paidAmount <= 0`, no soft delete, no active shipment claim, no pending/succeeded `order_payments`, and no live `payment_session_attempts` processing lease. Each order must win a guarded cancelled claim before inventory is released through `applyInventoryForStatusChange(db, orderId, "cancelled")`; release failure rolls the claim back to `incomplete`.

After release succeeds, the final archive soft-deletes the order, marks inventory restored, conditionally cancels a pending payment plan only when the order finalization actually won, and writes the `abandoned_checkouts` snapshot after finalization. The API scheduled worker runs it with a 60-minute grace period and a batch limit of 25, then invalidates product availability caches for archived order ids.

## Concurrency Control

- **Optimistic locking on orders**: `version` column, CAS update in `updateOrderDetails()`, amendments and `updateOrderStatus()`
- **Request keys on every dashboard write**: a repeated request (double click, retry) returns the first result. Refunds key their attempt rows (`refund_request:<order>:<key>:<n>`, same key + different amount is a 409); own-courier sends store the key on the shipment (bulk runs use `bulk:<key>` per order); bulk confirm and timeline lines derive the `order_events` id from the key, so a repeat can't add a line; return commands keep their `commandKey`.
- **Fulfilment states come only from parcels**: the generic status change (`updateOrderStatus`, dashboard and agents alike) makes only side-effect-free moves (incomplete→pending, pending/processing→confirmed, →cancelled, delivered→completed). Shipped comes from Mark as sent / Book courier, delivered from cash collected (COD) or `markOrderDelivered` (paid, fully sent), returned from Mark returned or a return. A Shipped order with nothing actually sent can still be cancelled, which restores its stock. On a part-sent order an own-courier parcel that came back is voided (`voidOrderFulfilment`), which takes its units off the sent list; part-sent stock is still reserved, so no stock moves.
- **Nothing with the courier is cancelled**: `updateOrderStatus(..., "cancelled")` refuses while any item has `fulfilled_quantity > 0` (also in the CAS), so units with a rider never go back into sellable stock. Own-courier parcels follow the order: a failed attempt marks open parcels `delivery_failed`, return to sender marks them `returned`, cash collected marks them `delivered`.
- **Optimistic locking on inventory**: `stockVersion` column on `productVariants`, separate from general `version`
- **Checkout reservation rollback**: `commitStorefrontOrderPayload()` commits inventory CAS and ledger edges in the same guarded batch as the order. A failed authority, inventory, or order guard rolls back the whole batch; no compensating stock release is needed. Late reservation failures surface buyer-safe cart issues.
- **Checkout idempotency**: `checkout_attempts` owns same-key replay, in-flight `202`, reserved order ids, and stale-claim recovery. `commitStorefrontOrderPayload()` also treats an already-committed order id as success so a crash after commit can converge without a duplicate order.
- **Discount redemption authority**: One engine (`modules/promotions`): `quoteStorefrontDiscount` evaluates the typed code with active automatic discounts; the commit re-evaluates the snapshot. Validation endpoints and pre-commit reads are advisory. Code discounts write immutable `promotion_redemptions` rows keyed to the canonical CRM customer (including guest profiles) with D1-triggered total/per-customer/spend limits; automatic discounts have no limits and write allocations only (revision-guarded). An order retry returns the existing order before a second claim. Cancellation/refund does not release typed claims; any future release policy must use an auditable adjustment ledger.
