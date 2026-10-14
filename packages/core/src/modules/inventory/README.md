# Inventory

The `inventory` domain owns SKU stock: reservations, deductions, releases and restores that follow an order, manual adjustments and stocktakes, stock locations, low-stock alerts, and purchasing (suppliers, purchase orders, transfers, unit cost). Every stock change writes one ledger v2 movement in the same batch as the SKU `stockVersion` CAS update. This document is for contributors who change stock writes or read the ledger.

## Entries and layer

- `index.ts` is the only entry. The domain has no `browser.ts`.
- Layer L4. It imports `markets`, `products` and `settings` only (`scripts/core-domain-graph.allow.json`). `checkout`, `orders`, `payments`, `delivery`, `fulfilment`, `digital`, `product-admin` and `store-transfer` import it.

## Owns

| Table | Purpose |
|-------|---------|
| `product_variants` (stock columns) | `stock`, `reserved_stock`, `preorder_stock`, `stock_version`, `track_inventory`, `low_stock_threshold`, `allow_preorder`, `allow_backorder`, `backorder_limit`, `cost_minor`. Other domains own the rest of the table. |
| `inventory_locations` | Where stock is held. One active default; migration 0102 creates `loc_default` ("Main location"). |
| `inventory_levels` | On-hand per SKU and location. Triggers write it; application code never does. |
| `inventory_movements` | The ledger. One row per counter change. |
| `inventory_operations` | Replay ledger for manual adjustment, scanner adjustment, stocktake and licence-key writes (`operation_key` primary key). |
| `inventory_commands` | Replay ledger for purchase-order receipts and transfer ship, receive and cancel. |
| `product_low_stock_alerts` | One alert row per SKU (`active`, `acknowledged`, `resolved`). |
| `suppliers`, `purchase_orders`, `purchase_order_lines`, `purchase_order_receipt_lines`, `inventory_transfers`, `inventory_transfer_lines`, `inventory_transfer_movements` | Purchasing and transfers between locations (migration 0109). |

- Settings document `inventory` (`inventorySettingsDocument`, field `defaultLowStockThreshold`) is declared in `products/low-stock-policy.ts`, because buyer availability bands read it. `deps.inventoryBands()` depends on it.
- DVC: the ledger, location, purchasing and transfer tables register no dependency of their own (`packages/shared/src/cache-deps.ts`). Their buyer-visible effect is the SKU availability band, which `product_variants` and `product_buyer_state` register. A write that keeps a SKU in its band advances no dependency. Exception: a level at a location that some sales channel does not sell advances its SKU's product, because that channel's sellable stock subtracts it (0122).
- Events (emitted by triggers): `inventory.level_changed` (each movement with a non-zero `stock_delta`), `inventory.purchase_order_updated` and `inventory.transfer_updated` (one per revision).
- A product with SKU movements, purchase-order lines or transfer lines keeps its history: the permanent delete is blocked.

## Stock model

- Available stock is `stock - reserved_stock`. A digital SKU's stock is its licence keys: only key import and revoke move it.
- `stock_version` is a CAS counter for stock writes. Each write adds exactly 1 and conditions on the value it read. `version` serves non-stock edits. A conflict retries up to 3 times with exponential backoff (base 40 to 50 ms).
- `orders.inventory_pool` stores the pool, and every later operation of the order reads it.

| Pool | Reserve | Deduct | Release | Restore |
|------|---------|--------|---------|---------|
| `regular` | `reserved +q`, needs `stock - reserved >= q` | `stock -q`, `reserved -q` | `reserved -q` | `stock +q` |
| `preorder` | `preorder_stock -q`, `reserved +q`, needs `allow_preorder` | `reserved -q` | `reserved -q`, `preorder_stock +q` | `preorder_stock +q` |
| `backorder` | `reserved +q`, needs `allow_backorder` and `backorder_limit` (0 = no limit) | `reserved -q` | `reserved -q` | no counter change |

## Ledger v2

A v2 movement records the `pool`, the `reservation_generation`, `stock_version_before` and `stock_version_after`, and the before, after and delta values of the three counters. `(variant_id, stock_version_after)` is unique, so the CAS version is the per-SKU sequence number. A `location_id` is required when `stock_delta` is not 0.

Types: `reserved`, `preorder_reserved`, `released`, `deducted`, `preorder_deducted`, `restored`, `adjusted`, `received`, `transfer_in` and `transfer_out`. Their counter effects follow the pool table above. `adjusted` moves `stock` (regular) or `preorder_stock` by the delta. `received` and `transfer_in` add to `stock`. `transfer_out` subtracts from it.

- The trigger `inventory_movements_ledger_v2_insert_semantics` rejects a v2 row whose type and deltas disagree.
- `getInventoryLedgerHealth()` counts v2 rows and invalid v2 rows. `foldInventoryLedgerV2()` replays events and throws `InventoryLedgerDiscontinuityError` on a gap.
- The reservation generation numbers one reserve-to-terminal cycle of an order and SKU. A restore uses the generation of the deduction it undoes.
- A movement that a retry may repeat has a deterministic id (`reservation:<sha256>`, `transition:<sha256>`, `imov_<hash>`, `expiry_release:<order>:<variant>...`). A duplicate claim that matches counts as success. A mismatch fails closed.
- Write order in one batch: guard statements, the movement `INSERT ... SELECT` gated on the SKU version, the CAS `UPDATE`, then the buyer-state refresh (`catalogBuyerStateRefreshStatementsForSkus`). A lost CAS aborts or compensates the whole batch, so a counter never changes without its movement.

## Order lifecycle

`applyInventoryForStatusChange()` and `applyInventoryForStatusChangeWithImpact()` (`inventory-transitions.ts`) are the only way a status change moves stock. They read `orders.inventory_action` (`none`, `reserved`, `deducted`, `restored`), act once and write the new value. A repeat call does nothing.

| New order status | Current action | Operation | New action |
|------------------|----------------|-----------|------------|
| `shipped`, `delivered` | `reserved` | deduct | `deducted` |
| `cancelled`, `returned`, `refunded` | `reserved` | release | `restored` |
| `cancelled`, `refunded` | `deducted` | restore | `restored` |
| `returned` | `deducted` | restore, unless an open order return exists: its receipt restocks | `restored` |
| `incomplete`, `pending`, `processing`, `confirmed` | `restored` | reserve again (repair only) | `reserved` |

- A deduct needs `reserved >= q`, and for the regular pool `stock >= q`. Drift fails closed.
- A deduct leaves from the order's `fulfillment_location_id` (the default when null). A restore returns to the location the generation was deducted from, else the order's location, else the default. A return receipt names its own restock location.
- `assertOrderStockCoverable()` refuses before the last parcel, a courier booking or the last pickup is recorded when the order's location lacks the units.
- Checkout and admin order creation call `prepareStockReservationBatch()` and compose its statements into their own batch. Order returns use `applyClaimedInventoryEntryBatch()` for an explicit deduct or restore under a stable claim key.
- Results list `availabilityTransitionVariantIds`, the SKUs whose band changed. The API removes the field from responses. Cache freshness does not read it: SQL triggers advance the dependencies.
- `reserveStock()`, `releaseReservation()`, `releaseMultiple()` and `recordMovement()` are old single-SKU helpers. They have no production caller and write no v2 edge. Do not add callers.

## Locations

- Every v2 movement with a non-zero `stock_delta` needs an active `location_id` (`INVENTORY_LOCATION_REQUIRED`). A removal needs the units there (`INVENTORY_LEVEL_SHORTFALL`). The whole batch aborts otherwise.
- For every SKU, `sum(inventory_levels.on_hand) = product_variants.stock`. A SKU inserted with stock books it at the default location. Reservations and releases carry no location.
- Manual adjustments, stocktakes and scanner writes take an optional `locationId` (default when omitted), which is part of the operation request hash. A stocktake counts that location.
- Product-editor stock edits and licence-key pools move stock at the default location. `assertSimpleConversionStockAtDefaultLocation()` (`product-admin`) blocks turning a simple product into an optioned one while its SKU holds units elsewhere.
- Archive a location only when it is not the default, holds no units, has no open order set to ship from it, and has no open purchase order or transfer.
- A new location without a country takes the store's (the backup market's). Migration 0122 gave the untouched default location the store's country.
- Sales channels sell the on-hand of their linked locations (`sales_channel_locations`, MARKETS-DESIGN D6). A new location is linked to every channel. A regular reservation with `salesChannelId` (checkout) also needs `stock - reserved_stock` minus the SKU's levels at the channel's unlinked locations to cover the quantity; reservations themselves stay location-free.

## Adjustments

- `executeInventoryOperation()` (`inventory-operations.ts`) runs `manual_adjustment`, `scanner_adjustment`, `stocktake` and `licence_keys`. It requires a 16 to 128 character operation key (the `Idempotency-Key` header or `operationKey`).
- It commits the movement, the CAS update and the `inventory_operations` row in one batch, with no pending row. An exact retry replays the stored result. The same key with a changed request is a conflict (409).
- `adjustInventory()` is the dashboard adjustment. Reasons: `received`, `correction`, `damage`, `theft`, `return`, `other`. `received` and `return` need a positive delta; `damage` and `theft` a negative one. Pools: `stock`, `preorderStock`.

## Low-stock alerts and availability bands

- The alert level of a SKU is its own `low_stock_threshold`, else the store default. `0` turns alerts off; sold out always needs review (`effectiveLowStockThresholdSql()` in `products/low-stock-policy.ts`).
- `checkAndAlertLowStock()` creates, reactivates, refreshes or resolves the alert row after a stock write. A failure is logged and never fails the committed write.
- `setLowStockThreshold()` sets a SKU level and writes no movement. `setDefaultLowStockThreshold()` writes the `inventory` document; its route then requests a catalog projection rebuild, because the level changes bands. The Low stock list reads live stock, not the alert rows.
- A band is `untracked`, `out_of_stock`, `low_stock` or `in_stock` (`@scalius/shared/buyer-availability`). The band is the buyer-visible truth. Public reads carry `availabilityBand`. Never expose exact stock to a public read: `stock` and `reservedStock` there are fixed compatibility values. Live cart and checkout validation stays authoritative.

## Reservation expiry

`releaseExpiredReservations(db, maxAgeMinutes = 30, { limit })` frees reservations whose order row never committed. It takes `reserved` and `preorder_reserved` movements older than the age with an `order_id` and no `orders` row, groups them by variant, order, pool and generation, and subtracts deducted and released quantities. It processes at most `limit` groups (default 50, maximum 200), reports `hasMore`, and writes a `released` movement with the counter update in one batch. It never touches an order that exists: a status transition cancels those. The cron runs it in its sweep rotation, `planLimits().maintenance.inventoryExpiryPerRun` groups a run (`apps/api/src/scheduled-maintenance.ts`).

## Purchasing, transfers and unit cost

**Cost visibility.** Unit costs, margins, valuation and purchase-order money need `products.view_costs`. Reads leave them out otherwise (`cost-visibility.ts`).

**Unit cost.** `product_variants.cost_minor` is the SKU cost in minor units (null = none). Buyers never see it. `setSkuCosts()` sets up to 100 SKUs in one batch, optionally guarded by the cost the merchant saw. The trigger `order_items_unit_cost_snapshot` copies the cost to `order_items.unit_cost_minor` when a line is created. That value never changes.

**Stock commands** (`stock-commands.ts`). A purchase-order receipt or a transfer ship, receive or cancel commits as one batch of at most 100 SKUs:

1. A subject guard: the document is still at the planned revision and status.
2. Per SKU, a v2 movement (`received`, `transfer_out` or `transfer_in`, regular pool) and the `stock_version` CAS update.
3. CAS guards that prove every SKU reached its planned edge.
4. The `inventory_commands` row: operation key, request hash and the revision it produced.
5. The document writes and the buyer-state refresh.

An exact retry replays the stored result. A changed request under the same key is refused (409). A lost race re-plans from fresh reads, up to 3 attempts. A removal may not take `stock` below `reserved_stock`.

| Document | States |
|----------|--------|
| Purchase order | `draft` (editable, deletable) -> `ordered` (lines locked) -> `partially_received` -> `received`; `cancelled` from `draft`, `ordered` or `partially_received` (received units stay). |
| Transfer | `draft` -> `in_transit` (all lines leave the origin at once) -> `partially_received` -> `received`; `cancelled` returns units still in transit to the origin. |

- Both documents hold at most 100 lines, one per live physical SKU. A transfer still receives or returns a SKU retired meanwhile. Every write advances `revision` once, and edits and status changes need the current revision.
- A receipt with `updateCost` sets each SKU cost to the weighted average `round_half_up((onHand x cost + received x unitCost) / (onHand + received))`. `onHand` is the SKU's stock across all locations. Without a cost or stock, the unit cost becomes the cost. `purchase_order_receipt_lines` keeps the cost before and after.
- Units in transit are out of both location levels and out of `stock`. Buyers never count them.
- Incoming stock is open purchase-order quantity plus units in transit, per destination (`readIncomingStock()`). Buyers never see it. `getInventoryValuation()` values on-hand units per location at the current unit cost and counts SKUs without a cost separately.

## Routes

Mounted under `/api/v1/admin/inventory` (`apps/api/src/routes/admin/inventory.ts`, `inventory-purchasing.ts`). Permissions are in `packages/core/src/auth/rbac/route-permissions/inventory.ts`.

| Paths | Permission |
|-------|------------|
| `GET /` (sections `variants`, `movements`, `alerts`), `GET /levels`, `GET /{variantId}/levels`, `POST /labels/preview`, `POST /labels/artifact`, `POST /movements/export`, `GET /alerts`, `GET /scanner/lookup` | `products.view` |
| `POST /{variantId}/adjust`, `POST /stock-adjust`, `POST /stock-set`, `PATCH /alerts`, `PUT /{variantId}/alert-level`, `PUT /default-alert-level` | `products.edit` |
| `GET /valuation`, `PUT /costs` (`PUT` also needs `products.edit`) | `products.view_costs` |
| `GET`, `POST /locations`; `PATCH /locations/{id}`; `POST /locations/{id}/archive`, `unarchive`, `default` | read: `products.view`, `inventory.view` or `settings.general.view`; write: `inventory.manage` or `settings.general.edit` |
| `/suppliers`: `GET`, `POST`, `GET`/`PATCH /{id}`, `POST /{id}/archive`, `unarchive` | read `inventory.view`; write `inventory.manage` |
| `/purchase-orders`: `GET`, `POST`, `GET`/`PUT`/`DELETE /{id}`, `POST /{id}/order`, `receive`, `cancel`, `GET /{id}/export` | read `inventory.view`; write `inventory.manage` (create and `PUT` also `products.view_costs`; export needs both) |
| `/transfers`: `GET`, `POST`, `GET`/`PUT`/`DELETE /{id}`, `POST /{id}/ship`, `receive`, `cancel` | read `inventory.view`; write `inventory.manage` |
