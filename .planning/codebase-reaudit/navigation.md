# Navigation Domain Re-Audit

**Date:** 2026-03-21
**Previous Audit:** 2026-03-20
**Scope:** Full vertical slice -- core service, validation, API routes (admin + public), admin UI, storefront consumption

---

## Summary

The fix session made substantial improvements to the navigation domain. A proper `navigation.validation.ts` file was created with typed Zod schemas (`headerConfigSchema`, `footerConfigSchema`, `navigationItemSchema`). The core service (`navigation.service.ts`) was significantly expanded from a single function to six functions covering full CRUD, JSON.parse with try/catch, and a shared `buildDefaultNavigation()` helper. However, the admin API route (`apps/api/src/routes/admin/navigation.ts`) was NOT updated to use ANY of the new service functions or validation schemas -- it still contains inline DB queries, raw `JSON.parse()` without try/catch, and `z.record(z.string(), z.unknown())` for save validation. The public navigation route (`apps/api/src/routes/navigation.ts`) was also NOT updated to use the shared `buildDefaultNavigation()`. The fix session created the right abstractions in the core package but forgot to wire them into the consuming routes.

**Overall Grade: 5/10** (up from B-/6 -- paradoxically lower because the new service/validation code is entirely unused, creating dead code AND leaving original issues unresolved)

---

## Previous Findings Status

### Critical Issues

#### 1. Ghost Endpoint: `preview-products` Does Not Exist
**Status: STILL OPEN**

`apps/admin/src/components/admin/navigation/AddNavItemDialog.tsx` (lines 189-213) still fetches `/api/v1/admin/navigation/preview-products`. No such route exists. The RBAC permissions file `packages/core/src/auth/rbac/route-permissions.ts` (line 560) even has a permission entry for this ghost endpoint, but no handler exists in `apps/api/src/routes/admin/navigation.ts`.

#### 2. `z.record(z.string(), z.unknown())` Bypasses Validation on Save
**Status: PARTIALLY FIXED (new code exists but is not wired in)**

A proper `navigation.validation.ts` was created in `packages/core/src/modules/navigation/navigation.validation.ts` with:
- `headerConfigSchema` (lines 34-51) -- validates topBar, logo, favicon, contact, social, navigation
- `footerConfigSchema` (lines 61-68) -- validates logo, tagline, description, copyrightText, menus, social
- `saveNavigationConfigSchema` (lines 71-74) -- wraps type + config with `z.union([headerConfigSchema, footerConfigSchema])`
- Exported from `index.ts`

However, `apps/api/src/routes/admin/navigation.ts` does NOT import any of these schemas. Line 120 still uses:
```typescript
config: z.record(z.string(), z.unknown()),
```

The new validation code is dead code. The original vulnerability remains.

#### 3. DELETE Route Requires a Request Body
**Status: STILL OPEN**

`apps/api/src/routes/admin/navigation.ts` (lines 209-248) still requires `{ type: "header" | "footer" }` as a JSON body on the DELETE request.

### Code Quality Issues

#### 1. Three Copies of Default Navigation Fallback Logic
**Status: PARTIALLY FIXED**

`buildDefaultNavigation()` was added to `packages/core/src/modules/navigation/navigation.service.ts` (lines 194-227). This is the correct single-location extraction. However:
- `apps/api/src/routes/navigation.ts` (lines 101-153) still has its own inline duplicate copy querying categories + pages and building the same nav structure.
- `packages/core/src/modules/storefront/storefront.service.ts` (lines 254-271) still has its own inline duplicate copy.

Neither consumer imports or calls `buildDefaultNavigation()`. The extracted function is dead code.

#### 2. `z.any()` / `z.unknown()` in Response Schemas
**Status: STILL OPEN**

- `apps/api/src/routes/admin/navigation.ts` (lines 76-77): `headerConfig: z.record(z.string(), z.unknown())`, `footerConfig: z.record(z.string(), z.unknown())`
- `apps/api/src/routes/navigation.ts` (line 53): `navigation: z.record(z.string(), z.unknown())`
- `apps/api/src/routes/navigation.ts` (line 180): response schema uses `z.object({...}).passthrough()` with partially typed items

These produce `unknown` in the generated OpenAPI spec/SDK types.

#### 3. Unused `navigationItemSchema` (in admin route)
**Status: STILL OPEN (and now there are TWO unused copies)**

The admin route `apps/api/src/routes/admin/navigation.ts` (lines 108-115) still defines its own local `navigationItemSchema` that is never used in validation. A second copy now exists in `packages/core/src/modules/navigation/navigation.validation.ts` (lines 8-20) -- also never used by any route. Two identical dead schemas.

#### 4. `NavigationItem` Type Defined in 5+ Places
**Status: STILL OPEN (now 6 places)**

Independent definitions:
1. `packages/core/src/modules/navigation/navigation.service.ts` (lines 14-19) -- `{ id, title, href?, subMenu? }` (NEW)
2. `packages/core/src/modules/navigation/navigation.validation.ts` (lines 8-13) -- Zod type annotation (NEW)
3. `apps/api/src/routes/admin/navigation.ts` (lines 101-106) -- local interface
4. `apps/api/src/routes/navigation.ts` (lines 24-28) -- `{ title, href, subMenu? }` (no `id`)
5. `apps/admin/src/components/admin/navigation/types.ts` (lines 3-8) -- `{ id, title, href?, subMenu? }`
6. `apps/storefront/src/lib/api/types.ts` (lines 247-252) -- `{ id?, title, href?, subMenu? }` (optional `id`)
7. `packages/core/src/modules/storefront/storefront.service.ts` (lines 45-50) -- `NestedNavigationItem` inline

The fix session added two more definitions (#1 and #2) instead of consolidating.

### Pattern Violations

#### 1. Admin Navigation Save Goes Through Two Competing API Paths
**Status: STILL OPEN**

The header builder saves to `/api/v1/admin/settings/header`, not through the navigation route. The navigation route's POST handler may be unused for header saves.

#### 2. Inconsistent Cache Invalidation
**Status: STILL OPEN**

`apps/api/src/routes/navigation.ts` (line 16) still uses hardcoded `ttl: 3600` instead of `CACHE_TTLS.STANDARD`. The `CACHE_TTLS` import is absent from this file entirely.

#### 3. Footer Builder Uses `getStorefrontPath={() => "#"}`
**Status: STILL OPEN**

`apps/admin/src/components/admin/footer-builder/NavigationMenusSection.tsx` (line 175) still passes `getStorefrontPath={() => "#"}`.

### Maintainability Concerns

#### 1. JSON Blob Storage with No Schema Versioning
**Status: STILL OPEN**

No version field added to headerConfig/footerConfig JSON. Runtime migration functions in HeaderBuilder/FooterBuilder remain the only migration path.

#### 2. Core Service is Minimal -- Most Logic Lives in API Routes
**Status: PARTIALLY FIXED (inverted problem)**

The core service now has 6 functions covering full CRUD:
- `getNavigationItems()` (lines 26-70)
- `getNavigationMenus()` (lines 73-86)
- `getNavigationMenu()` (lines 89-124)
- `saveNavigationConfig()` (lines 127-153)
- `updateNavigationConfig()` (lines 156-170)
- `deleteNavigationConfig()` (lines 173-186)
- `buildDefaultNavigation()` (lines 194-227)

However, the admin API route (`apps/api/src/routes/admin/navigation.ts`) does NOT call any of these new functions. It still contains inline DB queries for save (lines 146-163), update (lines 194-201), and delete (lines 237-244). The service functions exist but are dead code.

Only `getNavigationItems()` (the original function) is imported and used by the admin route (line 5).

#### 3. `MAX_NAV_DEPTH = 10`
**Status: STILL OPEN**

Unchanged at `apps/admin/src/components/admin/navigation/types.ts` (line 29).

### Performance & Scalability

#### 1. Full `siteSettings` Row Fetched on Every Public Navigation Request
**Status: PARTIALLY FIXED**

- `apps/api/src/routes/admin/navigation.ts` (line 89): now uses targeted `select({ headerConfig, footerConfig })` -- FIXED
- `apps/api/src/routes/navigation.ts` (line 66): still uses `db.select().from(siteSettings).limit(1)` (full row) -- STILL OPEN
- `apps/api/src/routes/navigation.ts` (line 194): still uses `db.select().from(siteSettings).limit(1)` (full row) -- STILL OPEN
- `apps/api/src/routes/header.ts` (line 74): still uses `db.select().from(siteSettings).limit(1)` (full row) -- STILL OPEN
- `apps/api/src/routes/footer.ts` (line 82): still uses `db.select().from(siteSettings).limit(1)` (full row) -- STILL OPEN

Only the admin GET route was fixed.

#### 2. `JSON.parse()` Without Try/Catch in Multiple Locations
**Status: PARTIALLY FIXED**

- `packages/core/src/modules/navigation/navigation.service.ts` (lines 82-83): `getNavigationMenus()` wraps JSON.parse in try/catch -- FIXED (but this function is never called)
- `apps/api/src/routes/admin/navigation.ts` (lines 93-94): raw `JSON.parse()` without try/catch -- STILL OPEN
- `apps/api/src/routes/navigation.ts` (lines 77, 90, 202, 205): raw `JSON.parse()` without try/catch in 4 locations -- STILL OPEN
- `apps/api/src/routes/header.ts` (line 82): raw `JSON.parse()` without try/catch -- STILL OPEN
- `apps/api/src/routes/footer.ts` (line 90): raw `JSON.parse()` without try/catch -- STILL OPEN
- `packages/core/src/modules/storefront/storefront.service.ts`: uses `safeJsonParse()` -- already safe

The storefront service is safe. All API routes remain vulnerable.

### Robustness Gaps

#### 1. No Validation That Referenced Categories/Pages Still Exist
**Status: STILL OPEN**

No dead link detection added.

#### 2. Concurrent Admin Edits Can Overwrite Each Other
**Status: STILL OPEN**

No optimistic concurrency added. The core service functions also lack version checking.

#### 3. Commented-out Code in `NavigationBuilder.tsx`
**Status: STILL OPEN**

`apps/admin/src/components/admin/navigation/NavigationBuilder.tsx` (lines 196-197):
```typescript
// const parentPath = pathParts.slice(0, -1).join(".");
// const parentIndex = pathParts[pathParts.length - 1];
```

---

## New Issues Found

### 1. Dead Code: 6 Unused Service Functions + 1 Validation Module
**Severity:** Medium (code bloat, false sense of safety)

The entire fix session output is dead code:

**`packages/core/src/modules/navigation/navigation.service.ts`:**
- `getNavigationMenus()` (lines 73-86) -- never called
- `getNavigationMenu()` (lines 89-124) -- never called
- `saveNavigationConfig()` (lines 127-153) -- never called
- `updateNavigationConfig()` (lines 156-170) -- never called
- `deleteNavigationConfig()` (lines 173-186) -- never called
- `buildDefaultNavigation()` (lines 194-227) -- never called

**`packages/core/src/modules/navigation/navigation.validation.ts`:**
- `headerConfigSchema` -- never imported by any route
- `footerConfigSchema` -- never imported by any route
- `saveNavigationConfigSchema` -- never imported by any route
- `navigationItemSchema` -- never imported by any route (the admin route has its own local copy)

The barrel export `packages/core/src/modules/navigation/index.ts` re-exports everything, but nothing imports from it except the admin route's existing `getNavigationItems` import.

### 2. Duplicate `navigationItemSchema` Definitions
**Severity:** Low

Two identical Zod schemas exist:
- `packages/core/src/modules/navigation/navigation.validation.ts` (lines 8-20)
- `apps/api/src/routes/admin/navigation.ts` (lines 108-115)

Neither is used for actual validation. If someone eventually wires one in, which is canonical?

### 3. `saveNavigationConfig()` in Service Duplicates Route Logic with Subtle Differences
**Severity:** Low (since unused, but a trap if wired in later)

The service function `saveNavigationConfig()` (lines 127-153) has the same create-or-update logic as the route handler (lines 140-167). If someone wires in the service function, they need to also add cache invalidation (`invalidateSiteSettingsCache(getKv())`) since the service function does not handle it. The route currently handles cache invalidation inline (line 165).

### 4. Header Route Social Links Schema Mismatch
**Severity:** Low

`apps/api/src/routes/header.ts` (line 104) returns `social: { facebook: headerConfig.social?.facebook || "" }` -- a flat object with a single `facebook` string. But the actual header config stores social as an array of `{ id, label, url }` objects (per the admin builder and the `headerConfigSchema` in `navigation.validation.ts`). The header route returns a completely wrong shape for social links.

This means the standalone `/header` endpoint returns a different social format than the `/storefront/layout` endpoint. Any consumer of `/header` gets broken social data.

### 5. `getNavigationMenu()` Service Function Uses Unsafe Type Assertions
**Severity:** Low (since unused)

`packages/core/src/modules/navigation/navigation.service.ts` (lines 89-124) casts extensively with `as Record<string, unknown>`, which masks type errors. If this function were wired in, runtime errors from unexpected JSON shapes would surface as property access on wrong types rather than clear validation failures.

---

## Scorecard

| Category | Score | Notes |
|----------|-------|-------|
| Data Integrity | 4/10 | Save validation still uses `z.unknown()` despite typed schemas existing |
| Error Handling | 3/10 | 6 raw `JSON.parse()` calls across routes without try/catch |
| Code Duplication | 3/10 | Default nav built in 3 places; extracted helper exists but unused |
| Dead Code | 2/10 | 6 service functions + 4 validation schemas + 2 Zod schemas are dead |
| API Conventions | 5/10 | Routes use `ok()`/`ApiError` correctly; DELETE body and hardcoded TTL remain |
| Type Safety | 4/10 | 6+ competing NavigationItem definitions; `z.unknown()` in OpenAPI |
| Performance | 5/10 | Admin GET route fixed; all 4 public routes still fetch full siteSettings row |
| Storefront | 7/10 | Layout endpoint works correctly with `safeJsonParse()`; nav fetcher exists |
| Admin UI | 7/10 | Builder works well; ghost `preview-products` and `getStorefrontPath={() => "#"}` remain |

**Overall: 5/10**

---

## Recommended Fixes (Priority Order)

### Priority 1: Wire in existing code (all abstractions exist, just need imports)

1. **Replace inline CRUD in admin route with service calls**
   - Files: `apps/api/src/routes/admin/navigation.ts`
   - Import and call `getNavigationMenus()`, `saveNavigationConfig()`, `updateNavigationConfig()`, `deleteNavigationConfig()` from `@scalius/core/modules/navigation`
   - Keep cache invalidation in the route (after service call)
   - ~30 minutes

2. **Replace `z.record(z.string(), z.unknown())` with imported validation schemas**
   - Files: `apps/api/src/routes/admin/navigation.ts`
   - Import `saveNavigationConfigSchema` (or `headerConfigSchema`/`footerConfigSchema`) from `@scalius/core/modules/navigation`
   - Remove the local duplicate `navigationItemSchema` and `saveConfigSchema`
   - ~15 minutes

3. **Replace inline default nav in public route with `buildDefaultNavigation()`**
   - Files: `apps/api/src/routes/navigation.ts`
   - Import `buildDefaultNavigation` from `@scalius/core/modules/navigation`
   - Replace lines 101-153 with a call to it
   - ~15 minutes

4. **Replace inline default nav in storefront service with `buildDefaultNavigation()`**
   - Files: `packages/core/src/modules/storefront/storefront.service.ts` (lines 254-271)
   - Import and call `buildDefaultNavigation(db)` instead of inline queries
   - Note: storefront service uses a batch query pattern, so this may need the batch results passed rather than a new DB call. Evaluate whether to accept the extra query or keep inline.
   - ~30 minutes

### Priority 2: Safety fixes

5. **Wrap all `JSON.parse()` in try/catch** in route files
   - Files: `apps/api/src/routes/navigation.ts` (4 locations), `apps/api/src/routes/header.ts` (1), `apps/api/src/routes/footer.ts` (1), `apps/api/src/routes/admin/navigation.ts` (2 -- if not replaced by service calls)
   - Return `{}` on parse failure
   - ~15 minutes

6. **Fix hardcoded `ttl: 3600`**
   - File: `apps/api/src/routes/navigation.ts` (line 16)
   - Import `CACHE_TTLS` from `../../utils/cache-ttls` and use `CACHE_TTLS.STANDARD`
   - ~2 minutes

7. **Use targeted `select()` in public routes**
   - Files: `apps/api/src/routes/navigation.ts` (2 locations), `apps/api/src/routes/header.ts` (1), `apps/api/src/routes/footer.ts` (1)
   - Change `db.select().from(siteSettings)` to `db.select({ headerConfig: siteSettings.headerConfig, ... })`
   - ~10 minutes

### Priority 3: Cleanup

8. **Remove commented-out code** in `NavigationBuilder.tsx` lines 196-197
9. **Delete duplicate `NavigationItem` type** from admin route (lines 101-106) once service type is used
10. **Fix header route social links** to return array format matching actual data shape
11. **Remove or implement `preview-products` endpoint**

---

## File Inventory (Updated)

| Layer | File | Lines | Status |
|-------|------|-------|--------|
| Core Service | `packages/core/src/modules/navigation/navigation.service.ts` | 228 | Expanded (6 new functions, all dead code) |
| Core Validation | `packages/core/src/modules/navigation/navigation.validation.ts` | 77 | NEW (all dead code) |
| Core Barrel | `packages/core/src/modules/navigation/index.ts` | 2 | Updated (exports validation) |
| Admin API Route | `apps/api/src/routes/admin/navigation.ts` | 250 | Unchanged (does not use new service/validation) |
| Public API Route | `apps/api/src/routes/navigation.ts` | 253 | Unchanged (does not use `buildDefaultNavigation`) |
| Public Header Route | `apps/api/src/routes/header.ts` | 112 | Unchanged (full select, no try/catch, wrong social shape) |
| Public Footer Route | `apps/api/src/routes/footer.ts` | 117 | Unchanged (full select, no try/catch) |
| Storefront Service | `packages/core/src/modules/storefront/storefront.service.ts` | ~350 | Unchanged (inline default nav, but uses `safeJsonParse`) |
| Admin UI Types | `apps/admin/src/components/admin/navigation/types.ts` | 46 | Unchanged |
| Admin UI Builder | `apps/admin/src/components/admin/navigation/NavigationBuilder.tsx` | 398 | Unchanged (commented-out code remains) |
| Admin UI Dialog | `apps/admin/src/components/admin/navigation/AddNavItemDialog.tsx` | ~779 | Unchanged (ghost endpoint remains) |
| Footer Builder | `apps/admin/src/components/admin/footer-builder/NavigationMenusSection.tsx` | 192 | Unchanged (`getStorefrontPath={() => "#"}` remains) |
| Storefront Types | `apps/storefront/src/lib/api/types.ts` | ~280 | Unchanged (separate NavigationItem definition) |
| Storefront Nav | `apps/storefront/src/lib/api/navigation.ts` | 42 | Unchanged |
