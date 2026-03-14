# Fraud Checker

Phone number fraud risk assessment via pluggable providers. Checks delivery history and cancellation rates from external APIs.

## Provider Interface

```typescript
// provider.ts
export interface FraudCheckProvider {
  readonly name: string;
  lookup(phone: string, apiUrl: string, apiKey: string): Promise<FraudCheckResult>;
}

export interface FraudCheckResult {
  riskLevel: "low" | "medium" | "high" | "unknown";
  details: Record<string, unknown>;
  raw?: unknown;
}
```

Risk thresholds (default provider): `>=50%` cancel rate = high, `>=20%` = medium, `<20%` = low, no parcels = unknown.

## Adding a New Provider

1. **Create provider class** in `provider.ts` (or a separate file):
   ```typescript
   export class MyFraudProvider implements FraudCheckProvider {
     readonly name = "my-provider";
     async lookup(phone: string, apiUrl: string, apiKey: string): Promise<FraudCheckResult> {
       // Call your API, normalize response to { riskLevel, details, raw }
     }
   }
   ```

2. **Register** in `provider.ts` at module load or in `index.ts`:
   ```typescript
   registerFraudCheckProvider(new MyFraudProvider());
   ```

3. **No other code changes needed.** The `FraudCheckerService` in `service.ts` resolves providers dynamically via `getFraudCheckProvider(providerType)`. When an admin saves a fraud checker configuration with `providerType: "my-provider"`, your implementation is used automatically.

4. **Admin configuration:** Providers are saved via `FraudCheckerService.saveProvider()` with fields `name`, `apiUrl`, `apiKey`, `isActive`, and `providerType`. The `providerType` key selects which `FraudCheckProvider` implementation to use.

## Registry Pattern

- `providers` is a module-level `Map<string, FraudCheckProvider>`
- `registerFraudCheckProvider(provider)` adds by `provider.name`
- `getFraudCheckProvider(type)` returns the matching provider or falls back to `"default"`
- The `DefaultFraudCheckProvider` is always registered at module load

## Configuration

Provider configs are stored in the `settings` DB table with `category = "fraud-checker"`. Each provider is a JSON-encoded row keyed by a unique provider ID. Fields: `name`, `apiUrl`, `apiKey`, `isActive`, `providerType`.

## Error Handling

Import from `@scalius/core/errors`:
- `ValidationError` -- missing required fields when saving a provider
- `NotFoundError` -- provider ID not found
- `ServiceUnavailableError` -- API call failed during lookup

## Key Files

- `provider.ts` -- `FraudCheckProvider` interface, `DefaultFraudCheckProvider`, registry (`registerFraudCheckProvider`, `getFraudCheckProvider`)
- `service.ts` -- `FraudCheckerService` class (CRUD, lookup, test connection)
- `index.ts` -- barrel exports
