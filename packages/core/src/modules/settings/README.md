# Settings

Central store configuration: site settings (singleton row), key-value settings, storefront URL, currency, notification channel preferences, checkout configuration, and admin site settings management.

## Files

- `index.ts` -- barrel re-exports everything from `settings.service.ts`, `site-settings.service.ts`, and `checkout-config.service.ts`
- `settings.service.ts` -- core service functions (storefront URL, currency, site settings, notification channels)
- `site-settings.service.ts` -- admin site settings operations (currency, header/footer, theme, SEO, storefront URL, allowed countries)
- `checkout-config.service.ts` -- public checkout configuration assembly
- `business-settings.service.ts` -- business info settings (company name, TIN, logo, address, invoice prefix/number)

## settings.service.ts

| Function | Signature | Description |
|----------|-----------|-------------|
| `getStorefrontPath` | `(db, path, kv?) => Promise<string>` | Builds a full storefront URL by fetching the base URL from DB, delegates to `@scalius/shared/storefront-url.buildStorefrontPath()` |
| `getStorefrontBaseUrl` | `(db, kv?) => Promise<string>` | Returns the storefront base URL from `siteSettings.storefrontUrl`. Falls back to `"/"`. KV-cached at `gw:storefront_url` (300s TTL) |
| `getCurrencyConfig` | `(db, kv?) => Promise<CurrencyConfig>` | Returns `CurrencyConfig { code, symbol, usdExchangeRate, decimalPlaces }` from the `settings` table (`category = "currency"`). `decimalPlaces` is derived from ISO 4217 via `getDecimalPlaces()` from `@scalius/shared/currency`. Defaults to `BDT / ??? / 1 / 2`. KV-cached at `gw:currency` (300s TTL) |
| `getSiteSettings` | `(db, kv?) => Promise<row>` | Returns the full `siteSettings` singleton row (headerConfig, footerConfig, storefrontUrl, etc.). KV-cached at `gw:site_settings` (300s TTL) |
| `invalidateSiteSettingsCache` | `(kv?) => Promise<void>` | Deletes the `gw:site_settings` KV key. Called by admin settings routes after any update to the siteSettings table |
| `getNotificationChannels` | `(db) => Promise<Record<string, string[]>>` | Returns notification channel preferences per order status. Normalizes both string-array format (canonical) and boolean-map format (from UI). Defaults to email-only for all 9 shared order notification types |
| `updateNotificationChannels` | `(db, input) => Promise<Record<string, string[]>>` | Saves notification channel preferences. Accepts both UI format (boolean maps, possibly wrapped in `{ channels }`) and canonical format (string arrays). Validates channels against known set (`email`, `sms`, `whatsapp`, `push`). Stores via `upsertSetting()` under category `notifications`, key `order_channels` |

### Default Notification Channels

```typescript
{
    order_created: ["email"],
    order_confirmed: ["email"],
    order_processing: ["email"],
    order_shipped: ["email"],
    order_delivered: ["email"],
    order_completed: ["email"],
    order_cancelled: ["email"],
    order_returned: ["email"],
    order_refunded: ["email"],
}
```

## site-settings.service.ts

Admin-facing DB operations for site settings. Cache invalidation stays in route handlers (which have access to KV from the Hono context).

| Function | Signature | Description |
|----------|-----------|-------------|
| `getCurrencySettings` | `(db) => { currencyCode, currencySymbol, usdExchangeRate }` | Reads currency settings from `settings` table |
| `saveCurrencySettings` | `(db, data) => void` | Upserts currency settings. Validates exchange rate is positive |
| `getGeneralSettings` | `(db) => { headerConfig, footerConfig }` | Returns parsed JSON from `siteSettings` singleton |
| `saveHeaderConfig` | `(db, config) => void` | Upserts headerConfig on `siteSettings` singleton (insert with `onConflictDoUpdate` on `singletonKey`) |
| `saveFooterConfig` | `(db, config) => void` | Upserts footerConfig on `siteSettings` singleton |
| `getThemeSettings` | `(db) => { colors }` | Reads storefront color overrides from `settings` (category=theme, key=storefront_colors) |
| `saveThemeSettings` | `(db, colors) => void` | Saves storefront color overrides via `upsertSetting()` |
| `getSeoSettings` | `(db) => { siteTitle, homepageTitle, homepageMetaDescription, robotsTxt }` | Reads SEO fields from `siteSettings` singleton |
| `saveSeoSettings` | `(db, data) => void` | Upserts SEO fields. Only updates provided fields (undefined values are skipped to avoid NULLing existing data) |
| `getStorefrontUrlSetting` | `(db) => { storefrontUrl }` | Reads storefrontUrl from `siteSettings` |
| `saveStorefrontUrl` | `(db, url?) => void` | Upserts storefrontUrl on `siteSettings` singleton |
| `getAllowedCountries` | `(db) => { allowedCountries, allowedCountriesMode }` | Reads allowed countries. Backward-compatible: handles old format (plain array) and new format (`{ countries, mode }`) |
| `saveAllowedCountries` | `(db, countries, mode?) => { allowedCountries, allowedCountriesMode }` | Stores as JSON `{ countries: string[], mode: "include" | "exclude" }` in settings table (category=phone, key=allowed_countries) |

## checkout-config.service.ts

### `getCheckoutConfig(db, kv?, encryptionKey?)`

Assembles the full checkout configuration for the storefront. Returns a `CheckoutConfig` object.

Uses `Promise.all()` to fetch site settings, currency rows, and allowed countries in parallel. Resolves enabled payment gateways dynamically from the gateway registry.

```typescript
interface CheckoutConfig {
    gateways: Array<Record<string, unknown>>;
    guestCheckoutEnabled: boolean;
    authVerificationMethod: string;
    checkoutMode: string;
    partialPaymentEnabled: boolean;
    partialPaymentAmount: number;
    allowedCountries: string[];
    allowedCountriesMode: "include" | "exclude";
    currency: {
        code: string;
        symbol: string;
        decimalPlaces: number;
    };
}
```

**Gateway filtering by `checkoutMode`:**
- `all` -- show all enabled gateways
- `gateways_only` -- hide COD
- `guest_cod_only` -- hide online gateways (Stripe, SSLCommerz, Polar)

## CurrencyConfig Type

```typescript
interface CurrencyConfig {
    code: string;          // ISO 4217 code (e.g. "BDT", "USD", "JPY")
    symbol: string;        // Display symbol (e.g. "???", "$", "??")
    usdExchangeRate: number; // How many units equal 1 USD
    decimalPlaces: number; // ISO 4217 decimal places (0, 2, or 3)
}
```

`decimalPlaces` is computed from the currency code by `getDecimalPlaces()` in `@scalius/shared/currency`, which uses an ISO 4217 lookup table. Most currencies use 2, zero-decimal currencies (JPY, KRW, VND, etc.) use 0, and 3-decimal currencies (KWD, BHD, OMR, etc.) use 3.

## Currency Formatting Stack

```
@scalius/shared/currency.ts              -- formatPrice(), formatPriceShort(), getDecimalPlaces(), getCurrencySymbol(), getCurrencyCode()
@scalius/shared/price-utils.ts           -- roundPrice(), addPrices(), subtractPrice(), calculatePercentageDiscount()
@scalius/core/modules/settings           -- getCurrencyConfig() (DB + KV cache)
apps/admin-v2/src/hooks/useCurrency.ts      -- React hook that fetches config and delegates to shared formatPrice()
```

- `currency.js` library powers all price formatting with precision arithmetic
- `formatPrice(price, opts?)` reads symbol/code from window globals (storefront) or passed options (admin). Uses `getDecimalPlaces()` to determine precision per currency code
- `formatPriceShort()` strips trailing zeros for whole numbers
- `useCurrency()` hook in admin fetches from API, caches in localStorage, delegates to `formatPrice()` from `@scalius/shared/currency`

## Data Model

### `siteSettings` (singleton row)
Stores headerConfig (JSON), footerConfig (JSON), storefrontUrl, siteTitle, homepageTitle, homepageMetaDescription, robotsTxt, authVerificationMethod, guestCheckoutEnabled, checkoutMode, partialPaymentEnabled, partialPaymentAmount, whatsapp OTP fields. Singleton enforced via `singletonKey` column with `onConflictDoUpdate`.

### `settings` (key-value store)
Generic key-value table with `category` + `key` + `value` columns. Categories used by this domain: `currency` (currency_code, currency_symbol, usd_exchange_rate), `phone` (allowed_countries -- JSON with `{ countries: string[], mode: "include" | "exclude" }`), `theme` (storefront_colors), `security` (csp_allowed_domains), `email` (email_provider, email_sender, encrypted resend_api_key), `firebase` (service_account, public_config), `ai` (widget AI providers, prompts, encrypted provider keys), `notifications` (order_channels), `stripe`, `sslcommerz`, `polar`, `payment_methods`.

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
| GET | `/allowed-countries` | Get allowed countries list and mode (include/exclude). Backward-compatible: handles old format (plain array) and new format (`{ countries, mode }`) |
| PUT | `/allowed-countries` | Save allowed countries with mode. Stores as JSON `{ countries: string[], mode: "include" | "exclude" }` in settings table (category=phone, key=allowed_countries) |
| GET | `/notification-channels` | Get notification channel preferences per order status |
| POST | `/notification-channels` | Save notification channel preferences. Normalizes and validates channels |

### `business.ts` -- Business info & invoice settings
| Method | Path | Description |
|--------|------|-------------|
| GET | `/business` | Get business info (company name, TIN, logo, address, invoice prefix) |
| POST | `/business` | Save business info settings |

### `sms.ts` -- SMS provider settings
| Method | Path | Description |
|--------|------|-------------|
| GET | `/sms` | Get SMS provider settings with masked credentials |
| POST | `/sms` | Save SMS provider settings (encrypted where needed) |

### `system.ts` -- System integrations & auth
| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth` | Get auth/checkout settings (verification method, guest checkout, checkout mode, partial payment, whatsapp config). Masks whatsappAccessToken |
| POST | `/auth` | Save auth/checkout settings. Skips masked token values |
| GET | `/security` | Get CSP allowed domains |
| POST | `/security` | Save CSP allowed domains. Also writes to KV at `security:csp_allowed_domains` |
| GET | `/email` | Get transactional email provider settings: Cloudflare binding status, Resend key status, selected provider, and sender |
| POST | `/email` | Save selected email provider + sender. Skips masked Resend key values and encrypts new Resend keys |
| GET | `/firebase` | Get Firebase settings (masks service account) |
| POST | `/firebase` | Save Firebase service account + public config. Validates JSON. Invalidates `FIREBASE_CONFIG` layout cache |

### `ai.ts` -- Widget AI providers and prompts
| Method | Path | Description |
|--------|------|-------------|
| GET | `/widget-ai` | Get provider, model, prompt, and masked credential status |
| POST | `/widget-ai` | Save provider config, local system prompts, and encrypted provider keys |

### `payments.ts` -- Payment gateway settings
| Method | Path | Description |
|--------|------|-------------|
| GET | `/payment-methods` | Get enabled methods + default + gateway status (stripe/sslcommerz/polar/cod) |
| POST | `/payment-methods` | Save enabled methods + default. Validates default is in enabled list. Invalidates checkout config/cache |
| GET | `/stripe` | Get Stripe keys (masks secret + webhook) |
| POST | `/stripe` | Save Stripe keys. Invalidates stripe, payment methods, and checkout config/cache |
| GET | `/sslcommerz` | Get SSLCommerz credentials (masks password) |
| POST | `/sslcommerz` | Save SSLCommerz credentials. Invalidates sslcommerz, payment methods, and checkout config/cache |
| GET | `/polar` | Get Polar credentials (masks token + webhook) |
| POST | `/polar` | Save Polar credentials. Invalidates polar, payment methods, and checkout config/cache |

### `shipping.ts` -- Shipping methods CRUD
Full CRUD with soft-delete, restore, permanent delete, pagination, search, sort.

### `delivery-locations.ts` -- Delivery location management
List, create, update, soft-delete, bulk-delete, delete-all, Pathao location import (chunked).

### `delivery-providers.ts` -- Delivery provider management
List, create, update, test connection, delete. Masks sensitive credential fields.

## Checkout Config (Storefront)

The storefront checkout endpoint returns:
- `gateways` filtered by `payment_methods.enabled_methods`, each gateway's own enabled/configured state, and `checkoutMode`
- `allowedCountries: string[]` -- country codes for phone validation
- `allowedCountriesMode: "include" | "exclude"` -- whether the list is allowlist or blocklist
- `currency.decimalPlaces: number` -- ISO 4217 decimal places for the configured currency

## Dependencies

- `@scalius/database` -- `siteSettings`, `settings` tables
- `@scalius/shared/storefront-url` -- URL path builder
- `@scalius/shared/currency` -- `getDecimalPlaces()` for ISO 4217 lookup
- `@scalius/shared/layout-cache` -- in-memory layout cache
- `@scalius/core/modules/payments/gateway-settings` -- `upsertSetting()`, gateway-specific getters/invalidators
- `@scalius/core/modules/payments/gateway-registry` -- `getRegisteredGateways()` for dynamic checkout config
- Cloudflare KV -- optional caching layer (300s TTL for currency, storefront URL, site settings)

## Known Gaps

- Hero slider admin route (`hero-sliders.ts`) imports `db` directly from `@scalius/database/client` instead of using `c.get("db")` from the Hono context.
- No validation that currencyCode is a valid ISO 4217 code on save.
