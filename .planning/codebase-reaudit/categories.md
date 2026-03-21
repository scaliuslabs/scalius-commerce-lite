# Categories Domain Re-Audit

**Date:** 2026-03-21
**Previous Audit:** 2026-03-20
**Scope:** Complete vertical slice -- schema, core service, API routes, admin UI, storefront

---

## Previous Finding Dispositions

### Critical Issues

#### 1. getCategoryEditData fetches ALL categories to find one by ID -- FIXED
**Files:** `apps/admin/src/loaders/admin/catalog.ts` (lines 61-79)

The loader now calls `apiGet<Category>("/categories/" + id)` directly instead of fetching all categories and filtering in JavaScript. A `GET /admin/categories/{id}` route was added to `apps/api/src/routes/admin/categories.ts` (lines 100-125), which delegates to `getCategoryById(db, id)` from the core service. The edit page loader is clean and efficient.

**Status:** FIXED

#### 2. Admin route error handling swallows core error types -- FIXED
**Files:** `apps/api/src/routes/admin/categories.ts`

All try/catch blocks have been removed from the create, update, delete, and bulk-delete handlers. Every handler now lets core service errors propagate directly to the global `onError` handler in `apps/api/src/app.ts` (line 84), which correctly serializes `AppError` subclasses with their proper status codes, error codes, and details. The admin route file now imports only `ValidationError` and `NotFoundError` from `../../utils/api-error` for route-level validation (e.g., empty array check on bulk-delete, not-found check on get-by-id).

**Status:** FIXED

#### 3. Public routes duplicate service logic instead of delegating -- FIXED
**Files:** `apps/api/src/routes/categories.ts` (lines 88-123)

The public `GET /categories` and `GET /categories/{slug}` routes now delegate to `getPublicCategories(db)` and `getPublicCategoryBySlug(db, slug)` from `@scalius/core/modules/categories/categories.storefront`. The functions are imported at line 11 and called directly in the route handlers. A dedicated `categories.storefront.ts` file was created with `getPublicCategories`, `getPublicCategoryBySlug`, `getPublicCategoryById`, and `getPublicCategoryTree`.

However, the `GET /{slug}/products` endpoint (lines 152-418) still has ~265 lines of inline query logic with no service function delegation. This was the biggest offender and remains unchanged.

**Status:** PARTIALLY FIXED -- list and slug routes delegate; products-by-category route still inline

### Code Quality Issues

#### 4. Date handling inconsistency across the stack -- STILL OPEN
**Files:** Multiple

The same inconsistencies persist:
- Core service `listCategories()` (line 79-81): Uses `CAST(... AS INTEGER)` then `new Date(... * 1000).toISOString()`
- `categories.storefront.ts` (lines 25, 52): Same `CAST(... AS INTEGER)` + manual conversion
- Admin hook `useCategoryList.ts` (line 120-122): Converts ISO string back to Date: `new Date(c.createdAt as string)`
- The catalog loader (line 49-51): Converts strings to Date with `new Date(category.createdAt)`

The Drizzle schema still declares `{ mode: "timestamp" }` which returns `Date` objects, but all service functions use `CAST(... AS INTEGER)` to bypass it. This inconsistency is stable (nothing is broken) but remains a maintenance burden.

**Status:** STILL OPEN

#### 5. Slug uniqueness check has a race condition -- STILL OPEN
**Files:** `packages/core/src/modules/categories/categories.service.ts` (lines 206-214, 250-258)

Both `createCategory()` and `updateCategory()` still use the SELECT-then-INSERT/UPDATE pattern. The unique index `categories_slug_idx` on `slug` (line 120 of `packages/database/src/schema/products.ts`) prevents data corruption, but a concurrent race would surface as a raw SQLite constraint error (500) rather than a user-friendly ConflictError (409).

Note: The unique index is on `slug` alone, not a partial index on `(slug) WHERE deletedAt IS NULL`. This means a soft-deleted category blocks the slug from being reused, which may be intentional but is worth documenting.

**Status:** STILL OPEN

#### 6. createCategorySchema has a rigid `createdAt` transform in image -- STILL OPEN
**Files:** `packages/core/src/modules/categories/categories.validation.ts` (lines 10-13)

The `imageSchema` still requires `createdAt` as a `z.date().or(z.string()).transform(...)`. The service layer never reads it -- `createCategory()` only uses `data.image?.url`. The admin form's CategoryForm.tsx schema (line 63) has `createdAt: z.date()` and the edit page loader sets `createdAt: new Date()` as a dummy value (line 75 of `catalog.ts`).

**Status:** STILL OPEN

#### 7. updateCategorySchema is identical to createCategorySchema -- STILL OPEN
**Files:** `packages/core/src/modules/categories/categories.validation.ts` (line 30)

`export const updateCategorySchema = createCategorySchema;` -- no change. All fields are required for update. The admin form always sends all fields, so this works in practice.

**Status:** STILL OPEN

### Pattern Violations

#### 8. Admin route catches core errors manually instead of letting them propagate -- FIXED
See finding #2 above.

**Status:** FIXED

#### 9. Public route bypasses core service layer -- PARTIALLY FIXED
See finding #3 above. The list and slug routes now delegate to `categories.storefront.ts`. The `GET /{slug}/products` route (265 lines) remains fully inline.

**Status:** PARTIALLY FIXED

#### 10. Missing `isActive` column on categories -- STILL OPEN
**Files:** `packages/database/src/schema/products.ts` (lines 101-123)

No `isActive` column was added. Categories still only support soft-delete via `deletedAt`. This remains an inconsistency with `products` and `collections` which both have `isActive`.

**Status:** STILL OPEN (enhancement, not a bug)

### Maintainability Concerns

#### 11. Category form schema defined in two places -- STILL OPEN
**Files:**
- `packages/core/src/modules/categories/categories.validation.ts` (server-side)
- `apps/admin/src/components/admin/CategoryForm.tsx` (lines 42-66, client-side)

The two schemas remain separate and nearly identical. The client schema has `slugEdited: z.boolean().optional()` and `id: z.string().optional()` which the server schema lacks. The image `createdAt` type also differs (`z.date()` on client vs `z.date().or(z.string()).transform(...)` on server).

**Status:** STILL OPEN

#### 12. Storefront category-mapping.ts is hardcoded and domain-specific -- STILL OPEN
**Files:** `apps/storefront/src/lib/category-mapping.ts`

The file still has hardcoded pharmacy/health store mappings. A TODO comment was added at line 22-25 acknowledging the issue: "These mappings are hardcoded for a pharmacy/health store. For other store types, this should be configurable from admin settings." The default fallback is still "Health & Beauty > Health Care".

**Status:** STILL OPEN (acknowledged with TODO)

#### 13. No admin API endpoint for single category fetch -- FIXED
**Files:** `apps/api/src/routes/admin/categories.ts` (lines 100-125)

A `GET /admin/categories/{id}` route was added that calls `getCategoryById(db, id)` and returns a 404 NotFoundError if not found.

**Status:** FIXED

### Performance & Scalability

#### 14. No category hierarchy (flat only) -- STILL OPEN
No `parentId` column was added. Flat structure remains. The `getPublicCategoryTree()` function in `categories.storefront.ts` (lines 93-95) was added but simply aliases `getPublicCategories()` -- it is a named placeholder for future hierarchy support.

**Status:** STILL OPEN (by design for now)

#### 15. Product count query in listCategories scans all active products -- STILL OPEN
**Files:** `packages/core/src/modules/categories/categories.service.ts` (lines 89-96)

The `countsQuery` still groups ALL active products by `categoryId`, not scoped to the categories on the current page. At least it is now batched with the main query via `db.batch()` (line 98-102), so there is only one round-trip. The scan itself has not been optimized.

**Status:** STILL OPEN

#### 16. Public /{slug}/products endpoint has separate image query -- STILL OPEN
**Files:** `apps/api/src/routes/categories.ts` (lines 320-339)

The separate `inArray` query for primary images persists. It is well-batched (one query, not N) but could be a JOIN in the main query.

**Status:** STILL OPEN

#### 17. Duplicate attribute subquery for count -- STILL OPEN
**Files:** `apps/api/src/routes/categories.ts` (lines 286-307 and 370-394)

The attribute filter subquery is still built identically twice -- once for results, once for count. Not extracted into a shared builder function.

**Status:** STILL OPEN

#### 18. listPublicCategories returns ALL categories unbounded -- STILL OPEN
**Files:** `packages/core/src/modules/categories/categories.service.ts` (lines 131-152), `packages/core/src/modules/categories/categories.storefront.ts` (lines 12-36)

Both `listPublicCategories()` and `getPublicCategories()` return all non-deleted categories without pagination. The storefront caches aggressively, so impact is limited to cache-miss scenarios. A comment in `categories.storefront.ts` line 10 acknowledges this: "No pagination -- categories are typically <100 rows and cached aggressively."

**Status:** STILL OPEN (acceptable for current scale)

### Robustness Gaps

#### 19. deleteCategory checks products but not soft-deleted products -- STILL OPEN
**Files:** `packages/core/src/modules/categories/categories.service.ts` (lines 278-283)

The `deleteCategory()` function still queries ALL products with the given `categoryId`, including soft-deleted ones. No `isNull(products.deletedAt)` filter. Same for `bulkDeleteCategories()` (lines 313-318). This means you cannot soft-delete a category that has soft-deleted products pointing to it.

**Status:** STILL OPEN

#### 20. bulkDeleteCategories collection cleanup has silent failure -- STILL OPEN
**Files:** `packages/core/src/modules/categories/categories.service.ts` (line 353)

The empty `catch { }` block still silently swallows JSON parse errors during collection config cleanup on permanent delete.

**Status:** STILL OPEN

#### 21. No cache invalidation on category mutation -- STILL OPEN
**Files:**
- `apps/api/src/routes/categories.ts` (lines 20-28): Cache middleware with 3600s TTL
- `apps/storefront/src/lib/api/categories.ts`: Edge cache with `CACHE_TTL.LONG`

Admin mutations (create/update/delete) do not trigger cache invalidation. Storefront may show stale data for up to the cache TTL period.

**Status:** STILL OPEN

#### 22. Restore does not check for slug conflicts -- STILL OPEN
**Files:** `packages/core/src/modules/categories/categories.service.ts` (lines 368-374)

`restoreCategories()` still sets `deletedAt: null` without checking whether the slug is already in use by another active category. Since the unique index is on `slug` alone (not a partial index), a soft-deleted category with slug "shoes" blocks a new "shoes" from being created, so the specific scenario described (restore conflict after creating a new one with same slug) would actually fail at the "create new" step. However, if the index were ever changed to a partial index, this would become a real bug.

**Status:** STILL OPEN (lower severity than originally assessed -- the non-partial unique index prevents the exact conflict scenario, but the error message would still be a raw SQLite constraint error rather than a user-friendly message)

#### 23. Sitemap uses createdAt instead of updatedAt for lastmod -- FIXED
**Files:** `apps/storefront/src/pages/sitemap-categories.xml.ts` (line 26)

The sitemap now uses `category.updatedAt || category.createdAt` as the lastmod value. The storefront `Category` type in `apps/storefront/src/lib/api/types.ts` (line 168) now includes `updatedAt?: string`. However, the public categories list endpoint (`getPublicCategories` in `categories.storefront.ts`) does not return `updatedAt` -- only `createdAt` is selected. The `getAllCategories()` storefront function uses this endpoint, so `category.updatedAt` will be undefined and it will fall back to `createdAt` in practice.

**Status:** PARTIALLY FIXED -- the sitemap code was updated but the public API data source does not provide `updatedAt`

---

## New Issues Found

### NEW-1. getPublicCategoryBySlug does not filter soft-deleted categories (BUG)
**Files:** `packages/core/src/modules/categories/categories.storefront.ts` (lines 42-56)

```typescript
export async function getPublicCategoryBySlug(db: Database, slug: string) {
    const category = await db
        .select({ ... })
        .from(categories)
        .where(eq(categories.slug, slug))  // Missing: isNull(categories.deletedAt)
        .get();
```

The public storefront query for a single category by slug does NOT filter by `isNull(categories.deletedAt)`. This means a soft-deleted category is still accessible on the storefront via its direct URL. Compare with:
- `getPublicCategories()` (line 28): correctly uses `isNull(categories.deletedAt)`
- `getCategoryBySlug()` in `categories.service.ts` (line 170): correctly uses `and(eq(categories.slug, slug), isNull(categories.deletedAt))`

The public route at `apps/api/src/routes/categories.ts` line 120-121 calls `getPublicCategoryBySlug(db, slug)`, so this bug is live in the storefront. The `GET /{slug}/products` route handler (line 179) does its own inline query which correctly includes `isNull(categories.deletedAt)`.

**Impact:** Soft-deleted categories are visible on the public storefront at `/categories/{slug}`. Admins who soft-delete a category expect it to be hidden immediately.

**Fix:** Add `and(eq(categories.slug, slug), isNull(categories.deletedAt))` to the WHERE clause in `getPublicCategoryBySlug()`.

**Severity:** High -- data leak of deleted content to public users.

### NEW-2. getCategoryById does not filter soft-deleted categories
**Files:** `packages/core/src/modules/categories/categories.service.ts` (lines 177-193)

```typescript
export async function getCategoryById(db: Database, id: string) {
    return db
        .select({ ... })
        .from(categories)
        .where(eq(categories.id, id))  // No deletedAt filter
        .get();
}
```

The admin `GET /admin/categories/{id}` route uses this function. Without a `deletedAt` filter, it returns soft-deleted categories too. This is actually acceptable for admin use (admin may want to view/restore a deleted category), but the function name is ambiguous -- it does not indicate whether it includes deleted records. The same applies to `getPublicCategoryById()` in `categories.storefront.ts` (lines 70-86).

**Impact:** Low -- admin context where showing deleted items is acceptable. But the function naming is misleading since `getPublicCategoryById` implies "public" (non-deleted) behavior.

### NEW-3. Admin route `getByIdRoute` handler uses `as any` type casts
**Files:** `apps/api/src/routes/admin/categories.ts` (lines 119, 125)

```typescript
app.openapi(getByIdRoute, (async (c: any) => {
    // ...
}) as any);
```

The handler is double-cast with `(c: any)` and `as any` to bypass OpenAPI type checking. This pattern also appears on the public `getCategoryProductsRoute` handler (line 152 of `apps/api/src/routes/categories.ts`). These casts suppress type errors that may indicate a schema mismatch between the route definition and the handler.

**Impact:** Hides potential type mismatches. If the route schema changes, the handler won't flag incompatibilities.

### NEW-4. Duplicate function: `listPublicCategories` and `getPublicCategories`
**Files:**
- `packages/core/src/modules/categories/categories.service.ts` (lines 131-152): `listPublicCategories()`
- `packages/core/src/modules/categories/categories.storefront.ts` (lines 12-36): `getPublicCategories()`

These two functions do exactly the same thing -- select all non-deleted categories ordered by name, with `CAST(createdAt AS INTEGER)` and ISO string conversion. Both are exported via `index.ts`. The only difference is `getPublicCategories` accepts an unused `options: { parentId?: string }` parameter.

The public API route uses `getPublicCategories` (from storefront). The old `listPublicCategories` appears unused but is still exported.

**Impact:** Confusion about which function to call. Dead code.

### NEW-5. `getPublicCategories` accepts unused `parentId` parameter
**Files:** `packages/core/src/modules/categories/categories.storefront.ts` (line 14)

```typescript
export async function getPublicCategories(
    db: Database,
    options: { parentId?: string } = {},
) {
```

The `parentId` parameter is accepted but never used in the query. There is no `parentId` column in the categories table. This is a forward-looking placeholder for hierarchy support but is misleading -- callers might pass `parentId` expecting it to filter.

**Impact:** Misleading API surface.

### NEW-6. `getPublicCategoryBySlug` does not return `updatedAt`
**Files:** `packages/core/src/modules/categories/categories.storefront.ts` (lines 42-64)

The function selects `createdAt` but not `updatedAt`. The storefront `Category` type (line 168 of `apps/storefront/src/lib/api/types.ts`) includes `updatedAt?: string`, but no storefront data source populates it. This means:
- The sitemap (finding #23 above) falls back to `createdAt` for `lastmod`
- The `getAllCategories()` function also does not return `updatedAt` since it calls `getPublicCategories()` which also omits it

**Fix:** Add `updatedAt: sql<number>\`CAST(${categories.updatedAt} AS INTEGER)\`` to the select in both `getPublicCategories` and `getPublicCategoryBySlug`, and include it in the return mapping.

---

## Summary Table

| # | Previous Finding | Status | Severity |
|---|-----------------|--------|----------|
| 1 | getCategoryEditData fetches all categories | FIXED | -- |
| 2 | Admin route error handling swallows core errors | FIXED | -- |
| 3 | Public routes duplicate service logic | PARTIALLY FIXED | Medium |
| 4 | Date handling inconsistency | STILL OPEN | Low |
| 5 | Slug uniqueness race condition | STILL OPEN | Low |
| 6 | Image schema requires unused `createdAt` | STILL OPEN | Low |
| 7 | updateCategorySchema identical to create | STILL OPEN | Low |
| 8 | Admin route catches errors manually | FIXED | -- |
| 9 | Public route bypasses core service | PARTIALLY FIXED | Medium |
| 10 | Missing `isActive` column | STILL OPEN | Low (enhancement) |
| 11 | Form schema in two places | STILL OPEN | Low |
| 12 | Hardcoded category-mapping.ts | STILL OPEN | Low |
| 13 | No admin GET by ID endpoint | FIXED | -- |
| 14 | No category hierarchy | STILL OPEN | Low (by design) |
| 15 | Product count scans all products | STILL OPEN | Medium |
| 16 | Separate image query in products endpoint | STILL OPEN | Low |
| 17 | Duplicate attribute subquery | STILL OPEN | Low |
| 18 | Unbounded public category list | STILL OPEN | Low |
| 19 | deleteCategory includes soft-deleted products | STILL OPEN | Medium |
| 20 | Silent catch in bulk delete cleanup | STILL OPEN | Low |
| 21 | No cache invalidation on mutation | STILL OPEN | Medium |
| 22 | Restore without slug conflict check | STILL OPEN | Low |
| 23 | Sitemap lastmod uses createdAt | PARTIALLY FIXED | Low |

| # | New Finding | Severity |
|---|------------|----------|
| NEW-1 | `getPublicCategoryBySlug` returns soft-deleted categories | High |
| NEW-2 | `getCategoryById` naming ambiguity re: deleted records | Low |
| NEW-3 | `as any` type casts on route handlers | Low |
| NEW-4 | Duplicate `listPublicCategories` / `getPublicCategories` | Low |
| NEW-5 | Unused `parentId` parameter in `getPublicCategories` | Low |
| NEW-6 | Public category endpoints don't return `updatedAt` | Medium |

---

## Recommended Priority Fixes

### Priority 1 -- Fix Now (Bugs)

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| NEW-1 | **Add `isNull(categories.deletedAt)` filter to `getPublicCategoryBySlug()`** | `packages/core/src/modules/categories/categories.storefront.ts` line 55 | Trivial |
| NEW-6 | **Add `updatedAt` to select in `getPublicCategories` and `getPublicCategoryBySlug`** | `packages/core/src/modules/categories/categories.storefront.ts` | Small |

### Priority 2 -- Improve (Quality)

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 3/9 | **Extract `/{slug}/products` inline query into a service function** | `apps/api/src/routes/categories.ts`, new function in `categories.storefront.ts` or `products.storefront.ts` | Medium |
| 19 | **Add `isNull(products.deletedAt)` to deleteCategory product check** | `packages/core/src/modules/categories/categories.service.ts` lines 280, 316 | Trivial |
| NEW-4 | **Remove duplicate `listPublicCategories` from `categories.service.ts`** | `packages/core/src/modules/categories/categories.service.ts` | Small |
| 20 | **Log collection config parse errors instead of empty catch** | `packages/core/src/modules/categories/categories.service.ts` line 353 | Trivial |

### Priority 3 -- Cleanup

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| NEW-3 | **Remove `as any` casts and fix OpenAPI type alignment** | `apps/api/src/routes/admin/categories.ts`, `apps/api/src/routes/categories.ts` | Small |
| NEW-5 | **Remove unused `parentId` parameter from `getPublicCategories`** | `packages/core/src/modules/categories/categories.storefront.ts` | Trivial |
| 6 | **Make image `createdAt` optional in validation schema** | `packages/core/src/modules/categories/categories.validation.ts` | Small |

---

## Overall Rating

**Previous Score:** Not explicitly rated, but extensive issues list suggested ~5/10.

**Current Score: 6.5/10**

**Rationale:** The major architectural fixes (dedicated GET-by-ID endpoint, error propagation cleanup, service layer delegation for list/slug routes) represent genuine improvements. The admin route file is now clean and follows conventions. However, one new high-severity bug was introduced (soft-deleted categories visible on public storefront via `getPublicCategoryBySlug`), the largest route handler (265 lines inline) was not refactored, and most of the original quality/robustness findings remain unchanged. The domain is functional but still has meaningful gaps in the storefront data layer.
