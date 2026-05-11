# Fraud Checker

Phone number fraud risk assessment via pluggable providers. Admin-only manual lookup tool. NOT integrated into the checkout or order pipeline.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports: service functions + types, provider interface + registry |
| `fraud-checker.service.ts` | Standalone functions for provider CRUD, phone lookup, connection testing |
| `provider.ts` | `FraudCheckProvider` interface, Bangladesh provider adapters, provider presets, provider registry (`registerFraudCheckProvider`, `getFraudCheckProvider`) |

## Provider Interface (`provider.ts`)

Every fraud check provider implements:

```typescript
interface FraudCheckProvider {
  readonly name: string;
  lookup(phone: string, config: FraudCheckProviderConfig): Promise<FraudCheckResult>;
}
```

Result shape:

```typescript
interface FraudCheckResult {
  riskLevel: "low" | "medium" | "high" | "unknown";
  details: Record<string, unknown>;
  raw?: unknown;
}
```

### Built-In Providers

Provider configuration presets live in `FRAUD_CHECK_PROVIDER_DEFINITIONS`, which is also used by the admin UI to show the right credential fields.

| Provider type | Adapter | Auth | Request |
|---------------|---------|------|---------|
| `default` | `DefaultFraudCheckProvider` | `Authorization: Bearer <apiKey>` | `FormData(phone)` |
| `fraudbd` | `FraudBdCheckProvider` | `api_key` / `API-KEY` header | JSON `{ phone }` |
| `fraudguard` | `FraudGuardCheckProvider` | `X-API-KEY` + `X-API-SECRET` headers | JSON `{ phone }` |
| `ecourier` | `ECourierFraudCheckProvider` | `API-KEY` + `API-SECRET` + `USER-ID` headers | JSON `{ mobile }` |

All providers normalize their responses into `mobile_number`, `total_parcels`, `total_delivered`, `total_cancel`, and optional per-courier `apis` stats so existing order UI consumers do not need provider-specific branches.

Risk level calculation:
- `total_parcels === 0` -> `"unknown"`
- Cancel rate >= 50% -> `"high"`
- Cancel rate >= 20% -> `"medium"`
- Cancel rate < 20% -> `"low"`

### Provider Registry

In-memory `Map<string, FraudCheckProvider>`. The `"default"` provider is registered on module load. Custom providers are registered via `registerFraudCheckProvider()`. Lookup via `getFraudCheckProvider()` falls back to `"default"` when the requested type is not found.

## Service Functions (`fraud-checker.service.ts`)

Stores provider configurations in the `settings` table with `category = "fraud-checker"`. Each provider is a JSON blob keyed by a nanoid.

| Function | Signature | Notes |
|----------|-----------|-------|
| `getFraudProviders` | `(db)` | List all configured providers from settings table. Parses JSON values, filters out parse failures. |
| `getFraudProvider` | `(db, id)` | Get single provider by settings key. Returns null if not found or parse fails. |
| `saveFraudProvider` | `(db, provider)` | Create or update. Validates `name`, `apiUrl`, and provider-specific credentials from `FRAUD_CHECK_PROVIDER_DEFINITIONS`. Defaults `providerType` to `"default"`. Uses `unixepoch()` for timestamps. |
| `deleteFraudProvider` | `(db, id)` | Hard-delete. Throws `NotFoundError` if missing. |
| `testFraudProvider` | `(db, id)` | Tests connection by looking up phone `"+8801700000000"`. Throws `NotFoundError` if provider missing. |
| `fraudLookup` | `(provider, phone)` | Look up a phone number using a specific provider config. Resolves provider implementation via `getFraudCheckProvider(providerType)`. Throws `ServiceUnavailableError` on failure. |
| `fraudLookupWithActiveProvider` | `(db, phone)` | Look up using the first provider where `isActive === true`. Throws `NotFoundError` if no active provider. |

### Exported Types

- **`FraudCheckerProvider`** (from service): `{ id, name, apiUrl, apiKey, apiSecret?, userId?, isActive, providerType? }` -- the stored config shape
- **`FraudCheckResult`** (from service): `{ success, data?, riskLevel?, error? }` -- the service-level result
- **`FraudCheckProvider`** (from provider): interface that providers implement
- **`ProviderFraudCheckResult`** (from provider, re-exported): `{ riskLevel, details, raw? }` -- the provider-level result

## Adding a Custom Provider

1. Create a class implementing `FraudCheckProvider` with a unique `name` and `lookup` method
2. Add a matching entry to `FRAUD_CHECK_PROVIDER_DEFINITIONS`
3. Call `registerFraudCheckProvider(new MyProvider())` at module load time
4. Admin saves config with `providerType: "my-provider"` -- the registry auto-resolves it

## Dependencies

- `@scalius/database` -- `settings` table (`category = "fraud-checker"`)
- `@scalius/core/errors` -- `ValidationError`, `NotFoundError`, `ServiceUnavailableError`
- `@scalius/shared/customer-utils` -- `formatPhoneForProvider()`
- `nanoid` -- provider config IDs
