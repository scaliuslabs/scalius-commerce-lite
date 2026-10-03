# Fraud Checker

Phone number fraud risk assessment through the fraud port (`@scalius/shared/plugins/providers/fraud`). Admin-only manual lookup tool on the order page: advice for the merchant, NOT integrated into the checkout or order pipeline (an app that must hold fulfilment answers the `order.risk` function instead).

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports: service functions, the port types, the built-in checkers |
| `fraud-checker.service.ts` | Saved checkers (CRUD), the phone lookup and the connection test through the port |
| `provider.ts` | The built-in checkers as fraud port adapters (`FraudAdapter`), response normalization and risk levels |
| `provider-definitions.ts` | Browser-safe presets: credential fields and labels of each built-in checker |

## The port

Every checker, built in or an installed app's, is one `FraudProvider` (`BoundProvider<"fraud">`, `integrations/provider-port.ts`): `check({ phone })` answers the port's `FraudCheck` (`riskLevel`, `phone`, `totalParcels`, `delivered`, `cancelled`, optional rates, `customerTag`, `providerStatus`, `message`, `couriers`), and `testConnection` when it has one. The lookup never asks which kind it got.

### Built-in checkers

Credential presets live in `FRAUD_CHECK_PROVIDER_DEFINITIONS`, which the dashboard also uses to show the right fields.

| Provider type | Adapter | Auth | Request |
|---------------|---------|------|---------|
| `default` | `defaultFraudChecker` | `Authorization: Bearer <apiKey>` | `FormData(phone)` |
| `fraudbd` | `fraudBdChecker` | `api_key` + `user_name` + `password` headers | JSON `{ phone_number }` |
| `fraudguard` | `fraudGuardChecker` | `X-API-KEY` + `X-API-SECRET` headers | JSON `{ phone_number }` |
| `ecourier` | `eCourierFraudChecker` | `API-KEY` + `API-SECRET` + `USER-ID` headers | JSON `{ number }` |

Courier-stat providers normalize their responses into the port's totals and per-courier `couriers`; status-only providers (eCourier Fraud Alert) answer zero totals plus `providerStatus`/`message`, and the status drives `riskLevel`. `builtInFraudChecker(type)` resolves an empty type to `default` and throws on an unknown one, so misconfiguration is visible. A built-in checker's `testConnection` looks up `+8801700000000`.

Risk level calculation:
- Provider status containing warning/fraud/blacklist/blocked/high/risky/bad/danger -> `"high"`
- Provider status containing medium/moderate/suspicious/caution/watch -> `"medium"`
- Provider status containing verified/good/excellent/safe/clear/new customer/low -> `"low"`
- `totalParcels === 0` -> `"unknown"`
- Cancel rate >= 50% -> `"high"`
- Cancel rate >= 20% -> `"medium"`
- Cancel rate < 20% -> `"low"`

### App checkers

A row whose `providerType` is `<plugin id>:<provider id>` names an installed app's fraud provider; its credentials live in the app's settings (encrypted). The lookup reaches it only through the `AppProviders` lookup the API passes (`apps/api/src/plugins/providers/app-providers.ts`), and fails closed (`ServiceUnavailableError` with the merchant-facing reason) when the app is not installed, active, approved for the port, runnable here, or its settings are incomplete or unreadable. The app's `ProviderError` message is shown; a built-in checker's error is masked.

## Service Functions (`fraud-checker.service.ts`)

Stores checkers in the `settings` table with `category = "fraud-checker"`. Each is keyed by a nanoid; new writes encrypt the JSON blob with `CREDENTIAL_ENCRYPTION_KEY`, while read paths keep legacy plaintext tolerance without falling back to `JWT_SECRET`.

| Function | Signature | Notes |
|----------|-----------|-------|
| `getFraudProviders` | `(db, encryptionKey?)` | List all saved checkers. Decrypts when needed, filters out parse failures. |
| `getFraudProvider` | `(db, id, encryptionKey?)` | One saved checker; null if missing or unreadable. |
| `saveFraudProvider` | `(db, provider, encryptionKey)` | Create or update. Requires `CREDENTIAL_ENCRYPTION_KEY`. A built-in checker needs `name`, a public HTTPS `apiUrl` and its preset's credentials; an app checker stores its name, `isActive` and `providerType` only (the route checks that an installed app declares it). |
| `deleteFraudProvider` | `(db, id)` | Hard-delete. Throws `NotFoundError` if missing. |
| `testFraudProvider` | `(db, id, encryptionKey?, apps?)` | The checker's `testConnection`, else a lookup of a test number. |
| `fraudLookup` | `(row, phone, apps?)` | One checker's lookup through the port. |
| `fraudLookupWithActiveProvider` | `(db, phone, encryptionKey?, apps?)` | The first active checker's lookup. Throws `NotFoundError` if none is active. |

Admin create/update routes call `requireEncryptionKey()` before saving and mask `apiKey`/`apiSecret` in responses. Encrypted rows that cannot be read with `CREDENTIAL_ENCRYPTION_KEY` are treated as unavailable, masked placeholders are never saved back as credentials, and lookups fail closed before external fraud APIs are called. Legacy plaintext rows remain readable for migration.

## Adding a Checker

Ship it as an app provider (`providers.fraud` in the manifest, `defineFraudProvider` in the SDK). A new built-in one is a `FraudAdapter` in `provider.ts`, an entry in `BUILT_IN_FRAUD_CHECKERS` and a preset in `FRAUD_CHECK_PROVIDER_DEFINITIONS`.

## Dependencies

- `@scalius/database` -- `settings` table (`category = "fraud-checker"`)
- `@scalius/core/errors` -- `ValidationError`, `NotFoundError`, `ServiceUnavailableError`
- `@scalius/shared/customer-utils` -- `formatPhoneForProvider()`
- `@scalius/shared/plugins/providers` -- the fraud port
- `nanoid` -- checker IDs
