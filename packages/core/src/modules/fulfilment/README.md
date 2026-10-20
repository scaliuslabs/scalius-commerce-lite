# Fulfilment

The `fulfilment` domain records the actions that hand an order's units to the buyer: own-rider parcels, courier bookings and their repair, pickup at the counter, services performed, automatic digital and gift-card delivery, and delivery outcomes (delivered, COD collected, failed, returned). Every action writes the fulfilment ledger. This document is for contributors who change handover actions.

## Entries and layer

- `index.ts` is the only entry. The domain has no `browser.ts`.
- Layer L9. It imports `delivery`, `digital`, `gift-cards`, `inventory`, `notifications`, `order-kernel`, `orders`, `payments` and `settings`. Only `checkout` imports it (`scripts/core-domain-graph.allow.json`).

## Owns

| Table | Purpose |
|-------|---------|
| `order_fulfillments` | One row per handover action: `kind` (`ship`, `pickup`, `digital`, `gift_card`, `service`), `status` (`active`, `voided`), `request_key`, `shipment_id`, `actor_type`, `cash_collected_minor`, `location_id`. |
| `order_fulfillment_lines` | The units one action covers: `order_item_id`, `quantity`. |

- `ledger.ts` is the only writer of both tables. `order_items.fulfilled_quantity` is a trigger projection of the active lines. Never write it.
- `(order_id, request_key)` is unique, so a retry returns the first result. `shipment_id` is unique. A fulfilment only moves `active` to `voided`, and its lines never change. A row linked to a parcel cannot be deleted. Triggers refuse a line beyond `quantity - fulfilled_quantity`.
- The tables are private to staff (no DVC dependency).

## Actions

Routes mount under `/api/v1/admin/orders` (`apps/api/src/routes/admin/orders/fulfilments.ts`, `bulk.ts`, `orders-status.ts`). Every route needs `orders.manage_shipments`, except `POST /{id}/cod` (`orders.edit`).

| Action | Function | Route |
|--------|----------|-------|
| Hand over lines: own rider (`ship`), buyer collected (`pickup`), service done (`service`) | `recordOrderFulfilment()` | `POST /{id}/fulfillments` |
| Void a parcel that came back | `voidOrderFulfilment()` | `POST /{id}/fulfillments/{fulfillmentId}/void` |
| Mark a pickup order ready | `markOrderReadyForPickup()` | `POST /{id}/pickup-ready` |
| Mark confirmed orders as sent (own courier) | `bulkFulfillOrders()` | `POST /bulk-fulfill` |
| Book a courier parcel | `bulkShipOrders()` (one order) | `POST /{id}/shipments` |
| Book couriers in bulk | `bulkShipOrders()` | `POST /bulk-ship` |
| Repair a booking | `reconcileOrderShipment()` | `POST /{id}/shipments/{shipmentId}/reconcile` |
| Resolve an unknown booking by courier lookup | `lookupUnknownOrderShipment()` | `POST /{id}/shipments/{shipmentId}/resolve-unknown/lookup` |
| Resolve an unknown booking by merchant attestation | `resolveUnknownOrderShipment()` | `POST /{id}/shipments/{shipmentId}/resolve-unknown` |
| Mark delivered (paid order, own rider, all sent) | `markOrderDelivered()` | `POST /{id}/mark-delivered` |
| COD collected, failed or returned | `processCodAction()` | `POST /{id}/cod` |
| Delete a parcel | `assertShipmentDeletable()` guards it | `DELETE /{id}/shipments/{shipmentId}` |

Courier status checks (`POST /{id}/shipments/{shipmentId}/status`, `/refresh`) and `/api/v1/admin/shipments/*` live in the API layer. They call `syncCourierFulfilmentFromShipment()`.

### Hand over (`recordOrderFulfilment`)

1. A repeated `requestKey` (a UUID) returns the first fulfilment with `replayed: true`.
2. The order must be `confirmed`, `shipped` or `delivered`, with no shipment claim, refund or payment-session attempt in flight and no open hold.
3. The requested lines, or every unsent unit of that kind, must fit `quantity - fulfilled_quantity`.
4. One batch: the order version CAS with the derived `fulfillment_status`, the own-rider `delivery_shipments` row for `ship` (`provider_type = manual`, status `in_transit`), and the fulfilment with its lines.
5. The last `ship` line moves a `confirmed` order to `shipped` and deducts stock through inventory. The result carries `statusChange` for the shipped notification.
6. The last `pickup` or `service` line of an order that ships nothing delivers it through the money gate. `cashReceived` (COD only) is recorded first. When money is still due, the result says `awaitingPayment`.
7. Before the last physical handover, `assertOrderStockCoverable()` refuses when the order's location lacks the units.

### Void and pickup

- Void is allowed for an active own-rider, pickup or service fulfilment of a `confirmed` order. `fulfilmentVoidBlockedReason()` (`orders`) is the one rule; the dashboard shows it as `canVoid`. Courier parcels follow the courier. A delivered parcel or a shipped order cannot be voided: use Mark returned.
- Void sets the parcel `returned` and puts the units back on the unsent list. No stock moves, because the reservation still stands. Returns never write the ledger: a returned unit stays fulfilled.
- `markOrderReadyForPickup()` needs `shipping_method_kind = pickup`. It sets `orders.pickup_ready_at` and writes the `order_ready_for_pickup` outbox row in one batch. A repeat returns the first mark.

## Courier bookings and reconciliation

- `bulkShipOrders()` validates 1 to 90 unique order ids and checks provider readiness once. Per order it claims the shipment (a lease in `order-kernel`), calls `createShipment()` in `delivery`, then CAS-updates the order to `shipped`, records the ledger and reconciles stock.
- `recordCourierBookingFulfilment()` records every unsent `ship` line as one system fulfilment linked to the parcel (`request_key = courier:<shipment id>`). It is idempotent.
- `syncCourierFulfilmentFromShipment()` follows the courier's status. For a handed-over status (`picked_up`, `in_transit`, `out_for_delivery`, `delivered`, `partial_delivered`, `delivery_failed`, `on_hold`) it records the fulfilment before the order moves. For `cancelled` or `pickup_failed` it voids the fulfilment after the order is back to `confirmed`.
- An uncertain courier outcome leaves the shipment `reconcile_required` with the claim held. `reconcileOrderShipment()` finishes local work from stored evidence and never calls the courier again. It refuses a shipment whose provider outcome is unknown.
- An unknown outcome resolves only through `lookupUnknownOrderShipment()` (the courier's `findShipment`) or `resolveUnknownOrderShipment()`. The attestation needs the current order version, a UUID `operationKey`, an evidence source (`courier_portal` or `courier_support`), a note of 8 to 500 characters and `confirmationAccepted`. Outcomes: `confirmed_existing` (needs `externalId`), `confirmed_not_created`, `confirmed_cancelled`. A courier that finds the order vetoes `confirmed_not_created`. Provider rules and status maps are in [delivery](../delivery/README.md).

## Delivery outcomes

`processCodAction()` runs under a CAS on the order version, with no shipment claim, refund or payment-session attempt in flight.

| Action | Allowed when | Effect |
|--------|--------------|--------|
| `collected` | order `shipped` or `delivered` (`confirmed` when nothing ships) | Moves the order to `delivered`, records the cash (`recordCODCollection()`), reconciles stock and marks provider-less parcels delivered. It rolls the status back if the cash record or stock repair fails. An existing record is a retry signal, except on an already delivered order (conflict). |
| `failed` | order `shipped`, or `confirmed` with a part-sent order | Records the attempt (`not_home`, `refused`, `no_cash`, `wrong_address`, `other`) and fails every own-courier parcel still out. |
| `returned` | order `shipped` or `delivered` | Creates and approves a return of every sent unit (`cod_return_to_sender`), marks COD returned and moves the order to `returned`. Stock comes back with the return receipt. |

`markOrderDelivered()` serves a paid order that an own rider sent in full: it needs status `shipped` and no unsent `ship` unit.

## Automatic fulfilment

- `autoFulfilOrder()` hands over `digital` and `gift_card` lines of a settled order (`paid` or `partially_refunded`), one fulfilment per type (`request_key = auto:<type>`). A repeated or concurrent run fails on the unique key and does nothing.
- `FULFILLER_REGISTRY` (`registry.ts`) maps a line type to `manual` (`ship`, `pickup`, `service`) or an automatic fulfiller (`auto/digital.ts`, `auto/gift-card.ts`). A type without a fulfiller fails closed at cart validation and checkout (`fulfilment_unavailable`).
- A fulfiller returns statements that run in the same batch as the ledger rows. The digital fulfiller creates entitlements or takes keys from the pool. When the pool is short it writes a staff alert, delivers nothing and fails the run. A digital-only order becomes `delivered` once everything is handed over.
- With `checkout.autoFulfilMode = after_confirmation` (the `checkout` settings document), delivery waits until staff confirm the order. An unreadable setting also waits. A held order waits for release.
- Triggers: `runOrderAutoFulfil` (`apps/api/src/background/auto-fulfil.ts`) right after the response when payment settles, checkout commits, COD is collected or cash is taken; and `sweepAutoFulfilment()`, which runs in the cron's sweep rotation (every 15 minutes on the Paid plan profile, every 23 minutes on Free). The sweep walks a cursor over the partial index `order_items_auto_pending_idx` (owed `digital` and `gift_card` lines), at most `planLimits().background.autoFulfilPerRun` orders a run (1 on Free, 50 on Paid).

## Rules

- Move order status only through `applyOrderStatusChange()` (`orders`) or the CAS paths in this domain. The state machine and the locks live in `order-kernel`. Cash at the door does not deliver an order that was not shipped.
- Commit local state before a courier call. Never call the courier a second time to repair local state.
- The dashboard submits one `/bulk-ship` request for the selected orders. Money, item count and contents come from the saved order, never from the request.
