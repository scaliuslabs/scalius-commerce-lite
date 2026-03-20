# Collections Domain Audit

**Date:** 2026-03-20
**Scope:** Complete vertical slice -- schema, core service, API routes (admin + public), admin UI, storefront components, storefront API client.

---

## Summary

The Collections domain is a well-structured vertical slice with clean separation across all layers. It supports two layout types (`manual` grid and `dynamic` carousel), configurable product resolution via a JSON config column, drag-and-drop reordering, soft-delete with trash/restore, and bulk operations. The homepage leverages an efficient batch-resolution path (`resolveCollectionProductsBatch`) to avoid N+1 queries.

The domain has **no critical production bugs** but contains several **pattern inconsistencies**, **type safety gaps**, and a **performance concern** in the reorder path. The highest-impact improvement is fixing the `new Date()` vs `sql\`unixepoch()\`` inconsistency, which is a ticking timestamp bug.

**Files audited (30 files):**
- Schema: `packages/database/src/schema/products.ts` (lines 125-141)
- Core: `packages/core/src/modules/collections/` (4 files)
- API admin routes: `apps/api/src/routes/admin/collections.ts`
- API public routes: `apps/api/src/routes/collections.ts`
- API entity schema: `apps/api/src/schemas/entities.ts` (lines 311-328)
- Admin UI: `apps/admin/src/components/admin/collection-form/` (4 files)
- Admin UI: `apps/admin/src/components/admin/collections-list/` (12 files)
- Admin pages: `apps/admin/src/pages/admin/collections/` (4 files)
- Admin loader: `apps/admin/src/loaders/admin/catalog.ts`
- Storefront: `apps/storefront/src/lib/api/collections.ts`
- Storefront: `apps/storefront/src/components/collection1.astro`
- Storefront: `apps/storefront/src/components/collection2.astro`
- Storefront: `apps/storefront/src/pages/index.astro`
- Storefront types: `apps/storefront/src/lib/api/types.ts` (Collection interface)
- Storefront service: `packages/core/src/modules/storefront/storefront.service.ts`

---

## Critical Issues

### 1. `new Date()` produces wrong timestamps in D1 -- active bug

**Severity:** High
**Files:** `packages/core/src/modules/collections/collections.service.ts` (lines 126, 146, 160, 168, 175, 182, 193)

Every mutation in the collections service sets timestamps using `new Date()`:

```typescript
// Line 126 -- updateCollection
const updateData: Partial<typeof collections.$inferInsert> & { updatedAt: Date } = { updatedAt: new Date() };

// Line 146 -- deleteCollection
.set({ deletedAt: new Date(), updatedAt: new Date() })

// Line 160 -- bulkDeleteCollections
.set({ deletedAt: new Date(), updatedAt: new Date() })
```

The schema defines these columns as `integer("updated_at", { mode: "timestamp" })` with `default(UNIX_NOW)` where `UNIX_NOW` resolves to `sql\`(strftime('%s', 'now'))\``. When Drizzle receives a JavaScript `Date` object for an integer timestamp column, it calls `.getTime()` which returns **milliseconds since epoch** (e.g., 1710000000000), but the schema stores **seconds since epoch** (e.g., 1710000000). The public routes then multiply by 1000 again in `formatTimestamp()`:

```typescript
// apps/api/src/routes/collections.ts line 33
const date = new Date(numTimestamp * 1000);
```

This means timestamps stored via `new Date()` get double-multiplied, producing dates in the year 56000+. The only reason this hasn't visibly broken is that the admin UI doesn't prominently display timestamps for collections -- it shows "Content Source" instead.

**Every other domain uses `sql\`unixepoch()\``:**
- `packages/core/src/modules/categories/categories.service.ts` -- uses `sql\`unixepoch()\``
- `packages/core/src/modules/widgets/widgets.service.ts` -- uses `sql\`unixepoch()\``
- `packages/core/src/modules/pages/pages.service.ts` -- uses `sql\`unixepoch()\``
- `packages/core/src/modules/analytics/analytics.service.ts` -- uses `sql\`unixepoch()\``

**Fix:** Replace all 7 instances of `new Date()` in `collections.service.ts` with `sql\`unixepoch()\``. Import `sql` (already imported). Change the type annotation on line 126 from `{ updatedAt: Date }` to `{ updatedAt: any }` or use `sql\`unixepoch()\`` directly in the set call.

### 2. `updateCollection` silently succeeds on non-existent IDs

**Severity:** Medium
**File:** `packages/core/src/modules/collections/collections.service.ts` (lines 121-138)

```typescript
export async function updateCollection(db: Database, id: string, data: UpdateCollectionInput) {
    const updateData = { updatedAt: new Date() };
    // ... build updateData ...
    return db.update(collections).set(updateData).where(eq(collections.id, id)).returning().get();
}
```

If `id` doesn't exist, `.returning().get()` returns `undefined` and the caller gets no error. The API route at `apps/api/src/routes/admin/collections.ts` line 346 returns `ok(c, result)` where `result` is `undefined`, sending `{ success: true, data: undefined }`.

Compare with `deleteCollection()` which properly checks existence first and throws `NotFoundError`. The update path should do the same.

**Fix:** Add existence check before update, or check the return value:
```typescript
const result = await db.update(collections).set(updateData).where(eq(collections.id, id)).returning().get();
if (!result) throw new NotFoundError("Collection not found");
return result;
```

---

## Code Quality Issues

### 3. Storefront type includes phantom `"AllCategories"` enum value

**File:** `apps/storefront/src/lib/api/types.ts` (line 192)

```typescript
export interface Collection {
  type: "manual" | "dynamic" | "AllCategories";
  // ...
}
```

Neither the DB schema (`packages/database/src/schema/products.ts` line 128: `enum: ["manual", "dynamic"]`), the Zod validation (`packages/core/src/modules/collections/collections.validation.ts` line 15: `z.enum(["manual", "dynamic"])`), nor the API entity schema (`apps/api/src/schemas/entities.ts` line 320: `z.enum(["manual", "dynamic"])`) accepts `"AllCategories"`. This is a leftover from a previous type system that was never cleaned up.

The homepage type guards in `apps/storefront/src/pages/index.astro` (lines 77-86) correctly only check for `"manual"` and `"dynamic"`, so a collection with type `"AllCategories"` would simply not render. But the type mismatch is confusing for anyone reading the storefront types.

**Fix:** Remove `"AllCategories"` from the `Collection` interface type union.

### 4. Storefront SDK client uses `as any` casts to navigate response envelope

**File:** `apps/storefront/src/lib/api/collections.ts` (lines 28, 62)

```typescript
return (data as any)?.data?.collections ?? null;
// ...
const d = (data as any)?.data;
```

The SDK response types don't match the actual envelope structure, so the storefront casts through `any`. This is a symptom of the SDK not being fully aligned with the API response envelope. When the SDK is regenerated with correct response schemas, these casts should be removable.

### 5. `CollectionRow` uses `& any` in forwardRef generic

**File:** `apps/admin/src/components/admin/collections-list/components/CollectionRow.tsx` (lines 23-25)

```typescript
export const CollectionRow = forwardRef<
  HTMLTableRowElement,
  CollectionRowProps & any
>(
```

The `& any` wipes out all type safety for the spread props from `@hello-pangea/dnd`. The proper fix is to type the Draggable props explicitly or use `DraggableProvidedDraggableProps` from the library.

### 6. API route query param `sort` uses unsafe type cast

**File:** `apps/api/src/routes/admin/collections.ts` (line 101)

```typescript
sort: q.sort as "name" | "type" | "isActive" | "updatedAt" | "sortOrder" | undefined,
```

The Zod schema for the query defines `sort` as `z.string().optional()`, so any string passes validation. The cast silences the type checker without actually constraining the input. If a client sends `sort=deleteMe`, it flows through to the service which falls into the `default` case of the sort switch and silently sorts by `sortOrder`.

**Fix:** Use `z.enum(["name", "type", "isActive", "updatedAt", "sortOrder"]).default("sortOrder")` in the route schema, eliminating the cast.

### 7. API route `order` query param also uses unsafe cast

**File:** `apps/api/src/routes/admin/collections.ts` (line 102)

Same issue as above: `order: q.order as "asc" | "desc" | undefined`. Fix with `z.enum(["asc", "desc"]).default("asc")`.

---

## Pattern Violations

### 8. `reorderCollections` uses sequential updates instead of `db.batch()`

**File:** `packages/core/src/modules/collections/collections.service.ts` (lines 186-196)

```typescript
export async function reorderCollections(db: Database, items: { id: string; sortOrder: number }[]): Promise<void> {
    for (const item of items) {
        await db.update(collections).set({ sortOrder: item.sortOrder, updatedAt: new Date() })
            .where(eq(collections.id, item.id));
    }
}
```

This issues N sequential D1 round trips (one per collection). With 10 collections, that is 10 round trips on every drag-and-drop. The batch resolution functions in the same file (`resolveCollectionProducts`, `resolveCollectionProductsBatch`) correctly use `db.batch()`.

**Fix:** Use `db.batch()`:
```typescript
export async function reorderCollections(db: Database, items: { id: string; sortOrder: number }[]): Promise<void> {
    if (items.length === 0) return;
    await db.batch(
        items.map((item) =>
            db.update(collections).set({ sortOrder: item.sortOrder, updatedAt: sql`unixepoch()` })
                .where(eq(collections.id, item.id))
        )
    );
}
```

### 9. Search uses LIKE instead of FTS5

**File:** `packages/core/src/modules/collections/collections.service.ts` (line 43)

```typescript
whereConditions.push(like(collections.name, `%${search}%`));
```

Other domains (categories, products) use FTS5 for search. Collections uses SQL `LIKE %term%` which is:
- Not indexed (full table scan on `name` column)
- Case-sensitive in SQLite by default (without NOCASE collation)
- Inconsistent with the project's search pattern

For a small table (typically <50 rows), the performance difference is negligible, but the pattern inconsistency makes the codebase harder to maintain. The LIKE search also does not sanitize `%` or `_` wildcards in the search term.

**Fix (low priority):** Either add FTS5 for consistency, or at minimum escape LIKE wildcards: `search.replace(/[%_]/g, '\\$&')`.

### 10. Duplicate `formatTimestamp` / `unixToISO` utility

**Files:**
- `apps/api/src/routes/collections.ts` (lines 25-42) -- `formatTimestamp()`
- `packages/core/src/modules/storefront/storefront.service.ts` (lines 27-37) -- `unixToISO()`

These are identical functions with different names. Both convert Unix seconds to ISO strings with the same null/NaN guards.

**Fix:** Extract to `@scalius/shared` as a single utility.

### 11. Admin delete route catches and re-wraps errors unnecessarily

**File:** `apps/api/src/routes/admin/collections.ts` (lines 366-376, 393-404)

```typescript
} catch (error: unknown) {
    const err = error as { message?: string; statusCode?: number };
    throw new ApiError(err.statusCode || 400, "ERROR", err.message || "Unknown error");
}
```

The `deleteCollection` service already throws `NotFoundError` (which extends `ApiError`). Catching it and re-wrapping loses the original error class. The API's global error handler already catches `ApiError` subclasses. This pattern is applied to both the soft-delete and permanent-delete routes.

**Fix:** Remove the try/catch blocks entirely. The service throws properly typed errors that the global handler will catch.

---

## Maintainability Concerns

### 12. Config is stored as raw JSON string -- no validation on read

**Files:**
- `packages/database/src/schema/products.ts` line 129: `config: text("config").notNull()`
- `packages/core/src/modules/collections/collections.service.ts` line 115: `config: JSON.stringify(data.config)`
- `apps/api/src/routes/collections.ts` line 163: `const config = JSON.parse(collection.config)`
- `apps/admin/src/loaders/admin/catalog.ts` line 100-102: manual parse with fallback
- `apps/admin/src/components/admin/collections-list/components/CollectionRow.tsx` line 94: `JSON.parse(collection.config)` in try/catch

Every consumer of the config column independently calls `JSON.parse()` with varying levels of error handling. There is no schema validation on read. If a row has malformed JSON, the public route throws an unhandled parse error (line 163 has no try/catch), while the admin row silently shows "N/A".

**Fix:** Add a `parseCollectionConfig()` function in the service module that validates against the Zod schema:
```typescript
export function parseCollectionConfig(raw: string): CollectionConfig {
    try {
        return collectionConfigSchema.parse(JSON.parse(raw));
    } catch {
        return { categoryIds: [], productIds: [], maxProducts: 8 };
    }
}
```

### 13. Form schema is duplicated between core validation and admin types

**Files:**
- `packages/core/src/modules/collections/collections.validation.ts` -- `createCollectionSchema`, `collectionConfigSchema`
- `apps/admin/src/components/admin/collection-form/types.ts` -- `collectionFormSchema`

These are nearly identical Zod schemas. The admin version adds an optional `id` field. But they can drift independently -- e.g., if a new config field is added to the core schema but forgotten in the admin form schema.

**Fix:** Import and extend the core schema in the admin form:
```typescript
import { createCollectionSchema } from "@scalius/core/modules/collections";
export const collectionFormSchema = createCollectionSchema.extend({ id: z.string().optional() });
```

### 14. Statistics counts are computed from current page, not total

**File:** `apps/admin/src/components/admin/collections-list/CollectionsList.tsx` (lines 76-78)

```typescript
const activeCount = collections.filter((c) => c.isActive).length;
const inactiveCount = collections.length - activeCount;
```

When paginated, `collections` only contains the current page's items. The statistics cards show "Active: 5" when there are 5 active collections on the current page, not the total across all pages. `pagination.total` is used for "Total Collections" but the active/inactive breakdown is only for the visible page.

**Fix:** Either compute active/inactive counts server-side and include them in the API response, or label the stats as "On this page" to set correct expectations.

---

## Performance & Scalability

### 15. `formOptions` endpoint loads up to 500 categories and 500 products

**File:** `apps/api/src/routes/admin/collections.ts` (lines 52-65)

```typescript
const [allCategories, allProducts] = await Promise.all([
    db.select({ id: categories.id, name: categories.name }).from(categories).where(isNull(categories.deletedAt)).limit(500),
    db.select({ id: products.id, name: products.name, price: products.price }).from(products).where(isNull(products.deletedAt)).limit(500),
]);
```

This loads all categories and products into memory for the collection form dropdowns. At 500 items, the response payload is ~25KB which is acceptable. But:
- The limit of 500 is undocumented; a store with 501+ products silently loses the rest
- The product data includes `price` which the form uses but could be fetched lazily
- No pagination or search on this endpoint -- the client-side `ProductSelectionSection` does local filtering

For stores with >500 products, the correct fix is to add server-side search/pagination to the product selector, similar to how the `Command` component already has a search input.

### 16. Batch resolution does not enforce per-collection `maxProducts` at the SQL level

**File:** `packages/core/src/modules/collections/collections.service.ts` (lines 362-472)

`resolveCollectionProductsBatch()` fetches ALL products matching the aggregate of all collection IDs, then applies per-collection `maxProducts` limits in JavaScript via `.slice(0, maxProducts)`. For category-based collections where a category has 200 products but `maxProducts` is 8, this fetches and discards 192 products.

The single-collection `resolveCollectionProducts()` correctly applies `.limit(maxProducts)` at the SQL level (line 291, 319).

This is an intentional tradeoff (2 D1 round trips for any number of collections vs. N round trips), and for the typical homepage with 3-5 collections it is fine. But for stores with large catalogs and many category-based collections, the over-fetching becomes measurable.

### 17. Correlated subqueries for image and variant detection

**File:** `packages/core/src/modules/collections/collections.service.ts` (lines 213-227)

```typescript
imageUrl: sql<string | null>`(
    SELECT "product_images"."url" FROM "product_images"
    WHERE "product_images"."product_id" = "products"."id"
      AND "product_images"."is_primary" = 1
    ORDER BY "product_images"."sort_order" ASC LIMIT 1
)`.as("imageUrl"),
hasVariants: sql<boolean>`(
    SELECT COUNT(*) > 0 FROM "product_variants"
    WHERE "product_variants"."product_id" = "products"."id"
      AND "product_variants"."deleted_at" IS NULL
)`.as("hasVariants"),
```

These correlated subqueries execute once per product row. For 50 products across 5 collections, that is 100 subqueries. The `product_images` table has an index on `(product_id, is_primary)` so the image lookup is indexed, but the `product_variants` query uses `COUNT(*) > 0` which scans all matching rows rather than `EXISTS()` which short-circuits.

**Fix (minor):** Change `COUNT(*) > 0` to `EXISTS (SELECT 1 FROM ...)`.

---

## Robustness Gaps

### 18. Public collection route does not validate JSON.parse output

**File:** `apps/api/src/routes/collections.ts` (line 163)

```typescript
const config = JSON.parse(collection.config);
const resolved = await resolveCollectionProducts(db, config);
```

If `collection.config` contains valid JSON but unexpected shape (e.g., `"null"` or `"[]"` or `{"badField": 1}`), `resolveCollectionProducts` receives an object without the expected fields. The function handles this gracefully by defaulting to empty arrays (`Array.isArray(config.productIds) ? config.productIds : []`), but a malformed config string (not valid JSON) would throw an unhandled `SyntaxError`.

**Fix:** Wrap in try/catch or validate with the Zod schema:
```typescript
let config;
try { config = JSON.parse(collection.config); }
catch { throw new ApiError(500, "INTERNAL", "Invalid collection config"); }
```

### 19. Bulk operations accept empty arrays without guard

**Files:** `packages/core/src/modules/collections/collections.service.ts`:
- `bulkDeleteCollections` (line 150) -- `inArray(collections.id, [])` with empty array
- `bulkActivateCollections` (line 165)
- `bulkDeactivateCollections` (line 172)
- `restoreCollections` (line 179)

Drizzle's `inArray` with an empty array generates `WHERE id IN ()` which is invalid SQL in SQLite. This would throw a D1 error.

The API routes don't guard for empty arrays either -- they pass the body directly through.

**Fix:** Add early return guard:
```typescript
if (ids.length === 0) return;
```

### 20. No storefront cache invalidation when collections are modified

**Files:**
- `apps/storefront/src/lib/api/collections.ts` -- edge-cached with `CACHE_TTL.LONG`
- `apps/api/src/routes/admin/collections.ts` -- no cache purge on mutations

When an admin creates, updates, reorders, or deletes a collection, the storefront edge cache continues serving stale data until TTL expires. Other domains (products, categories) have explicit cache purge mechanisms.

This means collection changes (reordering, activating/deactivating, renaming) may not appear on the storefront for the duration of `CACHE_TTL.LONG` (likely 1 hour based on other domain patterns).

---

## LLM-Friendliness

### Strengths

1. **Excellent README** -- `packages/core/src/modules/collections/README.md` is one of the best domain READMEs in the codebase. It documents types, config schema, product resolution priority, data flow, all service functions with signatures, all API endpoints, all UI components with file paths, and known gaps.

2. **Clear file naming** -- All files follow the `collections.{purpose}.ts` convention. The admin UI is split into logical components with a clear component tree.

3. **Small API surface** -- The service exports 9 functions with clear names (`listCollections`, `createCollection`, `updateCollection`, etc.). No god functions.

4. **Barrel exports** -- `packages/core/src/modules/collections/index.ts` re-exports everything. Admin UI has barrel exports at `components/index.ts`, `hooks/index.ts`.

5. **Type colocation** -- `apps/admin/src/components/admin/collections-list/types/index.ts` keeps all UI types in one file.

### Weaknesses

1. **Raw JSON config pattern** -- An LLM modifying collections must understand that `config` is a JSON-stringified blob with a specific shape, and that the shape is defined in the Zod schema but not enforced on read. A structured config column (or at minimum a `parseCollectionConfig()` helper) would make this self-documenting.

2. **Implicit product resolution priority** -- The `productIds > categoryIds` priority is only documented in the README and a JSDoc comment. The code expresses it through sequential `if/else if/else` blocks but doesn't name the pattern.

3. **Two parallel API paths for storefront** -- The homepage uses `resolveCollectionProductsBatch()` via `storefront.service.ts`, while the individual collection endpoint uses `resolveCollectionProducts()` via the public route. Both resolve products but through different code paths with slightly different data shapes. An LLM modifying one path might miss the other.

---

## Recommended Changes

### Priority 1 -- Correctness (should fix now)

| # | Issue | File | Fix |
|---|-------|------|-----|
| 1 | `new Date()` timestamp bug | `collections.service.ts` (7 lines) | Replace with `sql\`unixepoch()\`` |
| 2 | Silent update on missing ID | `collections.service.ts` line 121 | Add existence check or null guard |
| 18 | Unhandled JSON.parse in public route | `apps/api/src/routes/collections.ts` line 163 | Add try/catch |
| 19 | Empty array to `inArray()` | `collections.service.ts` (4 functions) | Add `if (ids.length === 0) return;` |

### Priority 2 -- Pattern Consistency (next session)

| # | Issue | File | Fix |
|---|-------|------|-----|
| 3 | `"AllCategories"` phantom type | `apps/storefront/src/lib/api/types.ts` line 192 | Remove from union |
| 6-7 | Unsafe sort/order casts | `apps/api/src/routes/admin/collections.ts` lines 101-102 | Use `z.enum()` in route schema |
| 8 | Sequential reorder updates | `collections.service.ts` lines 186-196 | Use `db.batch()` |
| 10 | Duplicate timestamp formatter | Two files | Extract to `@scalius/shared` |
| 11 | Unnecessary error re-wrapping | `apps/api/src/routes/admin/collections.ts` lines 366-376, 393-404 | Remove try/catch |

### Priority 3 -- Quality of Life (opportunistic)

| # | Issue | File | Fix |
|---|-------|------|-----|
| 5 | `& any` on CollectionRow | `CollectionRow.tsx` line 24 | Type DnD props explicitly |
| 12 | No config validation on read | Multiple files | Add `parseCollectionConfig()` helper |
| 13 | Duplicated form/validation schemas | `types.ts` vs `collections.validation.ts` | Import and extend core schema |
| 14 | Page-scoped statistics | `CollectionsList.tsx` lines 76-78 | Compute server-side |
| 17 | `COUNT(*) > 0` vs `EXISTS` | `collections.service.ts` line 222 | Use EXISTS subquery |

### Priority 4 -- Nice to Have (low urgency)

| # | Issue | File | Fix |
|---|-------|------|-----|
| 4 | SDK `as any` casts | `apps/storefront/src/lib/api/collections.ts` | Resolves when SDK is regenerated |
| 9 | LIKE search (not FTS5) | `collections.service.ts` line 43 | Add FTS5 or escape wildcards |
| 15 | 500 item limit on form options | `apps/api/src/routes/admin/collections.ts` | Add server-side search |
| 16 | Over-fetching in batch resolution | `collections.service.ts` line 362 | Acceptable tradeoff for now |
| 20 | No cache invalidation on mutations | Admin routes | Add purge-cache call on write operations |

---

## File Index

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Schema | `packages/database/src/schema/products.ts:125-141` | 17 | `collections` table definition |
| Core | `packages/core/src/modules/collections/collections.service.ts` | 473 | All queries and mutations |
| Core | `packages/core/src/modules/collections/collections.validation.ts` | 28 | Zod schemas |
| Core | `packages/core/src/modules/collections/index.ts` | 3 | Barrel exports |
| Core | `packages/core/src/modules/collections/README.md` | 198 | Domain documentation |
| API | `apps/api/src/routes/admin/collections.ts` | 407 | Admin OpenAPIHono routes |
| API | `apps/api/src/routes/collections.ts` | 189 | Public storefront routes |
| API | `apps/api/src/schemas/entities.ts:311-328` | 18 | `collectionSchema` Zod entity |
| Admin | `apps/admin/src/components/admin/collection-form/CollectionFormContainer.tsx` | 209 | Form with react-hook-form |
| Admin | `apps/admin/src/components/admin/collection-form/ProductSelectionSection.tsx` | 241 | Category/product picker |
| Admin | `apps/admin/src/components/admin/collection-form/LayoutSettingsSection.tsx` | 244 | Type, title, featured, max |
| Admin | `apps/admin/src/components/admin/collection-form/types.ts` | 54 | Form schema and types |
| Admin | `apps/admin/src/components/admin/collections-list/CollectionsList.tsx` | 247 | List orchestrator |
| Admin | `apps/admin/src/components/admin/collections-list/components/CollectionRow.tsx` | 259 | Inline edit, DnD row |
| Admin | `apps/admin/src/components/admin/collections-list/components/CollectionTable.tsx` | 251 | DnD table wrapper |
| Admin | `apps/admin/src/components/admin/collections-list/components/CollectionToolbar.tsx` | 95 | Search + bulk actions |
| Admin | `apps/admin/src/components/admin/collections-list/components/CollectionStatistics.tsx` | 66 | Stat cards |
| Admin | `apps/admin/src/components/admin/collections-list/components/CollectionDeleteDialog.tsx` | 55 | Delete confirmation |
| Admin | `apps/admin/src/components/admin/collections-list/components/CollectionPagination.tsx` | 20 | Pagination wrapper |
| Admin | `apps/admin/src/components/admin/collections-list/hooks/useCollections.ts` | 84 | Fetch + pagination state |
| Admin | `apps/admin/src/components/admin/collections-list/hooks/useCollectionActions.ts` | 129 | CRUD action handlers |
| Admin | `apps/admin/src/components/admin/collections-list/hooks/useBulkActions.ts` | 89 | Multi-select + bulk ops |
| Admin | `apps/admin/src/components/admin/collections-list/types/index.ts` | 126 | All list TypeScript types |
| Admin | `apps/admin/src/loaders/admin/catalog.ts` | 131 | SSR data loaders |
| Admin | `apps/admin/src/pages/admin/collections/index.astro` | -- | List page |
| Admin | `apps/admin/src/pages/admin/collections/new.astro` | 18 | Create page |
| Admin | `apps/admin/src/pages/admin/collections/[id]/edit.astro` | 30 | Edit page |
| Admin | `apps/admin/src/pages/admin/collections/trash.astro` | -- | Trash page |
| Storefront | `apps/storefront/src/lib/api/collections.ts` | 81 | SDK client with edge cache |
| Storefront | `apps/storefront/src/lib/api/types.ts:189-204` | 16 | Collection interfaces |
| Storefront | `apps/storefront/src/components/collection1.astro` | 101 | Grid layout component |
| Storefront | `apps/storefront/src/components/collection2.astro` | 18 | Carousel layout component |
| Storefront | `apps/storefront/src/pages/index.astro` | 138 | Homepage rendering |
| Batch | `packages/core/src/modules/storefront/storefront.service.ts:60-170` | 110 | Homepage batch resolution |
