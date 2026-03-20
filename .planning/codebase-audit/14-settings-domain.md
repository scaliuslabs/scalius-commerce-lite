# Audit 14 -- Settings Domain

## 1. Overview

The Settings domain manages all store configuration: site identity, checkout flow, payment gateways, integrations, theme, SEO, security, and more. It spans two storage patterns (singleton `siteSettings` row vs KV-style `settings` table), three service files in `@scalius/core`, eight API route files under `apps/api/src/routes/admin/settings/`, and roughly 17 admin UI components.

### File Inventory

**Core Services (packages/core/src/modules/settings/)**
| File | Purpose |
|------|---------|
| `settings.service.ts` | Read-only accessors: `getCurrencyConfig()`, `getSiteSettings()`, `getStorefrontPath()` with KV caching |
| `site-settings.service.ts` | Admin CRUD: currency, general (header/footer), theme, SEO, storefront URL, allowed countries |
| `checkout-config.service.ts` | Assembles public checkout config from siteSettings + gateway registry |
| `index.ts` | Barrel re-export of all three |

**API Routes (apps/api/src/routes/admin/settings/)**
| File | Mounted At | Endpoints |
|------|-----------|-----------|
| `site.ts` | `/` | currency, general, header, footer, theme, seo, storefront-url, allowed-countries |
| `system.ts` | `/` | auth, security, email, firebase |
| `integrations.ts` | `/` | openrouter |
| `payments.ts` | `/` | payment-methods, stripe, sslcommerz, polar |
| `shipping.ts` | `/shipping-methods` | Full CRUD + soft-delete/restore |
| `delivery-providers.ts` | `/delivery-providers` | Full CRUD + test connection |
| `delivery-locations.ts` | `/delivery-locations` (separate mount) | Full CRUD + Pathao import |
| `hero-sliders.ts` | `/hero-sliders` | Full CRUD |
| `meta-conversions-admin.ts` | `/meta-conversions` | Settings + logs |

**Admin UI (apps/admin/src/components/admin/settings/)**
- `GeneralSettingsPage.tsx` -- 10-tab container (header, footer, SEO, storefront, email, currency, countries, auth, security, scanner)
- `CheckoutSettingsPage.tsx` -- 5-tab container (checkout flow, payment gateways, languages, shipping, delivery locations)
- `ThemeSettingsPage.tsx` -- Standalone full-page theme editor
- Individual form components: `AuthSettingsBuilder`, `CurrencySettingsBuilder`, `EmailSettingsForm`, `FirebaseSettingsForm`, `AllowedCountriesBuilder`, `CheckoutFlowSettings`, `PaymentGatewaysManager`, `PaymentMethodSettings`, `ScannerTokenGenerator`
- Shared utilities: `payment-gateway-utils.tsx`

**Storefront** (`apps/storefront/src/lib/api/settings.ts`) -- Edge-cached fetchers for SEO, analytics, checkout language, hero sliders.

---

## 2. Two Storage Patterns: Separation Analysis

### Pattern A: `siteSettings` Table (Singleton Row)

Schema: `packages/database/src/schema/system.ts` lines 26-56.

Typed columns: `siteName`, `siteDescription`, `headerConfig` (JSON text), `footerConfig` (JSON text), `storefrontUrl`, `authVerificationMethod` (enum), `guestCheckoutEnabled` (boolean), `checkoutMode` (enum), `partialPaymentEnabled` (boolean), `partialPaymentAmount` (real), `whatsappAccessToken`, `whatsappPhoneNumberId`, `whatsappTemplateName`, SEO fields (`siteTitle`, `homepageTitle`, `homepageMetaDescription`, `robotsTxt`).

Enforced via `singletonKey` column with default `"default"`.

**Used by:** SEO, header/footer, storefront URL, checkout flow, auth/verification, partial payment.

### Pattern B: `settings` Table (KV Store)

Schema: `packages/database/src/schema/system.ts` lines 10-24.

Columns: `id`, `key`, `value` (all text), `type` (text), `category` (text), `updatedAt`, `expiresAt`. Unique constraint on `(key, category)`.

**Categories discovered in codebase:**
| Category | Keys | Used By |
|----------|------|---------|
| `currency` | `currency_code`, `currency_symbol`, `usd_exchange_rate` | Currency settings |
| `theme` | `storefront_colors` | Theme customization |
| `phone` | `allowed_countries` | Country restrictions |
| `security` | `csp_allowed_domains` | CSP config |
| `email` | `resend_api_key`, `email_sender` | Email delivery |
| `firebase` | `service_account`, `public_config` | Push notifications |
| `integrations` | `openrouter_api_key` | AI/LLM integration |
| `stripe` | `secret_key`, `publishable_key`, `webhook_secret`, `enabled` | Stripe gateway |
| `sslcommerz` | `store_id`, `store_password`, `sandbox`, `enabled` | SSLCommerz gateway |
| `polar` | `access_token`, `webhook_secret`, `product_id`, `sandbox`, `enabled` | Polar gateway |
| `payment_methods` | `enabled_methods`, `default_method` | Payment config |

### Verdict: Separation is Clear and Well-Motivated

The split is logical: `siteSettings` holds always-present, typed, tightly-coupled fields (checkout booleans, enums, JSON blobs). The `settings` KV table holds optional, provider-specific, extensible config that may have zero rows initially. This is well-documented in CLAUDE.md.

**One minor inconsistency:** `allowedCountries` is in the `settings` table under category `"phone"`, but conceptually it is site-level checkout config. It could live on `siteSettings` as a JSON column. However, the current approach works and the backward-compat parsing in `getAllowedCountries()` suggests it was migrated from an older format, so moving it would be churn for no gain.

---

## 3. Settings Categories: Consistency

Categories are **well-defined and non-overlapping**. Each category maps to exactly one conceptual domain. The `(key, category)` unique constraint prevents key collisions across categories.

**Minor concern:** The `type` column on the `settings` table is always set to `"string"` by `upsertSetting()` even for JSON values (theme colors, Firebase config, allowed countries). The `type` column is never queried programmatically. It is vestigial -- it exists in the schema but has no runtime purpose.

---

## 4. Route Organization

### Current Structure

```
/api/v1/admin/settings/
  site.ts        --> /currency, /general, /header, /footer, /theme, /seo, /storefront-url, /allowed-countries
  system.ts      --> /auth, /security, /email, /firebase
  integrations.ts --> /openrouter
  payments.ts    --> /payment-methods, /stripe, /sslcommerz, /polar
  shipping.ts    --> /shipping-methods/*
  delivery-providers.ts --> /delivery-providers/*
  delivery-locations.ts --> (mounted separately at root, not through settings.ts)
  hero-sliders.ts --> /hero-sliders/*
  meta-conversions-admin.ts --> /meta-conversions/*
```

The router composition in `settings.ts` mounts `site`, `integrations`, `payments`, and `system` at root (`"/"`) so their paths flatten. This matches the admin UI's fetch URLs (`/api/v1/admin/settings/stripe` not `/api/v1/admin/settings/payments/stripe`).

### Assessment: Mostly Logical

The split groups related endpoints. `site.ts` is the largest (8 endpoint pairs) but all concern storefront-visible configuration. `system.ts` groups infrastructure concerns (auth, email, firebase, security). `payments.ts` groups all gateway credentials.

**Observation:** `delivery-locations.ts` exports `adminLocationRoutes` but `settings.ts` does not import it. It appears to be mounted separately. This is fine but slightly inconsistent with the other delivery-related route (`delivery-providers.ts`) which is mounted through `settings.ts`.

---

## 5. Type Safety Analysis

### Service Layer -- Good

- `CurrencyConfig` interface is well-typed with numeric types (`settings.service.ts:15-20`).
- `CheckoutConfig` interface is explicit (`checkout-config.service.ts:10-24`).
- Gateway settings have typed interfaces: `StripeSettings`, `SSLCommerzSettings`, `PolarSettings` (`gateway-settings.ts`).

### API Routes -- Mixed

**Good patterns:**
- `site.ts` validates all POST bodies with Zod schemas (header, footer, theme, seo, currency, allowed-countries).
- `system.ts` validates auth, security, email, firebase with Zod schemas.
- `shipping.ts` and `delivery-locations.ts` have full Zod validation.

**Issues found:**

1. **`payments.ts` skips Zod validation on Stripe/SSLCommerz/Polar saves.** The `saveStripeRoute`, `saveSSLCommerzRoute`, and `savePolarRoute` all use `c.req.json()` with manual `as Record<string, unknown>` casts instead of `c.req.valid("json")`. The `savePaymentMethodsRoute` also uses `c.req.json()` then manually calls `updateMethodsSchema.parse(body)`. This bypasses OpenAPI validation and means the request body schema is not documented in the OpenAPI spec.

2. **`hero-sliders.ts` uses module-level `db` singleton** instead of `c.get("db")`. Same issue in `payments.ts`. This means those routes will always use the module-level DB instance regardless of what the Hono context provides. This could cause issues if the DB binding changes between requests in a multi-tenant setup.

3. **`new Date()` used for `updatedAt` in several places** (`system.ts` lines 166, 234, 242, 311, 322; `delivery-providers.ts` line 252). The schema defines `updatedAt` as `integer("updated_at", { mode: "timestamp" })` which expects Unix epoch integers. Other routes correctly use `sql\`unixepoch()\`` or `sql\`(cast(strftime('%s','now') as int))\``. The `new Date()` approach relies on Drizzle to serialize the Date object to an integer, which works but is inconsistent with the rest of the codebase.

4. **`getSiteSettings()` return type is untyped.** In `settings.service.ts:139-164`, the function returns the raw row or `null` without a typed interface. Callers get `any`-ish types. The Drizzle `InferSelectModel<typeof siteSettings>` type exists (`SiteSettings`) but is not used as the return type.

### Admin UI -- Acceptable

Most components correctly use `unwrapEnvelope()` for response parsing. Types are defined locally in each component (e.g., `PaymentMethodsData`, `StripeData`, `SSLCommerzData`, `PolarData`). This is duplicative but works.

---

## 6. Caching Strategy

### KV Cache (Cloudflare Workers KV)

| Cache Key | TTL | Written By | Invalidated By |
|-----------|-----|-----------|----------------|
| `gw:storefront_url` | 300s | `getStorefrontBaseUrl()` | Manual `kv.delete` in storefront-url save route |
| `gw:currency` | 300s | `getCurrencyConfig()` | Manual `kv.delete` in currency save route |
| `gw:site_settings` | 300s | `getSiteSettings()` | `invalidateSiteSettingsCache()` |
| `gw:stripe` | 300s | `getStripeSettings()` | `invalidateStripeCache()` |
| `gw:sslcommerz` | 300s | `getSSLCommerzSettings()` | `invalidateSSLCommerzCache()` |
| `gw:polar` | 300s | `getPolarSettings()` | `invalidatePolarCache()` |
| `gw:payment_methods` | 300s | `getActivePaymentMethods()` | `invalidatePaymentMethodsCache()` |

### In-Memory Cache (layout-cache)

| Key | Invalidated By |
|-----|----------------|
| `CACHE_KEYS.STOREFRONT_URL` | Storefront URL save route |
| `CACHE_KEYS.FIREBASE_CONFIG` | Firebase save route |

### Storefront Edge Cache

| Key | TTL |
|-----|-----|
| `global_seo_settings` | `CACHE_TTL.LONG` |
| `global_analytics_config` | `CACHE_TTL.LONG` |
| `global_checkout_language` | `CACHE_TTL.LONG` |
| `homepage_hero_sliders` | `CACHE_TTL.LONG` |

### Assessment: Solid but Inconsistent Invalidation

- The KV cache layer is well-structured with consistent 5-minute TTLs and explicit invalidation functions.
- **Theme save route** invalidates by pattern (`deleteCacheByPattern("api:storefront:layout:*", kv)`) while all other routes use key-specific deletion. This is fine but is the only place that uses pattern-based invalidation for settings.
- **Currency cache invalidation** uses raw `kv.delete("gw:currency")` in the route handler instead of a dedicated `invalidateCurrencyCache()` function. Minor inconsistency.
- **Header/footer save** calls `invalidateSiteSettingsCache()` correctly, which clears the aggregate `gw:site_settings` cache.
- Storefront edge caching is well-separated via `withEdgeCache()` wrapper.

---

## 7. Admin UI Cohesion

### Page Organization

The admin settings are organized into distinct Astro pages:

| URL | Page | Component |
|-----|------|-----------|
| `/admin/settings` | General settings | `GeneralSettingsPage` (10 tabs) |
| `/admin/settings/checkout` | Checkout settings | `CheckoutSettingsPage` (5 tabs) |
| `/admin/settings/theme` | Theme editor | `ThemeSettingsPage` |
| `/admin/settings/hero-sliders` | Hero sliders | `HeroSliderContainer` |
| `/admin/settings/delivery-providers` | Delivery providers | Separate component |
| `/admin/settings/meta-conversion` | Meta Conversions API | `MetaConversionsContainer` |
| `/admin/settings/notifications` | Firebase notifications | Separate component |
| `/admin/settings/fraud-checker` | Fraud checker | Separate component |
| `/admin/settings/cache` | Cache management | Separate component |
| `/admin/settings/account` | Account settings | Separate component |

### Assessment: Well-Organized with Minor UX Overlap

- The 10-tab `GeneralSettingsPage` is the main settings hub. It uses lazy-loaded tabs with `React.lazy()` and `Suspense` -- a good pattern for performance.
- `CheckoutSettingsPage` logically groups all checkout-related config.
- **Firebase** appears in General Settings (as a tab it is NOT present; there is no Firebase tab in GeneralSettingsPage) AND has a dedicated `/admin/settings/notifications` page. The `FirebaseSettingsForm` component exists in the settings folder but is not mounted in `GeneralSettingsPage`. It appears to only be used from the notifications page. This is fine.
- **PaymentMethodSettings.tsx is orphaned.** This component exists alongside `PaymentGatewaysManager.tsx` and serves a similar purpose (managing payment method toggles). However, `PaymentMethodSettings` only knows about 3 gateways (stripe, sslcommerz, cod -- missing polar), while `PaymentGatewaysManager` knows about all 4 and has a more polished UI with accordion-based credential management. `PaymentMethodSettings` appears to be an older version that has been superseded.

---

## 8. LLM-Friendliness

### Strengths
- Clear file naming convention: `site.ts`, `system.ts`, `payments.ts`, etc.
- Consistent comment headers in service files with section separators.
- `CLAUDE.md` documents the two storage patterns explicitly.
- Gateway registry pattern (`gateway-settings.ts` + `gateway-registry.ts`) is self-documenting.
- Each admin component is self-contained with its own fetch/save logic.

### Weaknesses
- The `settings.service.ts` vs `site-settings.service.ts` naming is confusing. The former is for read-only access (storefront/API consumers), the latter is for admin CRUD. A name like `settings.reader.ts` vs `settings.admin.ts` would be clearer.
- The flattened route mounting (`app.route("/", siteSettingsRoutes)`) means an LLM cannot determine route paths from the import alone -- it must read both the mount point and the route definitions.
- No index of all settings categories exists. An LLM must grep the codebase to discover the full list.

---

## 9. Issues Found

### P1 -- Bugs / Correctness

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 1 | **Module-level `db` singleton used instead of `c.get("db")`** | `payments.ts:2`, `hero-sliders.ts:2` | These routes use the module-level DB import instead of the context-injected database. This bypasses any per-request DB configuration that middleware might set up. All other settings routes correctly use `c.get("db")`. |
| 2 | **Stripe/SSLCommerz/Polar save routes skip Zod validation** | `payments.ts:72,132,189,247` | Uses `c.req.json()` with manual casting instead of defining request schemas and using `c.req.valid("json")`. No OpenAPI spec for these POST bodies. Input is not validated before being written to DB. |

### P2 -- Consistency / Maintainability

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 3 | **Inconsistent timestamp generation** | `system.ts` (5 places), `delivery-providers.ts` (1 place) | Uses `new Date()` for `updatedAt` while all other routes use `sql\`unixepoch()\``. Works due to Drizzle serialization but inconsistent. |
| 4 | **Orphaned `PaymentMethodSettings.tsx`** | `apps/admin/src/components/admin/settings/PaymentMethodSettings.tsx` | This component duplicates `PaymentGatewaysManager.tsx` but lacks Polar support and has a different UI. It appears unused -- `CheckoutSettingsPage` loads `PaymentGatewaysManager`, not this file. |
| 5 | **`getSiteSettings()` lacks explicit return type** | `settings.service.ts:139-164` | Returns the raw Drizzle row without specifying `SiteSettings | null` as the return type. Downstream consumers get weak typing. |
| 6 | **Currency cache invalidation inconsistent** | `site.ts:63` | Uses raw `kv?.delete("gw:currency")` instead of a dedicated `invalidateCurrencyCache()` function like other settings have. |
| 7 | **Duplicate `MASKED` / `MASKED_VALUE` constants** | `system.ts:12`, `integrations.ts:8`, `payments.ts:21`, `delivery-providers.ts:11`, `meta-conversions-admin.ts:9` | Each route file defines its own masked value constant. Should be a single shared constant. |
| 8 | **Duplicated `allowedCountries` parsing logic** | `site-settings.service.ts:231-255` AND `checkout-config.service.ts:54-69` | The backward-compat JSON parsing for allowed countries is copy-pasted across two files. The service function should be reused. |
| 9 | **`settings` table `type` column is vestigial** | `packages/database/src/schema/system.ts:16` | Always set to `"string"` by `upsertSetting()`. Never queried. Some routes set it to `"json"` (Firebase) but this is never used programmatically. |

### P3 -- Minor / Code Quality

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 10 | **Unnecessary try/catch re-throw** | `system.ts` (auth, security, email, firebase routes), `integrations.ts`, `payments.ts` | Pattern: `try { ... } catch (error) { throw error; }`. The catch does nothing -- errors would propagate naturally. |
| 11 | **`saveHeaderConfig` / `saveFooterConfig` create separate rows** | `site-settings.service.ts:69-114` | If no siteSettings row exists, `saveHeaderConfig` creates one with empty `footerConfig` and vice versa. This is correct due to the singleton pattern but the upsert boilerplate is repeated for every save function. |
| 12 | **`console.error` in production routes** | `shipping.ts`, `delivery-locations.ts` | Several routes log `console.error` before re-throwing. In a Workers environment, these go to the Cloudflare dashboard logs but clutter the output. Other routes do not log. |

---

## 10. Recommendations

### Immediate (P1)

1. **Fix `db` singleton imports in `payments.ts` and `hero-sliders.ts`.** Replace `import { db } from "@scalius/database/client"` with `const db = c.get("db")` in each route handler. This aligns with the pattern used by all other settings routes.

2. **Add Zod request schemas to payment gateway save routes.** The Stripe, SSLCommerz, and Polar save routes should define request body schemas and use `c.req.valid("json")` like the other routes. This fixes both the validation gap and the missing OpenAPI documentation.

### Short-Term (P2)

3. **Delete `PaymentMethodSettings.tsx`.** It is superseded by `PaymentGatewaysManager.tsx` and appears unused. Confirm by searching for imports.

4. **Add explicit return type to `getSiteSettings()`.** Type it as `Promise<SiteSettings | null>`.

5. **Extract shared `MASKED` constant.** Create a single constant in `apps/api/src/utils/constants.ts` and import it across all settings routes.

6. **Extract `parseAllowedCountries()` helper.** Deduplicate the backward-compat parsing logic in `site-settings.service.ts` and `checkout-config.service.ts`.

7. **Standardize timestamp generation.** Replace `new Date()` with `sql\`unixepoch()\`` in the six locations that use the JavaScript Date approach.

### Long-Term (P3)

8. **Consider a `SettingsManager` abstraction.** The repeated pattern of "read category from DB, map to object, cache in KV, invalidate on save" appears in 7+ places. A generic `SettingsManager<T>` class could reduce boilerplate for gateway settings.

9. **Remove the `type` column from `settings` table** in a future migration, or actually use it (e.g., auto-deserialize JSON values based on type).

10. **Strip unnecessary try/catch re-throws** across the settings routes. Let the global error handler deal with unhandled errors.

---

## 11. Architecture Diagram

```
Admin UI (React)
  |
  |-- GeneralSettingsPage (10 tabs)
  |     |-- HeaderBuilder, FooterBuilder
  |     |-- SeoSettingsBuilder, StorefrontUrlBuilder
  |     |-- EmailSettingsForm, CurrencySettingsBuilder
  |     |-- AllowedCountriesBuilder, AuthSettingsBuilder
  |     |-- SecuritySettingsBuilder, ScannerTokenGenerator
  |
  |-- CheckoutSettingsPage (5 tabs)
  |     |-- CheckoutFlowSettings
  |     |-- PaymentGatewaysManager
  |     |-- CheckoutLanguagesManager
  |     |-- ShippingMethodsManager
  |     |-- DeliveryLocationsManager
  |
  |-- ThemeSettingsPage (standalone)
  |-- HeroSliderContainer (standalone)
  |-- MetaConversionsContainer (standalone)
  |
  v
API Routes (Hono OpenAPIHono)
  |
  |-- settings/site.ts       --> @scalius/core settings services
  |-- settings/system.ts     --> Direct DB queries (settings table)
  |-- settings/integrations.ts --> Direct DB queries (settings table)
  |-- settings/payments.ts   --> @scalius/core gateway-settings
  |-- settings/shipping.ts   --> Direct DB queries (shippingMethods)
  |-- settings/delivery-*.ts --> @scalius/core delivery services
  |-- settings/hero-sliders.ts --> Direct DB queries (heroSliders)
  |-- settings/meta-conversions-admin.ts --> Direct DB + @scalius/core
  |
  v
Storage Layer
  |
  |-- siteSettings table (singleton row)
  |     Typed columns for site identity, checkout config, auth, SEO
  |
  |-- settings table (KV store)
  |     Categories: currency, theme, phone, security, email,
  |     firebase, integrations, stripe, sslcommerz, polar, payment_methods
  |
  |-- Cloudflare KV (cache layer)
  |     Keys: gw:currency, gw:site_settings, gw:stripe, gw:sslcommerz,
  |     gw:polar, gw:payment_methods, gw:storefront_url
  |
  |-- In-memory layoutCache (STOREFRONT_URL, FIREBASE_CONFIG)
```

---

## 12. Settings Category Registry (Reference)

For LLM and developer reference, the complete settings taxonomy:

### siteSettings (Singleton)
- **Identity:** siteName, siteDescription, logo, favicon
- **Layout:** headerConfig (JSON), footerConfig (JSON), socialLinks, contactInfo
- **SEO:** siteTitle, homepageTitle, homepageMetaDescription, robotsTxt
- **Checkout:** guestCheckoutEnabled, checkoutMode, partialPaymentEnabled, partialPaymentAmount
- **Auth:** authVerificationMethod, whatsappAccessToken, whatsappPhoneNumberId, whatsappTemplateName
- **Storefront:** storefrontUrl

### settings KV (By Category)
- **currency:** currency_code, currency_symbol, usd_exchange_rate
- **theme:** storefront_colors (JSON)
- **phone:** allowed_countries (JSON with mode)
- **security:** csp_allowed_domains
- **email:** resend_api_key, email_sender
- **firebase:** service_account (JSON), public_config (JSON)
- **integrations:** openrouter_api_key
- **stripe:** secret_key, publishable_key, webhook_secret, enabled
- **sslcommerz:** store_id, store_password, sandbox, enabled
- **polar:** access_token, webhook_secret, product_id, sandbox, enabled
- **payment_methods:** enabled_methods (JSON array), default_method
