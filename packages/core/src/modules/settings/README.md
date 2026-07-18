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
| `getCurrencyConfig` | `(db, kv?) => Promise<CurrencyConfig>` | Returns `CurrencyConfig { code, symbol, usdExchangeRate, decimalPlaces }` from the `settings` table (`category = "currency"`). `decimalPlaces` is derived from ISO 4217 via `getDecimalPlaces()` from `@scalius/shared/currency`. Defaults to `BDT / ??? / 1 / 2`. KV-cached at `gw:currency` (300s TTL); admin cleanup of this legacy key is best-effort so checkout/layout invalidation still runs after committed writes |
| `getSiteSettings` | `(db, kv?) => Promise<row>` | Returns the full `siteSettings` singleton row (headerConfig, footerConfig, storefrontUrl, etc.). KV-cached at `gw:site_settings` (300s TTL) |
| `invalidateSiteSettingsCache` | `(kv?) => Promise<void>` | Deletes the `gw:site_settings` KV key. Called by admin settings routes after any update to the siteSettings table |
| `invalidateStorefrontUrlCache` | `(kv?) => Promise<void>` | Deletes the separate `gw:storefront_url` KV key used by gateway URL helpers. Storefront URL saves must clear this alongside `gw:site_settings` |
| `getNotificationChannels` | `(db) => Promise<Record<string, string[]>>` | Returns notification channel preferences per order event. Normalizes both string-array format (canonical) and boolean-map format (from UI). Defaults to email-only for all 13 shared order notification types |
| `updateNotificationChannels` | `(db, input, encryptionKey?) => Promise<Record<string, string[]>>` | Saves customer notification channel preferences. Accepts both UI format (boolean maps, possibly wrapped in `{ channels }`) and canonical format (string arrays). Customer channels are limited to implemented delivery paths (`email`, `sms`, `whatsapp`): customer `push` is rejected until storefront customer push exists end to end, SMS saves require a ready active SMS provider that is not paused by provider-health, and WhatsApp saves require Meta Cloud API credentials that are not paused by provider-health. The admin UI mirrors that fail-closed rule by clearing readiness-locked SMS/WhatsApp selections on load and save instead of preserving impossible toggles. Stores via `upsertSetting()` under category `notifications`, key `order_channels` |
| `getOrderWhatsAppTemplateSettings` | `(db) => Promise<OrderWhatsAppTemplateSettings>` | Reads order WhatsApp template name/language from `settings.notifications`, defaulting to `order_status_update` / `en_US` |
| `updateOrderWhatsAppTemplateSettings` | `(db, input) => Promise<OrderWhatsAppTemplateSettings>` | Validates and saves order WhatsApp template name/language under `whatsapp_order_template_name` and `whatsapp_order_template_language` |
| `isWhatsAppCloudApiConfigured` | `(db) => Promise<boolean>` | Checks whether encrypted `settings.whatsapp/access_token` (or legacy plaintext fallback) and `site_settings.whatsapp_phone_number_id` are present before WhatsApp order channels can be enabled |

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
    refund_processing: ["email"],
    refund_failed: ["email"],
    order_refunded: ["email"],
    order_partially_refunded: ["email"],
    payment_balance_paid: ["email"],
}
```

## site-settings.service.ts

Admin-facing DB operations for site settings. Cache invalidation stays in route handlers (which have access to KV from the Hono context).

| Function | Signature | Description |
|----------|-----------|-------------|
| `getCurrencySettings` | `(db) => { currencyCode, currencySymbol, usdExchangeRate }` | Reads currency settings from `settings` table |
| `saveCurrencySettings` | `(db, data) => void` | Upserts currency settings. Validates exchange rate is positive |
| `getGeneralSettings` | `(db) => { headerConfig, footerConfig, revisions }` | Returns parsed JSON plus independent header/footer revisions from the `siteSettings` singleton |
| `saveHeaderConfig` | `(db, config, expectedRevision) => { revision }` | Validates and CAS-saves the header document; stale writers receive typed `SITE_PRESENTATION_REVISION_CONFLICT` evidence |
| `saveFooterConfig` | `(db, config, expectedRevision) => { revision }` | Validates and CAS-saves the footer document independently from the header |
| `getThemeSettings` | `(db) => { theme, revision }` | Reads the versioned semantic presentation document, upgrades a legacy flat color row, and fails closed for an invalid versioned document |
| `saveThemeSettings` | `(db, theme, expectedRevision) => { theme, revision }` | Sanitizes and CAS-publishes colors, typography, corners, density, container width, and safe component styles in the singleton theme document |
| `getSeoSettings` | `(db) => { siteTitle, homepageTitle, homepageMetaDescription, robotsTxt, discovery, returnPolicy }` | Reads SEO fields from `siteSettings` singleton, the default-on discovery policy from `settings` (`category=seo`, `key=discovery`), and merchant return-policy schema facts from `settings` (`category=seo`, `key=return_policy`). Sitemap discovery includes `staticPages`, `products`, `categories`, `collections`, and `pages`; structured-data discovery controls OnlineStore/WebSite/Product/ProductGroup/Breadcrumb/CollectionPage plus offer shipping schema. Return-policy settings stay disabled until the merchant saves complete buyer-visible facts. Admin reads must fail visibly on DB errors; routes must not return default-on settings after a failed read. |
| `saveSeoSettings` | `(db, data) => void` | Upserts SEO fields, optional discovery policy, and optional return-policy settings. Site fields only update provided values; discovery and return-policy patches are merged with stored policy and normalized before `upsertSetting()` so partial saves do not reset sibling sitemap/feed/robots/schema toggles or merchant return-policy facts |
| `getStorefrontUrlSetting` | `(db) => { storefrontUrl }` | Reads storefrontUrl from `siteSettings` |
| `saveStorefrontUrl` | `(db, url?) => void` | Upserts storefrontUrl on `siteSettings` singleton |
| `getAllowedCountries` | `(db) => { allowedCountries, allowedCountriesMode }` | Reads allowed countries. Backward-compatible: handles old format (plain array) and new format (`{ countries, mode }`) |
| `saveAllowedCountries` | `(db, countries, mode?) => { allowedCountries, allowedCountriesMode }` | Stores as JSON `{ countries: string[], mode: "include" | "exclude" }` in settings table (category=phone, key=allowed_countries) |

## Auth & Checkout Settings Routes

`apps/api/src/routes/admin/settings/system.ts` owns the admin-facing Auth & Access saves. Customer auth policy saves fail closed before writes/cache invalidation when any selected OTP channel is not deliverable:

- Email OTP requires a saved sender address plus Cloudflare `EMAIL` binding or a decryptable Resend key.
- SMS OTP requires an active supported Bangladesh SMS provider with decryptable credentials.
- WhatsApp OTP requires access token, phone number ID, and template name.

The public checkout config still exposes only the normalized policy; provider readiness details stay in admin settings endpoints and send-time checks.

## checkout-config.service.ts

### `getCheckoutConfig(db, kv?, encryptionKey?, runtimeEnv?)`

Assembles the full checkout configuration for the storefront. Returns a `CheckoutConfig` object.

Uses `Promise.all()` to fetch site settings, currency rows, the shared `getAllowedCountries()` policy, and customer-auth policy in parallel. It then evaluates delivery and required customer-sign-in readiness before resolving payment gateways. Resolves enabled payment gateways dynamically from the gateway registry after intersecting the raw merchant allowlist with provider readiness. The returned allowed-country values are storefront hints only; checkout and customer-auth services re-read and enforce the same include/exclude policy server-side.

```typescript
interface CheckoutConfig {
    gateways: Array<Record<string, unknown>>;
    guestCheckoutEnabled: boolean;
    authVerificationMethod: string;
    customerAuthPolicy: {
        otpChannels: Array<"email" | "sms" | "whatsapp">;
        requiredContactFields: Array<"email" | "phone">;
        optionalContactFields: Array<"email" | "phone">;
        defaultOtpChannel: "email" | "sms" | "whatsapp";
    };
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
- `partialPaymentEnabled` with a positive amount -- hide COD and require at least one usable online gateway

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
Stores headerConfig (JSON), footerConfig (JSON), storefrontUrl, siteTitle, homepageTitle, homepageMetaDescription, robotsTxt, the legacy customer-auth summary `authVerificationMethod`, guestCheckoutEnabled, checkoutMode, partialPaymentEnabled, partialPaymentAmount, and non-secret WhatsApp OTP fields such as phone-number ID and auth template name. The advanced customer auth policy lives in `settings.customer_auth/policy`; phone collection is always required, while OTP channels and email collection are configurable. `whatsapp_access_token` is legacy fallback only; new token saves go to encrypted `settings.whatsapp/access_token`, and legacy migration/cleanup requires a dedicated `migrationEncryptionKey` rather than the JWT-tolerant read key. Singleton enforced via `singletonKey` column with `onConflictDoUpdate`.

### `settings` (key-value store)
Generic key-value table with `category` + `key` + `value` columns. Categories used by this domain: `currency` (currency_code, currency_symbol, usd_exchange_rate), `phone` (allowed_countries -- JSON with `{ countries: string[], mode: "include" | "exclude" }`), `customer_auth` (advanced OTP channel and email collection policy), `theme` (storefront_colors), `security` (csp_allowed_domains), `seo` (`discovery` plus `return_policy` JSON settings), `email` (email_provider, email_sender, encrypted resend_api_key), `whatsapp` (encrypted Meta Cloud API access_token), `firebase` (encrypted service_account, public_config), `fraud-checker` (encrypted provider API credentials), `notifications` (order_channels, whatsapp_order_template_name, whatsapp_order_template_language), `notification_provider_health` (channel/provider pause markers for merchant-actionable provider setup failures), `stripe`, `sslcommerz`, `polar`, `payment_methods`.

SMS provider readiness is structural and local: it requires an active supported provider, decryptable required credentials, provider-required non-secret fields, and no obvious placeholder values such as `dummy`, `example`, `changeme`, `your-token-here`, or all-zero/simple numeric junk. This keeps notification and OTP settings fail-closed without issuing paid SMS test sends.

## API Endpoints (Admin)

All under `/api/v1/admin/settings/` -- split across multiple route files:

### `site.ts` -- Site-level settings
| Method | Path | Description |
|--------|------|-------------|
| GET | `/currency` | Get currency code/symbol/rate |
| POST | `/currency` | Save currency settings. Best-effort invalidates `gw:currency`, then invalidates layout and checkout cache groups |
| GET | `/general` | Get header + footer JSON configs |
| POST | `/header` | CAS-save header config (topBar, logo, favicon, contact, social, navigation) with `expectedRevision` |
| POST | `/footer` | CAS-save footer config (logo, tagline, description, copyrightText, menus, social) with `expectedRevision` |
| GET | `/theme` | Get the published semantic storefront style and revision |
| POST | `/theme` | Save storefront color overrides. Invalidates `api:storefront:layout:*` KV keys |
| GET | `/seo` | Get siteTitle, homepageTitle, homepageMetaDescription, robotsTxt, discovery policy, and merchant return-policy schema settings; fails closed on read errors |
| POST | `/seo` | Save SEO fields, nested partial discovery toggles, and top-level `returnPolicy` settings on `siteSettings/settings`; the API route invalidates homepage/layout/API caches and schedules warmups for public robots/sitemap/feed XML paths after committed saves |
| GET | `/storefront-url` | Get storefrontUrl from siteSettings |
| POST | `/storefront-url` | Save storefrontUrl. Invalidates layout cache + site settings KV |
| GET | `/allowed-countries` | Get allowed countries list and mode (include/exclude). Backward-compatible: handles old format (plain array) and new format (`{ countries, mode }`) |
| PUT | `/allowed-countries` | Save allowed countries with mode. Stores as JSON `{ countries: string[], mode: "include" | "exclude" }` in settings table (category=phone, key=allowed_countries) |
| GET | `/notification-channels` | Get notification channel preferences per order event, order WhatsApp template settings, `whatsappConfigured`/`whatsappError`, and SMS provider readiness (`smsProviderConfigured`, `smsProviderError`). Readiness is false when the active provider is paused by `notification_provider_health` after a setup failure |
| PUT | `/notification-channels` | Save customer notification channel preferences and optional order WhatsApp template settings. Normalizes channels, validates template names/language codes, rejects customer Push until implemented, rejects SMS until an active SMS provider is ready and not paused, and rejects WhatsApp until Meta credentials exist and are not paused |

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
| GET | `/auth` | Get customer verification policy and WhatsApp configuration. Masks encrypted or legacy `whatsappAccessToken`; uses tolerant reads but only migrates/clears legacy WhatsApp tokens when `CREDENTIAL_ENCRYPTION_KEY` is present |
| POST | `/auth` | Save customer verification policy and WhatsApp configuration. The strict request contract rejects checkout-flow fields, skips masked WhatsApp token values, encrypts new token values with `CREDENTIAL_ENCRYPTION_KEY`, and clears encrypted/legacy token storage when the token is set to an empty string |
| GET | `/checkout-flow` | Get guest-access, payment-flow, and advance-collection settings with the current positive monotonic revision |
| PUT | `/checkout-flow` | Replace the checkout-flow document using `expectedRevision`. A successful compare-and-swap advances the revision exactly once; stale writers receive typed `409 CHECKOUT_FLOW_REVISION_CONFLICT` with the current revision and do not overwrite the other session |
| GET | `/checkout-readiness` | Evaluate delivery readiness plus required customer sign-in provider readiness. Admin reads also inspect optional sign-in readiness so the editor can validate turning guest checkout off before saving |
| GET | `/security` | Get CSP allowed domains |
| POST | `/security` | Save storefront CSP allowed domains. Also writes to KV at `security:csp_allowed_domains`; this setting is layout/CSP-only and must not expand credentialed API CORS origins |
| GET | `/email` | Get transactional email provider settings: Cloudflare binding status, Resend key status, selected provider, and sender |
| POST | `/email` | Save selected email provider + sender. Skips masked Resend key values and encrypts new Resend keys |
| GET | `/firebase` | Get Firebase settings (masks service account) |
| POST | `/firebase` | Save Firebase service account + public config. Service-account saves validate required fields, require `CREDENTIAL_ENCRYPTION_KEY`, store encrypted `enc:` values, and invalidate `FIREBASE_CONFIG` layout cache |

### `payments.ts` -- Payment gateway settings
| Method | Path | Description |
|--------|------|-------------|
| GET | `/payment-methods` | Get raw merchant-selected methods/default, effective active methods/default, and gateway readiness (`configured`, `providerEnabled`, `checkoutSelected`, `checkoutVisible`, `usable`, `missingFields`, `blockedReason`) |
| POST | `/payment-methods` | Atomically save enabled methods + default. Validates default is in enabled list, selected gateways are checkout-usable, and the current checkout flow still has a compatible method. Invalidates checkout config/cache |
| GET | `/stripe` | Get Stripe keys (masks secret + webhook) |
| POST | `/stripe` | Save Stripe keys/provider enabled state. Rejects enabled saves until secret key, publishable key, and webhook secret are effectively present and not exact placeholder/demo values. Invalidates stripe, payment methods, and checkout config/cache |
| GET | `/sslcommerz` | Get SSLCommerz credentials (masks password) |
| POST | `/sslcommerz` | Save SSLCommerz credentials/provider enabled state. Rejects enabled saves until store ID and store password are effectively present. Invalidates sslcommerz, payment methods, and checkout config/cache |
| GET | `/polar` | Get Polar credentials (masks token + webhook) |
| POST | `/polar` | Save Polar credentials/provider enabled state. Rejects enabled saves until access token, product ID, and webhook secret are effectively present and not exact placeholder/demo values. Invalidates polar, payment methods, and checkout config/cache |

Payment gateway secret saves for Stripe, SSLCommerz, and Polar require the dedicated `CREDENTIAL_ENCRYPTION_KEY` and fail closed before settings writes or checkout-cache invalidation when that secret is missing. Runtime/readiness reads use the dedicated credential key and fail closed on missing/wrong-key ciphertext; legacy plaintext and old bare AES-GCM rows remain readable only when they do not require JWT fallback.

Stripe, SSLCommerz, and Polar checkout readiness must reject obvious exact placeholder credentials before checkout exposure or provider calls. Keep the checks narrow enough to avoid blocking legitimate provider test-mode credentials merely because they use `test` prefixes.

Provider readiness and storefront visibility are separate concepts. A gateway can be configured but provider-disabled, provider-enabled but hidden by checkout visibility, or selected for checkout but hidden by checkout-flow policy such as partial payment hiding COD. Keep admin copy and API responses explicit about those states instead of collapsing them into one "enabled" flag.

COD-only `POST /payment-methods` payloads are valid in compatible checkout flows, so admin UI must not render or save checkout visibility from fallback defaults when `GET /payment-methods` fails. Payment Gateways should keep the visibility editor locked behind a successfully loaded payment-method payload and show retry/error state instead.

Checkout Flow settings also depend on the same payment-method payload for compatibility previews. If payment-method readiness is pending or unavailable, the admin UI should mark payment flow as loading/unknown, show retry state for failed reads, and block checkout-flow saves instead of relying on backend rejection copy.

Checkout-flow composition is no longer coupled to the auth-provider write endpoint. `site_settings.checkout_flow_revision` starts at `1` for legacy rows and is the D1 authority for concurrent editor writes. The admin keeps its dirty draft when a stale save is rejected, then offers an explicit three-way merge (local changed fields win; untouched fields adopt the latest saved values) or a full replacement with the latest revision. Cache invalidation runs only after a committed CAS save.

If guest checkout is disabled, checkout readiness requires the dedicated `CREDENTIAL_ENCRYPTION_KEY` and at least one usable OTP channel allowed by the saved customer-auth policy. Email, SMS, and WhatsApp readiness reuse their strict provider readers; provider failures return only a safe aggregate checkout issue. Public `/checkout/config` fails closed before advertising payment gateways when required sign-in cannot deliver an OTP. Guest checkout still requires the buyer phone number; this readiness rule does not make phone collection optional.

WhatsApp access-token saves require the dedicated `CREDENTIAL_ENCRYPTION_KEY` and reject obvious dummy/placeholder values before storage. Runtime provider readiness and notification-channel saves pass the dedicated credential key; missing/wrong-key encrypted rows or placeholder token/phone/template values return `accessTokenConfigured=false` / not-ready instead of treating storage presence as configured. Legacy migration and legacy-column cleanup must receive `migrationEncryptionKey` from `getCredentialEncryptionKey()`; without that dedicated key, reads do not create encrypted rows and do not clear `site_settings.whatsapp_access_token`.

Firebase service-account saves require the dedicated `CREDENTIAL_ENCRYPTION_KEY` and fail closed before settings writes when that secret is missing. Runtime notification reads decrypt `enc:` rows, tolerate legacy plaintext/bare encrypted rows for migration, and never pass unreadable ciphertext to the FCM client. FCM OAuth access tokens are persisted in `SHARED_AUTH_CACHE` only as encrypted `enc:` values when the dedicated key is available; otherwise the FCM client uses per-instance memory/fresh OAuth exchange.

### `shipping.ts` -- Shipping methods CRUD
Full CRUD with soft-delete, restore, permanent delete, pagination, search, sort.

### `delivery-locations.ts` -- Delivery location management
List, create, update, soft-delete, bulk-delete, delete-all, Pathao location import (chunked).

### `delivery-providers.ts` -- Delivery provider management
List, create, update, test connection, delete. Persistent credential saves require the dedicated `CREDENTIAL_ENCRYPTION_KEY` and fail closed before DB writes/checkout cache invalidation if missing. List/get/update paths decrypt existing provider rows before masking or merging masked credential fields, including `webhookSecret`; provider runtime reads keep graceful legacy plaintext/JWT fallback only for migration.

## Checkout Config (Storefront)

The storefront checkout endpoint returns:
- `gateways` filtered by `payment_methods.enabled_methods`, each gateway's own enabled/configured state, checkout flow policy, and partial-payment policy
- `allowedCountries: string[]` -- country codes for phone validation
- `allowedCountriesMode: "include" | "exclude"` -- whether the list is allowlist or blocklist
- `currency.decimalPlaces: number` -- ISO 4217 decimal places for the configured currency
- `checkoutReadiness.customerSignInRequired` and `hasUsableCustomerSignIn` -- buyer-access readiness alongside shipping/location readiness

Storefront order creation must enforce the same effective checkout policy server-side. The API create-order route fresh-checks `guestCheckoutEnabled`, `checkoutMode`, partial-payment settings, and active payment methods before mutating orders; guest-disabled checkout requires a valid customer session whose phone matches the submitted order phone.

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
