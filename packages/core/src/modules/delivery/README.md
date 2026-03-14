# Delivery

Multi-courier delivery management with a provider factory pattern. Supports Pathao and Steadfast; extensible for additional couriers.

## Provider Interface

```typescript
// provider.ts
export interface DeliveryProviderInterface {
  getName(): string;
  getType(): DeliveryProviderType; // "pathao" | "steadfast" | ...
  testConnection(): Promise<{ success: boolean; message: string }>;
  createShipment(order: Order, options?: ShipmentOptions): Promise<ShipmentResult>;
  checkShipmentStatus(externalId: string): Promise<ShipmentStatus>;
}
```

## Adding a New Provider

1. **Define credential and config types** in `types.ts`:
   ```typescript
   export interface MyProviderCredentials { baseUrl: string; apiKey: string; }
   export interface MyProviderConfig { defaultWeight: number; }
   ```
   Also add any provider-specific API response types.

2. **Create provider class** in `providers/my-provider.ts`:
   - Implement `DeliveryProviderInterface`
   - Constructor takes `(credentials: MyProviderCredentials, config: MyProviderConfig)`
   - `createShipment()` calls the courier API, returns `ShipmentResult` with `externalId` and `trackingId`
   - `checkShipmentStatus()` polls the courier API, returns `ShipmentStatus` with a mapped status
   - Use `mapProviderStatus(this.getType(), rawStatus)` from `status-mapper.ts` for status normalization

3. **Add status mapping** in `status-mapper.ts`:
   - Add a `case "my-provider"` in `mapProviderStatus()` switch
   - Create `mapMyProviderStatus(status)` mapping courier-specific statuses to `ShipmentStatusCode` enum values: `PENDING`, `PICKED_UP`, `IN_TRANSIT`, `DELIVERED`, `FAILED`, `CANCELLED`, `RETURNED`, `UNKNOWN`

4. **Register in factory** (`factory.ts`):
   - Import your provider class
   - Add a `case "my-provider"` in the `createProvider()` switch, parsing `credentials` and `config` JSON from the DB record

5. **Add provider type to DB schema** in `packages/database/src/schema/`:
   - Add your type to the `DeliveryProviderType` union, then run `pnpm db:generate`

6. **Add tracking URL** (optional) in `tracking.ts`:
   - Add a `case "my-provider"` in `ShipmentTracker.getTrackingUrl()` returning the public tracking URL template

7. **Location mapping** (if needed):
   - If the courier requires numeric location IDs (like Pathao), use `getExternalLocationIds()` from `locations.ts`. Location mappings are stored in the `delivery_locations` table with `externalIds` JSON containing provider-keyed IDs.

## Credential Management

Provider records are stored in the `delivery_providers` DB table with columns: `id`, `name`, `type`, `isActive`, `credentials` (JSON string), `config` (JSON string). The factory parses these JSON strings at instantiation time. Admin creates/updates providers via `DeliveryService.saveProvider()`.

## Status Mapping

All courier-specific statuses are normalized to `ShipmentStatusCode` values via `status-mapper.ts`. The `ShipmentTracker` class in `tracking.ts` maps shipment status changes to order status updates (e.g., `picked_up` -> order `shipped`, `delivered` -> order `delivered`).

## Error Handling

Import from `@scalius/core/errors`:
- `NotFoundError` -- provider or shipment not found
- `ValidationError` -- shipment has no provider (manual shipment)
- `ServiceUnavailableError` -- courier API call failed

## Key Files

- `provider.ts` -- `DeliveryProviderInterface`
- `factory.ts` -- `createProvider()` factory switch
- `types.ts` -- credential/config/response types, `ShipmentResult`, `ShipmentStatus`, `ShipmentOptions`
- `providers/pathao.ts` -- Pathao implementation (OAuth token management, location mapping)
- `providers/steadfast.ts` -- Steadfast implementation (API key auth)
- `status-mapper.ts` -- `mapProviderStatus()` normalizer, `ShipmentStatusCode` enum
- `service.ts` -- `DeliveryService` class (CRUD, shipment lifecycle)
- `tracking.ts` -- `ShipmentTracker` (order status sync, tracking URLs)
- `locations.ts` -- city/zone/area management, external ID resolution
