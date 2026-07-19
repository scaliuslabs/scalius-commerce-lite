# Inventory and Order Operations Competitive Audit

Last reviewed: 2026-07-19

## Scope and evidence rules

This is a read-only benchmark of Shopify, Medusa v2, Adobe Commerce, and the
current Scalius codebase. “Verified” means the fact is supported by a current
first-party document, the cited current interface, or inspected Scalius source.
“Recommendation” is a proposed Scalius direction, not a claim about an external
platform. An external capability not found in the first-party material is
recorded as “not verified”, not asserted to be absent.

The authenticated Shopify demo admin was inspected without mutations on
2026-07-12. Its Inventory page exposed one dense table with search/filter,
import/export, configurable/savable columns, and On hand, Available, Committed,
Incoming, Unavailable, and Bin name columns. Its empty Orders page paired the
order work queue with a compact metric strip and kept Drafts and Abandoned
checkouts as adjacent workflows. Public Shopify Help Center sources below
support the domain facts; the live observation is only UX evidence.

## Current Scalius baseline — verified

- The 2026-07-12 production regression where Inventory returned 500 and Order
  View silently returned to the list was one shared SQL projection defect: the
  normalized option-label correlation double-qualified `product_variants.id`
  in joined queries. Commit `d803b9e8` fixes the projection and adds generic,
  inventory-adapter, and exact order-item query regressions. API Worker version
  `6824342a-370e-4f1b-82e0-9ad4c28f873d` was then verified live with 86
  inventory SKUs and order `16V71E`. The admin route now keeps a failed detail
  URL and presents retry/back recovery instead of masking read failures with a
  redirect (`90945958`).

- D1 variant counters are authoritative. Scalius has physical `stock`,
  `reservedStock`, and `preorderStock`, derives buyer availability as
  `stock - reservedStock`, uses `stockVersion` CAS, and commits ledger-v2
  before/after counter edges in the same batch as new stock writes. See
  [catalog inventory audit](catalog/INVENTORY.md),
  [ledger-v2 decision](catalog/INVENTORY-LEDGER-V2.md), and
  [inventory module](../../packages/core/src/modules/inventory/README.md).
- Reservations, releases, deductions, restores, preorder, backorder, expiry,
  low-stock policy, and order-linked movement claims are materially stronger
  than a plain mutable stock counter. Checkout and many order transitions have
  deterministic claims or version guards.
- Manual adjustment, scanner adjustment, and stocktake accept exact safe
  integers and require merchant operation keys. The canonical request hash and
  committed result are stored atomically with the ledger-v2 movement and
  `stockVersion` CAS; exact retries replay and changed-payload key reuse fails.
- Inventory is global per SKU. There is no stock-location/inventory-level,
  unavailable-hold, incoming-receipt, transfer, supplier, or purchase-order
  domain in the current schema or admin.
- Admin inventory offers server-backed SKU/product search, stock-state filters,
  sorting, stats, adjustment/stocktake, and paginated movement history. The
  durable audit records the remaining saved-view, configurable-column,
  location-aware filtering, and atomic import work.
- The sellable-SKU view keeps its dense desktop table and now renders a
  purpose-built card list below the desktop breakpoint. Both projections consume
  the same server-backed result and stock-status helper; mobile preserves product,
  SKU, merchant option labels, on-hand, committed, available, status, filtering,
  pagination, explicit sort context, and the same permission-gated Adjust action.
  Focused responsive source tests and targeted lint pass. Deployment and an
  authenticated 320/360/390/430 px browser check remain release evidence, not a
  locally verified claim.
- Orders have separate order, payment, fulfillment, item-fulfillment, shipment,
  inventory-action, refund-attempt, support-request, and notification evidence.
  Shipment and refund provider recovery are deliberately fail-closed. See the
  [orders module](../../packages/core/src/modules/orders/README.md).
- Manual fulfillment can select order-item rows, but not a quantity within a
  row: `createFulfillmentShipment()` accepts `itemIds` and marks each selected
  row shipped. A line with quantity five cannot be split 2 + 3 across
  fulfillments or locations. See
  [orders.fulfillment.ts](../../packages/core/src/modules/orders/orders.fulfillment.ts).
- Item-level return domain and API authority now persist request, approval,
  immutable receipt disposition, actor, recovery, and exact inventory movement
  evidence. Request/approval never change stock; only explicit warehouse
  restock disposition does. Refund remains independent. The order detail now
  owns the plural return workspace for request, per-line decision, receipt
  classification, cancellation, immutable receipt history, and recovery.
  Production order `3EFMCF` proves 7/0/7 remains unchanged at approval and
  returns to 8/0/8 only after an explicit one-unit restock receipt. See
  [item-level returns](./ITEM-LEVEL-RETURNS.md).
- Order audit facts exist but are fragmented across cards/tables. The current
  detail composition has status, support requests, payments, notifications,
  shipments, notes, and items, but no single actor-attributed chronological
  activity projection. See
  [OrderView.tsx](../../apps/admin-v2/src/components/admin/OrderView.tsx).

## External benchmark — verified facts

### Shopify

- Inventory states are explicit: On hand is composed of Committed, Unavailable,
  and Available; Incoming is separate and becomes on-hand/available when a
  transfer or purchase order is received. Unavailable carries reasons such as
  draft-order reservation, app hold, damaged, quality control, or safety stock.
  [Shopify inventory states](https://help.shopify.com/en/manual/products/inventory/fundamentals/inventory-states)
- Inventory is location-aware, and the admin shows state by variant/location.
  Transfers have draft, ready-to-ship, in-progress, transferred, and canceled
  states; can reserve origin stock; can use multiple tracked shipments; and can
  accept/reject partial receipt quantities with scanner support.
  [Shopify inventory transfers](https://help.shopify.com/en/manual/products/inventory/inventory-transfers/creating-and-managing-transfers)
- Purchase orders model supplier, products, quantities, costs, payment terms,
  and supplier currency, then link to transfers for shipment, receipt, and cost
  adjustments. Supplier payment remains outside Shopify.
  [Shopify purchase orders](https://help.shopify.com/en/manual/products/inventory/purchase-orders)
- Inventory history identifies creator, cause/reason, state deltas, and resulting
  totals. The product view retains 180 days and a broader report supports SKU,
  location, staff, app, and reason filters.
  [Shopify adjustment history](https://help.shopify.com/en/manual/products/inventory/adjusting-inventory/adjustment-history)
- The current Admin GraphQL inventory adjustment mutation requires an idempotency
  key as of API version 2026-04 and supports a reference document URI.
  [Shopify `inventoryAdjustQuantities`](https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryAdjustQuantities)
- Orders separate order, payment, fulfillment, and return status; the detail
  page preserves historical line facts and exposes a Timeline with payment and
  staff events. Orders support item edits, partial/full refunds, returns, and
  exchanges; return financials can produce refund, even exchange, or additional
  collection.
  [Shopify order statuses](https://help.shopify.com/en/manual/fulfillment/managing-orders/order-status),
  [order detail and Timeline](https://help.shopify.com/en/manual/fulfillment/managing-orders/managing-order-details),
  [returns and exchanges](https://help.shopify.com/en/manual/fulfillment/managing-orders/returns/creating-returns)

### Medusa v2

- InventoryItem is separate from product variant and can support kits/bundles.
  InventoryLevel is per location with stocked, reserved, and incoming quantities;
  ReservationItem is an explicit location-bound object that can be linked to an
  order or used for another hold use case.
  [Medusa inventory concepts](https://docs.medusajs.com/resources/commerce-modules/inventory/concepts)
- The Admin has separate inventory and reservation lists. Merchants can manage
  quantities per location and create/edit/delete manual reservations with a
  description while seeing the resulting availability.
  [Medusa inventory item management](https://docs.medusajs.com/user-guide/inventory/inventory),
  [reservation management](https://docs.medusajs.com/user-guide/inventory/reservations)
- Locations connect sales channels, fulfillment providers, shipping/pickup
  modes, zones, and shipping options.
  [Medusa locations](https://docs.medusajs.com/user-guide/settings/locations-and-shipping/locations)
- Orders expose summary, activity, payments, unfulfilled items, and one section
  per fulfillment. Staff can manually allocate unallocated items to a location.
  Fulfillment supports partial quantities, location choice, multiple fulfillment
  records, shipments, tracking, delivery, pickup, and pre-shipment cancellation.
  [Medusa order detail](https://docs.medusajs.com/user-guide/orders/manage),
  [fulfillments](https://docs.medusajs.com/user-guide/orders/fulfillments)
- Returns distinguish received from damaged quantities; exchanges/claims model
  inbound and outbound items, shipping, promotions, and an amount to refund or
  collect. Refunds can be partial/full, have configured reasons, and appear in
  order activity.
  [Medusa returns](https://docs.medusajs.com/resources/commerce-modules/order/return),
  [exchanges](https://docs.medusajs.com/user-guide/orders/exchanges),
  [payments and refunds](https://docs.medusajs.com/user-guide/orders/payments)
- Medusa workflows provide compensation and step retry facilities, and the
  Admin can inspect stored workflow executions. A general transport-level
  idempotency requirement for every inventory Admin mutation was not verified
  in the reviewed first-party docs.
  [workflow compensation](https://docs.medusajs.com/learn/fundamentals/workflows/compensation-function),
  [workflow execution UI](https://docs.medusajs.com/user-guide/settings/developer/workflows)
- Native procurement purchase orders and a merchant transfer workflow were not
  found in the reviewed Medusa v2 Inventory/Admin guides. This is not proof of
  absence; extensions or newer modules may provide them.

### Adobe Commerce

- Sources are physical warehouses/stores/drop-shippers; Stocks aggregate sources
  for sales channels; salable quantity is source quantity minus reservations and
  configured thresholds. Source Selection Algorithms recommend fulfillment
  sources and can be extended.
  [Adobe sources and stocks](https://experienceleague.adobe.com/en/docs/commerce-admin/inventory/basics/sources-stocks),
  [source selection and reservations](https://experienceleague.adobe.com/en/docs/commerce-admin/inventory/basics/selection-reservations)
- Reservations compensate through cancel/refund/ship lifecycles; partial
  shipment deducts only shipped quantity and leaves remaining reservations.
  Credit memos can return received items to the source that shipped them.
  [Adobe order/reservation states](https://experienceleague.adobe.com/en/docs/commerce-admin/inventory/basics/order-status)
- Multi-source orders can split shipments across sources. Adobe supports source
  recommendations/overrides and source-aware return-to-stock.
  [Adobe inventory order and shipment management](https://experienceleague.adobe.com/en/docs/commerce-admin/inventory/orders/shipments)
- Admin can bulk move all inventory from one source to another; the documented
  Admin action is not a shipment/receipt workflow and cannot move a partial
  quantity. Adobe's release notes also document a partial-transfer REST API.
  [Adobe transfer action](https://experienceleague.adobe.com/en/docs/commerce-admin/inventory/quantities/inventory-transfer),
  [Inventory Management release notes](https://experienceleague.adobe.com/en/docs/commerce-admin/inventory/release-notes)
- Order detail separates information, invoices, credit memos, shipments, and
  comments. Adobe Commerce RMA supports storefront requests and product-level
  return eligibility.
  [Adobe order processing](https://experienceleague.adobe.com/en/docs/commerce-admin/stores-sales/order-management/orders/order-processing),
  [Adobe RMA configuration](https://experienceleague.adobe.com/en/docs/commerce-admin/stores-sales/order-management/returns/rma-configure)
- Adobe Commerce action logs can record actor, success/failure, affected object,
  IP, and date for enabled Admin actions. This feature is Adobe Commerce-only,
  not Magento Open Source.
  [Adobe action logs](https://experienceleague.adobe.com/en/docs/commerce-admin/systems/action-logs/action-log)
- A supplier purchase-order/procurement workflow comparable to Shopify's was not
  verified in the reviewed Adobe inventory and order Admin guides.

## Gap matrix

| Capability | Scalius now | Benchmark signal | Decision |
|---|---|---|---|
| Inventory integrity | Strong CAS + atomic ledger-v2 edge + durable merchant operation replay | Shopify now requires API idempotency; Medusa exposes compensating workflows | Keep this contract for imports, transfers, and receipts |
| Inventory states | On hand, reserved, preorder; backorder is a policy/pool | Shopify: committed/unavailable/incoming; Medusa: stocked/reserved/incoming | Add explicit operational states without weakening ledger authority |
| Locations | Single global SKU counter | All three model physical sources/locations | Foundational P1 schema, before transfers or split fulfillment |
| Reservations | Counter + ledger generation, usually order-scoped | Medusa exposes location-bound reservation objects; Shopify exposes hold reasons | Preserve generation claims; add durable location/owner/reason projection |
| Adjustments/audit | Exact reasons and v2 edges; limited filters/export/actor UX | Shopify shows actor, reason, origin/app, state deltas and reports | Finish idempotency, actor/date/order filters, export, alert inbox |
| Transfers | None | Shopify has shipment/partial receipt workflow; Adobe has bulk source movement | Build Shopify-style operational transfer, not a counter-to-counter shortcut |
| Purchase orders | None | Shopify has supplier/terms/currency/cost + linked receipt | Add only after location/receipt authority exists |
| Fulfillment | Selected item rows; no within-line quantities or location | Medusa and Adobe support partial quantities and source choice | Introduce fulfillment lines with quantity + source/location |
| Returns | Item request/approval/receipt ledger; explicit restock; refund independent; compact order-detail workflow | All benchmarks separate item return lifecycle and refund/restock decisions | P0 lifecycle and merchant workflow complete; exchanges remain a later extension |
| Order audit UX | Rich but fragmented evidence cards | Shopify Timeline, Medusa Activity, Adobe comments/action log | Add one chronological, actor-aware activity projection |

## Prioritized Scalius decisions

### P0 — release correctness

1. **Replace whole-order return with an item-level return ledger — complete.** Persist a
   return header and lines with requested, approved, received, damaged, rejected,
   and restock quantities; reason and notes; shipment/receipt facts; refund
   allocation; actor; timestamps; and version. A request or approval must not
   restore stock. Only a receipt disposition explicitly marked restockable may
   create a location-aware ledger restore. Refund timing remains an independent
   merchant decision and keeps the existing provider single-flight/reconciliation
   protections. Exchange/claim can reuse the same inbound lines later.
2. **Keep every manual/scanner/import inventory write idempotent.** Manual,
   scanner, and stocktake writes now require an
   operation key, store request hash + result, reject same-key/different-payload,
   and return the committed result on replay. CSV import and future transfer
   receiving must reuse the same atomic operation contract rather than creating
   an alternate stock-write path.

### P1 — operational foundation

3. **Introduce stock locations and per-location inventory levels.** Use one
   default location so single-location merchants retain the current compact
   workflow. Authority becomes `(variantId, locationId)` counters/version plus
   location-aware ledger edges; product-wide totals are projections. Locations
   carry address, fulfillment/pickup capability, active state, and priority.
4. **Make reservations and holds first-class, reasoned records.** Link to order
   item/location/generation or an explicit owner; distinguish committed order
   quantity from unavailable safety/quality/damage/manual holds. Derive Incoming
   from open receipt lines rather than allowing arbitrary incoming edits.
5. **Replace row-level fulfillment with quantity-level fulfillment lines.** A
   shipment line records order item, quantity, source location, tracking/provider,
   and state. Deduct only quantities actually shipped from their source. Preserve
   the existing shipment claim/reconciliation pattern around provider side effects.
6. **Add an append-only order activity projection.** Normalize status, item edit,
   inventory, payment, refund, return, shipment, notification, support, note, and
   recovery events into one bounded timeline with actor/source and public/private
   visibility. Existing specialist ledgers remain authorities; the timeline is
   an operator projection, not a second mutable source of truth.

### P2 — inventory operations breadth

7. **Build transfers on the location/receipt model.** States: draft, ready,
   in-transit, partially received, received, canceled. Support partial shipments,
   accepted/rejected quantities, tracking/ETA, scanner receiving, notes, actor,
   and per-command idempotency. Reserve origin only at Ready; create Incoming at
   In transit; move to On hand only on accepted receipt.
8. **Build supplier and purchase-order documents after transfers.** Model supplier,
   destination, currency snapshot, payment terms, item cost, ordered/received/
   rejected quantities, expected date, and statuses draft/ordered/partial/received/
   closed/canceled. Receipt reuses transfer/receipt commands; supplier payment is
   recorded, not processed, unless a future provider has a proven need.
9. **Finish expert inventory UX.** Saved views, configurable columns, server-side
   actor/date/location/order filters, low-stock inbox/acknowledgement, streaming
   CSV export, and validate-all-before-commit stocktake import. Keep the current
   dense table for desktop operators and its focused narrow-screen SKU projection;
   do not turn every state into dashboard cards.

## Recommended implementation sequence

1. Adjustment idempotency and item-level return model.
2. Default location + per-location inventory level/ledger migration.
3. Quantity-level fulfillment and location-bound reservation/hold records.
4. Unified order activity projection.
5. Transfers and receiving.
6. Suppliers and purchase orders.
7. Saved views, alert inbox, exports/imports, and sourcing recommendations.

Do not build purchase orders, transfers, or multi-location UI as isolated forms
over the current global `product_variants.stock` counter. That would duplicate
inventory truth and force a second rewrite. The location-aware ledger and
idempotent receipt commands are the shared foundation.
