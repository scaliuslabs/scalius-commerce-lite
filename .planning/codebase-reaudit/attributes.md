# Attributes Domain Re-Audit

**Re-audit Date:** 2026-03-21
**Previous Audit Date:** Pre-fix-session
**Overall Rating: 7.5/10** (up from ~5.5/10)

---

## Previous Findings Status

### 1. Unsafe sort field injection -- arbitrary column access via user input
**Status: FIXED**

The sort field is now validated against an explicit allowlist in `packages/core/src/modules/attributes/attributes.service.ts` lines 65-68:

```typescript
const ALLOWED_SORT_FIELDS = ["name", "slug", "filterable", "createdAt", "updatedAt"] as const;
type SortField = typeof ALLOWED_SORT_FIELDS[number];
const safeSortField: SortField = ALLOWED_SORT_FIELDS.includes(sort as SortField) ? sort as SortField : "name";
const sortColumn = productAttributes[safeSortField];
```

Falls back to `"name"` for invalid input. The API route `apps/api/src/routes/admin/attributes.ts` line 52 still accepts any string for `sort`, but the service-layer allowlist makes this safe.

### 2. Non-atomic rename and delete of attribute values
**Status: STILL OPEN**

`renameAttributeValue()` (lines 437-471) and `deleteAttributeValue()` (lines 473-503) in `packages/core/src/modules/attributes/attributes.service.ts` still perform 2-3 separate sequential queries without `db.batch()`. If the second or third write fails, the system is left inconsistent (e.g., value rows updated but preset options array not updated).

### 3. `createAttribute` does not check soft-deleted duplicates
**Status: STILL OPEN**

`packages/core/src/modules/attributes/attributes.service.ts` lines 125-131 -- the uniqueness check queries all attributes including soft-deleted ones. A soft-deleted "Brand" blocks creating a new "Brand" with a generic error message. The admin user cannot find the blocker since it is hidden from the active view.

### 4. `options` column typed as `text mode: "json"` but loosely typed at runtime
**Status: STILL OPEN**

`packages/database/src/schema/products.ts` line 148 still uses `$type<string[]>()` with no runtime validation. Service code still casts with `(attribute.options as string[]) || []` (lines 292, 427, 460, 495 in `attributes.service.ts`).

### 5. `listAttributes` value count query does not filter soft-deleted products
**Status: STILL OPEN**

`packages/core/src/modules/attributes/attributes.service.ts` lines 82-93 -- the value count subquery still counts values from `productAttributeValues` without joining `products` or checking `isNull(products.deletedAt)`. This inflates counts when soft-deleted products have attribute values.

### 6. `attributeSchema` uses `z.any()` for timestamps and options
**Status: FIXED**

`apps/api/src/schemas/entities.ts` lines 403-413 now uses proper types:

```typescript
options: z.array(z.string()).nullable(),
createdAt: z.union([z.string(), z.number()]),
updatedAt: z.union([z.string(), z.number()]),
deletedAt: z.union([z.string(), z.number()]).nullable(),
```

### 7. Storefront public route has inline DB queries instead of using core service
**Status: FIXED**

A new file `packages/core/src/modules/attributes/attributes.public.ts` was created with three properly-layered functions:
- `getPublicFilterableAttributes()` -- global filter sidebar
- `getPublicAttributesByCategory()` -- category-scoped filters
- `getPublicAttributesByProductIds()` -- search-scoped filters

The route file `apps/api/src/routes/attributes.ts` now imports and delegates to these functions for the filterable and category routes (lines 12, 68, 96, 133). The `searchFiltersRoute` still has inline logic (see finding 16 below).

### 8. Duplicated category-attribute query logic (DRY violation)
**Status: FIXED**

The category-by-ID and category-by-slug routes in `apps/api/src/routes/attributes.ts` both now call `getPublicAttributesByCategory(db, categoryId)`. The slug variant resolves the slug to an ID first (lines 125-131), then calls the same core function. No duplicated query logic.

### 9. Admin API route `addValueRoute` returns 200 instead of 201
**Status: STILL OPEN**

`apps/api/src/routes/admin/attributes.ts` line 328 still uses `return ok(c, {})` (200) instead of `return created(c, ...)` (201). The route definition on line 315 also declares a 200 response. Creating a preset value should return 201.

### 10. `AttributeValuesViewer` reads `productNames` but API returns `sampleProducts`
**Status: FIXED**

The `AttributeValue` type in `apps/admin/src/components/admin/attributes-manager/types/index.ts` line 53-58 now uses `sampleProducts: string[]`. The viewer component `AttributeValuesViewer.tsx` line 154 reads `item.sampleProducts`. The field name matches the API response.

### 11. `listAttributeValues` has complex pagination logic mixing DB results with unused presets
**Status: STILL OPEN**

`packages/core/src/modules/attributes/attributes.service.ts` lines 261-411 -- the function is still ~150 lines with the same fragile pagination merge logic (lines 396-402). The interleaved concerns (DB pagination, preset merging, sample fetching) remain tightly coupled.

### 12. Admin `Attribute` type extends `ProductAttribute` but adds optional `valueCount`
**Status: STILL OPEN**

`apps/admin/src/components/admin/attributes-manager/types/index.ts` line 4-6 still declares `valueCount?: number`. The API always returns this field, so it should be `valueCount: number`. The `AttributesManager.tsx` line 90 still uses `(attr.valueCount || 0)` as a workaround.

### 13. Two separate attribute value viewer/editor components with duplicated fetch logic
**Status: STILL OPEN**

`AttributeValuesViewer.tsx` (lines 48-69) and `AttributeValueEditor.tsx` (lines 66-87) both independently fetch `/api/v1/admin/attributes/${attributeId}/values`, parse with `unwrapEnvelope`, set `values` state, and handle loading/errors. This duplicated fetch logic could be extracted into a shared `useAttributeValues(attributeId)` hook.

### 14. N+1 query in `listAttributeValues` -- per-value sample product fetch
**Status: FIXED**

`packages/core/src/modules/attributes/attributes.service.ts` lines 336-363 now uses a batched approach: a single query with `inArray(productAttributeValues.value, pageValues)` fetches all sample products at once, then groups them in-memory (capped at 5 per value). No more N+1.

### 15. `filterable` route fetches ALL unique values without limit
**Status: PARTIALLY FIXED**

The inline query was moved to `packages/core/src/modules/attributes/attributes.public.ts` `getPublicFilterableAttributes()` (lines 39-45). The query is cleaner but still fetches all distinct (attributeId, value) pairs without a LIMIT. For stores with many attributes and many unique values, this unbounded result set remains a concern. The 1-hour cache (`apps/api/src/routes/attributes.ts` line 24) mitigates repeat cost.

### 16. `searchFiltersRoute` fetches matching products then does a category-scoped attribute query
**Status: STILL OPEN**

`apps/api/src/routes/attributes.ts` lines 158-243 -- the search-filters endpoint still has the same semantic issue. It finds matching products (LIMIT 100), extracts their category IDs (line 191), then fetches ALL attribute values for products in those categories (line 214: `inArray(products.categoryId, categoryIds)`), not just the matching products. Filters shown may include values from non-matching products in the same categories.

Note: `getPublicAttributesByProductIds()` exists in `attributes.public.ts` (lines 103-128) and does the correct thing -- scoping to specific product IDs. The search-filters route does NOT use it; it still has inline logic using category IDs instead.

### 17. No index on `product_attribute_values.value` column
**Status: STILL OPEN**

`packages/database/src/schema/products.ts` lines 175-178 only indexes `productId` and `attributeId`. No composite index on `(attributeId, value)` exists. Queries filtering by value (renameAttributeValue, deleteAttributeValue, storefront attribute filtering) still require scanning the junction table.

### 18. `bulkDeleteAttributes` does not check for product usage
**Status: STILL OPEN**

`packages/core/src/modules/attributes/attributes.service.ts` lines 233-246 -- `bulkDeleteAttributes()` still blindly soft-deletes or hard-deletes without any usage check. The permanent delete path with `onDelete: "cascade"` silently wipes all product-attribute relationships.

### 19. `permanentlyDeleteAttribute` does not check for product usage
**Status: STILL OPEN**

`packages/core/src/modules/attributes/attributes.service.ts` lines 212-216 -- still a bare `db.delete()` with no usage check. Cascade FK deletes all `productAttributeValues` rows silently.

### 20. `restoreAttribute` does not check for name/slug collision with active attributes
**Status: STILL OPEN**

`packages/core/src/modules/attributes/attributes.service.ts` lines 218-231 -- restoring a soft-deleted attribute does not check if an active attribute with the same name/slug now exists. The DB UNIQUE constraint will throw an unhandled error rather than a clean ConflictError.

### 21. `addAttributeValue` silently no-ops for duplicate preset values
**Status: STILL OPEN**

`packages/core/src/modules/attributes/attributes.service.ts` lines 428-434 -- still silently does nothing if the value already exists. API returns 200 with `{}` regardless.

### 22. No length limits on attribute `options` array
**Status: STILL OPEN**

`packages/core/src/modules/attributes/attributes.validation.ts` line 13 -- still `z.array(z.string()).optional()` with no `.max()`. Service appends without limit.

---

## New Issues Found

### 23. `searchFiltersRoute` does not use existing `getPublicAttributesByProductIds()`
**Severity: MEDIUM**
**Files:** `apps/api/src/routes/attributes.ts` lines 158-243, `packages/core/src/modules/attributes/attributes.public.ts` lines 103-128

The fix session created `getPublicAttributesByProductIds()` which correctly scopes attribute values to specific product IDs. However, the `searchFiltersRoute` handler was not refactored to use it. Instead, it still has ~85 lines of inline logic that incorrectly scopes to categories. The fix is straightforward: extract matching product IDs, pass them to `getPublicAttributesByProductIds()`.

### 24. Route handlers cast `c` to `any` for type workaround
**Severity: LOW**
**Files:** `apps/api/src/routes/attributes.ts` lines 66, 92, 120, 158

All four public route handlers use `(async (c: any) => { ... }) as any` to work around Hono/OpenAPI type mismatches. This suppresses type checking on the context object, including `c.get("db")`, `c.req.valid()`, and return types.

### 25. `getPublicFilterableAttributes` does not filter by active/non-deleted products
**Severity: MEDIUM**
**File:** `packages/core/src/modules/attributes/attributes.public.ts` lines 19-60

The global filterable attributes function fetches ALL distinct values from `productAttributeValues` (line 39-45) without joining `products` to check `isActive` or `isNull(deletedAt)`. This means values from inactive or deleted products appear in the storefront filter sidebar. Compare with `getPublicAttributesByCategory()` which correctly filters by `eq(products.isActive, true)` and `isNull(products.deletedAt)`.

### 26. Storefront attributes client uses `result: any` type
**Severity: LOW**
**File:** `apps/storefront/src/lib/api/attributes.ts` line 41

```typescript
let result: any;
```

The SDK calls return typed responses, but the variable is declared `any`, losing type safety for the conditional branches. Should use a union type or handle each branch independently with typed returns.

---

## Summary of Status

| # | Finding | Status |
|---|---------|--------|
| 1 | Unsafe sort field injection | FIXED |
| 2 | Non-atomic rename/delete of values | STILL OPEN |
| 3 | createAttribute soft-deleted duplicate check | STILL OPEN |
| 4 | options column loosely typed at runtime | STILL OPEN |
| 5 | Value count includes soft-deleted products | STILL OPEN |
| 6 | attributeSchema uses z.any() | FIXED |
| 7 | Public route inline DB queries | FIXED |
| 8 | Duplicated category attribute query logic | FIXED |
| 9 | addValueRoute returns 200 not 201 | STILL OPEN |
| 10 | productNames vs sampleProducts mismatch | FIXED |
| 11 | Complex pagination merge logic | STILL OPEN |
| 12 | Attribute.valueCount optional | STILL OPEN |
| 13 | Duplicated viewer/editor fetch logic | STILL OPEN |
| 14 | N+1 query in listAttributeValues | FIXED |
| 15 | Unbounded filterable values query | PARTIALLY FIXED |
| 16 | searchFiltersRoute scopes to categories not products | STILL OPEN |
| 17 | No index on value column | STILL OPEN |
| 18 | bulkDeleteAttributes no usage check | STILL OPEN |
| 19 | permanentlyDeleteAttribute no usage check | STILL OPEN |
| 20 | restoreAttribute no collision check | STILL OPEN |
| 21 | addAttributeValue silent no-op | STILL OPEN |
| 22 | No max length on options array | STILL OPEN |
| 23 | searchFiltersRoute ignores getPublicAttributesByProductIds | NEW |
| 24 | Route handlers cast c to any | NEW |
| 25 | getPublicFilterableAttributes ignores product status | NEW |
| 26 | Storefront client uses any type | NEW |

**Fixed: 6/22 (27%)**
**Partially Fixed: 1/22 (5%)**
**Still Open: 15/22 (68%)**
**New Issues: 4**

---

## Remaining Priority Actions

### Priority 1 -- Data Integrity

| # | Change | Files | Effort |
|---|--------|-------|--------|
| 2 | Wrap renameAttributeValue and deleteAttributeValue in db.batch() | `packages/core/src/modules/attributes/attributes.service.ts` | Small |
| 18 | Add usage check to bulkDeleteAttributes | `packages/core/src/modules/attributes/attributes.service.ts` | Small |
| 19 | Add usage check to permanentlyDeleteAttribute | `packages/core/src/modules/attributes/attributes.service.ts` | Small |
| 20 | Add name/slug collision check to restoreAttribute | `packages/core/src/modules/attributes/attributes.service.ts` | Small |
| 25 | Filter by active/non-deleted products in getPublicFilterableAttributes | `packages/core/src/modules/attributes/attributes.public.ts` | Small |

### Priority 2 -- Correctness

| # | Change | Files | Effort |
|---|--------|-------|--------|
| 5 | Fix listAttributes value count to exclude soft-deleted products | `packages/core/src/modules/attributes/attributes.service.ts` | Small |
| 9 | Change addValueRoute to return 201 via created() | `apps/api/src/routes/admin/attributes.ts` | Trivial |
| 16/23 | Refactor searchFiltersRoute to use getPublicAttributesByProductIds | `apps/api/src/routes/attributes.ts` | Small |
| 21 | Return 409 or informative response when addAttributeValue is a duplicate | `packages/core/src/modules/attributes/attributes.service.ts` | Trivial |

### Priority 3 -- Performance

| # | Change | Files | Effort |
|---|--------|-------|--------|
| 17 | Add composite index on (attributeId, value) | `packages/database/src/schema/products.ts` + migration | Small |
| 15 | Add LIMIT to getPublicFilterableAttributes unique values query | `packages/core/src/modules/attributes/attributes.public.ts` | Small |

### Priority 4 -- Maintainability

| # | Change | Files | Effort |
|---|--------|-------|--------|
| 3 | Improve createAttribute error message for soft-deleted conflicts | `packages/core/src/modules/attributes/attributes.service.ts` | Trivial |
| 12 | Make Attribute.valueCount required (not optional) | `apps/admin/src/components/admin/attributes-manager/types/index.ts` | Trivial |
| 13 | Extract shared useAttributeValues hook from viewer/editor | `apps/admin/src/components/admin/attributes-manager/hooks/` | Small |
| 22 | Add .max(500) to options array in validation | `packages/core/src/modules/attributes/attributes.validation.ts` | Trivial |
| 24 | Remove (c: any) casts from public route handlers | `apps/api/src/routes/attributes.ts` | Small |

---

## What Improved

The fix session made meaningful progress on the highest-impact items:

1. **Security**: Sort field injection is properly guarded with an allowlist
2. **Architecture**: Public attribute queries extracted from routes into `attributes.public.ts` following thin-HTTP-layer convention
3. **DRY**: Category-by-ID and category-by-slug routes now share a single core function
4. **Performance**: N+1 query in listAttributeValues replaced with batched query
5. **Type Safety**: OpenAPI schema uses proper types instead of z.any()
6. **Field Mismatch**: productNames/sampleProducts bug fixed in types and component

The remaining issues are predominantly data-integrity guards (usage checks, collision checks, atomicity) and smaller correctness/maintainability items. The new `attributes.public.ts` module is well-structured but has a gap where `getPublicFilterableAttributes` does not filter by product status, and the search-filters route was not refactored to use `getPublicAttributesByProductIds`.
