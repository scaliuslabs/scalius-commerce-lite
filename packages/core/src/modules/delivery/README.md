# Delivery

Multi-courier delivery management with provider factory pattern. Supports Pathao and Steadfast.

## Files

| File | Purpose |
|------|---------|
| `provider.ts` | `DeliveryProviderInterface` -- contract all providers implement (`getName`, `getType`, `testConnection`, `createShipment`, `checkShipmentStatus`) |
| `factory.ts` | `createProvider()` -- factory switch that parses credentials (with optional AES-GCM decryption) and returns a `PathaoProvider` or `SteadfastProvider` |
| `types.ts` | Shared types: `ShipmentResult`, `ShipmentStatus`, `ShipmentOptions`, plus provider-specific credential/config/response types (`PathaoCredentials`, `PathaoConfig`, `SteadfastCredentials`, `SteadfastConfig`, etc.) |
| `providers/pathao.ts` | `PathaoProvider` -- OAuth2 password-grant auth, lazy token caching (1hr safety margin), location ID mapping via `getExternalLocationIds()`, COD amount calculation from `order.balanceDue` |
| `providers/steadfast.ts` | `SteadfastProvider` -- API key + secret key auth (`Api-Key` / `Secret-Key` headers), full-text address construction from order fields, COD amount from `order.balanceDue` |
| `status-mapper.ts` | `mapProviderStatus()` + `ShipmentStatusCode` enum -- normalizes provider-specific statuses to 14 canonical codes. Pathao map handles both webhook event names (`order.delivered`) and API status strings (`Pickup Cancel`). Steadfast map handles lowercase status strings including `_approval_pending` suffixes. |
| `service.ts` | `DeliveryService` class -- provider CRUD, shipment lifecycle (insert-first creation), status checking, shipment queries |
| `tracking.ts` | `ShipmentTracker` static class -- maps shipment status changes to order status updates (with inventory side-effects via `applyInventoryForStatusChange`), generates tracking URLs, placeholder notification method |
| `locations.ts` | Location CRUD (`getCities`, `getZones`, `getAreas`, `searchLocations`, `createLocation`, `updateLocation`, `deleteLocation`), external ID resolution (`getExternalLocationId`, `getExternalLocationIds`) for mapping internal locations to provider-specific numeric IDs |
| `pathao-location-import.ts` | Chunked bulk import of Pathao cities/zones/areas. Three phases (cities, zones, areas). Progress persisted in KV (`location_import:pathao`). Parallel API calls capped at 8 (`MAX_CONCURRENT`). Areas processed 30 zones per chunk (`ZONES_PER_CHUNK`). Upserts match by Pathao ID first, then by name+parent. |

## Database Schema

Three tables in `packages/database/src/schema/delivery.ts`:

### `delivery_locations`
- Hierarchical city > zone > area tree via self-referential `parentId` FK
- `type` enum: `"city"`, `"zone"`, `"area"`
- `externalIds` (JSON string): maps provider names to their numeric IDs, e.g. `{"pathao": 123}`
- `metadata` (JSON string): arbitrary provider metadata (e.g. `home_delivery_available`)
- Soft-delete via `deletedAt`
- Index on `parentId`

### `delivery_providers`
- `type` text: `"pathao"` or `"steadfast"` (from `DeliveryProvider` enum in `enums.ts`)
- `credentials` (JSON string): may be AES-GCM encrypted (format: `iv_base64:ciphertext_base64`)
- `config` (JSON string): provider-specific settings (storeId, delivery type, item weight, etc.)
- `isActive` boolean: only active providers are offered for shipment creation
- Index on `type`

### `delivery_shipments`
- `orderId` FK to `orders` (cascade delete)
- `providerId` FK to `delivery_providers` (set null on delete)
- `providerType` text: provider type at time of creation (survives provider deletion)
- `externalId`: provider's consignment/order ID
- `trackingId`: public tracking code
- `status`: normalized status from `ShipmentStatusCode`
- `rawStatus`: raw status string from provider
- `metadata` (JSON string): full provider response data, webhook payloads
- `shipmentItems` (JSON string): item details (currently unused)
- `shipmentAmount`: shipment cost
- `isFinalShipment`: marks last shipment for an order
- Compound index on `(providerId, status)`

## Provider Lifecycle

Providers implement `DeliveryProviderInterface` which extends `ProviderLifecycle` from `@scalius/core/providers/types`:

```
initialize(settings) -> void   // Both providers are no-ops (lazy auth)
healthCheck()        -> { healthy, message }  // Delegates to testConnection()
dispose()            -> void   // No-op
```

### Pathao Authentication
- OAuth2 password grant to `/aladdin/api/v1/issue-token`
- Token cached in-memory with 1-hour safety margin before expiry
- Credentials: `baseUrl`, `clientId`, `clientSecret`, `username`, `password`
- Config: `storeId`, `defaultDeliveryType` (48=regular, 12=express), `defaultItemType` (1=document, 2=parcel), `defaultItemWeight` (KG, min 0.5)

### Steadfast Authentication
- Static API key auth via `Api-Key` + `Secret-Key` headers
- Credentials trimmed on every request to handle whitespace
- Test connection checks `/status_by_invoice/test` -- accepts 200 or 404 as success
- Credentials: `baseUrl`, `apiKey`, `secretKey`
- Config: `defaultCodAmount`

## Shipment Creation (Insert-First Pattern)

`DeliveryService.createShipment()` guarantees a DB record exists even if the provider API succeeds but the subsequent DB write fails (e.g. worker timeout):

1. Load order + order items (with product names for item descriptions)
2. INSERT a `"creating"` placeholder shipment record
3. Call `provider.createShipment(order, enrichedOptions)`
4. On success: UPDATE record with `externalId`, `trackingId`, normalized `status`, raw metadata
5. On provider rejection: UPDATE record to `status: "failed"`, `rawStatus: "provider_rejected"`
6. On exception: UPDATE record to `status: "failed"`, `rawStatus: "exception"`

COD amount logic (both providers): `options.codAmount ?? order.balanceDue ?? (order.totalAmount - order.paidAmount)`

### Pathao-Specific Shipment Fields
- Requires mapped numeric IDs for `recipient_city`, `recipient_zone`, `recipient_area` (via `getExternalLocationIds("pathao")`)
- Validation: fails early if order lacks `city` or `zone`, or if external mappings are missing
- Sends: `store_id`, `merchant_order_id`, `recipient_name`, `recipient_phone`, `recipient_address`, `item_quantity`, `item_weight`, `item_description`, `amount_to_collect`, `delivery_type`, `item_type`, `special_instruction`

### Steadfast-Specific Shipment Fields
- Does NOT require numeric location IDs -- constructs full text address from `shippingAddress + areaName + zoneName + cityName`
- Sends: `invoice` (order ID), `recipient_name`, `recipient_phone`, `recipient_address`, `cod_amount`, `note`

## Status Mapping

`ShipmentStatusCode` enum (14 canonical statuses):
`pending`, `pickup_assigned`, `picked_up`, `pickup_failed`, `in_transit`, `out_for_delivery`, `delivered`, `partial_delivered`, `delivery_failed`, `on_hold`, `failed`, `cancelled`, `returned`, `unknown`

### Pathao Status Map
Handles two formats:
- Webhook events: `order.created`, `order.picked`, `order.delivered`, `order.returned`, etc. (20 mappings)
- API status strings: `Pending`, `Pickup Cancel`, `Pickup_Cancelled`, `Delivered`, etc. (normalized to lowercase with spaces replaced by underscores; 19 mappings)

### Steadfast Status Map
Single format: `pending`, `in_review`, `hold`, `delivered`, `delivered_approval_pending`, `partial_delivered`, `partial_delivered_approval_pending`, `cancelled`, `cancelled_approval_pending`, `unknown`, `unknown_approval_pending` (11 mappings)

## Shipment-to-Order Status Sync

`ShipmentTracker.updateOrderStatusFromShipment()` maps shipment status to order status:

| Shipment Status | Order Status | Conditions |
|----------------|-------------|------------|
| `picked_up` | `shipped` | Order not already `delivered`/`returned`/`cancelled` |
| `in_transit` | `shipped` | Order not already `delivered`/`returned`/`cancelled` |
| `delivered` | `delivered` | Always |
| `returned` | `returned` | Always |
| `failed` | `confirmed` | Only if order is `shipped` or `processing` (allows retry) |
| `cancelled` | `confirmed` or `cancelled` | If `shipped` -> `confirmed`; if `pending`/`processing` -> `cancelled` |
| `pending` | No change | |

Before updating order status, calls `applyInventoryForStatusChange()` for inventory side-effects.

### Tracking URLs
- Pathao: `https://merchant.pathao.com/tracking?consignment_id={trackingId}`
- Steadfast: `https://steadfast.com.bd/t/{trackingId}`

## AES-GCM Credential Encryption

File: `packages/core/src/utils/credential-encryption.ts`

- `encryptCredentials(plaintext, keyBase64)` -- AES-256-GCM with random 12-byte IV. Returns `base64(iv):base64(ciphertext)`.
- `decryptCredentials(encrypted, keyBase64)` -- reverses the encryption.
- `decryptCredentialsGraceful(value, keyBase64)` -- tries to decrypt; if it fails (plaintext data), returns as-is. Enables gradual migration.
- Key comes from `CREDENTIAL_ENCRYPTION_KEY` Cloudflare secret (base64-encoded 256-bit key).
- Used in `factory.ts` (decryption) and `service.ts` (encryption on save).

## Webhook Replay Protection

Both webhook handlers (`apps/api/src/routes/webhooks/pathao.ts`, `steadfast.ts`) use KV-based idempotency:

- Key format: `delivery_wh:{provider}:{consignmentId}_{event}`
- TTL: 24 hours (86400 seconds)
- Check BEFORE processing; write AFTER successful processing
- Deduplicated requests return success with `deduplicated: true`

## Webhook Authentication

File: `apps/api/src/middleware/webhook-auth.ts`

`verifyDeliveryWebhook()` uses a three-tier strategy:

1. **Signature verification** (if `credentials.webhookSecret` is set):
   - Pathao: checks `X-PATHAO-Signature` header against stored secret (constant-time comparison)
   - Steadfast: checks `Authorization: Bearer {token}` header against stored secret
   - Generic fallback: HMAC-SHA256 of request body via `X-Webhook-Signature` header
2. **IP allowlist** (if `config.allowedWebhookIps` is set): checks `CF-Connecting-IP` or `X-Forwarded-For`
3. **No security** (backward compat): logs a security warning and allows the request

## Pathao Location Import

File: `pathao-location-import.ts`

Chunked import optimized for Cloudflare Workers limits:

- **Phase 1 (cities)**: One API call to `/aladdin/api/v1/city-list`, bulk upsert all cities
- **Phase 2 (zones)**: Parallel API calls (`MAX_CONCURRENT=8`) to fetch zones for all cities, bulk upsert
- **Phase 3 (areas)**: 30 zones per chunk, parallel area fetches, bulk upsert. Preserves `home_delivery_available` and `pickup_available` in metadata.

Upsert logic: match by Pathao external ID first, then by `name+parentId`. Creates new if no match.
Progress stored in KV key `location_import:pathao` with 24h expiry.

Total import time: ~60-90 seconds for all of Bangladesh.

## API Endpoints

### Admin Shipment Routes (`apps/api/src/routes/admin/shipments.ts`)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/shipments/{id}` | Get shipment by ID |
| DELETE | `/admin/shipments/{id}` | Delete a shipment |
| POST | `/admin/shipments/{id}/check-status` | Poll provider for status update, sync order status, update `lastChecked` |

### Admin Delivery Provider Routes (`apps/api/src/routes/admin/settings/delivery-providers.ts`)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/settings/delivery-providers` | List all providers (credentials masked) |
| POST | `/admin/settings/delivery-providers` | Create provider (encrypts credentials if key available) |
| PUT | `/admin/settings/delivery-providers` | Update provider (unmasks credentials, merges with existing) |
| GET | `/admin/settings/delivery-providers/{id}` | Get provider by ID |
| POST | `/admin/settings/delivery-providers/{id}` | Test existing provider connection |
| DELETE | `/admin/settings/delivery-providers/{id}` | Delete provider |
| POST | `/admin/settings/delivery-providers/create-test` | Test credentials before saving (creates ephemeral provider) |

Credential masking: `clientSecret`, `password`, `apiKey`, `secretKey` replaced with `"xxxxxxxxxxxx"` in responses.

### Admin Delivery Location Routes (`apps/api/src/routes/admin/settings/delivery-locations.ts`)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/settings/delivery-locations` | List locations (paginated, filterable by type/parentId/search) |
| POST | `/admin/settings/delivery-locations` | Create a location |
| GET | `/admin/settings/delivery-locations/{id}` | Get location by ID |
| PUT | `/admin/settings/delivery-locations/{id}` | Update a location |
| DELETE | `/admin/settings/delivery-locations/{id}` | Soft-delete a location |
| DELETE | `/admin/settings/delivery-locations` | Bulk soft-delete (body: `{ ids: [...] }`) |
| DELETE | `/admin/settings/delivery-locations/all` | Hard-delete ALL locations (permanent) |
| POST | `/admin/settings/delivery-locations/import-pathao` | Process one chunk of Pathao import |
| GET | `/admin/settings/delivery-locations/import-pathao/status` | Check import progress |
| DELETE | `/admin/settings/delivery-locations/import-pathao` | Reset import progress |

### Public Location Routes (`apps/api/src/routes/locations.ts`)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/locations/cities` | Get all active cities (10-min cache) |
| GET | `/locations/zones?cityId=X` | Get active zones for a city |
| GET | `/locations/areas?zoneId=X` | Get active areas for a zone |

### Webhook Routes
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/webhooks/pathao` | Pathao status push (returns 202 + `X-Pathao-Merchant-Webhook-Integration-Secret` header) |
| POST | `/webhooks/steadfast` | Steadfast status push (handles `delivery_status` + `tracking_update` notification types) |

## Adding a New Provider

1. Add enum value to `DeliveryProvider` in `packages/database/src/schema/enums.ts`
2. Define credential/config/response types in `types.ts`
3. Create provider class implementing `DeliveryProviderInterface` in `providers/`
4. Add status mapping in `status-mapper.ts` (new `const PROVIDER_STATUS_MAP` + function)
5. Register in `factory.ts` switch case
6. Add provider visual config in `apps/admin/src/components/admin/delivery-providers/ProviderIcon.tsx` (`PROVIDER_VISUAL` and `PROVIDER_TYPES`)
7. Add default credentials/config in `apps/admin/src/components/admin/delivery-providers/DeliveryProvidersContainer.tsx` (`DEFAULT_CREDENTIALS` and `DEFAULT_CONFIG`)
8. Add credential form fields in `ProviderDetailPanel.tsx`
9. Add tracking URL in `ShipmentTracker.getTrackingUrl()` in `tracking.ts`
10. Add webhook route in `apps/api/src/routes/webhooks/` if the provider pushes status updates
11. Add webhook verification case in `apps/api/src/middleware/webhook-auth.ts`
12. Run `pnpm db:generate` if schema changed

## Dependencies

- `@scalius/database` -- `deliveryProviders`, `deliveryShipments`, `deliveryLocations`, `orders`, `orderItems`, `products`
- `@scalius/core/errors` -- `NotFoundError`, `ValidationError`, `ServiceUnavailableError`
- `@scalius/core/utils/credential-encryption` -- `encryptCredentials`, `decryptCredentialsGraceful`
- `@scalius/core/modules/inventory/inventory-transitions` -- `applyInventoryForStatusChange`
- `@scalius/core/modules/payments/process-payment` -- `recordWebhookEvent` (webhook audit trail)
- `@paralleldrive/cuid2` -- ID generation for locations
- `nanoid` -- ID generation for providers and shipments

## Known Gaps

- `ShipmentTracker.notifyStatusChange()` is a placeholder -- logs to console but does not send SMS/email/push notifications
- `shipmentItems` and `shipmentAmount` columns on `delivery_shipments` are defined in schema but never populated during creation
- `isFinalShipment` is defaulted to `false` but never set to `true` by any code path
- `trackingUrl` column on `delivery_shipments` is never populated -- tracking URLs are computed on-the-fly by `ShipmentTracker.getTrackingUrl()`
- `courierName` column on `delivery_shipments` is never populated during provider-based creation
- The `ShipmentList.tsx` component calls `/api/v1/admin/orders/{orderId}/shipments/{id}/refresh` which is not defined in the shipments route file shown -- this endpoint must be defined elsewhere (possibly in the order routes)
- Credential encryption is only applied on save if `CREDENTIAL_ENCRYPTION_KEY` env var is set -- providers created without the key store plaintext credentials
- The `delete /all` locations endpoint does a hard DELETE (not soft-delete), permanently removing all records
- ~~Pathao location import credentials parsed without decryption~~: Fixed -- import route now uses `decryptCredentialsGraceful()` before `JSON.parse()`
