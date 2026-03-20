# Pages Domain Audit

**Date:** 2026-03-20
**Scope:** Complete vertical slice -- schema, core service, API routes (admin + public), admin UI, storefront rendering

## Summary

The Pages domain is a straightforward CMS vertical slice with soft-delete, FTS5 search, shortcode processing, and bulk operations. It is functional and follows most codebase conventions. However, it has several concrete issues: duplicated query logic across two separate API route files, an unused `publishedAt` field that creates dead code paths, an `(as any)` cast in the storefront SDK client that masks type errors, inconsistent error handling between the create and update routes, and double shortcode processing in the storefront. None are production-breaking, but they accumulate maintainability and correctness risk.

## Critical Issues

### 1. Double shortcode processing on the storefront

**Files:**
- `apps/storefront/src/pages/[slug].astro` (lines 66-74)
- `apps/storefront/src/components/RichContent.astro` (lines 18-25)

`[slug].astro` calls `processShortcodes(page.content)` and then passes the result to `<RichContent>`, which calls `processShortcodes` again by default (its `processShortcodes` prop defaults to `true`). This means every shortcode in page content is processed twice. The second pass is a no-op (shortcodes are already replaced with HTML), but it performs unnecessary regex parsing, and if any rendered shortcode output accidentally matches the shortcode regex pattern, it could produce corrupt HTML.

**Fix:** Either pass `processShortcodes={false}` to `<RichContent>` in `[slug].astro`, or remove the manual `processShortcodes()` call from the frontmatter and let `RichContent` handle it.

### 2. Storefront SDK client uses `(data as any)` to extract page data

**File:** `apps/storefront/src/lib/api/pages.ts` (lines 34, 81)

```typescript
return (data as any)?.data?.page ?? null;  // line 34
const d = (data as any)?.data;              // line 81
```

The generated SDK types do not match the actual API response shape, so the client casts to `any` to drill into the envelope. This means:
- No compile-time protection if the API response shape changes.
- The `?.data?.page` chain is fragile -- if the envelope contract changes, this silently returns `null`.

**Fix:** Either fix the SDK generation to produce correct envelope-aware types, or create a typed unwrapper function (similar to `unwrapEnvelope` used in the admin).

## Code Quality Issues

### 3. Duplicated query logic between admin and public API routes

**Files:**
- `apps/api/src/routes/admin/pages.ts` -- delegates to `@scalius/core/modules/pages/pages.service.ts`
- `apps/api/src/routes/pages.ts` -- contains inline DB queries (does NOT use the core service)

The public pages route (`apps/api/src/routes/pages.ts`) duplicates the exact same query patterns that exist in `packages/core/src/modules/pages/pages.service.ts`. It has its own inline `db.select()` calls with manually specified column lists (lines 110-132, 181-201, 247-267). The admin route correctly delegates to the core service.

This violates the codebase convention: "Thin HTTP layer: `apps/api/src/routes/**` handles validation and auth, then delegates to `@scalius/core` services."

**Impact:** Any schema change requires updating column lists in two places. If a new field is added to `pages`, the public route must be manually updated.

**Fix:** Refactor `apps/api/src/routes/pages.ts` to import and call `getPageBySlug`, `getPageById`, and `listPages` from `@scalius/core/modules/pages/pages.service.ts`, adding a `publishedOnly` filter parameter to the service.

### 4. Inconsistent error handling in admin API routes

**File:** `apps/api/src/routes/admin/pages.ts`

The create route (lines 91-100) and update route (lines 275-285) both catch errors and re-throw as generic `ApiError`:

```typescript
catch (error: unknown) {
    const err = error as { message?: string; statusCode?: number };
    throw new ApiError(err.statusCode || 400, "ERROR", err.message || "Unknown error");
}
```

But the core service throws typed `ConflictError` and `NotFoundError` from `@scalius/core/errors`. The catch block casts the typed error to a generic object, losing the error class identity. Since the codebase already has a global error handler that maps `AppError` subclasses to proper HTTP responses, these try/catch blocks should be removed entirely, letting the errors propagate naturally.

The delete route (lines 303-308) correctly does NOT catch errors -- it lets them propagate. This inconsistency is confusing.

**Fix:** Remove the try/catch blocks from the create and update route handlers.

### 5. `pageSchema` in entity schemas omits `publishedAt`

**File:** `apps/api/src/schemas/entities.ts` (lines 360-377)

The OpenAPI `pageSchema` does not include `publishedAt`, even though:
- The DB schema has the column (`packages/database/src/schema/content.ts` line 23)
- The public routes SELECT and return `publishedAt` (`apps/api/src/routes/pages.ts` lines 122, 193, 259)
- The storefront type includes it (`apps/storefront/src/lib/api/types.ts` line 237)
- The admin type includes it (`apps/admin/src/types/api-responses.ts` line 404)
- The validation schema includes it (`packages/core/src/modules/pages/pages.validation.ts` line 15)

This means the OpenAPI spec, the generated SDK types, and the actual API response are all out of sync regarding `publishedAt`.

**Fix:** Add `publishedAt: z.any().nullable().optional()` to `pageSchema` in `apps/api/src/schemas/entities.ts`.

## Pattern Violations

### 6. `createPage` service does not persist `publishedAt` or `sortOrder`

**File:** `packages/core/src/modules/pages/pages.service.ts` (lines 112-127)

The `createPage` function explicitly enumerates fields in the `db.insert().values()` call, but omits `publishedAt` and `sortOrder` even though they are accepted by the validation schema. The admin form sends these fields (the form sets `publishedAt` to `new Date()` when publishing), but they are silently dropped by the service.

```typescript
await db.insert(pages).values({
    id: pageId,
    title: data.title,
    content: data.content,
    slug: data.slug,
    metaTitle: data.metaTitle || null,
    metaDescription: data.metaDescription || null,
    isPublished: data.isPublished,
    hideHeader: data.hideHeader,
    hideFooter: data.hideFooter,
    hideTitle: data.hideTitle,
    // Missing: publishedAt, sortOrder
    createdAt: sql`unixepoch()`,
    updatedAt: sql`unixepoch()`,
    deletedAt: null,
});
```

The `updatePage` function uses `{ ...data }` spread (line 144), so it DOES persist `publishedAt` and `sortOrder` on update. This asymmetry means the first save of a page always has `publishedAt = null` and `sortOrder = 0` (the schema default), regardless of what the user submitted.

**Fix:** Add `publishedAt: data.publishedAt || null` and `sortOrder: data.sortOrder ?? 0` to the `createPage` values object.

### 7. Bulk endpoint body key inconsistency

**File:** `apps/api/src/routes/admin/pages.ts`

- bulk-delete: body key is `pageIds` (line 114)
- bulk-publish: body key is `ids` (line 141)
- bulk-unpublish: body key is `ids` (line 163)
- bulk-restore: body key is `ids` (line 185)

The client-side code in `apps/admin/src/components/admin/pages-list/hooks/useBulkActions.ts` (lines 28-33) handles this split correctly, but it is an unnecessary divergence from a consistent API contract. Other domains in the codebase use `ids` consistently for bulk operations.

**Fix:** Change bulk-delete to use `ids` instead of `pageIds` and update the admin client accordingly.

### 8. Slug auto-generation always overwrites on edit

**File:** `apps/admin/src/components/admin/PageForm.tsx` (lines 145-160)

The `useEffect` that auto-generates the slug from the title fires on every title change, including during edit mode. If a user edits a page title, the slug is silently overwritten, which could break existing links. Most CMS implementations only auto-generate the slug on initial creation.

```typescript
React.useEffect(() => {
    if (!isClient) return;
    const subscription = form.watch((value, { name }) => {
      if (name === "title" && value.title) {
        const slug = value.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        form.setValue("slug", slug, { shouldValidate: true });
      }
    });
    return () => subscription.unsubscribe();
}, [form, isClient]);
```

**Fix:** Guard with `if (!isEdit)` or track whether the user has manually edited the slug.

## Maintainability Concerns

### 9. Manual column enumeration in public routes

**File:** `apps/api/src/routes/pages.ts` (lines 110-132, 181-201, 247-267)

The same 14-column SELECT is repeated three times in the public routes file. If a column is added or renamed, all three must be updated. The admin routes avoid this by delegating to the service, which uses `db.select()` (selects all columns).

### 10. Duplicate `PageData` interface

**File:** `apps/api/src/routes/pages.ts` (lines 25-41)

The file defines a `PageData` interface that exactly mirrors the Drizzle `Page` type from `packages/database/src/schema/content.ts`. This is dead code -- it is defined but never used as a type annotation in the file. It just adds a maintenance burden.

### 11. Four separate type definitions for `Page`

The `Page` type is defined in four places with slight variations:
- `packages/database/src/schema/content.ts` -- Drizzle `InferSelectModel` (timestamps as `Date`)
- `apps/admin/src/types/api-responses.ts` (line 392) -- timestamps as `Date`
- `apps/storefront/src/lib/api/types.ts` (line 226) -- timestamps as `number` (Unix)
- `apps/api/src/routes/pages.ts` (line 25) -- timestamps as `number` (unused)

The admin and storefront types disagree on whether timestamps are `Date` or `number`. This forces manual conversion in loaders (`apps/admin/src/loaders/admin/catalog.ts` lines 18-22) and hooks (`apps/admin/src/components/admin/pages-list/hooks/usePages.ts` lines 42-59).

**Fix:** Rely on the SDK-generated types from `@scalius/api-client` and remove the manual type definitions. Add a single `parsePageTimestamps` utility.

## Performance & Scalability

### 12. Public list route fetches full `content` column

**File:** `apps/api/src/routes/pages.ts` (lines 110-132)

The public `GET /pages` endpoint returns the full `content` field for every page in the list response. CMS page content can be large (HTML with embedded media references). For a list endpoint consumed by the storefront sitemap (`apps/storefront/src/pages/sitemap-pages.xml.ts`), this is wasted bandwidth -- the sitemap only uses `slug`, `publishedAt`, `updatedAt`, and `isPublished`.

The admin `listPages` service function also returns full content. For lists, consider a lightweight projection.

**Fix:** Create a `listPagesLite` variant that excludes `content`, or add a `fields` parameter.

### 13. Sequential shortcode processing

**File:** `apps/storefront/src/lib/shortcodes.ts` (lines 89-108)

Shortcodes are processed sequentially in a `for` loop, with each shortcode making an API call (`getWidgetById` or `getProductBySlug`). If a page has N shortcodes, this results in N sequential API requests.

```typescript
for (const shortcode of shortcodes) {
    let replacement = "";
    if (shortcode.type === "widget") {
      replacement = await renderWidgetShortcode(shortcode.id);
    } else if (shortcode.type === "product") {
      replacement = await renderProductShortcode(shortcode.id);
    }
    processedContent = processedContent.replace(shortcode.fullMatch, replacement);
}
```

**Fix:** Use `Promise.all` to resolve all shortcodes in parallel, then apply replacements.

### 14. No cache invalidation on admin mutations

When pages are created, updated, or deleted via admin routes, there is no mechanism to invalidate the storefront's edge cache (`apps/storefront/src/lib/api/pages.ts` uses `withEdgeCache` with `CACHE_TTL.LONG` -- likely 24 hours). Content changes may not appear on the storefront for up to 24 hours unless the admin manually purges via the CacheManager.

This is acceptable for low-traffic sites but becomes a user-experience issue at scale.

## Robustness Gaps

### 15. `publishedAt` field: stored, validated, sent, but never queried

**Status:** Confirmed -- matches CLAUDE.md backlog item.

The `publishedAt` column exists in the schema, is accepted by validation, is returned by all API endpoints, appears in the sitemap, and is set by the admin form -- but no query in the entire codebase filters on it. There is no "scheduled publishing" feature. The public routes filter on `isPublished` boolean only.

**Specific dead code paths:**
- `apps/admin/src/components/admin/PageForm.tsx` lines 99-102: Sets `publishedAt = new Date()` if publishing and no date is set.
- `packages/core/src/modules/pages/pages.validation.ts` lines 15-17: Complex `z.date().or(z.string()).nullable().optional().transform(...)` for a field that is never used as a filter.
- `apps/storefront/src/pages/sitemap-pages.xml.ts` lines 59-60: Uses `publishedAt` for the `lastmod` sitemap field, which is reasonable but relies on a value that may be null or stale.

**Decision needed:** Either implement scheduled publishing (filter `WHERE publishedAt <= now()` in addition to `isPublished`) or remove `publishedAt` entirely and use `updatedAt` for the sitemap.

### 16. `deletePage` does not verify the page exists before soft-deleting

**File:** `packages/core/src/modules/pages/pages.service.ts` (line 147-149)

```typescript
export async function deletePage(db: Database, id: string): Promise<void> {
    await db.update(pages).set({ deletedAt: sql`unixepoch()` }).where(eq(pages.id, id));
}
```

If the page ID does not exist, this silently succeeds (Drizzle updates zero rows without error). The API route returns 204 regardless. Compare this to `updatePage` which correctly checks existence first. The same issue applies to `bulkDeletePages`, `bulkPublishPages`, `bulkUnpublishPages`, and `restorePages`.

**Impact:** Low -- the admin UI only shows delete buttons for pages it already fetched. But it means the API endpoint is not strictly correct (returns 204 for non-existent IDs).

### 17. `restorePages` does not update `updatedAt`

**File:** `packages/core/src/modules/pages/pages.service.ts` (line 167-169)

```typescript
export async function restorePages(db: Database, ids: string[]): Promise<void> {
    await db.update(pages).set({ deletedAt: null }).where(inArray(pages.id, ids));
}
```

Restoring a page clears `deletedAt` but does not update `updatedAt`. This means a restored page retains its old `updatedAt` timestamp, which could cause it to appear stale in sorted lists and sitemaps.

**Fix:** Add `updatedAt: sql\`unixepoch()\`` to the `.set()` call.

### 18. Storefront `[slug].astro` redirects to `/404` instead of returning 404 status

**File:** `apps/storefront/src/pages/[slug].astro` (lines 19-21, 59-61)

When no slug is provided or the page is not found, the handler calls `Astro.redirect("/404")` which returns a 302 redirect. This is bad for SEO -- search engines see a redirect instead of a 404 status. The file extension and invalid slug checks correctly return `new Response(null, { status: 404 })`, creating an inconsistency within the same file.

**Fix:** Replace `Astro.redirect("/404")` with `return new Response(null, { status: 404 })` or render the 404 page inline with a 404 status code.

## LLM-Friendliness

### Strengths
- Clean barrel exports in `packages/core/src/modules/pages/index.ts`
- Validation schemas are co-located with the service in `packages/core/src/modules/pages/`
- Excellent README at `packages/core/src/modules/pages/README.md` -- documents all functions, endpoints, known gaps, and dependencies
- Admin UI is well-decomposed: `PagesList` -> hooks (`usePages`, `usePageActions`, `useBulkActions`) -> components (`PageRow`, `PageTable`, etc.)
- Type file at `apps/admin/src/components/admin/pages-list/types/index.ts` makes the component contract clear
- Consistent use of `extractApiError` and `unwrapEnvelope` from `@/lib/api-helpers` in the admin

### Weaknesses
- The public and admin API routes for pages are in different directories with no cross-reference comment -- an LLM searching for "page API" may only find one
- The `PageData` interface in `apps/api/src/routes/pages.ts` is misleading dead code
- The `(data as any)` casts in `apps/storefront/src/lib/api/pages.ts` hide the actual data shape, making it hard to trace the type flow
- No JSDoc on the core service functions (e.g., `listPages` has complex options but no documentation beyond the README)

## Recommended Changes

### Priority 1 -- Correctness
1. **Fix double shortcode processing** in `apps/storefront/src/pages/[slug].astro` -- pass `processShortcodes={false}` to `<RichContent>`.
2. **Add missing fields to `createPage`** in `packages/core/src/modules/pages/pages.service.ts` -- add `publishedAt` and `sortOrder` to the insert values.
3. **Guard slug auto-generation in edit mode** in `apps/admin/src/components/admin/PageForm.tsx` -- only auto-generate when `!isEdit`.
4. **Return 404 status instead of redirect** in `apps/storefront/src/pages/[slug].astro`.

### Priority 2 -- Consistency & Maintainability
5. **Refactor public routes to use core service** -- `apps/api/src/routes/pages.ts` should delegate to `pages.service.ts` instead of duplicating queries.
6. **Remove try/catch from admin create/update routes** -- let typed errors propagate to the global handler.
7. **Add `publishedAt` to `pageSchema`** in `apps/api/src/schemas/entities.ts`.
8. **Normalize bulk endpoint body keys** -- change `pageIds` to `ids` in bulk-delete.
9. **Add `updatedAt` update to `restorePages`**.

### Priority 3 -- Performance
10. **Parallelize shortcode resolution** in `apps/storefront/src/lib/shortcodes.ts` using `Promise.all`.
11. **Exclude `content` from list endpoints** when full content is not needed.

### Priority 4 -- Backlog Decision
12. **Decide on `publishedAt`**: Either implement scheduled publishing or remove the field and simplify.
