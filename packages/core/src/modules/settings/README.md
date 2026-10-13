# Settings

Store configuration as typed settings documents: one `settings` row per
document, one generic read, one generic write. Area services (platform,
currency, presentation, SEO, checkout flow, business, notifications) are thin
wrappers over the documents.

## Files

- `@scalius/core/settings-store` (`packages/core/src/settings-store/`, infrastructure, not a domain) -- `defineSettingsDocument()` and `selectSettingsDocuments()`: the only code that reads or writes document rows. It imports no domain, so any domain can own a document without depending on `settings`
- `documents.ts` -- the shared document definitions (key, zod schema, defaults, secret fields, optional per-colo mirror); a domain that owns a document declares it itself (`platform/document.ts`, `notifications/documents.ts`, `delivery/zones.ts`, `products/low-stock-policy.ts`)
- `staff-shortcuts.ts` -- one per-staff-member document (`staff-shortcuts:<userId>`, no KV, no secrets) for dashboard keyboard shortcuts; saves replace the whole map; the row is deleted with staff removal and invitation revocation
- `../platform/` (the platform domain owns the `platform` document and its service) -- deployment public origins (storefront/API/dashboard/media URLs, customer cookie domain, extra CORS origins) and their mirror-first Worker-entry resolution
- `site-settings.service.ts` -- currency (code, symbol), the theme (live, draft, versions, preview sessions), media delivery, SEO, allowed countries
- `settings.service.ts` -- `getCurrencyConfig()`
- `store-money.ts` -- code-only money helpers: `StoreCurrency`, `toStoreMinor()`, `orderPricePolicy()`, `priceIncrementForCurrency()` and the SQL currency code. The store pricing currency (`readStoreCurrency()`) and the SQL twin of its price increment (`storePriceIncrementSql()`) are in the `markets` domain, because the backup market holds the increment
- `business-settings.service.ts`, `customer-request-policy.ts` -- one document each
- Readiness is not here: checkout readiness lives in `checkout/readiness.ts`, customer sign-in readiness in `customers/sign-in-readiness.ts`, and their shared shapes and codes in `@scalius/shared/checkout-readiness`

## Settings documents

A document is `settings(category = <document key>, key = 'document', type = 'json', value = <JSON>, revision)`.

- **Read** (`read`, `readDetailed`, `fromRows` for batched reads): the stored JSON is merged over the defaults and validated. Missing row → defaults (`stored: false`, `revision: 0`). Invalid JSON/schema → defaults with a masked warning. Relational read errors propagate so callers fail closed.
- **Secrets** (`secretFields`): stored as `enc:` ciphertext encrypted with `CREDENTIAL_ENCRYPTION_KEY`. Reads decrypt strictly with that key; unreadable ciphertext or an obvious placeholder (`isPlaceholderSecret`) reads as the default (not configured) and is reported in `secretErrors` / `secretsConfigured`. A write that leaves a secret field untouched carries its ciphertext verbatim, so non-secret edits never need the key. Secrets are never logged or returned; routes mask them.
- **Write**: validates the patched (or `replace`d) document, compare-and-swaps on the revision it read, and advances the revision by one. Every merchant editor sends the revision it loaded (`expectedRevision`); a stale one throws `SettingsRevisionConflictError` (409 `SETTINGS_REVISION_CONFLICT`, details `{ document, expectedRevision, currentRevision }`). Internal plain patches retry a lost race. `writeSettingsDocuments()` commits several documents all-or-nothing; a revision guard leads the batch, so a stale write also rolls back `before`/`after` statements (media guards, provider-health clears).
- **Admin contract**: every settings GET returns `revision` in `data` (0 = never saved; `/auth` returns one per document it edits), every save requires `expectedRevision` and answers with the new `revision`.
- **Per-colo mirror** (`cacheKey`, non-secret documents only): a Cache API entry (60 s, keyed by the Worker version) from `settingsMirror(env)`, never authority. `readCached` is mirror-first; `writeCached`/`write(..., { kv })` writes through in the writer's colo; other colos converge within 60 s. Used by `platform` (`settings:platform`) and `security` (`settings:security`).
- **Checkout authority**: the existing `settings_checkout_authority_*` triggers advance `checkout_authority.revision` on every document insert, change, or delete, so in-flight checkouts are fenced against any settings change.

| Document | Contents | Secrets |
|----------|----------|---------|
| `platform` | `storefrontUrl`, `apiUrl`, `dashboardUrl`, `mediaUrl`, `customerAuthCookieDomain`, `corsAllowedOrigins`, `setupTokenRequired` | -- |
| `security` | `cspAllowedDomains` | -- |
| `media` | image optimization / delivery hosts | -- |
| `business` | company, TIN, logo, address, invoice prefix/logo | -- |
| `currency` | `currencyCode`, `currencySymbol` | -- |
| `customer_countries` | `allowedCountries`, `allowedCountriesMode` (the merchant's policy; the phone countries a store accepts are this list united with its markets' countries, `readAcceptedCustomerCountries()`) | -- |
| `checkout` | `guestCheckoutEnabled`, `checkoutMode`, `partialPaymentEnabled`, `partialPaymentAmount` (admin CAS revision) | -- |
| `customer_auth` | Customer accounts: `email` / `whatsapp` collection and code `channels` (any other shape resets to defaults) | -- |
| `customer_requests` | buyer self-service request policy | -- |
| `marketing_consent` | checkout consent checkbox, e-mail double opt-in | -- |
| `reviews` | reviews on/off, moderation, request delay, block words | -- |
| `gift_cards` | `defaultExpiryMonths` | -- |
| `policies` | the page id of each store policy (refund, privacy, terms, shipping, contact) | -- |
| `emi` | EMI plans shown on eligible products (informational) | -- |
| `seo` | titles, meta description, robots, `discovery`, `returnPolicy` | -- |
| `notifications` | customer/admin order channels, order WhatsApp template | -- |
| `email` | `provider`, `sender` | `resendApiKey` |
| `firebase` | `publicConfig` | `serviceAccount` |
| `whatsapp` | `phoneNumberId`, `authTemplateName` | `accessToken` |
| `sms` | active provider + provider fields | provider tokens/API keys |
| `stripe` | provider fields, `enabled` | secret key, webhook secret |
| `sslcommerz` (retired) | read once by the Bangladesh pack's activation, then cleared | store password |
| `payment_methods` | `enabledMethods` (`null` = COD implied), `defaultMethod` | -- |
| `meta_conversions` | `pixelId`, `testEventCode`, `isEnabled`, `logRetentionDays` | `accessToken` |

Domains own other documents: `inventory` (products), `delivery_pickup`
(delivery), `notifications` and `notification_templates` (notifications).

Not documents, on purpose: the theme (header, footer, homepage and pages; its
own live, draft and version tables), tax settings (tax module), and collections such as
checkout languages, analytics scripts, shipping methods, delivery
providers/locations, hero sliders, navigation menus, and fraud-checker provider
rows. `notification_provider_health` rows are operational pause markers in the
same table, not settings.

Phone collection is not a setting: checkout and customer identity always
require it.

## Theme: draft, publish and history

The theme is one document (`@scalius/shared/storefront-theme`) in three
places: the live row (`theme_settings`), one shared draft
(`theme_settings_drafts`) and immutable published versions
(`theme_settings_versions`). Every write is one guarded provider batch:

- **Save, restore, discard** replace only the draft. The live revision and
  the draft revision the caller read must both still hold; the draft revision
  only grows, so a stale editor gets a 409 and must reload or overwrite.
  Restore puts a published version in the draft (never live); discard puts
  the live document back in the draft at a new revision.
- **Publish** writes the live row, its version row (what changed since the
  previous live document, at most 30 structured changes plus a count, and an
  optional 500-character note), prunes history to the newest **20 versions**
  and rebases the draft onto the new live revision, all in one batch.
- A version row stores `{"meta": {changes, moreChanges, note}, "theme": …}`;
  the history list reads only `meta` (`json_extract`) and the publisher's
  name (joined from `user`), ten versions a page. Rows from before history
  metadata hold the bare document and list with no changes.
- Reads upgrade older documents in memory (`upgradeThemeDocument`); writes
  store only the current version, at most 512 KiB.

Previews: a draft preview follows saved edits; a version preview shows that
version. The 52-character bearer is `tpc_`/`tpv_` plus `D` and 47 random
characters (draft), or `V`, the revision in 10 base-36 digits, `_` and 36
random characters (version). Only its SHA-256 is stored, so the revision
cannot be changed without losing the session, and a pruned version stops
previewing. Bearers travel in POST bodies and an HttpOnly cookie, never URLs.

Agents use the same operations (Settings view/edit RBAC): the compact
workspace status, the full document as an authenticated JSON artifact,
history, draft save, one-page edits (homepage or one landing page), restore,
discard and publish. Every command answers revisions only.

## Platform origins

`env.STOREFRONT_URL` and the other public origins are resolved at Worker entry
by `resolvePlatformConfig()` (mirror first, then the `platform` document; a
DB failure resolves the empty configuration so callers fail closed).
`savePlatformSettings(db, patch, kv?, { expectedRevision }?)` validates every field before writing
(`storefrontUrl` is required and normalized to one HTTPS origin, HTTP loopback
only for local development) and writes the mirror through.

Admin API: `GET`/`PUT /api/v1/admin/settings/platform` (adds `readiness` and
`effective`). Public API: `GET /api/v1/platform` returns only the four origins
with a 60s `Cache-Control`; the storefront gets them in the `platform` block of
`GET /api/v1/storefront/layout`.

## Currency

`getCurrencyConfig(db)` returns `{ code, symbol, decimalPlaces }` from the
`currency` document. `decimalPlaces` is the
ISO 4217 exponent from the currency policy table
(`@scalius/shared/currency-policy`). A missing document yields the BDT
defaults; a relational read error throws. Catalog, shipping and order amounts
are stored as integer minor units of this currency, so once any product,
shipping method or order exists the code is locked (`isCurrencyCodeLocked`).

The price increment is the step every price, discount, fee and computed total
rounds to: the minor unit (1) or one whole unit (10^exponent). The backup
market holds it (`markets.price_increment_minor`, MARKETS-DESIGN step 2), not
this document. Merchants change it in Settings → Markets on the backup
market; it stays editable after the code locks. Saved prices are never
rewritten. A change queues a full catalogue projection rebuild, because
stored card prices round to it. A change of currency resets it to the new
currency's default (`resetBackupPriceIncrement()`): whole taka for BDT, the
minor unit otherwise. Read it through `readStoreCurrency()` or, in SQL,
`storePriceIncrementSql()` (both in `markets`).

## Notification channels

The notifications domain owns the `notifications` and `notification_templates`
documents (`notifications/documents.ts`) and their rules
(`notifications/channel-settings.ts`): `getNotificationChannels` /
`updateNotificationChannels` and the admin equivalents read and write the
`notifications` document. Customer channels are
limited to implemented delivery paths (`email`, `sms`, `whatsapp`); SMS and
WhatsApp saves require a ready provider that is not paused by
`notification_provider_health`. Every order event defaults to `["email"]`.

## Admin routes (`apps/api/src/routes/admin/settings/`)

- `site.ts` -- currency (a price-increment change queues the projection rebuild), the theme (editor, workspace, document, versions, draft, page draft, publish, restore, discard, preview session), media, SEO (partial discovery/return-policy patches, feed diagnostics, live probe), storefront URL, allowed countries. Public caches need no bump: a save advances the document's cache dependency in the same transaction (dependency-validated caching, `packages/shared/src/cache-deps.ts`).
- `notification-channels.ts`, `notification-templates.ts` -- customer and admin order channels, message templates.
- `system.ts` -- customer auth + WhatsApp (policy saves fail closed unless every selected OTP channel is deliverable; WhatsApp token saves require `CREDENTIAL_ENCRYPTION_KEY`, reject placeholders, skip masked values, and clear WhatsApp provider pauses in the same batch), checkout flow (`expectedRevision` CAS, revision `0` before the first save), checkout readiness, security (CSP only; never widens API CORS), email, Firebase.
- `payments.ts` -- payment methods and Stripe (SSLCommerz is the Bangladesh pack's; its keys are the pack's settings). Secret saves require `CREDENTIAL_ENCRYPTION_KEY`; enabled saves require non-placeholder credentials.
- `meta-conversions-admin.ts` -- Meta CAPI settings; a save clears the `meta-capi:browser-events:circuit` KV marker.
- `business.ts`, `sms.ts`, `platform.ts`.

## Checkout configuration

The checkout domain owns the checkout-flow policy and its document service
(`checkout/flow.ts`, `checkout/flow-settings.ts`) and the public configuration
(`checkout/config.ts`): settings never imports payments. `getCheckoutConfig()` reads the `checkout`, `currency`, `customer_auth`, and
`customer_countries` documents in one batch, evaluates delivery and required
sign-in readiness, then intersects the merchant payment allowlist with provider
readiness and checkout-flow policy (`guest_cod_only` hides online gateways,
`gateways_only` and partial payment hide COD). If settings cannot be read it
fails closed; it never guesses COD or a gateway. Order creation re-checks the
same policy through the checkout authority snapshot.
