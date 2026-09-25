# Fulfilment Module

The real actions that hand an order's units over: own-courier parcels (Mark as sent, partial sends, a parcel that came back), courier bookings and their reconciliation (including bookings with an unknown provider outcome), bulk shipping and bulk fulfilment, and delivery outcomes (Mark delivered; COD collected, failed or returned). Every status change goes through the orders lifecycle kernel (`orders/status/lifecycle.ts`), so the order state machine, inventory reconciliation and notifications stay in one place.

Public entry: `index.ts`.

## The ledger (Wave A §2.2)

Every action that hands units over inserts one `order_fulfillments` row
(`kind` = the lines' fulfilment type) and its `order_fulfillment_lines`, in one
batch that CAS-claims the order version. `order_items.fulfilled_quantity` is a
trigger projection of the active lines: never write it (a source policy
forbids it). A fulfilment only moves active → voided, which the triggers
subtract again; lines and fulfilments are otherwise immutable, and a parcel
row linked to a fulfilment can't be deleted.

- The last `ship` line moves a confirmed order to shipped and deducts stock.
- The last `pickup`/`service` line of an order that ships nothing delivers it
  through `applyOrderStatusChange` (money gate); cash taken at the counter is
  recorded first. Otherwise the result says `awaitingPayment`.
- Courier bookings, repairs, webhooks and status refreshes record every unsent
  ship line as one system fulfilment linked to the parcel, before the order
  moves; a courier cancellation (`cancelled`, `pickup_failed`) voids it after
  the order is back to confirmed.
- Void (`canVoid` in the order detail): own-rider, pickup and service
  fulfilments of a confirmed order. Courier parcels follow the courier.
- Returns never touch the ledger: a returned item stays fulfilled.

## Files

| Path | Exports | Purpose |
|------|---------|---------|
| `reconcile.ts` | `reconcileOrderShipment()`, `lookupUnknownOrderShipment()`, `resolveUnknownOrderShipment()` | Courier booking repair without calling the provider again |
| `bulk.ts` | `bulkShipOrders()`, `bulkFulfillOrders()` | Bulk courier booking and bulk Mark as sent |
| `delivery-outcomes.ts` | `processCodAction()`, `markOrderDelivered()` | Delivered, and COD collected/failed/returned |
| `ledger.ts` | `recordOrderFulfilment()`, `voidOrderFulfilment()`, `recordCourierBookingFulfilment()`, `syncCourierFulfilmentFromShipment()`, `assertShipmentDeletable()`, `deriveOrderFulfilmentStatus()` | The fulfilment ledger (Wave A): the only writer of `order_fulfillments` and their lines |
| `pickup.ts` | `markOrderReadyForPickup()` | Ready for pickup: `pickup_ready_at` plus the `order_ready_for_pickup` outbox row in one batch |
| `registry.ts` | `FULFILLER_REGISTRY`, `hasFulfiller()` | Which line types can be handed over (manual: ship, pickup, service; automatic: none until Wave B) |
| `auto-fulfil.ts` | `autoFulfilOrder()`, `sweepAutoFulfilment()` | Digital and gift-card lines after settlement (queue `order.auto_fulfil` and the 15-minute sweep) |
| `shared.ts` | -- | Helpers shared by the files above (not exported) |

### Fulfillment Flow
Own-rider "Mark as sent" is `POST /{id}/fulfillments` with `kind: "ship"`
(`recordOrderFulfilment()`); bulk "Mark as sent" (`bulkFulfillOrders()`)
calls the same function per order.
1. A repeated request key returns the first fulfilment (`replayed: true`).
2. The order must be confirmed, shipped or delivered, with no shipment claim, refund or payment-session attempt in flight.
3. The requested lines (or every unsent unit of the kind) are checked against `quantity - fulfilled_quantity`; the ledger triggers enforce the same bound.
4. One batch: the order version CAS with the derived `fulfillment_status`, the own-rider `delivery_shipments` row at `in_transit`, and the fulfilment with its lines. `fulfilled_quantity` is the triggers' projection.
5. The last ship line moves a confirmed order to `shipped` (deducting stock); the result carries a private `statusChange` fact the API turns into the shipped notification. An earlier parcel of a split shipment notifies per parcel.
6. A parcel that comes back is voided through `POST /{id}/fulfillments/{fulfillmentId}/void` (`voidOrderFulfilment()`): its units go back on the unsent list.
7. A later delivered/completed command moves only provider-less manual shipment rows to `delivered`. Carrier/provider shipment rows stay provider-owned.

### COD Actions
`processCodAction()` handles three actions with CAS protection on the order version:

- Collection is valid only for `shipped | delivered` orders: cash changes hands at the door, so it never skips the shipment.
- A failed delivery attempt is valid only for `shipped` orders; its reason and note are kept on `cod_tracking`.
- Return-to-sender is valid only for `shipped | delivered` orders.

The shared `canProcessOrderCodAction()` policy drives both the merchant UI and
the core write guard. The server must reject a stale or direct request even
when the dashboard has already hidden the action.

- `collected`: CAS-updates the shipped order to `delivered`, records collection via `recordCODCollection()` before inventory movement, reconciles reserved inventory, synchronizes shipped-item and provider-less manual-shipment delivery evidence, rolls back the delivered claim if COD evidence or inventory repair fails, and treats existing COD evidence as a retry/repair signal
- `failed`: Records failure via `recordCODFailure()`
- `returned`: records an approved return of every sent unit awaiting receipt, marks COD returned, and moves the order to `returned` at once (no cash is owed). Stock comes back only through the return receipt (good units restocked, damaged written off); a later `returned` status sync never restores stock on top of an open return.

### Bulk Ship Orders
`bulkShipOrders()` applies CAS protection per order:
1. Validates one unique batch of 1–90 order IDs before provider readiness or
   order reads. Provider options accept only bounded merchant choices; COD
   amount, item count, and item description are derived from the fresh order
   and line projection immediately before the provider call.
2. Reads order status and version
3. If the order is already `shipped`, treats the call as a retry and reconciles inventory without calling the provider again
4. For unshipped orders: claims by version, calls the provider, CAS-updates status to `shipped`, then deducts inventory
5. Provider-success/local-finalization failures leave the shipment `reconcile_required` and keep the matching order shipment claim until repair succeeds
6. CAS conflicts (concurrent admin + webhook edits) are logged and skipped gracefully

Admin bulk-shipping UI must submit one `/bulk-ship` request with all selected
order IDs and render the aggregate per-order result. Do not loop over
`/:id/shipments` from the browser for selected rows, repeat an ID, exceed 90,
or submit browser-authored order money/content as provider options.
