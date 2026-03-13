# Fraud Checker

Manages external fraud-checking providers and performs phone number lookups to assess customer risk (delivery history, cancellation rates).

## Exports

- `FraudCheckerService` — class for provider management and phone lookups
  - `getProviders()` / `getProvider()` / `saveProvider()` / `deleteProvider()` — CRUD
  - `testProvider()` — verify provider API connection
  - `lookup()` — check a phone number against a specific provider
  - `lookupWithActiveProvider()` — check using the first active provider
- `FraudCheckerProvider` / `FraudCheckResult` — TypeScript interfaces

## Dependencies

- `@scalius/database` — `settings` table (stores provider configs as JSON in the `fraud-checker` category)

## API Routes

- `GET /api/v1/admin/fraud-checker/providers` — list providers
- `POST /api/v1/admin/fraud-checker/lookup` — look up a phone number
