# Fraud Checker Providers

Codex-maintained notes for the admin fraud checker integration.

## Provider Matrix

| Provider | Provider type | Required fields | Default endpoint |
|----------|---------------|-----------------|------------------|
| Custom / Legacy API | `default` | API key | `https://fraudchecker.link/api/v1/qc/` |
| FraudBD | `fraudbd` | API key, username, password | `https://fraudbd.com/api/check-courier-info` |
| FraudGuard | `fraudguard` | API key, API secret | `https://fraudguard.slope.com.bd/api/v1/fraud-check` |
| eCourier Fraud Alert | `ecourier` | API key, API secret, user ID | `https://backoffice.ecourier.com.bd/api/fraud-status-check` |

## Implementation Notes

- Provider presets live in `packages/core/src/modules/fraud-checker/provider.ts`.
- Stored settings remain in the existing `settings` table under `category = "fraud-checker"`.
- The admin UI reads provider presets and only shows the credential fields required by the selected provider.
- API responses keep the legacy order UI shape: `mobile_number`, `total_parcels`, `total_delivered`, `total_cancel`, and optional `apis`.
- Status-only providers return `provider_status`/`message` and zero totals; `riskLevel` comes from the provider status rather than fake courier counts.
- `apiKey` and `apiSecret` are masked in API list/create/update responses. Updates preserve existing masked values.

## Current Source Notes

- FraudBD public docs describe `POST /api/check-courier-info`, `phone_number` JSON body, `api_key`, `user_name`, and `password` headers, and courier summaries across Pathao, Steadfast, Paperfly, and RedX.
- FraudGuard public docs describe `POST /api/v1/fraud-check`, `phone_number` JSON body, `X-API-KEY` and `X-API-SECRET` headers, delivery rate, customer tag, and courier stats.
- eCourier's merchant API documentation includes `POST /api/fraud-status-check`, `number` JSON body, and `API-KEY`, `API-SECRET`, and `USER-ID` headers. Its response is status-based (`customer_status` and `customer_message`), not courier-count based.

## Source Links

- FraudBD API docs: https://fraudbd.com/api-documentation
- FraudGuard API docs: https://fraudguard.slope.com.bd/api-documentation
- eCourier Merchant API PDF: https://ecourier.com.bd/wp-content/uploads/eCourier_Merchant_API_Document_General_v3-7.pdf

Re-check provider docs before changing endpoint defaults or credential semantics; these external APIs can change without versioned package releases.
