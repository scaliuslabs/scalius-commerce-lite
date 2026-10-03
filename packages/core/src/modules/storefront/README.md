# Storefront

Batched D1 queries for the public storefront API. Shapes homepage and layout data for the storefront app in minimal round-trips.

## Files

- `index.ts` -- barrel exports (re-exports everything from `storefront.service.ts`)
- `storefront.service.ts` -- `getHomepageData()`, `getLayoutData()`
- `homepage-sections.ts` -- the homepage section images and deal countdowns, planned into the homepage's second batch (catalog lists and brands live in `catalog/home-lists.ts` and `catalog/home-brands.ts`)

## Local Helpers

- `safeJsonParse<T>(json, fallback)` -- JSON.parse with fallback on null/undefined/error
- `unixToISO(timestamp)` -- converts Unix epoch seconds to ISO 8601 string; returns null for invalid values

## Service Functions

### `getHomepageData(db, { requests? })`

Fetches and shapes all homepage data in **two batched D1 round trips**
(`apps/api/src/storefront-render-budget.test.ts` measures it on a store
whose theme uses every section type).

**Batch 1**: the `seo` settings document, active collections (metadata) and
the published theme row. The theme alone says what to read: its sections
and home mode (`homeSectionRequests(theme.pages.home, theme.pages.homeMode)`
in `@scalius/shared/storefront-theme`); a theme preview passes `requests`
for its draft instead.

**Batch 2** (one `db.batch`, skipped when nothing needs it):
- `planCollectionProducts()` (`catalog/collections.ts`): products of the
  collections sections' collections and of collection-sourced section lists;
- `planHomeProductLists()` (`catalog/home-lists.ts`): newest, on sale,
  popular (distinct buyers in real orders of 30 days) and category lists;
- `planHomeBrands()` (`catalog/home-brands.ts`): public brands with public products;
- `planHomePromotions()` (`homepage-sections.ts`): running promotions' end times;
- `planHomeMedia()` (`homepage-sections.ts`): section images, hero slides and
  their phone images included (ready or trashed images only, at their
  published rendition);
- the category tiles' published categories, in the sections' order;
- a product homepage's product, while it is public.

Every product statement is scoped to the products it returns (the buyer
pricing projection never ranks the whole catalogue) and brings a media
statement for exactly the same rows, so card images need no third round
trip. `products.catalog-scale-plans.d1.test.ts` guards the query plans.

Returns: `{ seo, sections: { lists, media, brands, promotions, categories, collections, homeProduct } }`.

- **SEO**: unset copy stays null (the storefront titles the page with the store name).
- **Collections**: the collections sections' collections that are active and have products, with `categories`, `products` and `featuredProduct`.
- **Section lists**: one per source key, in request order, with the public category or active collection it reads (for titles and "View all"); a list with nothing to show is empty, and its sections render nothing.
- **Home product**: `{ id, slug }` while a product homepage's product is public; the storefront answers `/` with a redirect to its page.

### `getLayoutData(db)`

Fetches and shapes all layout data in **two batched D1 round trips**:

1. Analytics scripts, the settings documents it projects (currency, media
   delivery, Meta CAPI readiness, SEO discovery, business identity,
   security, policies), the published theme (parsed strictly; an unreadable
   row renders the default theme whole), the active checkout language, the
   store-shape counts, the reachable category tree, the published theme's
   brand images (logo, footer logo, tab icon) through the stored theme row,
   and the placed menus (`planPublishedNavigationPlacements`: the placement
   manifest and the published items of every placed menu).
2. The pages the linked store policies name (`planPublicStorePolicies`) and
   every resource the menu items link to (`planNavigationResourceSnapshots`,
   at most 90 IDs per statement). Skipped when there are none.

Meta CAPI readiness decrypts the access token only when the stored document
turns the pixel on. `storefront-render-budget.test.ts` holds a layout with
header and footer menus and linked policies to these two waves.

Returns: `{ analytics, navigation, footerMenus, categoryTree, currency, theme, brand, storeShape, media, metaCapi, business, seo, cspAllowedDomains, storefrontCopy, policies }`.
The look (logo, announcement, footer words) is the theme document and
`brand`; identity (name, phone, email, address, `socialLinks`) is `business`.

**Analytics processing**: Each active analytics script is assigned an effective delivery policy by `shouldUsePartytown()`. GA4, GTM, Facebook Pixel, and TikTok are always worker-isolated even when a legacy stored flag is false; Cloudflare Web Analytics stays on the main thread; trusted custom code respects its saved choice. Worker-isolated snippets are normalized through `processAnalyticsScript()` and the response exposes the effective policy.

**Currency**: Reads `currency_code`, `currency_symbol`, `usd_exchange_rate` from the settings table. Defaults to BDT.

**Theme**: The published theme document (`theme_settings`), or the default theme when the row is unreadable; `brand` carries its resolved brand images.

**SEO discovery**: Reads the default-on sitemap/feed/robots/JSON-LD policy from the `seo` settings document (`discovery`) plus its merchant return-policy schema settings (`returnPolicy`). Layout consumers use this to gate global OnlineStore, WebSite, and MerchantReturnPolicy JSON-LD without a second storefront API read. Product pages use the same policy plus active shipping methods to emit offer-level shipping schema when enabled. Return-policy JSON-LD is emitted only when the saved policy is enabled and has schema-safe country/category/window facts or a safe same-origin/absolute policy URL.

## API Endpoints

### Public Storefront (`/api/v1/storefront`)
| Method | Path | Description | Cache |
|--------|------|-------------|-------|
| GET | `/homepage` | The published theme's homepage data (SEO and what its sections show) | `PublicApi` edge cache keyed by the store cache generation and the API Worker version |
| GET | `/pages/slug/{slug}` | Consolidated CMS page render data | `PublicApi` edge cache keyed by the store cache generation and the API Worker version |
| GET | `/layout` | Consolidated layout data (analytics, nav, footer menus, currency, theme and its brand images, media, Meta CAPI readiness, public business identity and social profiles, SEO discovery, public platform origins, merchant CSP sources) | `PublicApi` edge cache keyed by the store cache generation |

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
- `apps/storefront/src/lib/api/settings.ts` -- `getSeoSettings()`, `getAnalyticsConfigurations()`, `getActiveCheckoutLanguage()` with edge cache

## Dependencies

- `@scalius/database` -- `categories`, `collections`, `media`, `theme_settings`, `analytics`, `pages`, `settings`
- `@scalius/core/integrations/analytics` -- `processAnalyticsScript()`, `shouldUsePartytown()`
- `../catalog` -- `resolveCollectionProductsBatch()`

## Known Gaps

- Public SEO route at `/api/v1/seo` still overlaps with the SEO payload inside the consolidated homepage endpoint.
- Abandoned checkouts cleanup endpoint requires auth middleware, but the save endpoint does not.
