# Settings

Central store configuration: site settings (singleton row), key-value settings, storefront URL, and currency.

## Files

- `index.ts` -- barrel re-exports everything from `settings.service.ts`
- `settings.service.ts` -- core service functions

## Service Functions

| Function | Description |
|----------|-------------|
| `getStorefrontPath(db, path, kv?)` | Builds a full storefront URL by fetching the base URL from DB, delegates to `@scalius/shared/storefront-url.buildStorefrontPath()` |
| `getStorefrontBaseUrl(db, kv?)` | Returns the storefront base URL from `siteSettings.storefrontUrl`. Falls back to `"/"`. KV-cached at `gw:storefront_url` (300s TTL) |
| `getCurrencyConfig(db, kv?)` | Returns `{ code, symbol, usdExchangeRate, decimalPlaces }` from the `settings` table (`category = "currency"`). `decimalPlaces` is derived from ISO 4217 via `getDecimalPlaces()` from `@scalius/shared/currency`. Defaults to `BDT / ৳ / 1 / 2`. KV-cached at `gw:currency` (300s TTL) |
| `getSiteSettings(db, kv?)` | Returns the full `siteSettings` singleton row (headerConfig, footerConfig, storefrontUrl, etc.). KV-cached at `gw:site_settings` (300s TTL) |
| `invalidateSiteSettingsCache(kv?)` | Deletes the `gw:site_settings` KV key. Called by admin settings routes after any update to the siteSettings table |

## Data Model

### `siteSettings` (singleton row)
Stores headerConfig (JSON), footerConfig (JSON), storefrontUrl, siteTitle, homepageTitle, homepageMetaDescription, robotsTxt, authVerificationMethod, guestCheckoutEnabled, checkoutMode, partialPaymentEnabled, partialPaymentAmount, whatsapp OTP fields.

### `settings` (key-value store)
Generic key-value table with `category` + `key` + `value` columns. Categories used by this domain: `currency` (currency_code, currency_symbol, usd_exchange_rate), `theme` (storefront_colors), `security` (csp_allowed_domains), `email` (resend_api_key, email_sender), `firebase` (service_account, public_config), `integrations` (openrouter_api_key), `stripe`, `sslcommerz`, `polar`, `payment_methods`.

## API Endpoints (Admin)

All under `/api/v1/admin/settings/` -- split across multiple route files:

### `site.ts` -- Site-level settings
| Method | Path | Description |
|--------|------|-------------|
| GET | `/currency` | Get currency code/symbol/rate |
| POST | `/currency` | Save currency settings. Invalidates `gw:currency` KV key |
| GET | `/general` | Get header + footer JSON configs |
| POST | `/header` | Save header config (topBar, logo, favicon, contact, social, navigation). Upserts siteSettings singleton |
| POST | `/footer` | Save footer config (logo, tagline, description, copyrightText, menus, social). Upserts siteSettings singleton |
| GET | `/theme` | Get storefront color overrides from `settings` (category=theme, key=storefront_colors) |
| POST | `/theme` | Save storefront color overrides. Invalidates `api:storefront:layout:*` KV keys |
| GET | `/seo` | Get siteTitle, homepageTitle, homepageMetaDescription, robotsTxt |
| POST | `/seo` | Save SEO fields on siteSettings singleton |
| GET | `/storefront-url` | Get storefrontUrl from siteSettings |
| POST | `/storefront-url` | Save storefrontUrl. Invalidates layout cache + site settings KV |

### `system.ts` -- System integrations & auth
| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth` | Get auth/checkout settings (verification method, guest checkout, checkout mode, partial payment, whatsapp config). Masks whatsappAccessToken |
| POST | `/auth` | Save auth/checkout settings. Skips masked token values |
| GET | `/security` | Get CSP allowed domains |
| POST | `/security` | Save CSP allowed domains. Also writes to KV at `security:csp_allowed_domains` |
| GET | `/email` | Get Resend email settings (masks API key) |
| POST | `/email` | Save Resend API key + sender. Skips masked values |
| GET | `/firebase` | Get Firebase settings (masks service account) |
| POST | `/firebase` | Save Firebase service account + public config. Validates JSON. Invalidates `FIREBASE_CONFIG` layout cache |

### `integrations.ts` -- Third-party integrations
| Method | Path | Description |
|--------|------|-------------|
| GET | `/openrouter` | Get OpenRouter API key status (masked) |
| POST | `/openrouter` | Save OpenRouter API key |
| GET | `/email` | Get email settings (duplicate of system.ts, same logic) |
| POST | `/email` | Save email settings (duplicate of system.ts) |
| GET | `/firebase` | Get Firebase settings (duplicate of system.ts, same logic) |
| POST | `/firebase` | Save Firebase settings (duplicate of system.ts) |

### `payments.ts` -- Payment gateway settings
| Method | Path | Description |
|--------|------|-------------|
| GET | `/payment-methods` | Get enabled methods + default + gateway status (stripe/sslcommerz/polar/cod) |
| POST | `/payment-methods` | Save enabled methods + default. Validates default is in enabled list |
| GET | `/stripe` | Get Stripe keys (masks secret + webhook) |
| POST | `/stripe` | Save Stripe keys. Invalidates stripe + payment methods KV cache |
| GET | `/sslcommerz` | Get SSLCommerz credentials (masks password) |
| POST | `/sslcommerz` | Save SSLCommerz credentials. Invalidates sslcommerz + payment methods KV cache |
| GET | `/polar` | Get Polar credentials (masks token + webhook) |
| POST | `/polar` | Save Polar credentials. Invalidates polar + payment methods KV cache |

### `shipping.ts` -- Shipping methods CRUD
Full CRUD with soft-delete, restore, permanent delete, pagination, search, sort.

### `delivery-locations.ts` -- Delivery location management
List, create, update, soft-delete, bulk-delete, delete-all, Pathao location import (chunked).

### `delivery-providers.ts` -- Delivery provider management
List, create, update, test connection, delete. Masks sensitive credential fields.

## Dependencies

- `@scalius/database` -- `siteSettings`, `settings` tables
- `@scalius/shared/storefront-url` -- URL path builder
- `@scalius/shared/layout-cache` -- in-memory layout cache
- `@scalius/core/modules/payments/gateway-settings` -- `upsertSetting()`, gateway-specific getters/invalidators
- Cloudflare KV -- optional caching layer (300s TTL for currency, storefront URL, site settings)

## Known Gaps

- `integrations.ts` duplicates the email and Firebase routes from `system.ts` (both files define GET/POST `/email` and GET/POST `/firebase`). The route that wins depends on mount order in the app.
- Hero slider admin route (`hero-sliders.ts`) imports `db` directly from `@scalius/database/client` instead of using `c.get("db")` from the Hono context.
- No validation that currencyCode is a valid ISO 4217 code on save.
