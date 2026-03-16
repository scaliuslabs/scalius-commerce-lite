# Settings

Central store configuration: site settings, storefront URL, and currency.

## Files

- `index.ts` -- barrel exports
- `settings.service.ts` -- `getSiteSettings()`, `getStorefrontPath()`, `getStorefrontBaseUrl()`, `getCurrencyConfig()`, `CurrencyConfig`

## Dependencies

- `@scalius/database` -- `siteSettings`, `settings`
- `@scalius/shared/storefront-url` -- URL path builder
- Cloudflare KV -- optional caching layer
