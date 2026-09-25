# Fulfilment Module

The real actions that hand an order's units over: own-courier parcels (Mark as sent, partial sends, a parcel that came back), courier bookings and their reconciliation (including bookings with an unknown provider outcome), bulk shipping and bulk fulfilment, and delivery outcomes (Mark delivered; COD collected, failed or returned). Every status change goes through the orders lifecycle kernel (`orders/status/lifecycle.ts`), so the order state machine, inventory reconciliation and notifications stay in one place.

Public entry: `index.ts`.

## Files

| Path | Exports | Purpose |
|------|---------|---------|
| `shipments.ts` | `createFulfillmentShipment()`, `getOrderShipments()`, `markParcelReturned()` | Own-courier parcels |
| `reconcile.ts` | `reconcileOrderShipment()`, `lookupUnknownOrderShipment()`, `resolveUnknownOrderShipment()` | Courier booking repair without calling the provider again |
| `bulk.ts` | `bulkShipOrders()`, `bulkFulfillOrders()` | Bulk courier booking and bulk Mark as sent |
| `delivery-outcomes.ts` | `processCodAction()`, `markOrderDelivered()` | Delivered, and COD collected/failed/returned |
| `shared.ts` | -- | Helpers shared by the files above (not exported) |

### Fulfillment Flow
1. `createFulfillmentShipment()` checks order is not cancelled/returned
2. Validates no items are already shipped/delivered (throws `ConflictError` if so)
3. Claims the order with a version/status/fulfillment check, then creates a provider-less manual/own-courier `deliveryShipments` row at `in_transit` and updates item fulfillment statuses to `shipped`
4. If final shipment: updates order `fulfillmentStatus` to `complete`, and order status to `shipped` when it was still confirmed
5. Applies inventory deduction for final shipments, including retries where the order was already marked shipped or delivered before inventory completed
6. When the final manual shipment actually changes the buyer-visible order status to `shipped`, the core result returns a private `statusChange` fact and the API route records it through the durable order-notification outbox. The fulfillment aggregate is read-only outside shipment-owned commands; `order_completed` remains tied to the buyer-visible `completed` order status.
7. A later delivered/completed command idempotently moves shipped items and only provider-less manual shipment rows to `delivered`. Carrier/provider shipment rows stay provider-owned and continue through provider sync/reconciliation.

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
