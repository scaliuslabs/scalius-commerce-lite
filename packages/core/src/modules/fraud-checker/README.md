# Fraud Checker

Phone number fraud risk assessment via pluggable providers. Admin-only manual lookup tool. NOT integrated into the checkout or order pipeline.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports for service, provider interface, and registry functions |
| `provider.ts` | `FraudCheckProvider` interface, `DefaultFraudCheckProvider`, provider registry (`registerFraudCheckProvider`, `getFraudCheckProvider`) |
| `service.ts` | `FraudCheckerService` class -- CRUD for provider configs, phone number lookup, connection testing |

## How It Works

### Provider Interface

Every fraud check provider implements:

```typescript
interface FraudCheckProvider {
  readonly name: string;
  lookup(phone: string, apiUrl: string, apiKey: string): Promise<FraudCheckResult>;
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

### Default Provider

`DefaultFraudCheckProvider` sends an HTTP POST with phone as FormData and Bearer token auth. Expects a JSON response with parcel delivery statistics:

```typescript
{
  mobile_number: string;
  total_parcels: number;
  total_delivered: number;
  total_cancel: number;
  apis?: Record<string, { total_parcels, total_delivered_parcels, total_cancelled_parcels }>;
}
```

Risk level calculation:
- `total_parcels === 0` -> `"unknown"`
- Cancel rate >= 50% -> `"high"`
- Cancel rate >= 20% -> `"medium"`
- Cancel rate < 20% -> `"low"`

Default API URL: `https://fraudchecker.link/api/v1/qc/`

### Provider Registry

In-memory `Map<string, FraudCheckProvider>`. The `"default"` provider is registered on module load. Custom providers are registered via `registerFraudCheckProvider()`. Lookup falls back to `"default"` when the requested type is not found.

### Service Layer (`FraudCheckerService`)

Stores provider configurations in the `settings` table with `category = "fraud-checker"`. Each provider is a JSON blob keyed by a nanoid.

| Method | Purpose |
|--------|---------|
| `getProviders()` | List all configured providers from settings table |
| `getProvider(id)` | Get a single provider by its settings key |
| `saveProvider(provider)` | Create or update a provider config. Validates `name`, `apiUrl`, `apiKey` required. |
| `deleteProvider(id)` | Delete a provider config. Throws `NotFoundError` if missing. |
| `testProvider(id)` | Test connection by looking up a dummy phone number (`01700000000`) |
| `lookup(provider, phone)` | Look up a phone number using a specific provider's config |
| `lookupWithActiveProvider(phone)` | Look up using the first provider where `isActive === true`. Throws `NotFoundError` if none active. |

## API Endpoints

Mounted at `/api/v1/admin/fraud-checker/` on the API worker.

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| GET | `/` | `settings.fraud_checker.view` | List providers (API keys masked) |
| POST | `/` | `settings.fraud_checker.edit` | Create provider |
| PUT | `/` | `settings.fraud_checker.edit` | Update provider (preserves existing API key if masked value sent) |
| DELETE | `/{id}` | `settings.fraud_checker.edit` | Delete provider |
| POST | `/{id}/test` | `settings.fraud_checker.view` | Test provider connection |

API keys are masked as `"••••••••••••"` in all responses. On update, if the incoming `apiKey` equals the masked value, the service preserves the existing key from the database.

## Admin UI

`apps/admin/src/components/admin/FraudCheckerSettings.tsx` -- React component with provider list, create/edit form, test connection button, and delete. Communicates via `window.fraudCheckerActions` bridge (bound by the Astro page loader at `apps/admin/src/lib/client/fraud-checker-actions.ts`).

## Adding a Custom Provider

1. Create a class implementing `FraudCheckProvider` with a unique `name` and `lookup` method
2. Call `registerFraudCheckProvider(new MyProvider())` at module load time
3. Admin saves config with `providerType: "my-provider"` -- the registry auto-resolves it

## Dependencies

- `@scalius/database` -- `settings` table (category = `"fraud-checker"`)
- `@scalius/core/errors` -- `ValidationError`, `NotFoundError`, `ServiceUnavailableError`
- `nanoid` -- provider config IDs

## Known Gaps

1. **Not integrated into checkout or order flow.** The service is purely a manual admin tool. No order, checkout, or storefront code imports or calls the fraud checker. `lookupWithActiveProvider()` exists but is never called outside of the fraud checker module itself.

2. **API keys stored in plaintext.** Provider configs (including `apiKey`) are stored as plain JSON in the `settings` table. No encryption at rest. Compare with delivery provider credentials which use AES-GCM encryption.

3. **No audit trail.** Fraud check lookups are not logged. There is no history of which phone numbers were checked, when, or by whom.

4. **`db` import is module-level singleton.** `service.ts` imports `db` directly from `@scalius/database/client` (the module-level singleton), not from Hono context. This works in single-tenant but would break in multi-tenant scenarios.

5. **Test phone number is hardcoded.** `testProvider()` always uses `"01700000000"` as the test phone number. This is a Bangladesh mobile number format.
