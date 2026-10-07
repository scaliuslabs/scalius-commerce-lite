# Fraud Checker

The `fraud-checker` domain looks up a buyer's courier delivery history by phone number through the fraud port. It is a manual tool on the dashboard order page: it advises the merchant and never blocks checkout or an order. It is for contributors who change the lookup or the saved checkers.

No checkout, order or payment code calls this domain. An installed app that must hold an order answers the `order.risk` function instead (`apps/api/src/plugins/order-risk.ts`).

## Entries and layer

- `index.ts` exports the service functions and the port type `FraudProvider`.
- Layer L0: the domain imports no other domain (`scripts/core-domain-graph.allow.json`). It uses `packages/core/src/integrations/provider-port.ts` for the app lookup and `integrations/retired-providers.ts` for checkers saved before the move.

## Checkers are apps

Core has no checker of its own. Every checker is an installed app's fraud provider (`<plugin id>:<provider id>`), declared in the app manifest (`providers.fraud`) and written with `defineFraudProvider` from `packages/plugin-sdk`. The Bangladesh courier-history services (FraudBD, FraudGuard, eCourier Fraud Alert and the custom fraudchecker.link API) are the Bangladesh pack's (`plugins/bangladesh`).

The API passes the app lookup in (`apps/api/src/plugins/providers/app-providers.ts`). A provider is usable only when its app is installed, active, approved for the port and runnable here, and its own settings are set and readable.

## Owns

Saved checkers are rows of the `settings` table with `category = "fraud-checker"`. The `key` is a nanoid, `type` is `json`, and `value` is the whole JSON object encrypted with `CREDENTIAL_ENCRYPTION_KEY`. A row stores `name`, `isActive` and `providerType` (the app provider). The app's own settings hold the credentials. These rows are not settings documents and register no DVC dependency.

### Rows saved before the move

A row saved before the move names a retired built-in type (`fraudbd`, `fraudguard`, `ecourier`, or none for the custom API) and holds that checker's credentials.

- It reads as the Bangladesh pack's provider, with `retired: true`.
- Until the pack is active, a lookup does not call anything and answers `unavailable` with the app's reason ("Activate Bangladesh pack in Apps to use it.").
- A save over it is refused, so its credentials are not lost.
- When the pack is activated, `apps/api/src/plugins/provider-handoff.ts` moves the credentials into the pack's settings (`readRetiredFraudCheckers`) and rewrites the row as the pack's row (`replaceRetiredFraudChecker`). The rewrite changes the row only if it is still the row that was read.

## The lookup

- `fraudLookupWithActiveProvider` uses the first active row and throws `NotFoundError` when none is active (the route answers `{ configured: false }`).
- A checker states the countries of the buyers it knows (`countries`; the Bangladesh checkers know `["BD"]`). The lookup takes the order's shipping country, else the phone's country. For another country it does not call the checker and answers `country_unsupported` (MARKETS-DESIGN step 3a).
- When the row's app cannot be used now, it does not call the checker and answers `unavailable` with the reason. The order page shows the reason and a link to the settings.
- An app's `ProviderError` message is kept (it is merchant-safe by the port's rule). Any other failure is masked as "Fraud check lookup failed".
- `testFraudProvider` uses the checker's `testConnection`. A checker without one says so.

## Routes

`apps/api/src/routes/admin/fraud-checker.ts`, mounted at `/api/v1/admin/fraud-checker`. Permissions are in `packages/core/src/auth/rbac/route-permissions/settings.ts`.

| Method and path | Permission | Notes |
|-----------------|------------|-------|
| `GET /` | `settings.fraud_checker.view` | Query `page`, `limit` (max 20). Rows carry no credential field. |
| `POST /` | `settings.fraud_checker.edit` | `{ name, isActive, providerType }`. The app must be installed. |
| `PUT /` | `settings.fraud_checker.edit` | The same with `id`. |
| `DELETE /{id}` | `settings.fraud_checker.edit` | |
| `POST /{id}/test` | `settings.fraud_checker.view` | The checker's merchant-safe message, at most 300 characters. |
| `POST /lookup` | `settings.fraud_checker.view` | Body `{ phone, countryCode? }`. Answers `configured`, `unsupportedCountry` or `unavailable` as states. |

A write calls `requireEncryptionKey()` first. A row that the key cannot read counts as unavailable.

## Rules

- Never block or change checkout, an order or a payment from a lookup result.
- Never store credentials in a row: they are the app's settings.
- Never fall back to `JWT_SECRET`.
