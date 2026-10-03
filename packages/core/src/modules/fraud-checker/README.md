# Fraud Checker

The `fraud-checker` domain looks up a buyer's courier delivery history by phone number through the fraud port. It is a manual tool on the dashboard order page: it advises the merchant and never blocks checkout or an order. It is for contributors who add or change a checker.

No checkout, order or payment code calls this domain. An installed app that must hold an order answers the `order.risk` function instead (`apps/api/src/plugins/order-risk.ts`).

## Entries and layer

- `index.ts` exports the service functions, the port types, `builtInFraudChecker()` and the four built-in checkers. It re-exports `browser.ts`.
- `browser.ts` holds `provider-definitions.ts` (`FRAUD_CHECK_PROVIDER_DEFINITIONS`). The dashboard uses it to show the right credential fields.

Layer L0: the domain imports no other domain (`scripts/core-domain-graph.allow.json`). It uses `packages/core/src/integrations/provider-port.ts` for the port binding.

## Owns

Saved checkers are rows of the `settings` table with `category = "fraud-checker"`. The `key` is a nanoid, `type` is `json`, and `value` is the whole JSON object encrypted with `CREDENTIAL_ENCRYPTION_KEY`. These rows are not settings documents: the domain does not call `defineSettingsDocument()` and registers no DVC dependency.

## The port

Every checker is one `FraudProvider` (`BoundProvider<"fraud">`). `check({ phone })` returns a `FraudCheck`. `testConnection` is optional. The lookup does not tell a built-in checker from an app's.

| Type | Adapter | Auth | Body |
|------|---------|------|------|
| `default` | `defaultFraudChecker` | `Authorization: Bearer <apiKey>` | `FormData` field `phone` |
| `fraudbd` | `fraudBdChecker` | `api_key`, `user_name`, `password` headers | JSON `{ phone_number }` |
| `fraudguard` | `fraudGuardChecker` | `X-API-KEY`, `X-API-SECRET` headers | JSON `{ phone_number }` |
| `ecourier` | `eCourierFraudChecker` | `API-KEY`, `API-SECRET`, `USER-ID` headers | JSON `{ number }` |

- Each request is a `POST` to the row's `apiUrl` with a 10-second timeout. The phone goes out in local format.
- Three checkers return totals and per-courier counts. The `ecourier` checker is status-only: it returns zero totals plus `providerStatus` and `message`.
- `builtInFraudChecker(type)` treats an empty type as `default` and throws on an unknown type.
- A built-in `testConnection` looks up `+8801700000000`.

Risk level: the provider status (or customer tag) decides first, matched by whole words.

| Status words | Level |
|--------------|-------|
| warning, fraud, blacklist(ed), blocked, high, risky, bad, danger | `high` |
| medium, moderate, suspicious, caution, watch | `medium` |
| verified, good, excellent, safe, clear, new customer, low | `low` |

With no matching status: 0 parcels gives `unknown`; a cancel rate of 50% or more gives `high`; 20% or more gives `medium`; less gives `low`.

### App checkers

A row whose `providerType` is `<plugin id>:<provider id>` names an installed app's fraud provider. The row stores only `name`, `isActive` and `providerType`; the app's own settings hold the credentials.

The API passes the app lookup in (`apps/api/src/plugins/providers/app-providers.ts`). The lookup fails closed with `ServiceUnavailableError` when the app is not installed, active, approved for the port or runnable, or when its settings are incomplete. A built-in checker's error is masked as "Fraud check lookup failed"; an app's `ProviderError` message is kept.

## Service functions

The service functions (list, get, save, delete, test, lookup) are in `index.ts`.

- A list skips rows that fail to decrypt or parse. `getFraudProvider` returns `null` for a missing or unreadable row.
- `saveFraudProvider` needs `name`, a public HTTPS `apiUrl` and the preset's credentials for a built-in checker.
- `fraudLookupWithActiveProvider` uses the first active checker and throws `NotFoundError` when none is active.
- A checker states the countries of the buyers it knows (`countries`: `"any"` or ISO codes; the built-in checkers know `["BD"]`). The lookup takes the order's shipping country (else the phone's country). For a country the checker does not know, it does not call the checker and returns `{ status: "country_unsupported", provider, countryCode }`; the route answers `unsupportedCountry` and the order page says so (MARKETS-DESIGN step 3a).
- `getFraudProviderUrlIssue()` allows only an absolute public HTTPS URL: no credentials, port other than 443, query, fragment, `localhost`, `.local`, `.internal`, IP address or hostname without a dot.

## Routes

`apps/api/src/routes/admin/fraud-checker.ts`, mounted at `/api/v1/admin/fraud-checker`. Permissions are in `packages/core/src/auth/rbac/route-permissions/settings.ts`.

| Method and path | Permission | Notes |
|-----------------|------------|-------|
| `GET /` | `settings.fraud_checker.view` | Query `page`, `limit` (max 20). Credentials are masked. |
| `POST /` | `settings.fraud_checker.edit` | Built-in checker (type default `default`) or app checker. An app checker must be installed. |
| `PUT /` | `settings.fraud_checker.edit` | `id` in the body. A masked credential is restored from the saved row, or the write fails. |
| `DELETE /{id}` | `settings.fraud_checker.edit` | |
| `POST /{id}/test` | `settings.fraud_checker.view` | The message is only "Connection successful" or "Connection failed". |
| `POST /lookup` | `settings.fraud_checker.view` | Body `{ phone }`. Answers `{ configured: false }` when no checker is active. |

A write calls `requireEncryptionKey()` first. A row that the key cannot read counts as unavailable, and a lookup fails before it calls an outside API.

## Rules

- Never block or change checkout, an order or a payment from a lookup result.
- Never store credentials unencrypted or fall back to `JWT_SECRET`. A stored value that is not encrypted still reads, so rows written before encryption keep working.
- Never save a masked placeholder as a credential.

## Add a checker

- An app: declare `providers.fraud` in the app manifest and implement it with `defineFraudProvider` in `packages/plugin-sdk`.
- A built-in one: add a `FraudAdapter` in `provider.ts`, an entry in `BUILT_IN_FRAUD_CHECKERS` and a preset in `FRAUD_CHECK_PROVIDER_DEFINITIONS`.
