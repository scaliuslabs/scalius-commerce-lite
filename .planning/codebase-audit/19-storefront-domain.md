# 19 - Storefront Domain Audit

## Scope

Storefront service module, checkout flow, abandoned checkouts, checkout languages, header/footer/hero builders, SEO, shipping methods, locations, and the storefront client layer.

---

## 1. Architecture Overview

### Service Layer (`packages/core/src/modules/storefront/`)

The storefront service is a lean data-shaping layer with two main exports:

- **`getHomepageData(db)`** -- Fetches SEO, hero sliders, widgets, and collections with products in exactly two batched D1 round-trips. Collection product resolution is well-optimized: collects all needed IDs up front, fetches in one batch, then builds lookup maps.
- **`getLayoutData(db)`** -- Fetches analytics, header config, navigation, footer config, currency, and theme colors in one batched D1 round-trip. Handles legacy social link formats (object vs array).

Both functions accept a `Database` parameter (not a singleton), following the refactored convention.

### API Routes

| Route File | Mount Path(s) | Purpose |
|---|---|---|
| `routes/storefront.ts` | `/storefront` | Homepage + layout consolidated endpoints |
| `routes/checkout.ts` | `/checkout` | Checkout config (payment gateways) |
| `routes/checkout-languages.ts` | `/checkout-languages` + `/admin/settings/checkout-languages` | Checkout i18n CRUD (dual-mounted) |
| `routes/abandoned-checkouts.ts` | `/abandoned-checkouts` + `/admin/settings/abandoned-checkouts` | Save/cleanup abandoned checkouts (dual-mounted) |
| `routes/header.ts` | `/header` | Header config (legacy standalone) |
| `routes/footer.ts` | `/footer` | Footer config (legacy standalone) |
| `routes/hero.ts` | `/hero` | Hero sliders (legacy standalone) |
| `routes/seo.ts` | `/seo` | SEO settings (legacy standalone) |
| `routes/locations.ts` | `/locations` | City/zone/area hierarchy |
| `routes/shipping-methods.ts` | `/shipping-methods` | Active shipping methods |
| `routes/admin/system-utils.ts` | `/admin/` | Abandoned checkout listing + cleanup for admin |

### Storefront Client (`apps/storefront/src/lib/api/`)

Each client module wraps the API call with `withEdgeCache` (L1 in-memory + L2 Cloudflare Cache API + KV versioning):

| Client File | Calls | Cache Key Strategy |
|---|---|---|
| `storefront.ts` | `/storefront/homepage`, `/storefront/layout` | `storefront_homepage_${BUILD_ID}`, `storefront_layout_${BUILD_ID}` |
| `checkout.ts` | `/checkout/config` | `checkout_config` |
| `header.ts` | `/header` | `global_header_data` |
| `footer.ts` | `/footer` | `global_footer_data` |
| `shipping.ts` | `/locations/*`, `/shipping-methods` | Per-city/zone keying for locations |
| `settings.ts` | `/seo`, `/analytics/configurations`, `/checkout-languages/active`, `/hero/sliders` | `global_*` prefixed keys |

### Admin Components

| Component | Pattern |
|---|---|
| `header-builder/` | Tabbed builder (Branding, Announcement, Contact & Social, Navigation). Config migration from legacy formats. |
| `footer-builder/` | Tabbed builder (Branding & Text, Navigation Menus, Social Media). Config migration from legacy formats. |
| `hero-slider/` | Desktop/mobile tabs with DnD-kit sortable slides, debounced image updates, optimistic UI. |
| `checkout-languages/` | Container + Table + Form Dialog + Actions Dialog + `useLanguages` hook. Full CRUD with soft-delete/restore. |
| `AbandonedCheckoutsManager.tsx` | Table with detail modal, bulk delete, search, sorting, pagination. |

---

## 2. Storefront Config: Header/Footer/Hero Builders

### Strengths

1. **Legacy migration is robust.** Both `HeaderBuilder` and `FooterBuilder` have `migrateConfig()` functions that normalize old social link formats (object `{ facebook: "url" }` to array `[{ id, label, url }]`), ensure navigation items have IDs, and provide safe defaults.
2. **Shared type system.** Both builders import from `@/components/admin/shared/builder-types` for `SocialLink` and `LogoConfig`, reducing duplication.
3. **Hero slider UX is well-crafted.** DnD-kit integration with optimistic updates, debounced API calls for text edits, and a clean drag overlay. Separate desktop/mobile tabs with recommended dimensions.
4. **Consolidated layout endpoint.** `getLayoutData()` batches 6 queries (analytics, settings, categories, pages, currency, theme) into a single D1 batch call, then shapes everything server-side. This eliminates N+1 patterns.

### Issues

**[P2-BUG] Legacy standalone header/footer routes use module-level `db` singleton.**
`routes/header.ts` and `routes/footer.ts` both import `import { db } from "@scalius/database/client"` (the module-level singleton) instead of using `c.get("db")` from the Hono context. This means they bypass the per-request database initialization that passes `c.env` to `getDb()`. In Cloudflare Workers, environment bindings are per-request. These routes will fail in production if the module-level singleton is not pre-initialized (which it typically is not in Workers).

Files: `/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/header.ts` (line 2), `/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/footer.ts` (line 2)

**[P3-REDUNDANCY] Standalone header/footer/hero/seo routes are superseded by consolidated endpoints.**
The storefront client (`storefront.ts`) uses `/storefront/homepage` and `/storefront/layout`, which already include all the data from the standalone `/header`, `/footer`, `/hero/sliders`, and `/seo` routes. The standalone routes still exist and are still called by individual client files (`header.ts`, `footer.ts`, `settings.ts`). This means:
- Double API surface to maintain
- The standalone routes have their own shape logic that can drift from the consolidated service
- The standalone `footer.ts` route returns data directly (not wrapped in `{ footer: ... }`) while the `header.ts` route wraps it as `{ header: ... }` -- inconsistent envelope shapes

**[P3-INCONSISTENCY] Header route's social link shape differs from the consolidated service.**
The standalone `routes/header.ts` returns social as `{ facebook: string }` (a single hardcoded platform), while `storefront.service.ts` returns a normalized `SocialLink[]` array. Any storefront code using the standalone header endpoint would see a different shape than the consolidated layout endpoint.

**[P4-HYGIENE] Hero route's user-agent sniffing produces identical SQL conditions.**
In `routes/hero.ts` lines 56-68, both the `isMobile` and `!isMobile` branches generate the same `or(eq("desktop"), eq("mobile"))` condition. The user-agent detection is redundant for the query -- the only behavioral difference is which images are returned in the `images` field, but both sliders are always fetched regardless. The `X-Device-Type` header is set but likely unused by any consumer.

---

## 3. Checkout Flow

### Strengths

1. **`getCheckoutConfig()` is well-designed.** It dynamically resolves enabled payment gateways from a registry, respects checkout mode (COD-only, gateways-only, all), handles partial payments, and includes currency configuration with proper decimal places.
2. **Storefront fallback is safe.** `checkout.ts` (storefront client) has a `COD_FALLBACK` constant ensuring the checkout never breaks even if the API is unreachable.
3. **API route has its own fallback.** `routes/checkout.ts` catches errors and returns a hardcoded COD fallback config (line 46-53), so the storefront always gets a working config.

### Issues

**[P2-BUG] Checkout route uses `getDb(c.env)` instead of `c.get("db")`.**
`routes/checkout.ts` line 38 calls `getDb(c.env)` directly, unlike all other refactored routes that use `c.get("db")` (set by middleware). While functionally equivalent, this bypasses any middleware-level DB setup or instrumentation.

File: `/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/checkout.ts`

**[P3-INCONSISTENCY] Checkout config API response omits `currency` field that the service returns.**
The `CheckoutConfig` interface in `checkout-config.service.ts` includes `currency: { code, symbol, decimalPlaces }`, but the storefront `CheckoutConfig` interface in `apps/storefront/src/lib/api/checkout.ts` does not include this field. The data is sent by the API but silently ignored by the storefront type. This is not a bug (TypeScript structural typing allows extra fields), but it means the checkout page may be missing useful currency information.

---

## 4. Abandoned Checkouts

### Strengths

1. **Upsert pattern.** The save endpoint correctly checks for an existing checkout by `checkoutId` and either updates or inserts, preventing duplicates.
2. **Cleanup endpoint is auth-protected.** Only authenticated callers can trigger cleanup (after successful order).
3. **Admin auto-cleanup is thorough.** The `system-utils.ts` listing endpoint performs three cleanup operations on every page load: deletes checkouts older than 30 days, migrates stale incomplete orders into abandoned checkouts, and deletes empty sessions older than 1 hour.
4. **Admin UI is well-built.** `AbandonedCheckoutsManager.tsx` has detail modal, bulk selection/deletion, search with debounce, sorting, and proper pagination with `AdminListPagination`.

### Issues

**[P2-SECURITY] The public `POST /abandoned-checkouts` endpoint has no authentication.**
Anyone can write arbitrary data to the `abandonedCheckouts` table by calling `POST /abandoned-checkouts` with a `checkoutId`. There is no rate limiting, CAPTCHA, or session validation. An attacker could flood the table with fake abandoned checkouts. Only the `/cleanup` sub-route has `authMiddleware`.

File: `/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/abandoned-checkouts.ts`

**[P2-BUG] `checkoutData` schema is `z.record(z.string(), z.string())` -- too restrictive.**
The Zod schema requires all values in `checkoutData` to be strings, but the admin manager's `parseCheckoutData()` expects nested objects like `data.cart.items` (an array of objects) and `data.cart.totalAmount` (a number). The schema would reject any checkout data with non-string values. Either the validation is wrong (it should be `z.record(z.string(), z.unknown())`) or the save endpoint is never actually called with structured data (the storefront serializes it differently).

File: `/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/abandoned-checkouts.ts` line 16

**[P3-CLEANUP-ON-READ] Admin listing triggers cleanup as a side effect of GET.**
The `GET /admin/settings/abandoned-checkouts` endpoint performs delete operations and data migration (incomplete orders to abandoned checkouts) as a side effect. This violates REST semantics (GET should be idempotent/safe). It also means every page refresh triggers cleanup, which adds latency to the listing response. This should be a separate scheduled job or a dedicated POST endpoint.

File: `/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/system-utils.ts` lines 52-93

**[P3-DUAL-MOUNT] Same route file mounted at both public and admin paths without differentiation.**
`abandoned-checkouts.ts` is mounted at both `/abandoned-checkouts` (public) and `/admin/settings/abandoned-checkouts` (admin). The admin path presumably goes through admin auth middleware, but the public `POST /` endpoint is unprotected. The dual-mount means the public routes are also accessible under the admin prefix, which is confusing.

---

## 5. Checkout Languages

### Strengths

1. **Complete lifecycle.** The API supports create, read, update, soft-delete, hard-delete, and restore -- a full CRUD lifecycle with trash management.
2. **Singleton active language.** When setting a language as active, all other languages are deactivated first, ensuring only one is active at a time.
3. **Graceful fallback.** The `GET /active` endpoint returns a hardcoded English fallback if no active or default language exists, so the storefront checkout never breaks.
4. **Admin UI is well-structured.** Decomposed into Container, Table, FormDialog, ActionsDialog, and a `useLanguages` hook. URL state is synced (search, sort, pagination, trashed view).
5. **Field visibility controls.** Merchants can toggle email, order notes, and area fields per language -- a nice localization feature.

### Issues

**[P2-BUG] PATCH method used for soft-delete is semantically wrong and overloaded.**
`PATCH /{id}` is used exclusively for soft-delete (setting `deletedAt`). PATCH should be for partial updates. If a future feature needs partial updates, the method is already taken. The conventional approach would be `DELETE /{id}` for soft-delete and a separate endpoint or query param for hard-delete.

File: `/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/checkout-languages.ts` lines 372-395

**[P3-SQL-INJECTION] Search uses unsanitized `like()` with user input.**
The list endpoint uses `like(checkoutLanguages.name, \`%${search}%\`)` directly. While Drizzle ORM parameterizes values in prepared statements, the `%` wildcards around user input could enable LIKE injection patterns (e.g., `%` or `_` characters in the search term are interpreted as wildcards). This is a minor concern since it only affects search results, not data integrity.

File: `/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/checkout-languages.ts` lines 183-184

**[P3-RACE-CONDITION] Setting active/default is not atomic.**
When creating or updating a language with `isActive: true`, the code first deactivates all active languages, then inserts/updates the new one. If the second operation fails, no language will be active. These should be wrapped in a transaction or `db.batch()`.

File: `/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/checkout-languages.ts` lines 256-274

**[P4-HYGIENE] `defaultLanguageData` is duplicated in three places.**
The same default language strings exist in:
1. `apps/api/src/routes/checkout-languages.ts` (API route)
2. `apps/admin/src/components/admin/checkout-languages/hooks/useLanguages.ts` (admin hook)
3. Hardcoded in the fallback response of `GET /active`

These can drift independently. A single source of truth in `@scalius/shared` would be cleaner.

---

## 6. Shipping Methods & Locations

### Strengths

1. **Clean hierarchical location API.** Cities, zones, and areas are fetched via separate endpoints with parent-child filtering. Each endpoint filters by `isActive` and `deletedAt IS NULL`.
2. **Storefront client caches per-parent.** Zones are cached as `shipping_zones_${cityId}` and areas as `shipping_areas_${zoneId}`, so different cities/zones get separate cache entries. This is correct.
3. **Shipping methods are simple and effective.** A flat list of active methods with fee, description, and sort order. No over-engineering.

### Issues

**[P4-HYGIENE] Shipping methods route returns raw timestamps without formatting.**
`routes/shipping-methods.ts` attempts to format `createdAt`/`updatedAt` with `instanceof Date` checks, but D1/Drizzle returns Unix timestamps (integers), not Date objects. The `instanceof Date` check will always be false, so `createdAt` and `updatedAt` will always be `null` in the response.

File: `/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/shipping-methods.ts` lines 62-68

---

## 7. SEO

### Strengths

1. **Sensible defaults.** If no settings exist, the SEO endpoint returns reasonable defaults including a basic robots.txt.
2. **Consolidated in homepage endpoint.** The `getHomepageData()` service already includes SEO fields, so the standalone `/seo` endpoint is primarily for non-homepage pages that need SEO settings.

### Issues

**[P3-WEIRD] SEO route cache TTL is 0.**
`routes/seo.ts` line 12 sets `ttl: 0` in the cache middleware, meaning the cache middleware is applied but effectively disabled. This is either intentional (SEO settings should always be fresh) or a mistake. If intentional, the middleware should not be applied at all for clarity.

File: `/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/seo.ts` line 12

---

## 8. LLM-Friendliness Assessment

### Good

- The storefront service has clear module boundaries: `getHomepageData()` and `getLayoutData()` are self-contained, well-documented functions.
- Route files are consistently structured with `createRoute()` + `app.openapi()` pairs.
- Type interfaces at each layer (service, API route, storefront client) make the data flow traceable.
- Admin components are decomposed into small, purpose-specific files with clear naming.

### Needs Improvement

- **`Record<string, unknown>` overuse in the service layer.** `storefront.service.ts` uses `Record<string, unknown>` extensively instead of typed interfaces. An LLM (or human) must mentally track what properties exist on each record through the batched query results. Typed interfaces for `ProductRow`, `CategoryRow`, `CollectionRow` would help.
- **Dual-mounted routes without clear documentation.** The same route file serving both public and admin paths is not obvious from reading the route file alone. The mounting happens in `app.ts`, which is far away.
- **Legacy standalone routes vs consolidated routes.** The existence of both creates confusion about which path is canonical.

---

## 9. Issues Summary

| ID | Severity | Category | Description | File(s) |
|---|---|---|---|---|
| S19-01 | P2-BUG | Database | Legacy header/footer routes use module-level `db` singleton instead of `c.get("db")` -- will fail in Workers | `routes/header.ts`, `routes/footer.ts` |
| S19-02 | P2-SECURITY | Auth | Public `POST /abandoned-checkouts` has no authentication -- anyone can write to the table | `routes/abandoned-checkouts.ts` |
| S19-03 | P2-BUG | Validation | `checkoutData` schema `z.record(string, string)` rejects nested objects that the admin parser expects | `routes/abandoned-checkouts.ts` |
| S19-04 | P2-BUG | Database | Checkout route uses `getDb(c.env)` directly instead of `c.get("db")` | `routes/checkout.ts` |
| S19-05 | P2-BUG | Semantics | PATCH used for soft-delete conflicts with partial update semantics | `routes/checkout-languages.ts` |
| S19-06 | P3-REDUNDANCY | Architecture | Standalone header/footer/hero/seo routes are superseded by consolidated storefront endpoints | `routes/header.ts`, `routes/footer.ts`, `routes/hero.ts`, `routes/seo.ts` |
| S19-07 | P3-INCONSISTENCY | Shape | Header route returns `{ facebook: string }` for social vs consolidated returns `SocialLink[]` | `routes/header.ts` vs `storefront.service.ts` |
| S19-08 | P3-CLEANUP-ON-READ | REST | Admin abandoned checkout listing performs cleanup mutations on GET | `routes/admin/system-utils.ts` |
| S19-09 | P3-RACE | Atomicity | Setting active/default checkout language is not atomic (deactivate + insert are separate) | `routes/checkout-languages.ts` |
| S19-10 | P3-SQL | Search | LIKE with unsanitized wildcards in checkout language search | `routes/checkout-languages.ts` |
| S19-11 | P3-INCONSISTENCY | Types | Checkout config `currency` field exists in service but missing from storefront type | `checkout.ts` (storefront) |
| S19-12 | P3-WEIRD | Cache | SEO route cache TTL is 0, effectively disabling caching | `routes/seo.ts` |
| S19-13 | P4-HYGIENE | Data | Shipping methods `instanceof Date` check always false for D1 timestamps | `routes/shipping-methods.ts` |
| S19-14 | P4-HYGIENE | DRY | `defaultLanguageData` duplicated in 3 locations | Multiple |
| S19-15 | P4-HYGIENE | Logic | Hero route user-agent sniffing produces identical SQL for mobile and desktop | `routes/hero.ts` |

---

## 10. Recommendations

### Immediate (P2)

1. **Fix `db` singleton in header/footer routes.** Replace `import { db } from "@scalius/database/client"` with `const db = c.get("db")` in `routes/header.ts` and `routes/footer.ts`. These routes will break in production Workers if the module-level singleton is not initialized.

2. **Add auth or rate-limiting to abandoned checkout save.** At minimum, add rate limiting by IP. Consider requiring a session token or the checkout session ID to be validated against an existing session.

3. **Fix `checkoutData` validation schema.** Change `z.record(z.string(), z.string())` to `z.record(z.string(), z.unknown())` or `z.any()` to accept the nested cart/customer data structure that the admin manager expects.

4. **Fix checkout route db access.** Change `getDb(c.env)` to `c.get("db")` for consistency with all other routes.

### Short-Term (P3)

5. **Deprecate standalone header/footer/hero/seo routes.** Migrate any remaining consumers to use the consolidated `/storefront/layout` and `/storefront/homepage` endpoints. Add deprecation notices to the standalone routes.

6. **Move cleanup out of abandoned checkout GET.** Create a `POST /admin/settings/abandoned-checkouts/cleanup` endpoint for the cleanup logic, or use a Cloudflare Cron Trigger. The GET listing should only list.

7. **Make checkout language active/default toggle atomic.** Wrap the deactivate + set-active operations in a `db.batch()` call.

8. **Sanitize LIKE wildcards.** Escape `%` and `_` characters in user-provided search terms before passing to `like()`.

9. **Fix SEO cache TTL.** Either set a real TTL (e.g., `CACHE_TTLS.STANDARD`) or remove the cache middleware entirely if TTL 0 is intentional.

### Long-Term (P4)

10. **Add types to storefront service.** Replace `Record<string, unknown>` with proper interfaces for batched query results in `storefront.service.ts`.

11. **Centralize `defaultLanguageData`.** Move to `@scalius/shared` or a dedicated checkout-languages constants file that both API and admin import.

12. **Fix shipping method timestamp formatting.** Use the `unixToISO()` helper (already in `storefront.service.ts`) instead of `instanceof Date` checks.

13. **Clean up hero route UA logic.** Remove the dead user-agent branching that produces identical query conditions.
