# Delivery

The `delivery` domain owns the courier port, saved courier accounts (delivery providers), shipments and their tracking, and the delivery places and rates a buyer chooses at checkout (locations, zones, shipping methods). It is for contributors who change booking, tracking or delivery pricing. Courier-specific facts (endpoints, headers, statuses, webhooks) are in [docs/delivery-providers](../../../../../docs/delivery-providers/README.md).

## Entries and layer

- `index.ts` exports the services, the courier port and registry (`couriers/port.ts`, `couriers/registry.ts`), and re-exports `browser.ts` (`types.ts`, `zone-match.ts`, `provider-readiness.ts`). Core has no courier adapter: every courier is an app's.
- Layer L5. It imports `inventory`, `order-kernel` and `settings`. `checkout`, `fulfilment`, `notifications` and `orders` import it (`scripts/core-domain-graph.allow.json`).

## Owns

| Table | Purpose |
|-------|---------|
| `delivery_providers` | A merchant's courier: `type` (the app courier), `is_active` (default false) and the last test (`last_test_*` columns). `credentials` and `config` are `{}`: the app's settings hold the keys. A row saved before its courier moved into an app keeps its old encrypted keys until the app's activation moves them. |
| `delivery_shipments` | A parcel. `provider_type` is `manual` for an own rider. |
| `places` | The place directory: a tree of numbered levels per country (Bangladesh: City, Thana, Area). `external_ids` is JSON, for example `{ "pathao": "123" }`. Imports key places by `source_key`. Soft delete. [Places](../../../../../docs/PLACES.md). |
| `delivery_zones`, `delivery_zone_locations` | A zone and its Bangladesh places. A place belongs to at most one zone. `delivery_zones.revision` guards edits. |
| `delivery_zone_regions` | What else a zone serves: a whole country (`admin_area` and `postal_prefix` empty), one admin area (the address rules' code) or a postal-code prefix. Primary key (`country_code`, `admin_area`, `postal_prefix`): a region belongs to one zone. Migration 0114. |
| `shipping_methods` | A rate: `zone_id`, `kind` (`delivery` or `pickup`), `fee_minor`, `free_over_minor`, `pickup_address`. A live delivery rate has a zone (trigger `SHIPPING_RATE_ZONE_REQUIRED`); local pickup has none. Soft delete. |

- Settings document `delivery_pickup` (`zones.ts`) is empty. Its revision guards edits of the local pickup rates.
- DVC: `shipping_methods`, `delivery_zones`, `delivery_zone_locations` and `delivery_zone_regions` advance dependency `ship`. `places` advances `loc` (not for its `source*` columns). Providers and shipments are private. Zone, place and region writes also advance `checkout_authority`; a place write only when its name, parent, level, country, status or deletion changes.

## Couriers

- Every courier implements the courier port (`@scalius/shared/plugins/providers/courier`). `couriers/port.ts` adds `setup()`, `preflight()` and `trackingUrl()`.
- A delivery provider row names its courier in `type`: an installed app's `<plugin id>:<provider id>` (`scalius.bangladesh:pathao`). Delivery and fulfilment code never branch on the courier.
- A courier states the countries it delivers to (`countries`: `"any"` or ISO codes; Pathao and Steadfast deliver to `["BD"]`). The provider list returns them. The order page offers a courier only for an order shipping to one of its countries and names the others with the reason; the bulk booking skips such orders. `createShipment()` refuses the country before any write, as a last guard (MARKETS-DESIGN step 3a).
- `createCourierProviders(apps)` builds one request's catalog from the active courier apps. The API loads them only when a row names an app courier (`requestCourierProviders()` in `apps/api/src/plugins/providers/courier.ts`). Without that source there is none.
- `Courier.setup(row, key)` reads the setup once: the call settings (null when unreadable: never call the courier) and the readiness summary. An app courier's settings are the app's, read strictly with `CREDENTIAL_ENCRYPTION_KEY`.
- A courier that books by its own place ids declares `locations` (Pathao: `pathao`, city and zone, numeric). The adapter's `preflight()` refuses a booking without them before the shipment row, and `createShipment` passes them as `recipient.locationIds`. The provider list returns `requiredLocations` (the order page asks for them) and `canFindShipment`.
- `ProviderError` decides the outcome of a booking. A certain refusal (`declined`, `misconfigured`, or `retryable` without `uncertain`) means nothing was booked. `uncertain`, or any other throw after the call started, keeps the booking for reconciliation.

## Provider readiness

`getDeliveryProviderReadinessSummary()` reports a lifecycle: `draft`, `tested`, `active` or `blocked`. `active` means on and set up.

- The courier names what blocks it (`activationBlockers`): the app's missing, unreadable or placeholder settings, or the app not active. The first blocker is the issue the dashboard shows.
- The app tests its own setup (`testConnection` through the app). The row records the last test; there is no proof on the row.
- Shipment creation and status checks need an active provider.

## Shipment creation

`createShipment(db, orderId, providerId, options, key, { shipmentId, couriers })` inserts first:

1. Check that the provider is `active`, run the courier `preflight()` (a courier's declared place ids) and run `assertOrderStockCoverable()`.
2. Build the `CourierShipmentInput` from the saved order. The caller supplies only staff options (`deliveryType`, `itemType`, `itemWeight`, `note`). `codAmountMinor` is the balance due. `idempotencyKey` is the shipment id.
3. Insert a `creating` shipment row (with the courier's name), then call the courier.
4. Success: save `external_id`, `tracking_id` (the booking id when the courier has none), `tracking_url`, `status`, `raw_status` and the courier's details in `metadata`.
5. Certain refusal: `status = failed`, `raw_status = provider_rejected`.
6. Uncertain outcome: `status = reconcile_required`, `raw_status = provider_outcome_unknown`. The caller (`fulfilment`) keeps the order's shipment claim without an expiry. If this write fails, the `creating` row still blocks a retry.
7. If persisting a success fails: `reconcile_required` with reason `shipment_success_persist_failed`.

- `fulfilment` calls this function (`bulkShipOrders()`) under the order's shipment claim (`order-kernel`, 15-minute lease). `createShipment()` does not write the order.
- An unknown outcome blocks another booking, deleting the shipment, a status check and local repair until someone resolves it. `lookupShipmentByMerchantOrderId()` asks the courier's `findShipment` (positive answers only). [fulfilment](../fulfilment/README.md) owns the resolution flow.
- `deleteShipmentRecord()` deletes only `failed` or `cancelled` rows, and refuses while a claim, a `creating` row or a reconciliation is open. A parcel linked to a fulfilment cannot be deleted.
- `checkShipmentStatus()` needs an active provider, an `external_id` and no open claim, refund or payment-session attempt. A courier error stores `unknown` with `raw_status = error`.
- A booking failure message carries the HTTP status, never the response body.

## Status and order sync

Each courier maps its own statuses to the port's 14 shipment codes (Pathao and Steadfast: `plugins/bangladesh/src/couriers.ts`; [Pathao](../../../../../docs/delivery-providers/pathao.md), [Steadfast](../../../../../docs/delivery-providers/steadfast.md)). An unmapped status becomes `unknown`.

`updateOrderStatusFromShipment(db, shipmentId, status)` moves the order:

| Shipment status | Order status |
|-----------------|--------------|
| `pickup_assigned`, `picked_up`, `in_transit`, `out_for_delivery` | `shipped`, unless the order is `delivered`, `returned` or `cancelled` |
| `delivered`, `partial_delivered` | `delivered` |
| `returned` | `returned` |
| `pickup_failed`, `delivery_failed`, `failed` | `confirmed`, only from `shipped` or `processing` |
| `cancelled` | `confirmed` from `shipped`; `cancelled` from `pending` or `processing` |
| `pending`, `on_hold`, `unknown` | no change |

- The update runs only when the state machine allows the transition (`canTransitionTo`). It is a CAS on `orders.version`: a concurrent admin change wins and the update is skipped. It refuses while a shipment claim, refund or payment-session attempt is in flight.
- After the CAS, and also when the status is unchanged, it reconciles stock (`applyInventoryForStatusChangeWithImpact`). If that fails, the shipment becomes `reconcile_required` with reason `order_status_inventory_reconcile_failed`, and a retry or `reconcileOrderShipment()` repairs it.
- The caller sends a customer notification only for `shipped`, `delivered`, `cancelled` and `returned`, and only when the order status really changed.
- `fulfilment` keeps the ledger in step through `syncCourierFulfilmentFromShipment()` ([fulfilment](../fulfilment/README.md)).

## Webhooks

The API mounts `POST /api/v1/webhooks/couriers/{id}` (app couriers whose port implements `verifyWebhook`), without session auth: the app's verification is the auth (`apps/api/src/routes/webhooks/couriers.ts`; rules in [docs/delivery-providers](../../../../../docs/delivery-providers/README.md)). After verification, the route:

1. Finds the shipment by external id, scoped to the one active provider row and the courier. An old or inactive row, or another provider's colliding id, cannot match. With the order number the courier echoes, it refuses a booking of another order and binds a booking a lookup confirmed without its id.
2. Claims the event once in `webhook_events`. A duplicate returns the earlier result.
3. Stores the status and details on the shipment, then runs `syncCourierFulfilmentFromShipment()`, `updateOrderStatusFromShipment()` and `syncCourierFulfilmentFromShipment()` again.
4. Enqueues the customer notification after a committed status change.

Admin status checks use the same sync through `checkAndSyncShipmentStatus()` (`apps/api/src/routes/admin/shipment-status-sync.ts`). Use that helper for every status-check endpoint.

## Locations and zones

- A place has a country and a level (`places.ts`). Bangladesh addresses read levels 1 to 3 as city, zone (thana) and area (`placeAddressFieldSql`). A name is trimmed and whitespace-collapsed, at most 120 characters. Active names are unique per parent and level. `deletePlaces()` soft-deletes a place with everything under it and removes all of them from zones in one batch, because orders and bookings still read the names.
- `importPlaces()` (`places-import.ts`) is the one idempotent dataset import: the dashboard, agents, plugins (the Bangladesh pack's dataset and its Pathao refresh) and the dev seed use it. Rules are in [Places](../../../../../docs/PLACES.md).
- `resolveActiveDeliveryLocationNames()` checks a checkout address: the city is a root city, the zone belongs to it, the area belongs to the zone, and all are active. Otherwise it throws `delivery_location_unavailable` with the failing field.
- A courier reads its own ids from `external_ids` (Pathao: positive integers for city and zone; the area is optional).
- A zone is a name plus Bangladesh places and regions (MARKETS-DESIGN step 3b). `resolveDestinationZoneId()` (`zone-match.ts`, browser safe; the dashboard order form uses it too) picks an address's zone, most specific first: Bangladesh place (area, then zone, then city), the longest postal prefix, the admin area, the whole country. With no zone the address gets no delivery rate. A `pickup` rate is store-wide, needs a pickup address, and is offered for every address.
- A zone serves a country `entire` when it holds the country whole and no other zone holds part of it (`zoneCountryCoverage()`). The public rate list states each rate's `countries`; JSON-LD and the feeds claim a country-wide rate only for `entire` countries.
- `resolveDeliveryRate()` is the one checkout decision: the rate is active and live, its zone matches the destination (pickup always matches), and the rate is free when the items subtotal before discounts reaches `free_over_minor`. The rate statement carries the destination country's regions as one JSON column, so the decision costs no extra statement.
- Limits: a rate or threshold up to 100,000 major units (`MAX_DELIVERY_AMOUNT`), 20 rates per zone, 2,000 places and 500 regions per zone, postal prefixes of 1 to 10 letters or digits. A fee is on the store's price increment (whole taka by default in BDT).
- Zone edits need the current `delivery_zones.revision`. Pickup edits need the revision of the `delivery_pickup` document. A region another zone holds is refused with that zone's name. A write cannot remove the last active rate. `applyDeliveryZoneTemplate()` creates starter Dhaka zones (Inside Dhaka, optionally Near Dhaka, and the zone Bangladesh for Outside Dhaka) only when no zone exists.
- The Bangladesh pack refreshes Pathao's live cities, zones and areas through `importPlaces()` in bounded steps (`plugins/bangladesh/src/pathao-places.ts`).

## Routes

Permissions are in `packages/core/src/auth/rbac/route-permissions/settings.ts` and `orders.ts`.

| Path | Permission |
|------|------------|
| `/api/v1/admin/settings/delivery-providers`: `GET /` | `settings.delivery_providers.view` or `orders.manage_shipments` |
| Same path: `GET /{id}` | `settings.delivery_providers.view` |
| Same path: `POST /`, `PUT /` (an app courier id, no keys), `POST /{id}` (test through the app), `DELETE /{id}` | `settings.delivery_providers.edit` |
| `/api/v1/admin/settings/delivery-locations`: reads (`GET /`, `GET /{id}`) | `settings.delivery_locations.view` |
| Same path: `GET /countries` | `settings.delivery_locations.view` |
| Same path: `POST /`, `PUT /{id}`, `DELETE /`, `DELETE /all`, `DELETE /{id}` | `settings.delivery_locations.edit` |
| Same path: `POST /import` (adds and updates, never deletes) | `settings.delivery_locations.edit` or `settings.delivery_locations.import` (what an app that loads a dataset asks for) |
| `/api/v1/admin/settings/shipping-methods`: `GET /`, `POST /` (create zone), `PUT /{id}`, `DELETE /{id}`, `PUT /pickup`, `PUT /template` | `settings.shipping_methods.view` (`GET`), `.edit` (writes) |
| `GET /api/v1/locations/cities`, `/zones`, `/areas` (and `/summaries`), `GET /api/v1/shipping-methods` (Bangladesh `cityId`/`zoneId`/`areaId`, or `countryCode`/`adminArea`/`postalCode`) | public |
| `GET`, `DELETE /api/v1/admin/shipments/{id}`; `POST /api/v1/admin/shipments/{id}/check-status` | `orders.view` / `orders.manage_shipments` |
| `/api/v1/admin/orders/{id}/shipments`, `.../{shipmentId}`, `/status`, `/refresh`, `/reconcile`, `/resolve-unknown` | see [fulfilment](../fulfilment/README.md) |

## Rules

- Never call a courier with unreadable or placeholder credentials. Fail closed.
- Never infer "not booked" from a 404, a failed lookup or an unknown status. Never attach an external id without evidence that binds it to the original provider and order.
- Never put a courier key on a delivery provider row: it belongs in the courier app's settings (sealed, never echoed).
- Never log credentials, courier response bodies, buyer contact data or webhook bodies.
- Always scope webhook shipment lookups to the one active provider row and the courier.
- Never write the fulfilment ledger or order status from a courier adapter. Adapters speak one courier's protocol only.
