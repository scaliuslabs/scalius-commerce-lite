# Navigation Domain Audit

**Date:** 2026-03-20
**Scope:** Complete vertical slice -- schema, core service, API routes (admin + public), admin UI components, storefront consumption

---

## Summary

The navigation domain stores header and footer configuration as JSON blobs in the `siteSettings` singleton row (`headerConfig` / `footerConfig` columns). There is no dedicated `navigation_items` table -- the entire nav tree is serialized JSON. The admin side is well-built (drag-and-drop tree builder with recursive nesting, indent/outdent, depth limits). The public API side has **significant duplication** -- the same "build default nav from categories + pages" logic exists in three separate locations. Validation is weak on the API save path, using `z.record(z.string(), z.any())` instead of the well-defined recursive `NavigationItem` schema that already exists in the same file. The storefront consumption path works correctly through the consolidated `/storefront/layout` endpoint.

**Overall Grade:** B- (functional, well-designed admin UI, but API layer has structural problems)

---

## Critical Issues

### 1. Ghost Endpoint: `preview-products` Does Not Exist

**Severity:** High (broken UI feature)
**Files:**
- `apps/admin/src/components/admin/navigation/AddNavItemDialog.tsx` (lines 189-213)

The `AddNavItemDialog` component makes a fetch to `/api/v1/admin/navigation/preview-products` when building "dynamic" navigation links with attribute filters. This endpoint does not exist anywhere in `apps/api/src/routes/`. The fetch silently fails (caught in try/catch), so the preview count always stays `null`. The dynamic link builder appears to work but the "X products" badge never renders.

**Fix:** Either implement the endpoint in `apps/api/src/routes/admin/navigation.ts` (query products by category + attribute filters and return a count), or remove the preview UI entirely.

### 2. `z.record(z.string(), z.any())` Bypasses Validation on Save

**Severity:** High (data integrity)
**Files:**
- `apps/api/src/routes/admin/navigation.ts` (line 120)

The `saveConfigSchema` defines `config` as `z.record(z.string(), z.any())`, meaning literally anything can be saved as navigation config. This is especially dangerous because:
- A `navigationItemSchema` with proper recursive `z.lazy()` validation already exists in the same file (lines 108-115) but is never used for save validation
- Malformed JSON persisted here will break the storefront header/footer rendering with no error until runtime
- The header config contains nested objects (topBar, logo, contact, social, navigation) -- all bypassed

**Fix:** Replace `z.record(z.string(), z.any())` with actual schema validation. The header config should validate against a schema matching `HeaderConfig` from `apps/admin/src/components/admin/header-builder/types.ts`. The footer config should validate against `FooterConfig` from `apps/admin/src/components/admin/footer-builder/types.ts`. At minimum, validate the `navigation` array within the config using the existing `navigationItemSchema`.

### 3. DELETE Route Requires a Request Body

**Severity:** Medium (HTTP convention violation)
**Files:**
- `apps/api/src/routes/admin/navigation.ts` (lines 209-248)

The `DELETE /admin/navigation/{id}` route requires a JSON body containing `{ type: "header" | "footer" }`. HTTP DELETE requests with bodies are technically allowed but widely discouraged and some clients/proxies strip DELETE bodies. This should use a query parameter instead, or the route path should encode the type (e.g., `DELETE /admin/navigation/{id}/header`).

---

## Code Quality Issues

### 1. Three Copies of Default Navigation Fallback Logic

**Files (all three contain the same pattern):**
- `apps/api/src/routes/navigation.ts` (lines 102-153) -- public `/navigation` route
- `packages/core/src/modules/storefront/storefront.service.ts` (lines 246-265) -- `getLayoutData()`
- `packages/core/src/modules/navigation/navigation.service.ts` (lines 6-49) -- admin item fetcher (partial overlap)

All three locations query categories (where `deletedAt IS NULL`) and pages (where `deletedAt IS NULL AND isPublished = true`), then build nav items with URLs like `/categories/{slug}` and `/{slug}`. If the URL pattern for categories ever changes, three files need updating. The `navigation.service.ts` version returns raw `{ categories, pages }` while the other two build a tree structure with "Home" + "Categories" dropdown + pages.

**Fix:** Extract the "build default navigation from DB entities" logic into a single function in `packages/core/src/modules/navigation/navigation.service.ts`. Import it in both the public route and the storefront service.

### 2. `z.any()` in Response Schemas

**Files:**
- `apps/api/src/routes/admin/navigation.ts` (lines 76-77) -- `headerConfig: z.any(), footerConfig: z.any()`
- `apps/api/src/routes/navigation.ts` (lines 53, 178) -- `navigation: z.record(z.string(), z.any())`, `items: z.array(z.any())`

These `z.any()` usages mean the OpenAPI spec provides no useful type information for navigation responses. Generated SDK types will all be `unknown` for these fields.

### 3. Unused `navigationItemSchema`

**File:** `apps/api/src/routes/admin/navigation.ts` (lines 108-115)

The well-crafted recursive `z.lazy()` schema for `NavigationItem` is defined but never referenced in any route validation. It exists as dead code.

### 4. `NavigationItem` Type Defined in 4+ Places

The `NavigationItem` interface is independently defined in:
- `apps/admin/src/components/admin/navigation/types.ts` (lines 3-8) -- `{ id, title, href?, subMenu? }`
- `apps/api/src/routes/admin/navigation.ts` (lines 101-106) -- identical shape
- `apps/api/src/routes/navigation.ts` (lines 24-28) -- `{ title, href, subMenu? }` (no `id`)
- `apps/storefront/src/lib/api/types.ts` (lines 246-251) -- `{ id?, title, href?, subMenu? }` (optional `id`)
- `packages/core/src/modules/storefront/storefront.service.ts` -- inline `NestedNavigationItem` type

The `id` field is required on the admin side but optional on the storefront side. The public navigation route's version omits `id` entirely. These divergences make it unclear what shape the client should expect.

**Fix:** Define `NavigationItem` once in `@scalius/shared` or `@scalius/database` and import everywhere.

---

## Pattern Violations

### 1. Admin Navigation Save Goes Through Two Competing API Paths

The admin header builder (`apps/admin/src/components/admin/header-builder/HeaderBuilder.tsx`) saves to `/api/v1/admin/settings/header` (line 103), while the admin navigation API route file (`apps/api/src/routes/admin/navigation.ts`) provides `POST /admin/navigation` with `{ type: "header", config: ... }`. These are two different save paths that both write to the same `siteSettings.headerConfig` column. The header builder does NOT use the navigation route -- it uses a settings route. This means:
- The navigation route's POST handler may be dead code for header saves
- Or there's a second consumer using it that's not immediately obvious
- Cache invalidation happens in both paths but through different mechanisms

### 2. Inconsistent Cache Invalidation

**Files:**
- `apps/api/src/routes/admin/navigation.ts` -- calls `invalidateSiteSettingsCache(getKv())` after save
- `apps/api/src/routes/navigation.ts` -- uses `cacheMiddleware({ ttl: 3600 })` with hardcoded 3600 instead of `CACHE_TTLS.STANDARD`
- `apps/api/src/routes/header.ts` and `apps/api/src/routes/footer.ts` -- use `CACHE_TTLS.STANDARD`
- Storefront edge cache uses `BUILD_ID`-keyed cache -- not invalidated by admin save at all

The storefront layout cache (`storefront_layout_${BUILD_ID}`) is never explicitly busted when navigation is saved. Users must wait for TTL expiry or redeploy.

### 3. Footer Builder Uses `NavigationBuilder` But Ignores `getStorefrontPath`

**File:** `apps/admin/src/components/admin/footer-builder/NavigationMenusSection.tsx` (line 176)

```tsx
getStorefrontPath={() => "#"}
```

The footer builder passes a stub function that always returns `"#"` for storefront URLs. The "open in new tab" button on footer nav items will navigate to `#` instead of the actual storefront page.

---

## Maintainability Concerns

### 1. JSON Blob Storage with No Schema Versioning

The `headerConfig` and `footerConfig` columns store arbitrary JSON with no version field. Both `HeaderBuilder` and `FooterBuilder` include `migrateConfig()` functions that handle legacy formats at runtime. As the config shape evolves, these migration functions grow without bound. There's no way to batch-migrate existing config in the database -- every read must run through the migration function.

**Affected files:**
- `apps/admin/src/components/admin/header-builder/HeaderBuilder.tsx` (lines 24-69)
- `apps/admin/src/components/admin/footer-builder/FooterBuilder.tsx` (lines 27-74)

### 2. Core Service is Minimal -- Most Logic Lives in API Routes

`packages/core/src/modules/navigation/navigation.service.ts` contains a single function (49 lines) that returns categories and pages. All actual navigation CRUD (save/update/delete config) lives directly in the API route file (`apps/api/src/routes/admin/navigation.ts`). This violates the project's "thin HTTP layer" convention. Business logic (building default nav, merging config, cache invalidation) should be in the core service.

### 3. `MAX_NAV_DEPTH = 10` May Be Overly Generous

**File:** `apps/admin/src/components/admin/navigation/types.ts` (line 29)

Allowing 10 levels of navigation nesting creates practical problems:
- The mobile menu (`MobileMenu.astro`) only renders 3 levels deep (hardcoded template with level 1, 2, 3 -- lines 56-159)
- The desktop nav (`RecursiveDesktopNav.astro`) is truly recursive but screen real estate runs out at ~4 levels of flyout
- Each nesting level adds 20px indent in the admin builder, so 10 levels = 200px consumed

---

## Performance & Scalability

### 1. Full `siteSettings` Row Fetched on Every Public Navigation Request

**Files:**
- `apps/api/src/routes/navigation.ts` (line 66): `db.select().from(siteSettings).limit(1)` -- fetches ALL columns
- `apps/api/src/routes/header.ts` (line 74): same pattern
- `apps/api/src/routes/footer.ts` (line 82): same pattern

Each of these public routes fetches the entire `siteSettings` singleton including all columns (WhatsApp tokens, checkout mode, SEO fields, etc.) when they only need `headerConfig` or `footerConfig`. The storefront layout endpoint (`storefront.service.ts` line 184) correctly selects only `{ headerConfig, footerConfig }`.

**Fix:** Use targeted `select({ headerConfig })` in the individual routes.

### 2. Navigation JSON Parsed on Every Request

The `headerConfig` and `footerConfig` values are stored as JSON strings and parsed with `JSON.parse()` on every request. For the storefront layout endpoint this is fine (cached). For the admin GET endpoint, this happens on every page load. If the JSON blob grows large (many menu items, deeply nested), parsing becomes measurable.

### 3. No Size Limit on Navigation Config

There is no validation on the size of the config JSON being saved. A deeply nested tree with thousands of items would:
- Slow down every storefront page load (JSON parse on every layout fetch)
- Eventually hit D1's row size limits
- Make the admin builder unusable (rendering thousands of drag-and-drop rows)

### 4. Drag-and-Drop Uses Different Libraries for Same Level vs. Cross-Level

The `NavigationBuilder` uses `@hello-pangea/dnd` for drag-and-drop, which works for same-list reordering. However, cross-list dragging (moving items between nesting levels via drag) is not supported -- the `handleDragEnd` only handles `source.droppableId === destination.droppableId`. Users must use indent/outdent instead. This is a UX limitation, not a bug, but worth noting for future enhancement.

---

## Robustness Gaps

### 1. No Validation That Referenced Categories/Pages Still Exist

When a user adds a category to the navigation and later deletes that category, the nav item persists with a dead link (e.g., `/categories/deleted-slug`). There is no reconciliation step that checks whether referenced entities still exist.

**Fix:** Add a lightweight validation on `GET /admin/navigation` that marks stale links, or add a reconciliation job on category/page delete.

### 2. `JSON.parse()` Without Try/Catch in Multiple Locations

**Files:**
- `apps/api/src/routes/admin/navigation.ts` (lines 93-94): `JSON.parse(row.headerConfig)` and `JSON.parse(row.footerConfig)` -- if either column contains corrupt JSON, the entire admin navigation page crashes
- `apps/api/src/routes/navigation.ts` (lines 77, 91): same pattern in public route

The storefront service (`storefront.service.ts`) also has raw `JSON.parse()` without try/catch for navigation config.

**Fix:** Wrap all `JSON.parse()` calls in try/catch, returning `{}` on failure.

### 3. Concurrent Admin Edits Can Overwrite Each Other

Two admins editing navigation simultaneously will overwrite each other's changes. The save path does:
1. Read existing siteSettings row
2. Update the relevant config column
3. No version check / optimistic concurrency

This is a general siteSettings problem, not navigation-specific, but navigation edits (complex tree structures) are the most likely to be lost.

### 4. `handleDragEnd` Does Not Handle Cross-List Drops Gracefully

**File:** `apps/admin/src/components/admin/navigation/NavigationBuilder.tsx` (lines 231-266)

The drag-end handler only processes `source.droppableId === destination.droppableId` (same-list reorder). If a cross-list drop occurs (shouldn't, since each droppable has a unique `type`), the result is silently ignored. The `type` prop on `<Droppable>` prevents this in practice, but the handler should still log or handle unexpected states.

---

## LLM-Friendliness

### Good Patterns

1. **Clear type definitions in `types.ts`** -- The admin navigation types file (`apps/admin/src/components/admin/navigation/types.ts`) is self-contained and clearly documents the `NavigationItem` shape with comments. An LLM can read this file and understand the domain model immediately.

2. **Recursive tree operations are well-named** -- Functions like `updateItem`, `removeItem`, `addItemsToPath`, `handleIndent`, `handleOutdent` in `NavigationBuilder.tsx` have clear names and predictable signatures.

3. **Comprehensive README** -- `packages/core/src/modules/navigation/README.md` has an accurate data flow diagram and documents known gaps. This is excellent for LLM context.

### Problem Areas

1. **Four competing `NavigationItem` type definitions** make it unclear which is canonical. An LLM asked to "update the NavigationItem type" would need to update 4+ files.

2. **Save path ambiguity** -- The header builder saves to `/admin/settings/header` while the navigation route provides `POST /admin/navigation`. An LLM adding a new field to header config would need to trace both paths.

3. **Inline `Record<string, unknown>` casts** throughout the builder migration functions (`as Record<string, unknown>`) are opaque and would confuse an LLM trying to understand the actual type of the data.

4. **Commented-out code** in `NavigationBuilder.tsx` (line 196) -- `// const parentPath = pathParts.slice(0, -1).join(".");` and `// const parentIndex = pathParts[pathParts.length - 1];`. Dead code in the outdent handler is confusing.

---

## Recommended Changes

### Priority 1 (High Impact, Low Effort)

1. **Wrap all `JSON.parse()` in try/catch** across all navigation-related files. Return `{}` on failure. (~15 minutes, 4 files)

2. **Replace `z.record(z.string(), z.any())` with typed schema** for the save config body in `apps/api/src/routes/admin/navigation.ts`. Use the existing `navigationItemSchema` for the navigation array. (~30 minutes)

3. **Fix the hardcoded `3600` TTL** in `apps/api/src/routes/navigation.ts` to use `CACHE_TTLS.STANDARD` for consistency. (~2 minutes)

4. **Remove commented-out code** in `NavigationBuilder.tsx` line 196-197. (~1 minute)

### Priority 2 (Medium Impact, Medium Effort)

5. **Extract default navigation builder** into a shared function in `packages/core/src/modules/navigation/navigation.service.ts` and call it from both `apps/api/src/routes/navigation.ts` and `packages/core/src/modules/storefront/storefront.service.ts`. (~1 hour)

6. **Implement or remove the `preview-products` endpoint**. Either add `GET /admin/navigation/preview-products` that counts products by category + attribute filters, or remove the preview UI from `AddNavItemDialog.tsx`. (~1 hour to implement, ~15 minutes to remove)

7. **Use targeted `select()` in public routes** -- change `db.select().from(siteSettings)` to `db.select({ headerConfig: siteSettings.headerConfig })` in `header.ts`, `footer.ts`, and `navigation.ts`. (~15 minutes)

8. **Fix footer builder `getStorefrontPath`** -- pass a real implementation instead of `() => "#"` in `NavigationMenusSection.tsx`. The `useStorefrontUrl` hook should be called in the `FooterBuilder` and threaded through. (~30 minutes)

### Priority 3 (Future Consideration)

9. **Consolidate `NavigationItem` type** to a single canonical definition, ideally in `@scalius/shared` since both admin and storefront need it.

10. **Add config versioning** -- include a `version` field in the headerConfig/footerConfig JSON so the migration functions can branch cleanly and eventually drop legacy support.

11. **Reduce `MAX_NAV_DEPTH`** from 10 to 4 or 5. The mobile menu hardcodes 3 levels, and desktop flyouts become unusable beyond 4.

12. **Add dead link detection** -- on admin GET, compare stored navigation URLs against current categories/pages and flag stale entries.

13. **Add storefront cache purge** -- when navigation is saved via admin, trigger a cache purge for the storefront layout cache (not just the KV `gw:site_settings` key).

---

## File Inventory

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Schema | `packages/database/src/schema/system.ts` (lines 26-58) | 32 | `siteSettings` table with `headerConfig` and `footerConfig` text columns |
| Core Service | `packages/core/src/modules/navigation/navigation.service.ts` | 50 | `getNavigationItems()` -- returns categories + pages for admin picker |
| Core Service | `packages/core/src/modules/navigation/index.ts` | 1 | Barrel export |
| Core Service (related) | `packages/core/src/modules/storefront/storefront.service.ts` (lines 172-341) | ~170 | `getLayoutData()` -- builds navigation from headerConfig with fallback |
| Admin API Route | `apps/api/src/routes/admin/navigation.ts` | 250 | CRUD for navigation config (5 endpoints) |
| Public API Route | `apps/api/src/routes/navigation.ts` | 253 | Public navigation endpoints (2 endpoints) |
| Public API Route | `apps/api/src/routes/header.ts` | 112 | Public header config endpoint |
| Public API Route | `apps/api/src/routes/footer.ts` | 117 | Public footer config endpoint |
| Public API Route | `apps/api/src/routes/storefront.ts` (lines 47-78) | 31 | Consolidated `/storefront/layout` endpoint |
| Admin UI | `apps/admin/src/components/admin/navigation/NavigationBuilder.tsx` | 398 | Drag-and-drop tree builder |
| Admin UI | `apps/admin/src/components/admin/navigation/SortableNavItem.tsx` | 305 | Recursive sortable row component |
| Admin UI | `apps/admin/src/components/admin/navigation/AddNavItemDialog.tsx` | 779 | Multi-type add item dialog |
| Admin UI | `apps/admin/src/components/admin/navigation/types.ts` | 46 | Type definitions + depth colors |
| Admin UI (consumer) | `apps/admin/src/components/admin/header-builder/HeaderBuilder.tsx` | 218 | Uses NavigationBuilder in Navigation tab |
| Admin UI (consumer) | `apps/admin/src/components/admin/header-builder/NavigationSection.tsx` | 23 | Thin wrapper passing props to NavigationBuilder |
| Admin UI (consumer) | `apps/admin/src/components/admin/footer-builder/NavigationMenusSection.tsx` | 192 | Uses NavigationBuilder per footer menu column |
| Storefront | `apps/storefront/src/lib/api/navigation.ts` | 40 | `getNavigationData()` -- SDK-based nav fetcher (possibly unused in favor of layout endpoint) |
| Storefront | `apps/storefront/src/components/header/DesktopNav.astro` | 303 | Desktop nav rendering with overflow "More" menu |
| Storefront | `apps/storefront/src/components/header/RecursiveDesktopNav.astro` | 60 | Recursive flyout submenu rendering |
| Storefront | `apps/storefront/src/components/header/MobileMenu.astro` | 235 | Mobile drawer with 3-level hardcoded nesting |
