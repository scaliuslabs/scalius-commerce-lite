# Storefront

Batched D1 queries for the public storefront API. Shapes homepage and layout data for the storefront app in minimal round-trips.

## Files

- `storefront.service.ts` -- `getHomepageData()`, `getLayoutData()`

## Service Functions

### `getHomepageData(db)`

Fetches and shapes all homepage data in **two batched D1 round-trips**.

**Batch 1** (4 parallel queries):
1. SEO settings from `siteSettings` (siteTitle, homepageTitle, homepageMetaDescription)
2. Active hero sliders from `heroSliders` (desktop + mobile)
3. Active homepage widgets from `widgets` (displayTarget = "homepage", ordered by placementRule + sortOrder)
4. Active collections metadata from `collections` (ordered by sortOrder)

**Batch 2** (4 parallel queries, driven by Batch 1 results):
1. Products by explicit ID (from collection configs)
2. Products by category ID (from collection configs)
3. Category metadata (names, slugs)
4. Featured products (from collection configs)

Returns: `{ seo, hero, widgets, collections }` with computed `discountedPrice` on all products.

### `getLayoutData(db)`

Fetches and shapes all layout data in a **single batched D1 round-trip** (6 parallel queries):

1. Active analytics scripts -- applies Partytown processing via `processAnalyticsScript()`
2. Site settings (headerConfig, footerConfig JSON)
3. Categories (for navigation fallback when no custom nav configured)
4. Published pages (for navigation fallback)
5. Currency settings from `settings` table (category = "currency")
6. Theme color overrides from `settings` table (category = "theme", key = "storefront_colors")

Returns: `{ analytics, header, navigation, footer, currency, theme }`

**Header processing**: Normalizes social links (supports both array and legacy `{ facebook: "url" }` format). Falls back to auto-generated navigation from categories + pages when no custom navigation is configured.

**Footer processing**: Normalizes social links, menus with nanoid-generated IDs for entries missing them.

## API Endpoints

### Public Storefront (`/api/v1/storefront`)
| Method | Path | Description | Cache |
|--------|------|-------------|-------|
| GET | `/homepage` | Consolidated homepage data (SEO, hero, widgets, collections + products) | `api:storefront:homepage:*` with CACHE_TTLS.STANDARD |
| GET | `/layout` | Consolidated layout data (analytics, header, nav, footer, currency, theme) | `api:storefront:layout:*` with CACHE_TTLS.STANDARD |
| GET | `/csp` | CSP allowed domains from `settings` (category = security) | `api:storefront:csp:*` with CACHE_TTLS.STANDARD |

### Public Hero (`/api/v1/hero`)
| Method | Path | Description | Cache |
|--------|------|-------------|-------|
| GET | `/sliders` | Get active hero sliders. Optional `?type=desktop\|mobile` filter. Auto-detects mobile via User-Agent. Sets `X-Device-Type` header | `api:hero:*` with 3600s TTL |
| GET | `/sliders/{id}` | Get hero slider by ID (active only) | `api:hero:*` with 3600s TTL |

### Public SEO (`/api/v1/seo`)
| Method | Path | Description | Cache |
|--------|------|-------------|-------|
| GET | `/` | Get SEO settings (siteTitle, homepageTitle, homepageMetaDescription, robotsTxt). Defaults to "Scalius Commerce" | `api:seo:*` with TTL=0 |

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
| GET | `/stats` | Get KV cache statistics |
| GET | `/groups` | Get invalidation group definitions and admin path-to-group mapping |
| GET | `/last-cleared` | Get last-cleared timestamps per group |
| POST | `/clear` | Clear ALL cache. Also triggers storefront purge via PURGE_URL |
| POST | `/clear-group` | Clear specific groups. Records timestamps, triggers storefront purge if groups bump HTML |

## Storefront Consumers

- `apps/storefront/src/lib/api/storefront.ts` -- `getHomepageData()` and `getLayoutData()` wrappers with edge cache (BUILD_ID in cache key)
- `apps/storefront/src/lib/api/settings.ts` -- `getSeoSettings()`, `getAnalyticsConfigurations()`, `getActiveCheckoutLanguage()`, `getHeroSliders()` with edge cache

## Dependencies

- `@scalius/database` -- `siteSettings`, `products`, `categories`, `collections`, `widgets`, `heroSliders`, `analytics`, `pages`, `settings`, `checkoutLanguages`, `abandonedCheckouts`
- `@scalius/core/integrations/analytics` -- `processAnalyticsScript()`, `shouldUsePartytown()`
- `nanoid` -- fallback ID generation for footer social links/menus
- `currency.js` -- discount price calculation in `getHomepageData()`

## Known Gaps

- Public hero route at `/api/v1/hero/sliders` and the consolidated `/api/v1/storefront/homepage` both serve hero slider data -- the storefront uses the consolidated endpoint, making the standalone hero endpoint partially redundant.
- Public SEO route at `/api/v1/seo` has TTL=0 on its cache middleware (effectively no caching), while the same data is cached via the consolidated homepage endpoint.
- Abandoned checkouts cleanup endpoint requires auth middleware, but the save endpoint does not.
