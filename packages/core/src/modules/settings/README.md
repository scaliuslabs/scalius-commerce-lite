# Settings

Central service for store configuration: site settings, storefront URL, and currency.

## Exports

- `getSiteSettings()` — full site settings row (header config, footer config, storefront URL, etc.)
- `getStorefrontPath()` — build a full storefront URL from a path (with DB lookup + optional KV cache)
- `getStorefrontBaseUrl()` — storefront base URL with KV caching
- `getCurrencyConfig()` — currency code, symbol, and USD exchange rate (with KV caching)
- `CurrencyConfig` — TypeScript interface

## Dependencies

- `@scalius/database` — `siteSettings`, `settings` tables
- `@scalius/shared/storefront-url` — URL path builder
- Cloudflare KV — optional caching layer

## API Routes

- `GET /api/v1/admin/seo` — get site settings
- `PUT /api/v1/admin/seo` — update site settings
