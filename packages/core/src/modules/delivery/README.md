# Delivery

Multi-courier delivery management with provider factory pattern. Supports Pathao and Steadfast.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports (delivery.service, tracking, factory, locations, types, status-mapper, provider). Excludes pathao-location-import and providers/. |
| `provider.ts` | `DeliveryProviderInterface` -- focused contract all delivery providers implement: `getName`, `getType`, `testConnection`, `createShipment`, and `checkShipmentStatus`. |
| `factory.ts` | `createProvider()` -- factory that strict-reads encrypted credentials with `CREDENTIAL_ENCRYPTION_KEY`, parses credentials/config JSON, then returns a `PathaoProvider` or `SteadfastProvider` based on `provider.type`. Legacy plaintext rows remain readable for migration; unreadable encrypted rows fail before provider clients are built. |
| `types.ts` | Shared types: `ShipmentResult`, `ShipmentStatus`, `ShipmentOptions`, plus provider-specific credential/config/response types (`PathaoCredentials`, `PathaoConfig`, `SteadfastCredentials`, `SteadfastConfig`, etc.) |
| `delivery.service.ts` | Standalone functions for provider CRUD, shipment lifecycle (insert-first creation), status checking, shipment queries |
| `provider-readiness.ts` | Activation/readiness rules for Pathao/Steadfast required fields plus keyed setup fingerprints for durable live-test proof |
| `tracking.ts` | Standalone functions: `updateOrderStatusFromShipment()` maps shipment status to order status (with inventory side-effects via `applyInventoryForStatusChange`), `getTrackingUrl()` |
| `status-mapper.ts` | `mapProviderStatus()` + `ShipmentStatusCode` enum -- normalizes provider-specific statuses to 14 canonical codes |
| `locations.ts` | Location CRUD and external ID resolution functions |
| `pathao-location-import.ts` | Chunked bulk import of Pathao cities/zones/areas (excluded from barrel exports) |
| `providers/pathao.ts` | `PathaoProvider` -- OAuth2 password-grant auth, lazy token caching, location ID mapping |
| `providers/steadfast.ts` | `SteadfastProvider` -- API key + secret key auth, full-text address construction |

## Delivery Service Functions (`delivery.service.ts`)

| Function | Signature | Notes |
|----------|-----------|-------|
| `getDeliveryProviders` | `(db)` | All providers, ordered by updatedAt desc |
| `getActiveDeliveryProviders` | `(db)` | Active providers only |
| `getDeliveryProvider` | `(db, id)` | Single provider by ID |
| `saveDeliveryProvider` | `(db, provider, encryptionKey)` | Create or update. Requires `CREDENTIAL_ENCRYPTION_KEY`; rejects before insert/update if no dedicated key is supplied. Preserves live-test proof only when the current setup fingerprint still matches. |
| `deleteDeliveryProvider` | `(db, id)` | Hard delete |
| `testDeliveryProvider` | `(db, id, encryptionKey?)` | Records a test attempt, tests connection via provider instance, and stores successful proof for the current provider type/credentials/config fingerprint |
| `createShipment` | `(db, orderId, providerId, options?, encryptionKey?)` | Requires a provider whose readiness summary is `active`, preflights Pathao city/zone mappings, then uses the insert-first pattern (see below). Enriches with order item names and quantities. |
| `getShipment` | `(db, id)` | Single shipment by ID |
| `getLatestShipment` | `(db, orderId)` | Most recent shipment for an order |
| `getShipments` | `(db, orderId)` | All shipments for an order, ordered by createdAt desc |
| `checkShipmentStatus` | `(db, shipmentId, encryptionKey?)` | Requires the shipment provider to still be active, polls provider API, updates DB record |
| `deleteShipmentRecord` | `(db, id)` | Hard delete only failed/cancelled shipment attempts after claim/reconciliation safety checks. Active and fulfilled shipment history is immutable; stale failed/cancelled claims are cleared before deletion. |

## Tracking Functions (`tracking.ts`)

| Function | Signature | Notes |
|----------|-----------|-------|
| `updateOrderStatusFromShipment` | `(db, shipmentId, newStatus)` | Maps shipment status to order status, CAS update on `orders.version` first when status changes, then applies inventory side-effects via `applyInventoryForStatusChange()`. Same-status retries still reconcile stale inventory. Inventory failures mark the shipment `reconcile_required` with sanitized repair metadata. Concurrent admin changes take priority (CAS conflict is logged and skipped). |
| `getTrackingUrl` | `(providerType, trackingId)` | Returns tracking URL for Pathao or Steadfast, null for others |

## Location Functions (`locations.ts`)

| Function | Signature | Notes |
|----------|-----------|-------|
| `getCities` | `(db)` | All active cities, ordered by sortOrder |
| `getZones` | `(db, cityId)` | Active zones for a city |
| `getAreas` | `(db, zoneId)` | Active areas for a zone |
| `searchLocations` | `(db, query, type?)` | LIKE search on name, limit 50 |
| `createLocation` | `(db, data: LocationData)` | Creates with cuid2 ID |
| `updateLocation` | `(db, id, data)` | Partial update |
| `deleteLocation` | `(db, id)` | Soft-delete |
| `getLocationById` | `(db, id)` | Single active location, parses JSON fields |
| `getExternalLocationId` | `(db, locationId, providerType)` | Resolves provider-specific numeric ID from `externalIds` JSON |
| `getExternalLocationIds` | `(db, { city?, zone?, area? }, providerType)` | Batch-resolves external IDs for city/zone/area |

**Exported type:** `LocationData` -- `{ id?, name, type, parentId?, externalIds, metadata, isActive?, sortOrder? }`

## Shipment Creation (Insert-First Pattern)

`createShipment()` guarantees a DB record exists even if the provider API succeeds but the subsequent DB write fails:

1. Load order + order items (with product names for item descriptions and count)
2. Enrich options with `itemCount` (sum of quantities) and `itemDescription` (product names x qty)
3. INSERT a `"creating"` placeholder shipment record
4. Call `provider.createShipment(order, enrichedOptions)`
5. On success: UPDATE with `externalId`, `trackingId`, normalized `status`, raw metadata
6. On provider rejection: UPDATE to `status: "failed"`, `rawStatus: "provider_rejected"`
7. On exception: UPDATE to `status: "failed"`, `rawStatus: "exception"`

Provider shipment creation is coordinated by order-level shipment claims in the orders module. Bulk shipment creation preflights provider readiness once before the per-order loop; missing, inactive, unconfigured, untested, stale-test, or unreadable providers return one clear failure per requested order without writing order claims or shipment placeholders. `deleteShipmentRecord()` is the deletion gate: do not bypass it when removing shipments, because it protects active claims, reconciliation evidence, and stale claimed rows that still need manual resolution. When provider creation succeeded but local order/inventory finalization failed, the orders module repairs from the persisted shipment evidence and only then clears the matching order claim; delivery providers must not be called a second time for that repair.

For Pathao, positive-integer city and zone `externalIds.pathao` mappings are mandatory before the insert-first placeholder is written. Area mappings remain optional because Pathao accepts some shipments without area IDs, but when present the provider payload includes them.

## Status Mapping

`ShipmentStatusCode` enum (14 canonical statuses):
`pending`, `pickup_assigned`, `picked_up`, `pickup_failed`, `in_transit`, `out_for_delivery`, `delivered`, `partial_delivered`, `delivery_failed`, `on_hold`, `failed`, `cancelled`, `returned`, `unknown`

### Pathao Status Map
Handles two formats:
- Webhook events: `order.created`, `order.picked`, `order.delivered`, etc. (20 mappings)
- API status strings: normalized to lowercase with spaces to underscores (19 mappings)
- Unmapped statuses log a warning and default to `unknown`

### Steadfast Status Map
Single format: 11 mappings including `_approval_pending` suffixes. Normalized to lowercase.

## Shipment-to-Order Status Sync

`updateOrderStatusFromShipment()` maps shipment status to order status:

| Shipment Status | Order Status | Conditions |
|----------------|-------------|------------|
| `pickup_assigned` | `shipped` | Order not already delivered/returned/cancelled |
| `picked_up` | `shipped` | Order not already delivered/returned/cancelled |
| `in_transit` | `shipped` | Order not already delivered/returned/cancelled |
| `out_for_delivery` | `shipped` | Order not already delivered/returned/cancelled |
| `partial_delivered` | `delivered` | Same as delivered |
| `delivered` | `delivered` | Allowed direct from confirmed; deducts reserved stock if the order skipped shipped locally |
| `returned` | `returned` | Always |
| `pickup_failed`, `delivery_failed`, `failed` | `confirmed` | Only if order is shipped or processing |
| `cancelled` | `confirmed` or `cancelled` | If shipped -> confirmed; if pending/processing -> cancelled |
| `pending`, `on_hold`, `unknown` | No order change | Shipment-only state |

Before updating, performs CAS update on `orders.version` to prevent race conditions with concurrent admin status changes. If the CAS fails (admin made a change at the same time), the webhook update is skipped with a log message. On CAS success, calls `applyInventoryForStatusChange()` for inventory side-effects. If inventory reconciliation fails after the status CAS, the shipment is marked `reconcile_required` with the carrier status needed for local repair. If the mapped order status already equals the current order status, it still calls `applyInventoryForStatusChange()` so provider retries or the explicit admin repair can fix stale `inventoryAction` left by a prior failure; callers should only send customer notifications when a real order status change is returned.

Delivery webhooks and admin shipment refresh/check paths enqueue customer notifications from the API layer through `ORDER_NOTIFICATIONS_QUEUE` after a committed order status change. The API helper maps only order statuses with existing templates: `shipped`, `delivered`, `returned`, and `cancelled`. Shipment-only states such as `out_for_delivery`, `on_hold`, and `delivery_failed` remain internal unless new notification templates/settings are added. All admin status-check endpoints must use the shared API shipment-status sync helper so provider polling, `lastChecked`, order/inventory reconciliation, availability cache invalidation, and notification enqueue stay in one path.

Delivery webhook verification is active-provider authoritative. `verifyDeliveryWebhook()` must find exactly one active provider for the courier type; zero or multiple active providers fail closed before signature/IP checks. The webhook routes then scope shipment lookup by the verified `providerId` and `providerType` as well as the external consignment/tracking identifier, so an old/inactive provider row or another provider's colliding external id cannot update a shipment. Admin-triggered shipment creation and status polling also reject inactive provider IDs before provider API calls or local placeholder writes. Pathao shipment creation preflights required city/zone mappings before provider token work or local placeholder writes; the Pathao provider keeps its own mapping check as defense-in-depth.

## Provider Activation Readiness

Delivery providers are inactive drafts by default on both create and update-as-create paths. Turning a provider active still requires complete local setup through `assertDeliveryProviderReadyForActivation()`, but shipment actions require more: the provider readiness summary must be `active`, meaning the row is enabled and has a successful live connection test for the current provider type, unmasked credentials, and config. The proof is stored as a keyed fingerprint, so editing credentials/config clears stale success evidence unless the fingerprint still matches. A failed test records failure time without replacing successful proof, and a later failure blocks action readiness until a new successful test passes. Pathao activation requires `baseUrl`, `clientId`, `clientSecret`, `username`, `password`, and `storeId`; Steadfast activation requires `baseUrl`, `apiKey`, and `secretKey`. Admin list/get responses include a readiness summary with statuses `draft`, `configured`, `tested`, `active`, or `blocked` while returning masked credentials.

## Credential Storage

Delivery provider credentials are encrypted before storage with the dedicated `CREDENTIAL_ENCRYPTION_KEY`. `saveDeliveryProvider()` is write-strict and must not be called with `getEncryptionKey()` fallback output; route-facing saves use `requireEncryptionKey()` and fail before DB writes or checkout-cache invalidation when the key is missing. Admin list/get/update paths strict-read existing rows before masking or merging masked fields, including `webhookSecret`, so encrypted rows are never returned as ciphertext and masked placeholders are never persisted as real credentials. Provider runtime reads, webhook verification, Pathao import, shipment creation, status polling, and live tests pass only `getCredentialEncryptionKey()` output; missing/wrong keys fail closed before courier calls while legacy plaintext rows remain readable for migration.

Active provider saves also reject incomplete setup, obvious placeholder values, and base URLs that are not absolute credential-free HTTPS URLs. Provider failures retain only bounded status/field metadata; raw upstream HTML/JSON bodies that may echo buyer details are never logged or returned as shipment diagnostics.

### Tracking URLs
- Pathao: `https://merchant.pathao.com/tracking?consignment_id={trackingId}`
- Steadfast: `https://steadfast.com.bd/t/{trackingId}`

## Pathao Location Import (`pathao-location-import.ts`)

Chunked import optimized for Cloudflare Workers limits:

- **Phase 1 (cities)**: One API call, bulk upsert
- **Phase 2 (zones)**: Parallel API calls (`MAX_CONCURRENT=8`), bulk upsert
- **Phase 3 (areas)**: 30 zones per chunk (`ZONES_PER_CHUNK`), parallel area fetches, bulk upsert

Upsert logic: match by Pathao external ID first, then by `name+parentId`. Progress stored in KV (`location_import:pathao`, 24h TTL). Token cached with 10-minute safety margin.

**Exported functions:** `processPathaoImportChunk()`, `resetPathaoImportProgress()`, `getPathaoImportStatus()`

**Exported type:** `ImportChunkResult`

## Dependencies

- `@scalius/database` -- `deliveryProviders`, `deliveryShipments`, `deliveryLocations`, `orders`, `orderItems`, `products`
- `@scalius/core/errors` -- `NotFoundError`, `ValidationError`, `ServiceUnavailableError`
- `@scalius/core/utils/credential-encryption` -- `encryptCredentials`, `readStoredCredentialStrict`
- `@scalius/core/modules/inventory/inventory-transitions` -- `applyInventoryForStatusChange`
- `@scalius/shared/customer-utils` -- `formatPhoneForProvider` (used by fraud-checker provider, not delivery directly)
- `@paralleldrive/cuid2` -- ID generation for locations
- `nanoid` -- ID generation for shipments
