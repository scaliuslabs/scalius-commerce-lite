# Fraud Checker Providers

Codex-maintained notes for the admin fraud checker integration.

## Provider Matrix

| Provider | Provider type | Required fields | Default endpoint |
|----------|---------------|-----------------|------------------|
| Custom / Legacy API | `default` | API key | `https://fraudchecker.link/api/v1/qc/` |
| FraudBD | `fraudbd` | API key | `https://api.fraudbd.com/api/check-courier-info` |
| FraudGuard | `fraudguard` | API key, API secret | `https://fraudguard.slope.com.bd/api/v1/fraud-check` |
| eCourier Fraud Alert | `ecourier` | API key, API secret, user ID | `https://backoffice.ecourier.com.bd/api/fraud-status-check` |

## Implementation Notes

- Provider presets live in `packages/core/src/modules/fraud-checker/provider.ts`.
- Stored settings remain in the existing `settings` table under `category = "fraud-checker"`.
- The admin UI reads provider presets and only shows the credential fields required by the selected provider.
- API responses keep the legacy order UI shape: `mobile_number`, `total_parcels`, `total_delivered`, `total_cancel`, and optional `apis`.
- `apiKey` and `apiSecret` are masked in API list/create/update responses. Updates preserve existing masked values.

## Current Source Notes

- FraudBD has public API documentation with a courier-info check endpoint and sandbox examples.
- FraudGuard public docs describe key/secret based fraud-check calls.
- eCourier's merchant API documentation includes a fraud-alert status check endpoint with `API-KEY`, `API-SECRET`, and `USER-ID` headers.

Re-check provider docs before changing endpoint defaults or credential semantics; these external APIs can change without versioned package releases.
