# Fraud Checker

Phone number fraud risk assessment via pluggable providers. Registry pattern for dynamic provider resolution.

## Files

- `index.ts` -- barrel exports
- `provider.ts` -- `FraudCheckProvider` interface, `DefaultFraudCheckProvider`, `registerFraudCheckProvider()`, `getFraudCheckProvider()`
- `service.ts` -- `FraudCheckerService` (CRUD, lookup, test connection)

## Adding a provider

1. Create class implementing `FraudCheckProvider` (name, lookup method)
2. Call `registerFraudCheckProvider(new MyProvider())` at module load
3. Admin saves config with `providerType: "my-provider"` -- auto-resolved

## Dependencies

- `@scalius/database` -- `settings` (category = "fraud-checker")
- `@scalius/core/errors` -- `ValidationError`, `NotFoundError`, `ServiceUnavailableError`
