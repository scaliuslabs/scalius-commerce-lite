# Delivery

Multi-courier delivery management with provider factory pattern. Supports Pathao and Steadfast.

## Files

- `provider.ts` -- `DeliveryProviderInterface` (getName, getType, testConnection, createShipment, checkShipmentStatus)
- `factory.ts` -- `createProvider()` factory switch
- `types.ts` -- credential/config/response types, `ShipmentResult`, `ShipmentStatus`, `ShipmentOptions`
- `providers/pathao.ts` -- Pathao implementation (OAuth, location mapping)
- `providers/steadfast.ts` -- Steadfast implementation (API key auth)
- `status-mapper.ts` -- `mapProviderStatus()`, `ShipmentStatusCode` enum
- `service.ts` -- `DeliveryService` (CRUD, shipment lifecycle)
- `tracking.ts` -- `ShipmentTracker` (order status sync, tracking URLs)
- `locations.ts` -- city/zone/area management, external ID resolution
- `pathao-location-import.ts` -- bulk import Pathao location data into delivery_locations

## Provider lifecycle

Providers extend the `ProviderLifecycle` interface (`initialize()`, `healthCheck()`, `dispose()`) from `@scalius/core/providers/types`.

## Security & reliability

- Delivery provider credentials are encrypted at rest using AES-256-GCM (see `packages/core/src/utils/credential-encryption.ts`). Decryption is graceful — plaintext credentials still work during migration.
- Webhook handlers use KV-based idempotency to prevent replay attacks. Keys: `delivery_wh:{provider}:{consignmentId}_{event}` with 24h TTL.
- Shipment creation uses an insert-first pattern: DB record created with status `"creating"` before the provider API call, then updated on success/failure. Ensures shipments are never lost.

## Adding a provider

1. Define credential/config types in `types.ts`
2. Create provider class implementing `DeliveryProviderInterface` (and `ProviderLifecycle`) in `providers/`
3. Add status mapping case in `status-mapper.ts`
4. Register in `factory.ts` switch
5. Add provider type to DB schema, run `pnpm db:generate`
6. Optionally add tracking URL in `tracking.ts`

## Dependencies

- `@scalius/database` -- `deliveryProviders`, `deliveryShipments`, `deliveryLocations`, `orders`
- `@scalius/core/errors` -- `NotFoundError`, `ValidationError`, `ServiceUnavailableError`
