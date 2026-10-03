# Delivery

The `delivery` domain owns the courier port and its adapters, saved courier accounts (delivery providers), shipments and their tracking, and the delivery places and rates a buyer chooses at checkout (locations, zones, shipping methods). It is for contributors who change booking, tracking or delivery pricing. Courier-specific facts (endpoints, headers, statuses, webhooks) are in [docs/delivery-providers](../../../../../docs/delivery-providers/README.md).

## Entries and layer

- `index.ts`: `delivery.service`, `tracking`, `locations`, `zones`, `location-validation`, `status-mapper`, `pathao-location-import`, the courier port and registry (`couriers/port.ts`, `couriers/registry.ts`), `pathaoCourier`, `steadfastCourier`. It re-exports `browser.ts`.
- `browser.ts`: `types.ts`, `tracking-url.ts` (`getTrackingUrl()`), `provider-readiness.ts`.
- Layer L4. It imports `inventory`, `order-kernel` and `settings`. `checkout`, `fulfilment`, `notifications` and `orders` import it (`scripts/core-domain-graph.allow.json`).

## Owns

| Table | Purpose |
|-------|---------|
| `delivery_providers` | A saved courier account: `type`, `is_active` (default false), encrypted `credentials`, `config`, and the live-test columns `last_test_attempt_at`, `last_test_success_at`, `last_test_failure_at`, `last_test_success_fingerprint`. |
| `delivery_shipments` | A parcel: `order_id`, `provider_id`, `provider_type` (`manual` for an own rider), `external_id`, `tracking_id`, `tracking_url`, `status`, `raw_status`, `metadata`, `shipment_amount_minor`, `last_checked`. |
| `delivery_locations` | The city, zone (thana) and area tree: `type`, `parent_id`, `external_ids` (JSON, for example `{ "pathao": "123" }`), `is_active`, soft delete (`deleted_at`). |
| `delivery_zones`, `delivery_zone_locations` | A zone and its places. A place belongs to at most one zone (the primary key of `location_id`). `delivery_zones.revision` guards edits. |
| `shipping_methods` | A delivery rate: `zone_id` (null = "Everywhere else"), `kind` (`delivery` or `pickup`), `fee_minor`, `free_over_minor`, `pickup_address`, soft delete. |

- Settings document `delivery_everywhere_else` (`zones.ts`): an empty document. Its revision guards edits of the "Everywhere else" rates.
- DVC: `shipping_methods`, `delivery_zones` and `delivery_zone_locations` advance dependency `ship`. `delivery_locations` advances `loc`. Providers and shipments are private. Public readers declare `deps.shipping()` and `deps.locations()`.
- KV: the Pathao import keeps its progress under `location_import:pathao` (24-hour TTL).

## Couriers

- Every courier implements the courier port (`@scalius/shared/plugins/providers/courier`): `createShipment`, `trackShipment`, and optionally `findShipment`, `cancelShipment`, `quote`, `verifyWebhook`, `reconcileCod`, `testConnection`. `couriers/port.ts` adds `setup()`, `preflight()` and `trackingUrl()`.
- A delivery provider row names its courier in `type`: `pathao`, `steadfast`, or an installed app's `<plugin id>:<provider id>`. Delivery and fulfilment code never branch on the courier.
- `createCourierProviders(apps)` builds one request's catalog: built-in couriers first, then app couriers. An app cannot shadow a built-in id. Functions take a `CourierProvidersSource`, either the catalog or a loader the API calls only when a row names an app courier (`apps/api/src/plugins/providers/courier.ts`, `requestCourierProviders()`). Without a source, only built-ins exist.
- `Courier.setup(row, key)` reads a row once. It returns the call settings (null when unreadable: never call the courier), the readiness summary and a setup fingerprint.
- Built-in couriers keep encrypted credentials on the row. `readRowCourierSetup()` reads them strictly with `CREDENTIAL_ENCRYPTION_KEY` and parses the JSON. A legacy plaintext value still reads. An app courier's row has no credentials: its settings live in the app, and readiness is the app's (active, approved, runnable, settings complete, secrets readable).
- `ProviderError` decides the outcome of a booking. A certain refusal (`declined`, `misconfigured`, or `retryable` without `uncertain`) means nothing was booked. `uncertain`, or any other throw after the call started, keeps the booking for reconciliation.

## Provider readiness

`getDeliveryProviderReadinessSummary()` reports a lifecycle: `draft`, `configured`, `tested`, `active` or `blocked`. `active` means enabled and tested.

- Setup needs these fields. Pathao: `baseUrl`, `clientId`, `clientSecret`, `username`, `password`, `storeId` (config). Steadfast: `baseUrl`, `apiKey`, `secretKey`.
- A value that looks like a placeholder (`test`, `demo`, `changeme`, `password`, repeated digits, and similar) blocks activation. The `baseUrl` must be an absolute public HTTPS URL without credentials, a custom port, a query or a fragment.
- The test proof is an HMAC-SHA256 fingerprint of the type, credentials and config, keyed with `CREDENTIAL_ENCRYPTION_KEY`. `saveDeliveryProvider()` keeps the proof only while the fingerprint still matches. A failure after the last success blocks actions until a new test passes. App couriers keep no proof.
- Shipment creation and status checks need an active provider. Providers start inactive on create.

## Shipment creation

`createShipment(db, orderId, providerId, options, key, { shipmentId, couriers })` follows the insert-first pattern:

1. Check that the provider is `active`, run the courier `preflight()` (Pathao needs mapped city and zone ids) and run `assertOrderStockCoverable()`.
2. Build the `CourierShipmentInput` from the saved order: recipient and location ids, `codAmountMinor` (the balance due), item count and description. The caller supplies only staff options (`deliveryType`, `itemType`, `itemWeight`, `note`). `idempotencyKey` is the shipment id.
3. Insert a `creating` shipment row.
4. Call the courier.
5. Success: set `external_id`, `tracking_id` (the booking id when the courier has none), `tracking_url` (an app's tracking page), `status`, `raw_status` and the courier's details in `metadata`.
6. Certain refusal: set `status = failed`, `raw_status = provider_rejected`.
7. Uncertain outcome: set `status = reconcile_required`, `raw_status = provider_outcome_unknown`. The caller (`fulfilment`) keeps the order's shipment claim without an expiry. If this write fails, the `creating` row still blocks a retry.
8. If persisting a success fails: `reconcile_required` with reason `shipment_success_persist_failed`.

- `fulfilment` calls this function (`bulkShipOrders()`), under the order's shipment claim (`order-kernel`, 15-minute lease). `createShipment()` does not write the order.
- An unknown outcome blocks another booking, deleting the shipment, a status check and local repair until the outcome is resolved. `lookupShipmentByMerchantOrderId()` asks the courier's `findShipment` (positive answers only). Without a positive answer the merchant attests (`resolveUnknownOrderShipment()` in `fulfilment`). A courier that finds the order vetoes "not created".
- `deleteShipmentRecord()` deletes only `failed` or `cancelled` rows. It refuses while a claim, a `creating` row or a reconciliation is open. A parcel linked to a fulfilment cannot be deleted.
- `checkShipmentStatus()` needs an active provider, an `external_id` and no open claim, refund or payment-session attempt. A courier error stores `unknown` with `raw_status = error`.
- A booking failure message carries the HTTP status, never the response body.

## Status and order sync

`mapProviderStatus(type, status)` maps a courier status to one of 14 codes: `pending`, `pickup_assigned`, `picked_up`, `pickup_failed`, `in_transit`, `out_for_delivery`, `delivered`, `partial_delivered`, `delivery_failed`, `on_hold`, `failed`, `cancelled`, `returned`, `unknown`. An unmapped status becomes `unknown`. The maps are in [Pathao](../../../../../docs/delivery-providers/pathao.md) and [Steadfast](../../../../../docs/delivery-providers/steadfast.md).

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
- `fulfilment` keeps the ledger in step: `syncCourierFulfilmentFromShipment()` records the handover before the order moves and voids it after a cancellation (see [fulfilment](../fulfilment/README.md)).

## Webhooks

The API mounts `POST /api/v1/webhooks/pathao`, `POST /api/v1/webhooks/steadfast` and `POST /api/v1/webhooks/couriers/{id}` (app couriers whose port implements `verifyWebhook`) without session auth: verification is the auth (`apps/api/src/routes/webhooks/`, `apps/api/src/middleware/webhook-auth.ts`). Verification rules are in [docs/delivery-providers](../../../../../docs/delivery-providers/README.md).

Each route does the same after verification:

1. Find the shipment by external id, scoped to the verified provider id and type. An old or inactive row, or another provider's colliding id, cannot match.
2. Claim the event once in `webhook_events`. A duplicate returns the earlier result.
3. Store the status and details on the shipment, then run `syncCourierFulfilmentFromShipment()`, `updateOrderStatusFromShipment()` and `syncCourierFulfilmentFromShipment()` again.
4. Enqueue the customer notification after a committed status change.

Admin status checks (`checkAndSyncShipmentStatus()` in `apps/api/src/routes/admin/shipment-status-sync.ts`) use the same sync. Use that helper for every status-check endpoint.

## Locations and zones

- A location is a city, a zone (thana) or an area. A name is trimmed and whitespace-collapsed, at most 120 characters. Active names are unique per parent and type. `deleteLocations()` soft-deletes a place with its children and removes all of them from zones in one batch, because orders and bookings still read the names.
- `resolveActiveDeliveryLocationNames()` checks a checkout address: the city is a root city, the zone belongs to it, the area belongs to the zone, and all are active. Otherwise it throws `delivery_location_unavailable` with the failing field.
- `getExternalLocationId()` reads a courier's id from `external_ids`. Pathao needs positive integers for city and zone (`isPositiveIntegerExternalLocationId()`). The area is optional.
- A zone is a name plus a set of places. An address resolves to the zone of its most specific assigned place (area, then zone, then city). With no zone it gets the "Everywhere else" rates. A `pickup` rate is store-wide, needs a pickup address, and is offered for every address.
- `resolveDeliveryRate()` is the one checkout decision: the rate is active and live, its zone matches the address (pickup always matches), and the rate is free when the items subtotal before discounts reaches `free_over_minor`. `listDeliveryRatesForAddress()` lists the rates for an address.
- Limits: a rate or threshold up to 100,000 major units (`MAX_DELIVERY_AMOUNT`), 20 rates per zone, 2,000 places per zone. In BDT a fee is a whole taka.
- Zone edits need the current `delivery_zones.revision`. "Everywhere else" edits need the revision of the `delivery_everywhere_else` document. A write cannot remove the last active rate. `applyDeliveryZoneTemplate()` creates starter Dhaka zones (`dhaka_two_zone`, `dhaka_three_zone`) only when no zone exists.

## Pathao location import

`processPathaoImportChunk()` imports cities, zones and areas through repeated calls from the dashboard until the status is `complete`. Phase 1 reads the cities in one call. Phase 2 reads the zones of every city (8 parallel calls). Phase 3 reads areas for 30 zones per chunk. A row matches by `external_ids.pathao`, then by name and parent. It skips duplicate ids and operational routing buckets (`shouldSuppressPathaoLocationName()`) and deactivates rejected rows it imported earlier. Progress is in KV. The token lives for one chunk.

## Routes

| Path | Permission |
|------|------------|
| `/api/v1/admin/settings/delivery-providers`: `GET /` | `settings.delivery_providers.view` or `orders.manage_shipments` |
| Same path: `GET /{id}` | `settings.delivery_providers.view` |
| Same path: `POST /`, `PUT /`, `POST /create-test` (test an unsaved setup), `POST /{id}` (test a saved one), `DELETE /{id}` | `settings.delivery_providers.edit` |
| `/api/v1/admin/settings/delivery-locations`: `GET /`, `GET /{id}`; `POST /`, `PUT /{id}`, `DELETE /`, `DELETE /all`, `DELETE /{id}`; `POST`, `DELETE /import-pathao`, `GET /import-pathao/status` | `settings.delivery_locations.view` for reads; `.edit` for writes and the import status |
| `/api/v1/admin/settings/shipping-methods`: `GET /`, `POST /` (create zone), `PUT /{id}`, `DELETE /{id}`, `PUT /everywhere-else`, `PUT /template` | `settings.shipping_methods.view` / `.edit` |
| `GET /api/v1/locations/cities`, `/zones`, `/areas` (and `/summaries`), `GET /api/v1/shipping-methods` | public |
| `GET`, `DELETE /api/v1/admin/shipments/{id}`; `POST /api/v1/admin/shipments/{id}/check-status` | `orders.view` / `orders.manage_shipments` |
| `/api/v1/admin/orders/{id}/shipments`, `.../{shipmentId}`, `/status`, `/refresh`, `/reconcile`, `/resolve-unknown` | see [fulfilment](../fulfilment/README.md) |

Route files: `apps/api/src/routes/admin/settings/delivery-providers.ts`, `apps/api/src/routes/admin/settings/delivery-locations.ts`, `apps/api/src/routes/admin/settings/shipping.ts`, `apps/api/src/routes/locations.ts`, `apps/api/src/routes/shipping-methods.ts`, `apps/api/src/routes/admin/shipments.ts` and `apps/api/src/routes/admin/orders-status.ts`. Permissions: `packages/core/src/auth/rbac/route-permissions/settings.ts` and `orders.ts`.

## Rules

- Never call a courier with unreadable or placeholder credentials. Fail closed.
- Never infer "not booked" from a 404, a failed lookup or an unknown status. Never attach an external id without evidence that binds it to the original provider and order.
- Never save a masked placeholder (`••••••••••••`) as a credential. The admin routes mask `clientSecret`, `password`, `apiKey`, `secretKey` and `webhookSecret`.
- Never log credentials, courier response bodies, buyer contact data or webhook bodies.
- Always scope webhook shipment lookups to the verified provider id and type.
- Never write the fulfilment ledger or order status from a courier adapter. Adapters speak one courier's protocol only.

## Where to look

- `delivery.service.ts`, `provider-readiness.ts`, `tracking.ts`, `status-mapper.ts`, `tracking-url.ts`.
- `couriers/` (`port.ts`, `registry.ts`, `row-setup.ts`, `pathao.ts`, `steadfast.ts`).
- `locations.ts`, `location-names.ts`, `location-validation.ts`, `zones.ts`, `pathao-location-import.ts`.
- Tests: `delivery.service.test.ts`, `delivery.create-outcome.d1.test.ts` (both adapters through the real claim flow), `tracking.test.ts`, `provider-readiness.test.ts`, `zones.d1.test.ts`, `locations.d1.test.ts`, `couriers/*.test.ts`.
