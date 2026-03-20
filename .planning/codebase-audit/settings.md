# Settings Domain Audit

## Summary

The Settings domain is the most sprawling vertical in the codebase, touching 9 API route files, 3 core service files, and 14+ admin UI components across two settings page tabs (General Settings, Checkout Settings) plus standalone pages (Theme, Payment Gateways). It manages two distinct storage backends -- the `siteSettings` singleton table for typed fields and the `settings` KV table for extensible config -- and implements KV caching with manual invalidation across multiple cache keys.

**Scope of audit:**
- Schema: `packages/database/src/schema/system.ts`
- Core services: `packages/core/src/modules/settings/` (3 service files + index)
- API routes: `apps/api/src/routes/admin/settings/` (9 files) + `apps/api/src/routes/admin/settings.ts` (aggregator)
- Admin UI: `apps/admin/src/components/admin/settings/` (14 files) + 3 builder components in parent directory

**Overall assessment:** Functional and well-organized at the page level, but the API route layer contains significant pattern violations. Many route handlers inline raw DB operations instead of delegating to core services, violating the "thin HTTP layer" convention. Timestamp handling is inconsistent across files, and the domain has zero test coverage.

---

## Critical Issues

### 1. `delivery-locations.ts` orphaned from settings router -- silent dead import possible

**Files:** `apps/api/src/routes/admin/settings/delivery-locations.ts`, `apps/api/src/routes/admin/settings.ts`, `apps/api/src/app.ts`

The `delivery-locations.ts` file lives inside the `settings/` directory but is NOT mounted through the `adminSettingsRoutes` aggregator in `apps/api/src/routes/admin/settings.ts`. Instead, it is mounted directly in `apps/api/src/app.ts` at line 330:

```typescript
app.route("/admin/settings/delivery-locations", adminLocationRoutes);
```

This creates confusion: a developer adding a new settings sub-route would naturally add it to the aggregator file, but delivery-locations breaks this pattern. The exported name (`adminLocationRoutes`) also does not follow the naming convention of other settings exports (e.g., `siteSettingsRoutes`, `paymentSettingsRoutes`).

**Impact:** Maintenance confusion. A refactor of the settings aggregator could accidentally break delivery locations routing.

**Fix:** Move the mount into the aggregator (`settings.ts`) with `app.route("/delivery-locations", adminLocationRoutes)` and rename the export to `deliveryLocationsRoutes` for consistency.

### 2. Hero sliders use `CURRENT_TIMESTAMP` (ISO string) instead of Unix epoch integers

**File:** `apps/api/src/routes/admin/settings/hero-sliders.ts`, lines 94-95, 161, 197

```typescript
createdAt: sql`CURRENT_TIMESTAMP`,
updatedAt: sql`CURRENT_TIMESTAMP`
```

Every other entity in the codebase uses `sql\`(cast(strftime('%s','now') as int))\`` or the schema's `UNIX_NOW` default for timestamps. The `heroSliders` schema in the database likely stores `createdAt`/`updatedAt` as `integer` columns (Unix epoch). `CURRENT_TIMESTAMP` produces an ISO 8601 string like `"2026-03-20 12:00:00"`, which will be coerced to `0` when stored in an integer column, corrupting timestamp data.

**Impact:** All hero slider `createdAt`/`updatedAt` values are stored as `0` (or the numeric prefix of the ISO string), making time-based queries meaningless.

**Fix:** Replace all `sql\`CURRENT_TIMESTAMP\`` usages with `sql\`(cast(strftime('%s','now') as int))\`` in `hero-sliders.ts`.

### 3. `saveHeaderConfig` / `saveFooterConfig` overwrite each other's data on fresh installs

**File:** `packages/core/src/modules/settings/site-settings.service.ts`, lines 69-103

Both `saveHeaderConfig` and `saveFooterConfig` use `onConflictDoUpdate` targeting the singleton key. The insert fallback (for when no row exists yet) hardcodes the OTHER config as `JSON.stringify({})`:

```typescript
// saveHeaderConfig fallback insert:
footerConfig: JSON.stringify({}),  // <-- will wipe footer if row doesn't exist

// saveFooterConfig fallback insert:
headerConfig: JSON.stringify({}),  // <-- will wipe header if row doesn't exist
```

On a fresh install, if the admin saves the header first (creating the row), then saves the footer, the `onConflictDoUpdate` correctly only updates `footerConfig`. But if somehow the header save and footer save race on a completely fresh DB, the second insert would lose the first's data.

**Impact:** Low probability in practice (the singleton row is created on first access), but the pattern is fragile. `saveSeoSettings` at line 163 has the same issue -- its insert fallback sets `headerConfig: JSON.stringify({})` and `footerConfig: JSON.stringify({})`.

**Fix:** All functions writing to `siteSettings` should use an "ensure row exists first, then update" pattern, or a single `upsertSiteSettings` helper that reads the current row and merges.

---

## Code Quality Issues

### 4. Massive inline DB operations in route handlers (thin-layer violation)

The "thin HTTP layer" convention dictates that routes validate input, check auth, then delegate to `@scalius/core` services. Multiple settings route files violate this by embedding raw Drizzle queries directly:

| File | Inline DB operations | Should delegate to |
|------|---------------------|--------------------|
| `apps/api/src/routes/admin/settings/system.ts` | Lines 44, 89, 145-154, 222-226, 258-275, 299-310, 338-358 | `@scalius/core/modules/settings` |
| `apps/api/src/routes/admin/settings/integrations.ts` | Lines 29-35, 64-76 | A new `integrations.service.ts` |
| `apps/api/src/routes/admin/settings/payments.ts` | Lines 162-164, 236-238, 311-313 (GET handlers read directly) | `gateway-settings.ts` already exists -- use its getters |
| `apps/api/src/routes/admin/settings/hero-sliders.ts` | ALL CRUD operations inline | A new `hero-sliders.service.ts` in core |
| `apps/api/src/routes/admin/settings/shipping.ts` | ALL CRUD operations inline | A new `shipping.service.ts` in core |
| `apps/api/src/routes/admin/settings/delivery-locations.ts` | Most operations inline | Partially delegates to `@scalius/core/modules/delivery/locations` |
| `apps/api/src/routes/admin/settings/meta-conversions-admin.ts` | ALL operations except log cleanup inline | A new `meta-conversions.service.ts` in core |

**Impact:** Business logic scattered across API routes. Impossible to reuse from other entry points. Harder to test.

### 5. Nine instances of `as any` type casting in route handlers

**Files:** `shipping.ts` (3), `delivery-providers.ts` (2), `meta-conversions-admin.ts` (3), `delivery-locations.ts` (1)

Pattern:
```typescript
app.openapi(createRoute_, (async (c: any) => {
    // ...
}) as any);
```

This bypasses Hono's OpenAPI type checking entirely. The root cause is likely a type mismatch between the Zod schema and the handler's expected context type.

**Fix:** Investigate the type mismatch. Usually caused by missing `.passthrough()` on request schemas or incorrect response schema typing. Fix the schemas rather than casting to `any`.

### 6. Redundant try/catch/throw pattern

Every handler in `system.ts`, `integrations.ts`, `payments.ts`, and `delivery-providers.ts` wraps the entire body in:

```typescript
try {
    // ... actual logic ...
} catch (error: unknown) {
    throw error;
}
```

This catch-and-rethrow adds no value -- Hono's error handler already catches unhandled errors. In some cases (e.g., `integrations.ts` line 37-39), the catch literally just re-throws.

**Impact:** Code noise. Makes handlers ~6 lines longer than necessary.

**Fix:** Remove the try/catch wrapper unless it adds actual error transformation logic (e.g., the `shipping.ts` handlers that catch `UNIQUE constraint` errors and rethrow as `ConflictError` -- those are legitimate).

### 7. Inconsistent secret masking constant names

| File | Constant |
|------|----------|
| `system.ts` | `MASKED = "............"` |
| `integrations.ts` | `MASKED_VALUE = "............"` |
| `payments.ts` | `MASKED = "............"` |
| `delivery-providers.ts` | `MASKED_VALUE = "............"` |
| `meta-conversions-admin.ts` | `MASKED_VALUE = "............"` |
| `AuthSettingsBuilder.tsx` | `MASKED_VALUE = "............"` |
| `EmailSettingsForm.tsx` | `MASKED_VALUE = "............"` |

Two different names for the same concept, duplicated across 7+ files.

**Fix:** Export a single `MASKED_VALUE` constant from `@scalius/shared` or from the API's shared utils.

---

## Pattern Violations

### 8. Two services for the same domain with overlapping functionality

**Files:**
- `packages/core/src/modules/settings/settings.service.ts` -- read-only with KV caching (used by storefront/runtime)
- `packages/core/src/modules/settings/site-settings.service.ts` -- read/write without KV caching (used by admin routes)

Both files query the same tables. `settings.service.ts` has `getCurrencyConfig()` with KV caching; `site-settings.service.ts` has `getCurrencySettings()` without caching but with a different return shape. The storefront calls `getCurrencyConfig()` (cached), while the admin route calls `getCurrencySettings()` (uncached).

This dual-service pattern is intentional (read-only cached vs. read-write uncached) but the naming does not communicate the distinction. The name "site-settings" suggests it handles the `siteSettings` table, but it also handles the `settings` KV table (currency, theme, allowed countries).

**Impact:** Confusing for new contributors. Risk of accidentally using the cached version for writes or the uncached version for hot paths.

**Fix:** Rename to `settings.read.ts` (cached, storefront) and `settings.admin.ts` (uncached, admin) to clarify intent.

### 9. Allowed countries parsing logic duplicated between service and checkout-config

**Files:**
- `packages/core/src/modules/settings/site-settings.service.ts`, lines 211-234 (`getAllowedCountries`)
- `packages/core/src/modules/settings/checkout-config.service.ts`, lines 55-70

Both contain identical backward-compatible JSON parsing logic for the `allowedCountries` setting (handling both the old array format and the new `{ countries, mode }` object format). This is copy-paste duplication.

**Fix:** `checkout-config.service.ts` should call `getAllowedCountries()` from `site-settings.service.ts` instead of reimplementing the parsing.

### 10. `upsertSetting` imported from payments, not settings

**File:** `packages/core/src/modules/settings/site-settings.service.ts`, line 10

```typescript
import { upsertSetting } from "../payments/gateway-settings";
```

The generic `upsertSetting` helper (insert-or-update a row in the `settings` KV table) lives in the payments module (`gateway-settings.ts`) but is used by the settings module for currency, theme, and allowed-countries operations.

**Impact:** Circular conceptual dependency. Settings depends on payments for a generic utility.

**Fix:** Move `upsertSetting` (and `upsertEncryptedSetting`) to `packages/core/src/modules/settings/settings.service.ts` or a dedicated `settings-utils.ts`, then re-export from payments for backward compatibility.

### 11. `CheckoutFlowSettings` and `AuthSettingsBuilder` both POST to `/auth` endpoint

**Files:**
- `apps/admin/src/components/admin/settings/CheckoutFlowSettings.tsx`, line 61
- `apps/admin/src/components/admin/settings/AuthSettingsBuilder.tsx`, line 66

Both components fetch from and POST to `/api/v1/admin/settings/auth`. The `/auth` endpoint handles a mix of concerns: authentication method, WhatsApp config, guest checkout, checkout mode, and partial payments. Two separate UI components write overlapping subsets to the same endpoint.

**Impact:** If a user saves auth settings in one tab, then saves checkout flow in another tab, the second save may overwrite fields from the first save with stale values (since each only sends a subset of fields). The API handler uses `if (body.X) updates.X = body.X` guards, but `if (body.guestCheckoutEnabled)` would fail to send `false` because `false` is falsy. Line 98 correctly uses `typeof body.guestCheckoutEnabled === "boolean"`, but line 95 uses `if (body.authVerificationMethod)` which would skip an empty string.

**Fix:** Split the `/auth` endpoint into `/auth/verification` and `/auth/checkout-flow`, or use a single source of truth in the UI with a shared state hook.

---

## Maintainability Concerns

### 12. CurrencySettingsBuilder embeds 200+ hardcoded currency entries

**File:** `apps/admin/src/components/admin/settings/CurrencySettingsBuilder.tsx`, lines 26-212

The `CURRENCIES` array contains 200+ entries with codes, symbols, names, and decimal places, hardcoded inline in a React component. This data is also partially duplicated in `@scalius/shared/currency` (which has `getDecimalPlaces()`).

**Impact:** If a currency is added or corrected, it must be updated in multiple places. The 200-line constant also bloats the component file to 448 lines.

**Fix:** Move the currency data to `@scalius/shared/currency` as the single source of truth. Import and use from the component.

### 13. No Zod validation in core service layer

**Files:** `packages/core/src/modules/settings/site-settings.service.ts`, `packages/core/src/modules/settings/checkout-config.service.ts`

All validation happens in the API route Zod schemas. The core services accept raw objects without validation. If any other entry point (queue consumer, background job) calls these services, invalid data would pass through.

The settings module has no `settings.validation.ts` file, unlike other domains (e.g., `orders.validation.ts`, `products.validation.ts`).

### 14. Admin UI components have inconsistent loading patterns

Some components use `isFetching`/`isLoading` (SeoSettingsBuilder, SecuritySettingsBuilder), while others use `loading`/`saving` (AuthSettingsBuilder, CurrencySettingsBuilder, EmailSettingsForm). Some track dirty state (`ThemeSettingsPage`), while most do not -- pressing Save when nothing changed still makes an API call.

| Component | Loading state name | Saving state name | Dirty tracking |
|-----------|-------------------|-------------------|----------------|
| `ThemeSettingsPage.tsx` | `loading` | `saving` | Yes |
| `AuthSettingsBuilder.tsx` | `loading` | `saving` | No |
| `CurrencySettingsBuilder.tsx` | `loading` | `saving` | No |
| `CheckoutFlowSettings.tsx` | `loading` | `saving` | No |
| `SeoSettingsBuilder.tsx` | `isFetching` | `isLoading` | No |
| `SecuritySettingsBuilder.tsx` | `isFetching` | `isLoading` | No |
| `StorefrontUrlBuilder.tsx` | (none -- no fetch spinner) | `isLoading` | No |
| `EmailSettingsForm.tsx` | `loading` | `saving` | No |

**Fix:** Standardize on `loading`/`saving` for all settings components. Add dirty tracking to prevent unnecessary saves.

### 15. Three builder components live outside the settings directory

**Files:**
- `apps/admin/src/components/admin/SeoSettingsBuilder.tsx`
- `apps/admin/src/components/admin/SecuritySettingsBuilder.tsx`
- `apps/admin/src/components/admin/StorefrontUrlBuilder.tsx`

These are settings components consumed by `GeneralSettingsPage.tsx` but live one directory up from the rest of the settings components. The lazy imports use `"../SeoSettingsBuilder"` instead of `"./SeoSettingsBuilder"`.

**Impact:** File navigation confusion. Settings components are split across two directories.

**Fix:** Move all three into `apps/admin/src/components/admin/settings/`.

---

## Performance & Scalability

### 16. KV cache invalidation is inconsistent across settings types

| Cache Key | TTL | Invalidated by | Method |
|-----------|-----|----------------|--------|
| `gw:site_settings` | 300s | Header, footer, SEO, storefront-url, auth saves | `invalidateSiteSettingsCache()` |
| `gw:currency` | 300s | Currency save | Raw `kv?.delete("gw:currency")` in route |
| `gw:storefront_url` | 300s | Storefront URL save | `layoutCache.invalidate()` + `invalidateSiteSettingsCache()` |
| `gw:stripe` | 300s | Stripe save | `invalidateStripeCache()` |
| `gw:sslcommerz` | 300s | SSLCommerz save | `invalidateSSLCommerzCache()` |
| `gw:polar` | 300s | Polar save | `invalidatePolarCache()` |
| `api:storefront:layout:*` | varies | Theme save | `deleteCacheByPattern()` |
| `security:csp_allowed_domains` | none | Security save | `env.CACHE.put()` |

Currency cache invalidation is a raw `kv?.delete()` call in the route handler instead of a dedicated function, unlike all other settings. The security CSP cache uses `env.CACHE.put()` (writing to KV) instead of the standard `getKv()` pattern.

**Fix:** Create `invalidateCurrencyCache(kv)` in `settings.service.ts`. Standardize the CSP cache to use `getKv()`.

### 17. `getCheckoutConfig` makes N+1 gateway calls

**File:** `packages/core/src/modules/settings/checkout-config.service.ts`, lines 80-83

```typescript
const gatewaySettingsPromises = registeredGateways.map((gw) =>
    gw.getSettings(db, kv, encryptionKey).catch(() => null)
);
```

Each registered gateway's `getSettings()` call issues a separate DB query (or KV lookup). With 3 gateways, that is 3 additional queries on top of the 3 parallel queries already made (siteSettings, currency, allowedCountries). Total: 6 DB calls per checkout config fetch.

**Impact:** Acceptable for 3-4 gateways with KV caching. If gateway count grows to 7+ (per roadmap), this becomes a concern on cold-cache requests.

**Fix:** Consider a single `readCategory` call that fetches all payment-related settings at once, then distributes to individual gateway parsers.

### 18. `deleteCacheByPattern` on theme save is potentially expensive

**File:** `apps/api/src/routes/admin/settings/site.ts`, line 243

```typescript
await deleteCacheByPattern("api:storefront:layout:*", kv);
```

KV `list()` operations scan key prefixes and can be slow if there are many keys. This is called synchronously in the save handler.

**Fix:** Use `waitUntil()` to perform cache invalidation asynchronously, preventing the admin user from waiting for the KV scan to complete.

---

## Robustness Gaps

### 19. No validation of `partialPaymentAmount` relative to order values

**File:** `apps/api/src/routes/admin/settings/system.ts`, line 109

The `partialPaymentAmount` field accepts any number. There is no validation that it is less than a typical order total, or that it is positive when `partialPaymentEnabled` is true.

**Fix:** Add `z.number().min(0)` and a check that amount > 0 when enabled.

### 20. `DELETE /delivery-locations/all` has no confirmation or soft-delete

**File:** `apps/api/src/routes/admin/settings/delivery-locations.ts`, lines 160-169

```typescript
await db.delete(deliveryLocations);
```

This permanently deletes ALL delivery locations with no soft-delete, no confirmation token, and no guard against accidental calls. All other delete operations in the settings domain use soft-delete.

**Impact:** Accidental API call (or UI bug) permanently destroys all delivery location data with no recovery path.

**Fix:** Require a confirmation body parameter (e.g., `{ confirmDeleteAll: true }`), or change to soft-delete.

### 21. `SeoSettingsBuilder.tsx` double-parses the response on error

**File:** `apps/admin/src/components/admin/SeoSettingsBuilder.tsx`, lines 37-41

```typescript
if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.details || "Failed to fetch SEO settings");
}
const json = await response.json(); // <-- second .json() call
```

If the response is OK, it calls `.json()` twice -- once at line 38 (inside the `!response.ok` block, which won't execute) and once at line 40. But if there was a 200 response with an invalid JSON body, the second `.json()` would fail. More importantly, this pattern is subtly wrong: `.json()` consumes the body stream. If a future refactor moves the error check after the successful parse, the body would already be consumed.

Contrast with other components like `AuthSettingsBuilder.tsx` which correctly check `res.ok` BEFORE calling `.json()`.

### 22. Whatsapp access token stored unencrypted in `siteSettings`

**File:** `packages/database/src/schema/system.ts`, line 47; `apps/api/src/routes/admin/settings/system.ts`, lines 111-113

The WhatsApp access token is stored as plaintext in the `siteSettings.whatsappAccessToken` column. Payment gateway secrets (Stripe secret key, SSLCommerz password, Polar access token) are stored with AES-GCM encryption via `upsertEncryptedSetting`. The WhatsApp token is equally sensitive but receives no encryption.

**Fix:** Encrypt the WhatsApp access token using the same `upsertEncryptedSetting`/`decryptCredentialsGraceful` pattern used for payment credentials. This requires moving it from `siteSettings` to the `settings` KV table, or adding encryption/decryption at the service layer.

---

## LLM-Friendliness

### Strengths

1. **Clear file organization:** The `settings/` directory in both API routes and admin components is well-scoped. Each sub-route file handles one concern.
2. **Consistent OpenAPI schemas:** All route files use `createRoute()` with Zod schemas, making API contracts discoverable.
3. **Lazy-loaded tabs:** `GeneralSettingsPage.tsx` and `CheckoutSettingsPage.tsx` use `React.lazy()` with a `mountedTabs` pattern that prevents re-mounting on tab switch.
4. **Good README documentation:** `packages/core/src/modules/settings/README.md` exists with a function reference and cache key inventory.

### Weaknesses

1. **Route files mix concerns:** `system.ts` handles auth, security, email, AND firebase -- four completely unrelated concerns in one file. An LLM must read 373 lines to understand any one of them.
2. **No TypeScript interfaces for settings shapes:** The KV `settings` table stores everything as `string` values. The actual shape of each category (currency keys, firebase keys, email keys) is only discoverable by reading route handlers. There are no shared type definitions.
3. **`payment-gateway-utils.tsx` exports types but is a React file:** LLMs looking for payment settings types would need to search inside a `.tsx` file rather than a dedicated `.ts` types file.

### Recommendations for LLM readability

- Split `system.ts` into `auth.ts`, `security.ts`, `email.ts`, `firebase.ts` and mount each in the settings aggregator.
- Create a `settings.types.ts` in core that defines `CurrencySettingsPayload`, `SeoSettingsPayload`, `AuthSettingsPayload`, etc.
- Add JSDoc to each route handler explaining which table(s) it reads/writes and which cache keys it invalidates.

---

## Recommended Changes

### Priority 1 -- Data Correctness

| # | Issue | File | Fix |
|---|-------|------|-----|
| 1 | Hero slider timestamps use `CURRENT_TIMESTAMP` (ISO string) instead of Unix epoch | `apps/api/src/routes/admin/settings/hero-sliders.ts` | Replace `sql\`CURRENT_TIMESTAMP\`` with `sql\`(cast(strftime('%s','now') as int))\`` (4 locations) |
| 2 | `DELETE /delivery-locations/all` hard-deletes with no guard | `apps/api/src/routes/admin/settings/delivery-locations.ts:160` | Add `{ confirmDeleteAll: true }` body requirement |
| 3 | WhatsApp token stored unencrypted | `apps/api/src/routes/admin/settings/system.ts`, schema `system.ts` | Encrypt like payment gateway credentials |

### Priority 2 -- Architecture Fixes

| # | Issue | File | Fix |
|---|-------|------|-----|
| 4 | Route handlers inline DB queries (thin-layer violation) | All 7 sub-route files | Extract service functions to `@scalius/core/modules/settings/` |
| 5 | `upsertSetting` lives in payments module | `packages/core/src/modules/payments/gateway-settings.ts` | Move to settings module, re-export from payments |
| 6 | Allowed countries parsing duplicated | `site-settings.service.ts` + `checkout-config.service.ts` | `checkout-config` should call `getAllowedCountries()` |
| 7 | `delivery-locations.ts` not mounted through settings aggregator | `apps/api/src/app.ts:330` | Move mount to `settings.ts` aggregator |

### Priority 3 -- Code Quality Cleanup

| # | Issue | File | Fix |
|---|-------|------|-----|
| 8 | 9 `as any` type casts | `shipping.ts`, `delivery-providers.ts`, `meta-conversions-admin.ts`, `delivery-locations.ts` | Fix underlying Zod/Hono type mismatches |
| 9 | Redundant try/catch/throw in 7 files | All route files | Remove passthrough try/catch blocks |
| 10 | Inconsistent `MASKED` / `MASKED_VALUE` constants | 7+ files | Centralize to one export |
| 11 | `system.ts` bundles 4 unrelated concerns | `system.ts` | Split into `auth.ts`, `security.ts`, `email.ts`, `firebase.ts` |
| 12 | 3 builder components misplaced outside settings dir | `SeoSettingsBuilder.tsx`, `SecuritySettingsBuilder.tsx`, `StorefrontUrlBuilder.tsx` | Move to `settings/` directory |
| 13 | `console.error` in route handlers | `shipping.ts`, `delivery-locations.ts` | Remove (Hono error handler logs already) |
| 14 | Currency data hardcoded in component | `CurrencySettingsBuilder.tsx` | Move to `@scalius/shared/currency` |
| 15 | Inconsistent admin UI state naming | All settings components | Standardize on `loading`/`saving` |

### Priority 4 -- Test Coverage

| # | Area | What to test |
|---|------|--------------|
| 1 | Core services | `getCurrencyConfig`, `getSiteSettings`, `getCheckoutConfig` -- verify caching, fallback defaults |
| 2 | `site-settings.service.ts` | `saveHeaderConfig`/`saveFooterConfig` race condition on fresh DB |
| 3 | Checkout config gateway resolution | Verify `getCheckoutConfig` respects `checkoutMode` filtering |
| 4 | Allowed countries parsing | Both old array format and new `{ countries, mode }` format |
| 5 | Hero slider timestamps | Verify timestamps are stored as integers, not ISO strings |
