# Settings

Store configuration as typed settings documents: one `settings` row per
document, one generic read, one generic write. Area services (platform,
currency, presentation, SEO, checkout flow, business, notifications) are thin
wrappers over the documents.

## Files

- `settings-store.ts` -- `defineSettingsDocument()` and `selectSettingsDocuments()`: the only code that reads or writes document rows
- `documents.ts` -- every document definition (key, zod schema, defaults, secret fields, optional KV mirror)
- `../platform/platform-settings.service.ts` (the platform domain) -- deployment public origins (storefront/API/dashboard/media URLs, customer cookie domain, extra CORS origins) and their KV-first Worker-entry resolution
- `site-settings.service.ts` -- currency, header/footer/homepage presentation (CAS), published theme/draft workflow, media delivery, SEO, storefront URL, allowed countries
- `settings.service.ts` -- `getCurrencyConfig()` and notification channel preferences
- `business-settings.service.ts`, `customer-request-policy.ts`, `checkout-flow-admin.service.ts` -- one document each
- `checkout-config.service.ts` / `checkout-readiness.ts` -- public checkout configuration and readiness (one batched document read)

## Settings documents

A document is `settings(category = <document key>, key = 'document', type = 'json', value = <JSON>, revision)`.

- **Read** (`read`, `readDetailed`, `fromRows` for batched reads): the stored JSON is merged over the defaults and validated. Missing row → defaults (`stored: false`, `revision: 0`). Invalid JSON/schema → defaults with a masked warning. Relational read errors propagate so callers fail closed.
- **Secrets** (`secretFields`): stored as `enc:` ciphertext encrypted with `CREDENTIAL_ENCRYPTION_KEY`. Reads decrypt strictly with that key; unreadable ciphertext or an obvious placeholder (`isPlaceholderSecret`) reads as the default (not configured) and is reported in `secretErrors` / `secretsConfigured`. A write that leaves a secret field untouched carries its ciphertext verbatim, so non-secret edits never need the key. Secrets are never logged or returned; routes mask them.
- **Write**: validates the patched (or `replace`d) document, compare-and-swaps on the revision it read, and advances the revision by one. Every merchant editor sends the revision it loaded (`expectedRevision`); a stale one throws `SettingsRevisionConflictError` (409 `SETTINGS_REVISION_CONFLICT`, details `{ document, expectedRevision, currentRevision }`). Internal plain patches retry a lost race. `writeSettingsDocuments()` commits several documents all-or-nothing; a revision guard leads the batch, so a stale write also rolls back `before`/`after` statements (media guards, provider-health clears).
- **Admin contract**: every settings GET returns `revision` in `data` (0 = never saved; `/auth` returns one per document it edits), every save requires `expectedRevision` and answers with the new `revision`.
- **KV mirror** (`cacheKey`, non-secret documents only): `readCached` is KV-first; `writeCached`/`write(..., { kv })` writes through. Used by `platform` (`settings:platform`) and `security` (`settings:security`).
- **Checkout authority**: the existing `settings_checkout_authority_*` triggers advance `checkout_authority.revision` on every document insert, change, or delete, so in-flight checkouts are fenced against any settings change.

| Document | Contents | Secrets |
|----------|----------|---------|
| `platform` | `storefrontUrl`, `apiUrl`, `dashboardUrl`, `mediaUrl`, `customerAuthCookieDomain`, `corsAllowedOrigins`, `setupTokenRequired` | -- |
| `security` | `cspAllowedDomains` | -- |
| `media` | image optimization / delivery hosts | -- |
| `business` | company, TIN, logo, address, invoice prefix/logo | -- |
| `currency` | `currencyCode`, `currencySymbol`, `usdExchangeRate` | -- |
| `customer_countries` | `allowedCountries`, `allowedCountriesMode` | -- |
| `checkout` | `guestCheckoutEnabled`, `checkoutMode`, `partialPaymentEnabled`, `partialPaymentAmount` (admin CAS revision) | -- |
| `customer_auth` | Customer accounts: `email` / `whatsapp` collection and code `channels` (any other shape resets to defaults) | -- |
| `customer_requests` | buyer self-service request policy | -- |
| `header` / `footer` / `homepage` | storefront presentation (independent CAS revisions) | -- |
| `seo` | titles, meta description, robots, `discovery`, `returnPolicy` | -- |
| `notifications` | customer/admin order channels, order WhatsApp template | -- |
| `email` | `provider`, `sender` | `resendApiKey` |
| `firebase` | `publicConfig` | `serviceAccount` |
| `whatsapp` | `phoneNumberId`, `authTemplateName` | `accessToken` |
| `sms` | active provider + provider fields | provider tokens/API keys |
| `stripe` / `sslcommerz` | provider fields, `enabled`, `sandbox` | secret key, webhook secret / store password |
| `payment_methods` | `enabledMethods` (`null` = COD implied), `defaultMethod` | -- |
| `meta_conversions` | `pixelId`, `testEventCode`, `isEnabled`, `logRetentionDays` | `accessToken` |

Not documents, on purpose: the published theme and theme drafts (their own
draft/publish tables), tax settings (tax module), and collections such as
checkout languages, analytics scripts, shipping methods, delivery
providers/locations, hero sliders, navigation menus, and fraud-checker provider
rows. `notification_provider_health` rows are operational pause markers in the
same table, not settings.

Phone collection is not a setting: checkout and customer identity always
require it.

## Platform origins

`env.STOREFRONT_URL` and the other public origins are resolved at Worker entry
by `resolvePlatformConfig()` (KV mirror first, then the `platform` document; a
DB failure resolves the empty configuration so callers fail closed).
`savePlatformSettings(db, patch, kv?, { expectedRevision }?)` validates every field before writing
(`storefrontUrl` is required and normalized to one HTTPS origin, HTTP loopback
only for local development) and writes the KV mirror through.

Admin API: `GET`/`PUT /api/v1/admin/settings/platform` (adds `readiness` and
`effective`). Public API: `GET /api/v1/platform` returns only the four origins
with a 60s `Cache-Control`; the storefront gets them in the `platform` block of
`GET /api/v1/storefront/layout`.

## Currency

`getCurrencyConfig(db)` returns `{ code, symbol, usdExchangeRate, decimalPlaces }`
from the `currency` document; `decimalPlaces` comes from ISO 4217 via
`getDecimalPlaces()` in `@scalius/shared/currency`. A missing document yields
the BDT defaults; a relational read error throws. Catalog, shipping and order
amounts are stored as integer minor units of this currency, so once any product,
shipping method or order exists the code is locked (`isCurrencyCodeLocked`).

## Notification channels

`getNotificationChannels` / `updateNotificationChannels` and the admin
equivalents read and write the `notifications` document. Customer channels are
limited to implemented delivery paths (`email`, `sms`, `whatsapp`); SMS and
WhatsApp saves require a ready provider that is not paused by
`notification_provider_health`. Every order event defaults to `["email"]`.

## Admin routes (`apps/api/src/routes/admin/settings/`)

- `site.ts` -- currency, header/footer (`expectedRevision` CAS), homepage (CAS + media guard), theme draft/publish, SEO (partial discovery/return-policy patches), storefront URL, allowed countries, notification channels. Saves bump the cache generation after commit.
- `system.ts` -- customer auth + WhatsApp (policy saves fail closed unless every selected OTP channel is deliverable; WhatsApp token saves require `CREDENTIAL_ENCRYPTION_KEY`, reject placeholders, skip masked values, and clear WhatsApp provider pauses in the same batch), checkout flow (`expectedRevision` CAS, revision `0` before the first save), checkout readiness, security (CSP only; never widens API CORS), email, Firebase.
- `payments.ts` -- payment methods, Stripe, SSLCommerz. Secret saves require `CREDENTIAL_ENCRYPTION_KEY`; enabled saves require non-placeholder credentials.
- `meta-conversions-admin.ts` -- Meta CAPI settings; a save clears the `meta-capi:browser-events:circuit` KV marker.
- `business.ts`, `sms.ts`, `platform.ts`.

## Checkout configuration

`getCheckoutConfig()` reads the `checkout`, `currency`, `customer_auth`, and
`customer_countries` documents in one batch, evaluates delivery and required
sign-in readiness, then intersects the merchant payment allowlist with provider
readiness and checkout-flow policy (`guest_cod_only` hides online gateways,
`gateways_only` and partial payment hide COD). If settings cannot be read it
fails closed; it never guesses COD or a gateway. Order creation re-checks the
same policy through the checkout authority snapshot.
