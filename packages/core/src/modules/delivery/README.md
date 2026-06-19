# Delivery

Multi-courier delivery management with provider factory pattern. Supports Pathao and Steadfast.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports (delivery.service, tracking, factory, locations, types, status-mapper, provider). Excludes pathao-location-import and providers/. |
| `provider.ts` | `DeliveryProviderInterface` -- contract all providers implement. Extends `ProviderLifecycle` from `@scalius/core/providers/types`. Methods: `getName`, `getType`, `testConnection`, `createShipment`, `checkShipmentStatus`. |
| `factory.ts` | `createProvider()` -- factory that parses credentials (with optional AES-GCM decryption via `decryptCredentialsGraceful()`) and config JSON, then returns a `PathaoProvider` or `SteadfastProvider` based on `provider.type`. Read paths tolerate legacy plaintext/JWT-encrypted rows only for migration. |
| `types.ts` | Shared types: `ShipmentResult`, `ShipmentStatus`, `ShipmentOptions`, plus provider-specific credential/config/response types (`PathaoCredentials`, `PathaoConfig`, `SteadfastCredentials`, `SteadfastConfig`, etc.) |
| `delivery.service.ts` | Standalone functions for provider CRUD, shipment lifecycle (insert-first creation), status checking, shipment queries |
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
| `saveDeliveryProvider` | `(db, provider, encryptionKey)` | Create or update. Requires `CREDENTIAL_ENCRYPTION_KEY`; rejects before insert/update if no dedicated key is supplied. |
| `deleteDeliveryProvider` | `(db, id)` | Hard delete |
| `testDeliveryProvider` | `(db, id, encryptionKey?)` | Tests connection via provider instance |
| `createShipment` | `(db, orderId, providerId, options?, encryptionKey?)` | Insert-first pattern (see below). Enriches with order item names and quantities. |
| `getShipment` | `(db, id)` | Single shipment by ID |
| `getLatestShipment` | `(db, orderId)` | Most recent shipment for an order |
| `getShipments` | `(db, orderId)` | All shipments for an order, ordered by createdAt desc |
| `checkShipmentStatus` | `(db, shipmentId, encryptionKey?)` | Polls provider API, updates DB record |
| `deleteShipmentRecord` | `(db, id)` | Hard delete shipment only after claim/reconciliation safety checks. Rejects active order shipment claims, `reconcile_required`, and unresolved expired claimed rows; clears stale failed/cancelled claims before deletion. |

## Tracking Functions (`tracking.ts`)

| Function | Signature | Notes |
|----------|-----------|-------|
| `updateOrderStatusFromShipment` | `(db, shipmentId, newStatus)` | Maps shipment status to order status, CAS update on `orders.version` first when status changes, then applies inventory side-effects via `applyInventoryForStatusChange()`. Same-status retries still reconcile stale inventory. Concurrent admin changes take priority (CAS conflict is logged and skipped). |
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

Provider shipment creation is coordinated by order-level shipment claims in the orders module. `deleteShipmentRecord()` is the deletion gate: do not bypass it when removing shipments, because it protects active claims, reconciliation evidence, and stale claimed rows that still need manual resolution.

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

Before updating, performs CAS update on `orders.version` to prevent race conditions with concurrent admin status changes. If the CAS fails (admin made a change at the same time), the webhook update is skipped with a log message. On CAS success, calls `applyInventoryForStatusChange()` for inventory side-effects. If the mapped order status already equals the current order status, it still calls `applyInventoryForStatusChange()` so provider retries can repair stale `inventoryAction` left by a prior failure; callers should only send customer notifications when a real order status change is returned.

Delivery webhooks and admin shipment refresh/check paths enqueue customer notifications from the API layer through `ORDER_NOTIFICATIONS_QUEUE` after a committed order status change. The API helper maps only order statuses with existing templates: `shipped`, `delivered`, `returned`, and `cancelled`. Shipment-only states such as `out_for_delivery`, `on_hold`, and `delivery_failed` remain internal unless new notification templates/settings are added.

## Credential Storage

Delivery provider credentials are encrypted before storage with the dedicated `CREDENTIAL_ENCRYPTION_KEY`. `saveDeliveryProvider()` is write-strict and must not be called with `getEncryptionKey()` fallback output; route-facing saves use `requireEncryptionKey()` and fail before DB writes or checkout-cache invalidation when the key is missing. Admin list/get/update paths decrypt existing rows before masking or merging masked fields, including `webhookSecret`, so encrypted rows are never returned as ciphertext and masked placeholders are never persisted as real credentials. Provider runtime reads keep graceful plaintext/JWT fallback through `createProvider()` for legacy migration only.

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
- `@scalius/core/utils/credential-encryption` -- `encryptCredentials`, `decryptCredentialsGraceful`
- `@scalius/core/modules/inventory/inventory-transitions` -- `applyInventoryForStatusChange`
- `@scalius/core/providers/types` -- `ProviderLifecycle`, `HealthCheckResult`
- `@scalius/shared/customer-utils` -- `formatPhoneForProvider` (used by fraud-checker provider, not delivery directly)
- `@paralleldrive/cuid2` -- ID generation for locations
- `nanoid` -- ID generation for shipments
