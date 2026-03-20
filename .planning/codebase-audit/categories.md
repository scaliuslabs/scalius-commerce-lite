# Categories Domain Audit

**Date:** 2026-03-20
**Scope:** Complete vertical slice -- schema, core service, API routes, admin UI, storefront

## Summary

The Categories domain is a relatively simple flat-list CRUD domain with FTS5 search, soft-delete lifecycle, and a well-structured admin UI. The codebase is functional and covers the common operations well. However, it has several concrete issues: a wasteful N+1 loader for the edit page, duplicated query logic between core service and public API route, inconsistent error handling patterns in the admin API route, no hierarchy support (flat only), and zero test coverage. The domain is well-documented in its own README, which is a positive signal.

**Files in scope:**
- `packages/database/src/schema/products.ts` (lines 101-123)
- `packages/core/src/modules/categories/categories.service.ts`
- `packages/core/src/modules/categories/categories.validation.ts`
- `packages/core/src/modules/categories/index.ts`
- `apps/api/src/routes/admin/categories.ts`
- `apps/api/src/routes/categories.ts`
- `apps/admin/src/components/admin/CategoryForm.tsx`
- `apps/admin/src/components/admin/categories/` (6 files + hook)
- `apps/admin/src/pages/admin/categories/` (3 pages)
- `apps/admin/src/loaders/admin/catalog.ts`
- `apps/storefront/src/lib/api/categories.ts`
- `apps/storefront/src/lib/category-mapping.ts`
- `apps/storefront/src/pages/categories/[slug].astro`
- `apps/storefront/src/pages/sitemap-categories.xml.ts`

---

## Critical Issues

### 1. getCategoryEditData fetches ALL categories to find one by ID

**Files:** `apps/admin/src/loaders/admin/catalog.ts` (lines 61-83)

```typescript
export async function getCategoryEditData(id: string) {
  const listResult = await apiGet<{ categories: Category[]; pagination: PaginationResponse }>("/categories", {
    page: "1",
    limit: "999",
  });
  const category = listResult.categories.find((c) => c.id === id);
```

This fetches up to 999 categories from the admin list endpoint, serializes them all to JSON, transfers them over the service binding, then filters in JavaScript to find one. The core service already has `getCategoryById()` but it is never exposed as an admin API route.

**Impact:** Wastes bandwidth, CPU, and memory on every category edit page load. At 100+ categories this becomes noticeably slow over a service binding. At 1000+ categories the `limit: 999` cap silently breaks -- the category may not be found.

**Fix approach:**
1. Add a `GET /admin/categories/{id}` route that calls `getCategoryById(db, id)` from the core service
2. Update `getCategoryEditData()` to call `apiGet<Category>("/categories/" + id)` instead of the list endpoint
3. Format the response the same way (add `slugEdited: true`, build image object from `imageUrl`)

### 2. Admin route error handling swallows core error types

**Files:** `apps/api/src/routes/admin/categories.ts` (lines 121-128, 159-166, 222-228, 250-256)

The create, update, delete, and bulk-delete routes catch errors from the core service and re-throw them as generic `ApiError`:

```typescript
} catch (error: unknown) {
    const err = error as { message?: string; statusCode?: number; suggestion?: string; affectedProducts?: unknown };
    throw new ApiError(err.statusCode || 400, "ERROR", err.message || "Unknown error");
}
```

But the core service throws `AppError` subclasses (`ConflictError`, `ValidationError`, `NotFoundError`) which already have `status` and `code` properties -- and these are already handled by Hono's global `onError` in `apps/api/src/app.ts` (line 84) which checks `instanceof ApiError` (which is aliased to `AppError`).

**Problems with the current pattern:**
- `err.statusCode` does not exist on `AppError` -- the property is `err.status`. This means `err.statusCode || 400` always falls back to 400, even for 404 (NotFoundError) or 409 (ConflictError).
- The `error.details` (which contains `suggestion` and `affectedProducts` for `ValidationError`) is only partially forwarded in some routes but not others.
- The typed error code (e.g. `"CONFLICT"`, `"VALIDATION_ERROR"`) is replaced with the generic string `"ERROR"`.

**Fix approach:** Remove all try/catch blocks from the create, update, delete, and bulk-delete handlers. Let the core service errors propagate naturally to the global `onError` handler, which already serializes them correctly. The `permanentDeleteRoute` and `restoreCategoryRoute` handlers already do this correctly (no try/catch).

### 3. Public routes duplicate service logic instead of delegating

**Files:** `apps/api/src/routes/categories.ts` (lines 87-462)

The public category routes in `apps/api/src/routes/categories.ts` contain full database query logic inline -- selecting columns, joining tables, building WHERE conditions, handling pagination. The core service in `packages/core/src/modules/categories/categories.service.ts` has `listPublicCategories()` and `getCategoryBySlug()` but only the list endpoint partially overlaps with `listPublicCategories()` -- neither is actually called.

The `GET /{slug}/products` endpoint (lines 197-463) is a 260-line handler with:
- Inline SQL query construction for products
- Dynamic attribute filtering subquery
- Duplicate count query with identical subquery
- Manual image fetching and mapping
- Price sort with inline CASE expression

This logic belongs in the core service layer (e.g. `categories.storefront.ts` or `products.storefront.ts`), not in the route handler.

**Impact:** Violates the "thin HTTP layer" convention from CLAUDE.md. Makes this logic untestable in isolation and duplicates patterns that exist in product service functions.

---

## Code Quality Issues

### 4. Date handling inconsistency across the stack

**Files:** Multiple

The categories domain has at least four different date handling patterns:

1. **Core service `listCategories()`** (line 79-81): Uses `CAST(${categories.createdAt} AS INTEGER)` then manually converts: `new Date(category.createdAt * 1000).toISOString()`
2. **Public route list handler** (line 96-109): Reads `categories.createdAt` directly as Drizzle timestamp mode (returns `Date`), then: `category.createdAt instanceof Date ? category.createdAt.toISOString() : null`
3. **Public route slug handler** (line 151): Uses `CAST(... AS INTEGER)` + `unixToDate()` helper
4. **Admin hook** (`useCategoryList.ts` line 120-122): Converts ISO string back to Date: `new Date(c.createdAt as string)`

The Drizzle schema declares `createdAt` with `{ mode: "timestamp" }`, which means Drizzle returns a `Date` object. The `CAST(... AS INTEGER)` workaround in the service is to get a raw number for manual formatting. This inconsistency means any change to timestamp handling risks breaking a downstream consumer.

### 5. Slug uniqueness check has a race condition

**Files:** `packages/core/src/modules/categories/categories.service.ts` (lines 206-212, 250-258)

Both `createCategory()` and `updateCategory()` use a SELECT-then-INSERT/UPDATE pattern for slug uniqueness:

```typescript
const existing = await db
    .select({ id: categories.id })
    .from(categories)
    .where(sql`slug = ${data.slug} AND deleted_at IS NULL`)
    .get();
if (existing) throw new ConflictError("...");
// ... later ...
await db.insert(categories).values({ ... });
```

Between the SELECT and the INSERT, another concurrent request could insert the same slug. The `categories_slug_idx` unique index would then throw a raw SQLite constraint error instead of the user-friendly `ConflictError`.

**Mitigation:** The database has a unique index on `slug`, so data integrity is preserved. But the raw SQLite error would surface as a 500 rather than a 409. A UNIQUE constraint on `(slug, deletedAt IS NULL)` partial index or a try/catch around the insert with constraint-violation detection would make this robust.

### 6. createCategorySchema has a rigid `createdAt` transform in image

**Files:** `packages/core/src/modules/categories/categories.validation.ts` (lines 4-15)

```typescript
const imageSchema = z.object({
    // ...
    createdAt: z
        .date()
        .or(z.string())
        .transform((val) => (val instanceof Date ? val : new Date(val))),
}).nullable();
```

The `createdAt` field in the image sub-schema is required but the service layer never reads it -- `createCategory()` only uses `data.image?.url`. This means the admin form must always provide a Date/string for a field that has no backend purpose. The edit page loader hacks around this: `createdAt: new Date()`.

### 7. updateCategorySchema is identical to createCategorySchema

**Files:** `packages/core/src/modules/categories/categories.validation.ts` (line 30)

```typescript
export const updateCategorySchema = createCategorySchema;
```

This means update requires all fields (name, slug, description, image, etc.) to be sent, even if only one field changed. There is no partial update support. If the admin form sends `null` for description when the user intended to keep the existing value, the description gets wiped.

Currently the admin form always sends all fields, so this works in practice. But it makes PATCH-style partial updates impossible without schema changes.

---

## Pattern Violations

### 8. Admin route catches core errors manually instead of letting them propagate

**Convention from CLAUDE.md:** "Thin HTTP layer: routes handle validation and auth, then delegate to core services"

The admin categories route catches errors from the core service and re-throws them, losing type information in the process. Compare with the permanent delete and restore handlers in the same file which correctly let errors propagate:

```typescript
// GOOD -- let errors propagate (lines 275-279)
app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await permanentlyDeleteCategory(db, id);
    return noContent(c);
});

// BAD -- catch and re-throw with lost info (lines 118-128)
app.openapi(createCategoryRoute, async (c) => {
    // ...
    try {
        const result = await createCategory(db, data);
        return created(c, result);
    } catch (error: unknown) {
        const err = error as { message?: string; statusCode?: number; ... };
        throw new ApiError(err.statusCode || 400, "ERROR", err.message || "Unknown error");
    }
});
```

### 9. Public route bypasses core service layer

**Convention from CLAUDE.md:** Service functions live in `packages/core/src/modules/`

The public `GET /categories` and `GET /categories/{slug}` routes inline their queries instead of calling `listPublicCategories()` or `getCategoryBySlug()` from the core service. The `GET /categories/{slug}/products` route has 260 lines of inline query logic with no service function at all.

### 10. Missing `isActive` column on categories

Other entities (`products`, `collections`) have an `isActive` boolean column for toggling visibility without deletion. Categories only have `deletedAt` for soft-delete. This means a category cannot be temporarily hidden -- it must be deleted and restored. This is inconsistent with the products pattern where a product can be `isActive: false` but still exist.

---

## Maintainability Concerns

### 11. Category form schema defined in two places

**Files:**
- `packages/core/src/modules/categories/categories.validation.ts` (server-side Zod)
- `apps/admin/src/components/admin/CategoryForm.tsx` (client-side Zod, lines 42-66)

These two schemas are nearly identical but not shared. If a field is added to the server schema, the client schema must be updated manually. Divergence between them causes silent validation failures (server rejects what client allows, or vice versa).

The `CategoryForm.tsx` schema has an extra `slugEdited` field and slight differences in the image schema (`createdAt: z.date()` vs `z.date().or(z.string()).transform(...)`).

### 12. Storefront category-mapping.ts is hardcoded and domain-specific

**Files:** `apps/storefront/src/lib/category-mapping.ts`

This file maps category slugs to Google/Facebook product taxonomy IDs using a hardcoded dictionary with categories like "medicine", "vitamins-supplements", "baby-care". This is a leftover from a specific pharmacy/health store and will be wrong for any other store type.

The default fallback is "Health & Beauty > Health Care" which is not a generic default.

**Impact:** Any non-pharmacy store using this codebase will emit incorrect structured data in feeds.

### 13. No admin API endpoint for single category fetch

**Files:** `apps/api/src/routes/admin/categories.ts`

The admin API has endpoints for list, create, update, delete, bulk operations, and form-options -- but no `GET /admin/categories/{id}` for fetching a single category. The core service has `getCategoryById()` but it is not exposed. This forces the edit page loader to use the wasteful list-then-filter approach (Critical Issue #1).

---

## Performance & Scalability

### 14. No category hierarchy (flat only)

**Files:** `packages/database/src/schema/products.ts` (lines 101-123)

The `categories` table has no `parentId` column. Categories are flat. This means:
- No subcategories (e.g. "Electronics > Phones > Smartphones")
- No breadcrumb trails beyond Home > Category
- No tree-based navigation or megamenu support
- Products can only belong to one category level

For a small store (<50 categories) this is fine. For larger catalogs this becomes a real limitation. The schema noted in the README acknowledges this: "No category hierarchy: Categories are flat."

**If hierarchy is added later**, the impact touches: schema migration, service layer (tree queries, recursive CTE for ancestors), API routes (tree response format), admin UI (tree picker, drag-and-drop reordering), storefront navigation, breadcrumbs, and sitemap generation.

### 15. Product count query in listCategories scans all active products

**Files:** `packages/core/src/modules/categories/categories.service.ts` (lines 89-96)

```typescript
const countsQuery = db
    .select({
        categoryId: products.categoryId,
        count: sql<number>`count(*)`.as("count"),
    })
    .from(products)
    .where(and(isNull(products.deletedAt), eq(products.isActive, true)))
    .groupBy(products.categoryId);
```

This counts ALL active products grouped by category, not just the ones for the categories on the current page. With 10,000+ products and 50+ categories, this is a full table scan on every category list page load (including search, page changes, sort changes).

**Fix approach:** Either:
- Add a `productCount` column to `categories` and maintain it via triggers or application-level increment/decrement
- Use a subquery correlated to only the categories returned in the current page

### 16. Public /{slug}/products endpoint has N+1 image query pattern

**Files:** `apps/api/src/routes/categories.ts` (lines 362-384)

After fetching products, the route fetches primary images in a separate query using `inArray`:

```typescript
const images = await db.select({ productId, url })
    .from(productImages)
    .where(and(eq(productImages.isPrimary, true), inArray(productImages.productId, productIds)));
```

This is actually well-batched (1 query, not N), but the `inArray` with 20+ IDs on every page load is suboptimal. A JOIN in the main products query would eliminate the second round-trip.

### 17. Duplicate attribute subquery for count

**Files:** `apps/api/src/routes/categories.ts` (lines 413-440)

When attribute filters are active, the route builds the exact same subquery twice -- once for the results and once for the count:

```typescript
// Results query subquery (line 331-353)
const subquery = db.select({ productId }).from(productAttributeValues)...

// Count query subquery (line 414-440) -- IDENTICAL
const countSubquery = db.select({ productId }).from(productAttributeValues)...
```

This could be extracted into a shared subquery builder function.

### 18. listPublicCategories returns ALL categories unbounded

**Files:** `packages/core/src/modules/categories/categories.service.ts` (lines 131-152)

`listPublicCategories()` fetches every non-deleted category with no pagination. The storefront `getAllCategories()` caches this, but the initial fetch at cache miss loads all categories. With hundreds of categories this payload grows unbounded.

---

## Robustness Gaps

### 19. deleteCategory checks products but not soft-deleted products

**Files:** `packages/core/src/modules/categories/categories.service.ts` (lines 277-283)

```typescript
const referencedProducts = await db
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(eq(products.categoryId, id))
    .limit(5)
    .all();
```

This finds ALL products with this `categoryId`, including soft-deleted products (`deletedAt IS NOT NULL`). This means you cannot soft-delete a category if it has soft-deleted products still pointing to it, even though those products are effectively invisible. The admin would need to permanently delete the products first, which is unexpected UX.

Contrast with `listCategories()` product counts (line 95) which correctly filters to only active, non-deleted products.

### 20. bulkDeleteCategories collection cleanup has silent failure

**Files:** `packages/core/src/modules/categories/categories.service.ts` (lines 338-352)

```typescript
for (const collection of affectedCollections) {
    try {
        const config = JSON.parse(collection.config);
        // ...
    } catch { }
}
```

The empty `catch {}` silently swallows JSON parse errors. If a collection has malformed config JSON, the permanent delete succeeds but the collection config is left with a dangling reference to a deleted category ID.

### 21. No cache invalidation on category mutation

**Files:**
- `apps/api/src/routes/categories.ts` (lines 20-28): Cache middleware with 3600s TTL
- `apps/storefront/src/lib/api/categories.ts`: Edge cache with `CACHE_TTL.LONG`

When a category is created, updated, or deleted via the admin API, neither the public API cache (3600s TTL) nor the storefront edge cache is invalidated. Storefront visitors may see stale category data for up to an hour after admin changes.

### 22. Restore does not check for slug conflicts

**Files:** `packages/core/src/modules/categories/categories.service.ts` (lines 366-371)

```typescript
export async function restoreCategories(db: Database, categoryIds: string[]): Promise<void> {
    await db.update(categories)
        .set({ deletedAt: null })
        .where(inArray(categories.id, categoryIds));
}
```

If a category with slug "shoes" was soft-deleted, then a new category with slug "shoes" was created, restoring the original would create a duplicate slug. The unique index is on `slug` alone (not a partial index filtering `deletedAt IS NULL`), so this would throw a raw SQLite constraint error instead of a user-friendly message.

### 23. Sitemap uses createdAt instead of updatedAt for lastmod

**Files:** `apps/storefront/src/pages/sitemap-categories.xml.ts` (line 26)

```typescript
const categoryUrls: SitemapUrl[] = categories.map((category) => ({
    loc: `${baseUrl}/categories/${category.slug}`,
    lastmod: category.createdAt,  // Should be updatedAt
```

This means search engines never see that a category page was updated. `updatedAt` would be the correct field for `lastmod`, but the `Category` type in the storefront only has `createdAt` (the public API does not return `updatedAt`).

---

## LLM-Friendliness

### Positive

- The `README.md` in `packages/core/src/modules/categories/` is excellent -- clear data flow diagram, complete function table, endpoint table, and known gaps section.
- Service functions have JSDoc comments explaining purpose and side effects.
- File naming is consistent: `categories.service.ts`, `categories.validation.ts`.
- The admin UI is well-decomposed: container + header + toolbar + table + pagination + hook.
- Clear barrel export in `index.ts`.

### Needs Improvement

- The public route file `apps/api/src/routes/categories.ts` is 466 lines with all logic inline. An LLM working on category product filtering would need to read the entire file. Extracting the product query builder into a service function would make it more navigable.
- The `useCategoryList.ts` hook is 625 lines with 15+ state variables, 12+ handlers, and multiple effects. It would benefit from being split into smaller custom hooks (e.g. `useCategorySearch`, `useCategorySelection`, `useCategoryActions`).
- The `CategoryForm.tsx` duplicates the Zod schema from the core package. An LLM adding a field would need to update both files -- and there is nothing in the code indicating this coupling.
- The loader file `apps/admin/src/loaders/admin/catalog.ts` mixes page, category, and collection loaders in one file. Domain-specific loader files would be easier to locate.

---

## Recommended Changes

### Priority 1 -- Fix (Bugs/Correctness)

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 1 | **Add `GET /admin/categories/{id}` route** and update `getCategoryEditData()` to use it | `apps/api/src/routes/admin/categories.ts`, `apps/admin/src/loaders/admin/catalog.ts` | Small |
| 2 | **Remove try/catch blocks** from create/update/delete/bulk-delete handlers, let core errors propagate to global handler | `apps/api/src/routes/admin/categories.ts` | Small |
| 3 | **Add slug conflict check to `restoreCategories()`** -- query for existing active categories with same slugs before restoring | `packages/core/src/modules/categories/categories.service.ts` | Small |
| 4 | **Fix sitemap lastmod** -- return `updatedAt` from public category API, use it in sitemap | `apps/api/src/routes/categories.ts`, `apps/storefront/src/pages/sitemap-categories.xml.ts` | Small |

### Priority 2 -- Improve (Quality/Performance)

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 5 | **Extract public route product query into service function** (e.g. `getProductsByCategory()` in `categories.storefront.ts` or `products.storefront.ts`) | `apps/api/src/routes/categories.ts`, new service file | Medium |
| 6 | **Delegate public category list/slug routes to core service** instead of inline queries | `apps/api/src/routes/categories.ts` | Small |
| 7 | **Fix deleteCategory product check** to exclude soft-deleted products: add `isNull(products.deletedAt)` to the WHERE clause | `packages/core/src/modules/categories/categories.service.ts` | Small |
| 8 | **Scope product count query** to only categories on current page, not all categories | `packages/core/src/modules/categories/categories.service.ts` | Small |
| 9 | **Log collection config parse errors** in bulk delete cleanup instead of silent `catch {}` | `packages/core/src/modules/categories/categories.service.ts` | Trivial |

### Priority 3 -- Enhance (Future-Proofing)

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 10 | **Add `isActive` column to categories** for parity with products/collections | Schema migration, service, API routes, admin UI | Medium |
| 11 | **Replace hardcoded category-mapping.ts** with admin-configurable taxonomy mapping (stored in settings) | `apps/storefront/src/lib/category-mapping.ts`, new settings UI | Medium |
| 12 | **Add test coverage** -- at minimum: slug uniqueness, soft-delete guards, bulk delete with collection cleanup | New test file in `tests/` | Medium |
| 13 | **Category hierarchy** -- add `parentId` column for subcategories (if product catalog growth warrants it) | Schema, service, API, admin UI, storefront nav | Large |

---

## Appendix: Error Flow Analysis

The categories domain has three error-handling paths:

1. **Core service** throws `AppError` subclasses (`ConflictError`, `ValidationError`, `NotFoundError`) from `@scalius/core/errors`
2. **API route** (admin) catches these and re-throws as `ApiError` (which is aliased to `AppError`) -- this is redundant and lossy
3. **Global handler** in `apps/api/src/app.ts` catches `ApiError` (= `AppError`) and serializes to JSON response

The correct flow should be: Core throws --> Global handler catches and serializes. The admin route layer should not interfere.

Current error property mapping:
| Core Error Class | `.status` | `.code` | Admin route reads | Admin route sends |
|-----------------|-----------|---------|-------------------|-------------------|
| `ConflictError` | 409 | `"CONFLICT"` | `err.statusCode` (undefined) | 400, `"ERROR"` |
| `ValidationError` | 400 | `"VALIDATION_ERROR"` | `err.statusCode` (undefined) | 400, `"ERROR"` |
| `NotFoundError` | 404 | `"NOT_FOUND"` | `err.statusCode` (undefined) | 400, `"ERROR"` |

The admin route's `err.statusCode` cast reads a nonexistent property, defaulting everything to 400. This means a `NotFoundError(404)` becomes a `400 Bad Request` to the client.
