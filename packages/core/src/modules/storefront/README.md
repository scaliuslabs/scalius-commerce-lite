# Storefront

Batched D1 queries for the public storefront API. Shapes homepage and layout data for the storefront app in minimal round-trips.

## Files

- `index.ts` -- barrel exports (re-exports everything from `storefront.service.ts`)
- `storefront.service.ts` -- `getHomepageData()`, `getLayoutData()`
- `homepage-sections.ts` -- the homepage section product lists and images, planned into the homepage's second batch

## Local Helpers

- `safeJsonParse<T>(json, fallback)` -- JSON.parse with fallback on null/undefined/error
- `unixToISO(timestamp)` -- converts Unix epoch seconds to ISO 8601 string; returns null for invalid values

## Service Functions

### `getHomepageData(db, { requests? })`

Fetches and shapes all homepage data in **two batched D1 round trips**
(`apps/api/src/storefront-render-budget.test.ts` measures it on a store
whose theme uses every section type).

**Batch 1**: the `seo` and `homepage` settings documents, active hero
sliders, active collections (metadata), the category-rail categories, and
the published theme row. The theme's sections say which product lists and
images to read (`homeSectionRequests` in `@scalius/shared/storefront-theme`);
a theme preview passes `requests` for its draft instead.

**Batch 2** (one `db.batch`, skipped when nothing needs it):
- `planCollectionProducts()` (collections service): products of the
  homepage collections and of collection-sourced section lists;
- `planHomeProductLists()` (`homepage-sections.ts`): newest, on sale,
  popular (distinct buyers in real orders of 30 days) and category lists;
- `planHomeMedia()`: section images (ready or trashed images only);
- the hero rendition lookup for slides still on an original upload.

Every product statement is scoped to the products it returns (the buyer
pricing projection never ranks the whole catalogue) and brings a media
statement for exactly the same rows, so card images need no third round
trip. `products.catalog-scale-plans.d1.test.ts` guards the query plans.

Returns: `{ seo, hero, collections, presentation, sections: { lists, media } }`.

- **SEO**: unset copy stays null (the storefront titles the page with the store name).
- **Hero**: Separate revision-guarded `desktop` and `mobile` documents. Images are validated through the shared bounded hero contract; malformed or unsafe saved documents fail closed to no public slides.
- **Collections**: only `showOnHomepage` collections with resolved products, with `categories`, `products` and `featuredProduct`.
- **Section lists**: one per source key, in request order, with the public category or active collection it reads (for titles and "View all"); a list with nothing to show is empty, and its sections render nothing.

### `getLayoutData(db)`

Fetches and shapes all layout data in a **single batched D1 round-trip** (11 parallel queries):

1. Active analytics scripts -- applies Partytown processing via `processAnalyticsScript()` from `@scalius/core/integrations/analytics`
2. Site settings (headerConfig, footerConfig JSON)
3. Categories (for navigation fallback when no custom nav configured)
4. Published pages (for navigation fallback)
5. Currency settings from `settings` table (category = "currency")
6. Versioned semantic storefront style from `theme_settings`, with the legacy flat color row used only before the first versioned publish
7. Media delivery host settings from `settings` table (category = "media", key = "image_optimization")
8. Meta CAPI browser dispatch readiness from the `meta_conversions` settings document
9. SEO discovery policy from `settings` table (category = "seo", key = "discovery")
10. Public business identity fields from `settings` table (category = "business_info") for OnlineStore JSON-LD
11. Merchant return-policy schema settings from `settings` table (category = "seo", key = "return_policy")

Returns: `{ analytics, header, navigation, footer, currency, theme, media, metaCapi, business, seo }`

**Analytics processing**: Each active analytics script is assigned an effective delivery policy by `shouldUsePartytown()`. GA4, GTM, Facebook Pixel, and TikTok are always worker-isolated even when a legacy stored flag is false; Cloudflare Web Analytics stays on the main thread; trusted custom code respects its saved choice. Worker-isolated snippets are normalized through `processAnalyticsScript()` and the response exposes the effective policy.

**Header processing**: Normalizes social links (supports both array format and legacy `{ facebook: "url" }` object format). Falls back to auto-generated navigation from categories + pages when no custom navigation is configured in `headerConfig`. Includes topBar, logo, favicon, contact, and social fields with sensible defaults.

**Footer processing**: Normalizes social links and menus. Uses `nanoid()` to generate IDs for menu/link entries missing them. Includes logo, favicon, tagline, description, copyrightText, menus, and social fields.

**Currency**: Reads `currency_code`, `currency_symbol`, `usd_exchange_rate` from the settings table. Defaults to BDT.

**Theme**: Reads storefront color overrides from the `settings` table. Returns as `{ colors: Record<string, string> }`.

**SEO discovery**: Reads the default-on sitemap/feed/robots/JSON-LD policy from the `seo` settings document (`discovery`) plus its merchant return-policy schema settings (`returnPolicy`). Layout consumers use this to gate global OnlineStore, WebSite, and MerchantReturnPolicy JSON-LD without a second storefront API read. Product pages use the same policy plus active shipping methods to emit offer-level shipping schema when enabled. Return-policy JSON-LD is emitted only when the saved policy is enabled and has schema-safe country/category/window facts or a safe same-origin/absolute policy URL.

## API Endpoints

### Public Storefront (`/api/v1/storefront`)
| Method | Path | Description | Cache |
|--------|------|-------------|-------|
| GET | `/homepage` | Consolidated homepage data (SEO, hero, collections + products) | `PublicApi` edge cache keyed by the store cache generation |
| GET | `/pages/slug/{slug}` | Consolidated CMS page render data | `PublicApi` edge cache keyed by the store cache generation |
| GET | `/layout` | Consolidated layout data (analytics, header, nav, footer, currency, theme, media, Meta CAPI readiness, public business identity, SEO discovery, public platform origins, merchant CSP sources) | `PublicApi` edge cache keyed by the store cache generation |

### Public Hero (`/api/v1/hero`)
| Method | Path | Description | Cache |
|--------|------|-------------|-------|
| GET | `/sliders` | Get active hero sliders. Optional `?type=desktop\|mobile` filter. Auto-detects mobile via User-Agent. Sets `X-Device-Type` header | Explicit `type=desktop/mobile` requests use the `PublicApi` edge cache keyed by the store cache generation; untyped User-Agent-derived requests bypass shared cache |
| GET | `/sliders/{id}` | Get hero slider by ID (active only) | `PublicApi` edge cache keyed by the store cache generation |

### Public SEO (`/api/v1/seo`)
| Method | Path | Description | Cache |
|--------|------|-------------|-------|
| GET | `/` | Get SEO settings (siteTitle, homepageTitle, homepageMetaDescription, robotsTxt, default-on discovery policy, and merchant return-policy schema settings) | `PublicApi` edge cache keyed by the store cache generation |

### Public Checkout (`/api/v1/checkout`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/config` | Returns checkout config including `allowedCountries`, `allowedCountriesMode`, and `currency` with `decimalPlaces` |

### Public Checkout Languages (`/api/v1/checkout-languages`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/active` | Get active checkout language. Falls back to default, then hardcoded English fallback with 30+ label strings. Includes `customerPhoneHelp` field |
| GET | `/` | List all languages with pagination, search, sort, trashed filter |
| POST | `/` | Create language. Auto-deactivates other active/default languages when setting isActive/isDefault |
| GET | `/{id}` | Get language by ID |
| PUT | `/{id}` | Update language. Enforces unique code constraint |
| PATCH | `/{id}` | Soft-delete (sets deletedAt) |
| DELETE | `/{id}` | Hard-delete (204 No Content) |
| POST | `/{id}/restore` | Restore soft-deleted language |

### Public Abandoned Checkouts (`/api/v1/abandoned-checkouts`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/` | Save/update abandoned checkout (upsert by checkoutId) |
| POST | `/cleanup` | Delete checkout record after successful order (auth-protected) |

### Cache Management (`/api/v1/cache`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/clear` | "Refresh store": starts a new public cache generation (`bumpCacheGeneration`). Saves already do this; there are no purges or groups |

## Storefront Consumers

- `apps/storefront/src/lib/api/storefront.ts` -- `getHomepageData()` and `getLayoutData()` wrappers with edge cache (BUILD_ID in cache key)
- `apps/storefront/src/lib/api/settings.ts` -- `getSeoSettings()`, `getAnalyticsConfigurations()`, `getActiveCheckoutLanguage()`, `getHeroSliders()` with edge cache

## Dependencies

- `@scalius/database` -- `categories`, `collections`, `heroSliders`, `analytics`, `pages`, `settings`
- `@scalius/core/integrations/analytics` -- `processAnalyticsScript()`, `shouldUsePartytown()`
- `@scalius/core/modules/collections/collections.service` -- `resolveCollectionProductsBatch()`
- `nanoid` -- fallback ID generation for footer social links/menus

## Known Gaps

- Public hero route at `/api/v1/hero/sliders` and the consolidated `/api/v1/storefront/homepage` both serve hero slider data -- the storefront uses the consolidated endpoint, making the standalone hero endpoint partially redundant.
- Public SEO route at `/api/v1/seo` still overlaps with the SEO payload inside the consolidated homepage endpoint.
- Abandoned checkouts cleanup endpoint requires auth middleware, but the save endpoint does not.
