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

## Adding a provider

1. Define credential/config types in `types.ts`
2. Create provider class implementing `DeliveryProviderInterface` in `providers/`
3. Add status mapping case in `status-mapper.ts`
4. Register in `factory.ts` switch
5. Add provider type to DB schema, run `pnpm db:generate`
6. Optionally add tracking URL in `tracking.ts`

## Dependencies

- `@scalius/database` -- `deliveryProviders`, `deliveryShipments`, `deliveryLocations`, `orders`
- `@scalius/core/errors` -- `NotFoundError`, `ValidationError`, `ServiceUnavailableError`
