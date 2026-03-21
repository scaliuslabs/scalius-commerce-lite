# Pages Domain Re-Audit

**Date:** 2026-03-21
**Previous Audit:** 2026-03-20
**Scope:** Complete vertical slice -- schema, core service, API routes (admin + public), admin UI, storefront rendering

## Overall Score: 7/10 (was ~5/10)

Significant improvements from the fix session. Six of the eighteen original findings are fully resolved, two are partially fixed, and ten remain open. The most impactful fixes were: public routes now delegate to core service functions (eliminating duplicated query logic), `createPage` now persists `publishedAt` and `sortOrder`, the slug auto-generation is now guarded in edit mode, the storefront properly returns 404 status codes, the admin routes no longer swallow typed errors with try/catch, and the storefront SDK client uses a typed `unwrapData` helper instead of `(data as any)` casts.

---

## Previous Findings Status

### 1. Double shortcode processing on the storefront
**Status: FIXED**

`apps/storefront/src/pages/[slug].astro` (line 100) now passes `processShortcodes={false}` to `<RichContent>`, preventing the double-processing. The frontmatter calls `processShortcodes()` at line 69, and RichContent correctly skips its own processing because the prop is explicitly false.

### 2. Storefront SDK client uses `(data as any)` to extract page data
**Status: FIXED**

`apps/storefront/src/lib/api/pages.ts` now uses a typed `unwrapData<T>()` helper from `apps/storefront/src/lib/api/unwrap.ts` instead of `(data as any)`. Line 35 uses `unwrapData<{ page: Page }>(data)?.page ?? null` and line 82 uses `unwrapData<{ pages: Page[]; pagination: any }>(data)`. The single `as` cast is centralized in `unwrap.ts` (lines 20-21, 32-33), which is the recommended pattern for dealing with the SDK envelope mismatch.

Note: There is still one `any` remaining at line 82 for `pagination: any`. This is minor but could be typed as `{ total: number; page: number; limit: number; totalPages: number }`.

### 3. Duplicated query logic between admin and public API routes
**Status: PARTIALLY FIXED**

The public routes file (`apps/api/src/routes/pages.ts`) now imports and delegates to `getPublicPages` and `getPublicPageBySlug` from `@scalius/core/modules/pages/pages.service.ts` for the list route (line 76) and the slug route (line 107). These are new service functions added at lines 102-147 of the service file.

However, the `GET /pages/:id` route (lines 135-176) still contains inline DB query logic with a manual 14-column SELECT. It does not call a service function. This route should use a `getPublicPageById` function in the core service.

### 4. Inconsistent error handling in admin API routes
**Status: FIXED**

The admin routes (`apps/api/src/routes/admin/pages.ts`) no longer have try/catch blocks wrapping `createPage` (line 93) or `updatePage` (line 273). Both now directly call the service and let typed errors (`ConflictError`, `NotFoundError`) propagate to the global error handler. The delete route (line 296) was already correct. All routes are now consistent.

### 5. `pageSchema` in entity schemas omits `publishedAt`
**Status: STILL OPEN**

`apps/api/src/schemas/entities.ts` lines 358-374 still does not include `publishedAt` in the `pageSchema`. The DB schema (`packages/database/src/schema/content.ts` line 23), the validation schema (`packages/core/src/modules/pages/pages.validation.ts` line 15), the storefront type (`apps/storefront/src/lib/api/types.ts` line 238), and the admin type (`apps/admin/src/types/api-responses.ts` line 404) all include it. The OpenAPI spec, generated SDK types, and actual API response remain out of sync for this field.

**Fix:** Add `publishedAt: z.union([z.string(), z.number()]).nullable()` to `pageSchema` in `apps/api/src/schemas/entities.ts`, consistent with the `createdAt`/`updatedAt`/`deletedAt` pattern already used.

### 6. `createPage` service does not persist `publishedAt` or `sortOrder`
**Status: FIXED**

`packages/core/src/modules/pages/pages.service.ts` lines 171-172 now include `publishedAt: data.publishedAt ?? null` and `sortOrder: data.sortOrder ?? 0` in the `createPage` insert values. The asymmetry between create and update is resolved.

### 7. Bulk endpoint body key inconsistency
**Status: STILL OPEN**

`apps/api/src/routes/admin/pages.ts` line 109 still uses `pageIds` for the bulk-delete body key, while bulk-publish (line 137), bulk-unpublish (line 159), and bulk-restore (line 181) all use `ids`. The admin client at `apps/admin/src/components/admin/pages-list/hooks/useBulkActions.ts` lines 28-31 handles the split correctly with a conditional, but this remains an unnecessary divergence from the rest of the codebase which uses `ids` consistently for bulk operations.

**Fix:** Change `pageIds` to `ids` in the bulk-delete route schema (line 109) and handler (line 124), then update `useBulkActions.ts` to always send `{ ids: selected }`.

### 8. Slug auto-generation always overwrites on edit
**Status: FIXED**

`apps/admin/src/components/admin/PageForm.tsx` line 146 now includes the guard `if (!isClient || isEdit) return;`, preventing slug auto-generation during edit mode. The `isEdit` dependency is also included in the useEffect deps array at line 160.

### 9. Manual column enumeration in public routes
**Status: PARTIALLY FIXED**

The list route and slug route now delegate to core service functions that use `db.select()` (all columns). However, the `GET /pages/:id` route (lines 148-166) still manually enumerates 14 columns in its inline SELECT. This is the only remaining instance.

**Fix:** Add a `getPublicPageById` function to `packages/core/src/modules/pages/pages.service.ts` and call it from the route.

### 10. Duplicate `PageData` interface
**Status: STILL OPEN**

`apps/api/src/routes/pages.ts` lines 26-42 still defines a `PageData` interface that is never used as a type annotation anywhere in the file. It mirrors the Drizzle `Page` type and serves no purpose.

**Fix:** Delete lines 26-42 from `apps/api/src/routes/pages.ts`.

### 11. Four separate type definitions for `Page`
**Status: STILL OPEN**

The `Page` type is still defined in four places with inconsistencies:
- `packages/database/src/schema/content.ts` line 134 -- Drizzle `InferSelectModel` (timestamps as `Date`)
- `apps/admin/src/types/api-responses.ts` line 393 -- timestamps as `Date`
- `apps/storefront/src/lib/api/types.ts` line 227 -- timestamps as `number` (Unix)
- `apps/api/src/routes/pages.ts` line 26 -- timestamps as `number` (unused interface)

The admin and storefront types still disagree on timestamp format (`Date` vs `number`). Manual conversion happens in `apps/admin/src/loaders/admin/catalog.ts` lines 16-22 and `apps/admin/src/components/admin/pages-list/hooks/usePages.ts` lines 42-59.

This is a codebase-wide pattern issue (not pages-specific) and should be addressed by relying on SDK-generated types from `@scalius/api-client`.

### 12. Public list route fetches full `content` column
**Status: STILL OPEN**

The public list route (now via `getPublicPages` in `packages/core/src/modules/pages/pages.service.ts` line 135) still uses `db.select()` which returns all columns including `content`. The sitemap (`apps/storefront/src/pages/sitemap-pages.xml.ts`) only uses `slug`, `publishedAt`, `updatedAt`, and `isPublished`. Content can be large HTML.

**Fix:** Create a `listPagesLite` function or add a `fields` parameter to `getPublicPages` to exclude `content` when full HTML is not needed.

### 13. Sequential shortcode processing
**Status: STILL OPEN**

`apps/storefront/src/lib/shortcodes.ts` lines 93-106 still processes shortcodes sequentially in a `for` loop. Each shortcode triggers an API call (`renderWidgetShortcode` or `renderProductShortcode`), resulting in N sequential requests for N shortcodes.

**Fix:** Collect all shortcode resolution promises, run with `Promise.all`, then apply replacements.

### 14. No cache invalidation on admin mutations
**Status: STILL OPEN**

Admin page mutations (create/update/delete) do not trigger storefront cache invalidation. The storefront uses `withEdgeCache` with `CACHE_TTL.LONG` for page data. This is documented as acceptable for the current scale, with manual purge available via CacheManager.

### 15. `publishedAt` field: stored, validated, sent, but never queried
**Status: STILL OPEN (backlog item)**

No query in the codebase filters on `publishedAt`. The public routes filter only on `isPublished` boolean. The field is persisted correctly now (fix #6) but still never used for scheduled publishing. This is a documented backlog item in CLAUDE.md.

### 16. `deletePage` does not verify the page exists before soft-deleting
**Status: STILL OPEN**

`packages/core/src/modules/pages/pages.service.ts` line 200-202 still updates without checking existence. `bulkDeletePages` (line 204), `bulkPublishPages` (line 212), `bulkUnpublishPages` (line 216), and `restorePages` (line 220) all have the same behavior. The API returns 204/200 for non-existent IDs.

Impact remains low since the admin UI only shows actions for fetched pages.

### 17. `restorePages` does not update `updatedAt`
**Status: STILL OPEN**

`packages/core/src/modules/pages/pages.service.ts` line 221 sets `{ deletedAt: null }` without updating `updatedAt`. A restored page retains its old `updatedAt` timestamp.

**Fix:** Change line 221 to `{ deletedAt: null, updatedAt: sql\`unixepoch()\` }`.

### 18. Storefront `[slug].astro` redirects to `/404` instead of returning 404 status
**Status: FIXED**

`apps/storefront/src/pages/[slug].astro` now returns `new Response(null, { status: 404 })` consistently in all cases: no slug (line 20), file extension (line 27), invalid slug prefix (line 42), invalid slug format (line 49), and page not found (line 60). No `Astro.redirect("/404")` calls remain.

---

## New Issues Found

### N1. Public `GET /pages/:id` route still has inline DB query
**Files:** `apps/api/src/routes/pages.ts` lines 135-176

While the list and slug routes now correctly delegate to service functions, the `GET /pages/:id` route still contains a manual 14-column SELECT with inline conditions. This is the only remaining violation of the "thin HTTP layer" convention in the pages domain. It also still imports `pages` from `@scalius/database/schema` and `isNull`/`eq`/`and` from `drizzle-orm` which would not be needed if it delegated to the service.

**Fix:** Add `getPublicPageById` to `packages/core/src/modules/pages/pages.service.ts`:
```typescript
export async function getPublicPageById(db: Database, id: string) {
    return db.select().from(pages)
        .where(and(eq(pages.id, id), eq(pages.isPublished, true), isNull(pages.deletedAt)))
        .get() ?? null;
}
```
Then the route handler becomes:
```typescript
const page = await getPublicPageById(db, id);
if (!page) throw new NotFoundError("Page not found");
return ok(c, { page });
```

### N2. Unused imports in public routes file
**Files:** `apps/api/src/routes/pages.ts` lines 3-4

The file still imports `pages` from `@scalius/database/schema` and `isNull, eq, and, SQL` from `drizzle-orm`. The `isNull`, `eq`, `and`, and `SQL` imports are only used by the inline `GET /pages/:id` query. The `pages` import is used there too. Once N1 is fixed, these become dead imports.

### N3. `pagination: any` in storefront pages client
**Files:** `apps/storefront/src/lib/api/pages.ts` line 82

The `unwrapData` call uses `pagination: any` which undermines the typed unwrapping. Should be typed as `{ total: number; page: number; limit: number; totalPages: number }`.

### N4. `publishedOnly` query param accepted but ignored by public list route
**Files:** `apps/api/src/routes/pages.ts` lines 49, 73-77

The `pagesQuerySchema` (line 49) accepts a `publishedOnly` query parameter, but the handler (line 76) passes only `{ page, limit, sort }` to `getPublicPages()`. The `publishedOnly` value is destructured but never used. The service function `getPublicPages` hardcodes `eq(pages.isPublished, true)` at line 120 of the service, so all results are published-only regardless. The parameter gives a false impression that non-published pages can be fetched through the public API.

**Fix:** Remove the `publishedOnly` field from `pagesQuerySchema` since public routes always return published pages only.

---

## Summary Table

| # | Finding | Status | Severity |
|---|---------|--------|----------|
| 1 | Double shortcode processing | FIXED | -- |
| 2 | `(data as any)` SDK casts | FIXED | -- |
| 3 | Duplicated query logic | PARTIALLY FIXED | Medium |
| 4 | Error swallowing in admin routes | FIXED | -- |
| 5 | `publishedAt` missing from `pageSchema` | STILL OPEN | Medium |
| 6 | `createPage` missing `publishedAt`/`sortOrder` | FIXED | -- |
| 7 | Bulk endpoint body key inconsistency | STILL OPEN | Low |
| 8 | Slug auto-generation in edit mode | FIXED | -- |
| 9 | Manual column enumeration | PARTIALLY FIXED | Medium |
| 10 | Unused `PageData` interface | STILL OPEN | Low |
| 11 | Four separate `Page` type definitions | STILL OPEN | Medium |
| 12 | List endpoint fetches full `content` | STILL OPEN | Low |
| 13 | Sequential shortcode processing | STILL OPEN | Low |
| 14 | No cache invalidation on mutations | STILL OPEN | Low |
| 15 | `publishedAt` never queried | STILL OPEN (backlog) | Low |
| 16 | `deletePage` no existence check | STILL OPEN | Low |
| 17 | `restorePages` no `updatedAt` update | STILL OPEN | Low |
| 18 | Storefront 302 redirect instead of 404 | FIXED | -- |
| N1 | Public `GET /pages/:id` inline DB query | NEW | Medium |
| N2 | Unused imports in public routes | NEW | Low |
| N3 | `pagination: any` in storefront client | NEW | Low |
| N4 | `publishedOnly` param accepted but ignored | NEW | Low |

## Priority Recommendations

### Priority 1 -- Quick Wins (complete the partial fixes)
1. **Add `getPublicPageById` to core service** and refactor `GET /pages/:id` in `apps/api/src/routes/pages.ts` -- resolves N1, completes #3 and #9, cleans up N2.
2. **Add `publishedAt` to `pageSchema`** in `apps/api/src/schemas/entities.ts` -- resolves #5.
3. **Remove `publishedOnly` from `pagesQuerySchema`** in `apps/api/src/routes/pages.ts` -- resolves N4.
4. **Update `restorePages` to set `updatedAt`** in `packages/core/src/modules/pages/pages.service.ts` -- resolves #17.

### Priority 2 -- Cleanup
5. **Delete unused `PageData` interface** from `apps/api/src/routes/pages.ts` -- resolves #10.
6. **Normalize bulk-delete body key** to `ids` -- resolves #7.
7. **Type `pagination` in storefront pages client** -- resolves N3.

### Priority 3 -- Performance (defer unless measured)
8. **Parallelize shortcode resolution** with `Promise.all` -- resolves #13.
9. **Create `listPagesLite` without `content`** -- resolves #12.

### Priority 4 -- Backlog Decisions (unchanged)
10. **Decide on `publishedAt`** -- implement scheduled publishing or remove the field (#15).
11. **Consolidate `Page` types** to SDK-generated types (#11) -- codebase-wide effort.
