# Delivery

Manages delivery providers and shipments. Uses a provider factory pattern to support multiple courier integrations.

## Exports

- `DeliveryService` — class with methods for provider CRUD, shipment creation, status tracking
  - `getProviders()` / `getActiveProviders()` / `getProvider()` — query providers
  - `saveProvider()` / `deleteProvider()` / `testProvider()` — manage providers
  - `createShipment()` / `getShipment()` / `getShipments()` — shipment lifecycle
  - `checkShipmentStatus()` — poll external provider for status updates
- `createProvider()` — factory function to instantiate provider-specific adapters

## Dependencies

- `@scalius/database` — `deliveryProviders`, `deliveryShipments`, `orders` tables

## API Routes

- `GET /api/v1/admin/shipping-methods` — list delivery providers
- `POST /api/v1/admin/shipping-methods` — create/update provider
- `POST /api/v1/orders/:id/ship` — create shipment for an order
