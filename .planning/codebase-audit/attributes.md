# Attributes Domain Audit

## Summary

The attributes domain is a well-structured vertical slice covering schema, core service, API routes, storefront public routes, and a fully componentized admin UI. It handles product attribute definitions (e.g. "Brand", "Color") and per-product attribute values, with features for filtering, soft-delete/restore, bulk operations, and preset value management.

**Overall quality: Solid** -- the code follows codebase conventions, uses proper error classes, and has clean separation. However, there are several medium-severity issues around atomicity, type safety, performance (N+1 queries), and missing validation that should be addressed.

**Files audited:**

| Layer | Files |
|-------|-------|
| Schema | `packages/database/src/schema/products.ts` (lines 143-180) |
| Core service | `packages/core/src/modules/attributes/attributes.service.ts` |
| Core validation | `packages/core/src/modules/attributes/attributes.validation.ts` |
| Core index | `packages/core/src/modules/attributes/index.ts` |
| API routes (admin) | `apps/api/src/routes/admin/attributes.ts` |
| API routes (public) | `apps/api/src/routes/attributes.ts` |
| API entity schema | `apps/api/src/schemas/entities.ts` (lines 404-416) |
| Admin page | `apps/admin/src/pages/admin/attributes/index.astro` |
| Admin manager | `apps/admin/src/components/admin/attributes-manager/AttributesManager.tsx` |
| Admin types | `apps/admin/src/components/admin/attributes-manager/types/index.ts` |
| Admin hooks | `apps/admin/src/components/admin/attributes-manager/hooks/useAttributes.ts` |
| Admin hooks | `apps/admin/src/components/admin/attributes-manager/hooks/useAttributeActions.ts` |
| Admin hooks | `apps/admin/src/components/admin/attributes-manager/hooks/useBulkActions.ts` |
| Admin components | All 9 files in `apps/admin/src/components/admin/attributes-manager/components/` |
| Storefront client | `apps/storefront/src/lib/api/attributes.ts` |

---

## Critical Issues

### 1. Unsafe sort field injection -- arbitrary column access via user input

**Severity: HIGH**
**File:** `packages/core/src/modules/attributes/attributes.service.ts` line 65

```typescript
const sortField = sort as keyof typeof productAttributes._.columns;
const attributes = await db
    .select()
    .from(productAttributes)
    .orderBy(
        order === "asc"
            ? asc(productAttributes[sortField])
            : desc(productAttributes[sortField]),
    )
```

The `sort` parameter comes directly from the user's query string (`?sort=name`). It is cast with `as keyof` but never validated against an allowlist. If a user sends `?sort=deletedAt` or any internal column name, they can sort by it. Worse, if the column name does not exist on the Drizzle schema object, `productAttributes[sortField]` returns `undefined`, which could cause a runtime crash in the Drizzle `asc()`/`desc()` call.

The API route does not constrain `sort` either -- it accepts any string:

```typescript
sort: z.string().optional().default("name").openapi({ description: "Sort field" }),
```

**Fix:** Add an allowlist in the validation or service layer:

```typescript
const ALLOWED_SORT_FIELDS = ["name", "slug", "filterable", "updatedAt", "createdAt"] as const;
type SortField = typeof ALLOWED_SORT_FIELDS[number];
const safeSort: SortField = ALLOWED_SORT_FIELDS.includes(sort as SortField) ? sort as SortField : "name";
```

### 2. Non-atomic rename and delete of attribute values

**Severity: MEDIUM-HIGH**
**File:** `packages/core/src/modules/attributes/attributes.service.ts` lines 419-485

Both `renameAttributeValue()` and `deleteAttributeValue()` perform two separate DB writes (update/delete on `productAttributeValues`, then update on `productAttributes.options`) without using `db.batch()`. If the second write fails, the system is left in an inconsistent state where the value rows were updated but the preset options array still has the old value (or vice versa).

```typescript
// renameAttributeValue -- 3 separate queries, no batch:
// 1. UPDATE productAttributeValues SET value = newValue
// 2. SELECT productAttributes WHERE id = attributeId
// 3. UPDATE productAttributes SET options = [renamed]
```

**Fix:** Wrap each mutation in `db.batch()`:

```typescript
export async function renameAttributeValue(db: Database, attributeId: string, oldValue: string, newValue: string) {
    const attribute = await db.select().from(productAttributes).where(eq(productAttributes.id, attributeId)).get();
    if (!attribute) throw new NotFoundError("Attribute not found");

    const batchOps = [
        db.update(productAttributeValues).set({ value: newValue })
            .where(and(eq(productAttributeValues.attributeId, attributeId), eq(productAttributeValues.value, oldValue))),
    ];

    const currentOptions = (attribute.options as string[]) || [];
    if (currentOptions.includes(oldValue)) {
        const newOptions = currentOptions.map(o => o === oldValue ? newValue : o);
        batchOps.push(db.update(productAttributes).set({ options: newOptions }).where(eq(productAttributes.id, attributeId)));
    }

    await db.batch(batchOps as any);
}
```

---

## Code Quality Issues

### 3. `createAttribute` does not check soft-deleted duplicates

**File:** `packages/core/src/modules/attributes/attributes.service.ts` lines 122-128

The uniqueness check queries attributes regardless of `deletedAt` status. This means a soft-deleted attribute with name "Brand" will block creating a new attribute called "Brand". This is technically correct for DB uniqueness but bad UX -- the admin sees "An attribute with that name already exists" but cannot find it because it is in the trash.

**Fix:** Either (a) offer a more specific error message noting the attribute is in the trash, or (b) scope the check to `isNull(deletedAt)` and let the DB UNIQUE constraint catch genuine conflicts.

### 4. `options` column typed as `text mode: "json"` but loosely typed at runtime

**File:** `packages/database/src/schema/products.ts` line 148

```typescript
options: text("options", { mode: "json" }).$type<string[]>(),
```

The Drizzle `$type<string[]>()` provides compile-time hints but no runtime validation. In `attributes.service.ts`, the options are cast repeatedly:

```typescript
const attrOptions = (attribute.options as string[]) || [];
const currentOptions = (attribute.options as string[]) || [];
```

If malformed JSON is stored (e.g., a number array or nested objects), the service silently proceeds with incorrect data.

### 5. `listAttributes` value count query does not filter soft-deleted products

**File:** `packages/core/src/modules/attributes/attributes.service.ts` lines 79-90

The value count subquery counts all distinct values in `productAttributeValues` regardless of whether the owning product is soft-deleted. This inflates value counts compared to what `listAttributeValues` shows (which filters `isNull(products.deletedAt)`).

```typescript
// Missing: innerJoin with products + isNull(products.deletedAt)
const valueCounts = attributeIds.length > 0
    ? await db
        .select({
            attributeId: productAttributeValues.attributeId,
            valueCount: count(sql`DISTINCT ${productAttributeValues.value}`)
        })
        .from(productAttributeValues)
        .where(inArray(productAttributeValues.attributeId, attributeIds))
        .groupBy(productAttributeValues.attributeId)
        .all()
    : [];
```

### 6. `attributeSchema` uses `z.any()` for timestamps and options

**File:** `apps/api/src/schemas/entities.ts` lines 406-416

```typescript
export const attributeSchema = z.object({
    // ...
    options: z.any().nullable(),
    createdAt: z.any(),
    updatedAt: z.any(),
    deletedAt: z.any().nullable(),
});
```

Using `z.any()` defeats OpenAPI type generation. The SDK will type these as `unknown`. Should be:

```typescript
options: z.array(z.string()).nullable(),
createdAt: z.union([z.string(), z.number()]),
updatedAt: z.union([z.string(), z.number()]),
deletedAt: z.union([z.string(), z.number()]).nullable(),
```

---

## Pattern Violations

### 7. Storefront public route has inline DB queries instead of using core service

**File:** `apps/api/src/routes/attributes.ts`

This 389-line file contains raw Drizzle queries directly in the route handlers. The convention (documented in CLAUDE.md) is "Thin HTTP layer: validate -> delegate to core -> respond." All other domains follow this. The attributes public routes should delegate to functions in `packages/core/src/modules/attributes/`.

The route file imports schema tables directly:

```typescript
import { productAttributes, productAttributeValues, products, categories } from "@scalius/database/schema";
```

This violates the layering. The route handler should call something like `getFilterableAttributes(db)`, `getFilterableAttributesByCategory(db, categoryId)`, etc.

### 8. Duplicated category-attribute query logic (DRY violation)

**File:** `apps/api/src/routes/attributes.ts` lines 135-189 and 212-279

The `categoryAttributesRoute` (by ID) and `categorySlugAttributesRoute` (by slug) have near-identical query logic. The only difference is looking up the category by ID vs slug first. The attribute query + grouping + mapping code is copied verbatim (~45 lines duplicated).

### 9. Admin API route `addValueRoute` returns 200 instead of 201

**File:** `apps/api/src/routes/admin/attributes.ts` line 328

```typescript
app.openapi(addValueRoute, async (c) => {
    // ...
    await addAttributeValue(db, attributeId, value);
    return ok(c, {});
});
```

Creating a resource should return `created(c, ...)` with 201 status, consistent with `createAttributeRoute` which correctly uses `created()`.

### 10. `AttributeValuesViewer` reads `productNames` but API returns `sampleProducts`

**File:** `apps/admin/src/components/admin/attributes-manager/components/AttributeValuesViewer.tsx` lines 154-169

```typescript
{(item.productNames || []).slice(0, 3).map((name, idx) => (
    <Badge key={idx} variant="outline" className="text-xs">{name}</Badge>
))}
```

But the `listAttributeValues` service returns `sampleProducts`, not `productNames`:

```typescript
// attributes.service.ts line 350
sampleProducts: samples.map((s) => s.productName),
```

And the `AttributeValue` type in `types/index.ts` declares `productNames: string[]`, not `sampleProducts`. This mismatch means the viewer dialog always shows "No values found" for the example products column because `item.productNames` is always undefined (the API sends `sampleProducts`).

---

## Maintainability Concerns

### 11. `listAttributeValues` has complex pagination logic mixing DB results with unused presets

**File:** `packages/core/src/modules/attributes/attributes.service.ts` lines 254-394

This 140-line function is the most complex function in the attributes domain. It:
1. Fetches the attribute definition
2. Runs a paginated GROUP BY query for values with product counts
3. For EACH value on the page, runs a separate query for sample products (N+1)
4. Computes unused preset values from the options array
5. Manually merges unused presets into pagination results

The pagination merge logic (lines 376-383) is particularly fragile:

```typescript
if (page > dbTotalPages || (page === dbTotalPages && values.length < limit)) {
    const dbItemsOnPage = values.length;
    const slotsLeft = limit - dbItemsOnPage;
    const presetOffset = page <= dbTotalPages ? 0 : (page - dbTotalPages - 1) * limit + (limit - dbItemsOnPage);
    finalValues = [...values, ...unusedPresets.slice(presetOffset, presetOffset + slotsLeft)];
}
```

This manual pagination-merging is error-prone and hard to reason about. Consider fetching unused presets server-side in a unified query or simplifying by not paginating the values viewer (attribute values are typically < 100).

### 12. Admin `Attribute` type extends `ProductAttribute` but adds optional `valueCount`

**File:** `apps/admin/src/components/admin/attributes-manager/types/index.ts` line 4

```typescript
export interface Attribute extends ProductAttribute {
  valueCount?: number;
}
```

The `valueCount` is always returned by the API's `listAttributes` (it enriches every attribute). Making it optional means the UI must null-check it everywhere (`attr.valueCount || 0`, `attr.valueCount ?? 0`). It should be `valueCount: number`.

### 13. Two separate attribute value viewer/editor components with duplicated fetch logic

**Files:**
- `apps/admin/src/components/admin/attributes-manager/components/AttributeValuesViewer.tsx`
- `apps/admin/src/components/admin/attributes-manager/components/AttributeValueEditor.tsx`

Both components independently fetch `/api/v1/admin/attributes/{id}/values` and maintain their own `values`, `isLoading`, and `searchQuery` state. The viewer is read-only, the editor adds rename/delete. These could share a hook like `useAttributeValues(attributeId)`.

---

## Performance & Scalability

### 14. N+1 query in `listAttributeValues` -- per-value sample product fetch

**File:** `packages/core/src/modules/attributes/attributes.service.ts` lines 329-353

```typescript
const values = await Promise.all(
    dbValues.map(async (row) => {
        const samples = await db
            .select({ productName: products.name })
            .from(productAttributeValues)
            .innerJoin(products, eq(productAttributeValues.productId, products.id))
            .where(/* ... */)
            .limit(5)
            .all();
        return { /* ... */ sampleProducts: samples.map((s) => s.productName) };
    })
);
```

For a page of 20 values, this fires 20 additional queries. With a default limit of 20, that is 20 + 3 = 23 queries per page load.

**Fix:** Use a single batched query with `inArray(productAttributeValues.value, pageValues)` and `GROUP_CONCAT` or a window function to collect sample product names.

### 15. `filterable` route fetches ALL unique values without limit

**File:** `apps/api/src/routes/attributes.ts` lines 88-97

```typescript
const uniqueValues = attributeIds.length > 0
    ? await db
        .selectDistinct({
            attributeId: productAttributeValues.attributeId,
            value: productAttributeValues.value
        })
        .from(productAttributeValues)
        .where(inArray(productAttributeValues.attributeId, attributeIds))
    : [];
```

With many products and many attribute values (e.g., "Brand" with 500 unique brands), this query returns the full cartesian product of (attributeId, value) with no LIMIT. The 1-hour cache mitigates repeat cost but the initial query can be expensive.

### 16. `searchFiltersRoute` fetches matching products then does a category-scoped attribute query

**File:** `apps/api/src/routes/attributes.ts` lines 302-387

The search-filters endpoint first finds matching products (LIMIT 100), extracts their category IDs, then fetches ALL attribute values for those categories (not just the matching products). This means the attribute filters shown for a search may include values from products NOT in the search results. This is a logic/semantic bug as well as a performance concern.

### 17. No index on `product_attribute_values.value` column

**File:** `packages/database/src/schema/products.ts` lines 160-180

The schema indexes `productId` and `attributeId` but not `value`. Queries that filter by value (the storefront's attribute-based product filtering in `products.storefront.ts`, and `renameAttributeValue` / `deleteAttributeValue` in the service) use `eq(productAttributeValues.value, ...)` which requires a full scan of the junction table.

For stores with many products, add a composite index:

```typescript
index("product_attribute_values_attr_value_idx").on(table.attributeId, table.value),
```

---

## Robustness Gaps

### 18. `bulkDeleteAttributes` does not check for product usage

**File:** `packages/core/src/modules/attributes/attributes.service.ts` lines 230-241

`deleteAttribute()` (single) properly checks for product usage and throws a `ConflictError` if the attribute is in use. However, `bulkDeleteAttributes()` blindly soft-deletes (or hard-deletes) without any usage check:

```typescript
export async function bulkDeleteAttributes(db: Database, ids: string[], permanent = false) {
    if (permanent) {
        await db.delete(productAttributes).where(inArray(productAttributes.id, ids));
    } else {
        await db.update(productAttributes).set({ deletedAt: ... }).where(inArray(productAttributes.id, ids));
    }
}
```

This means bulk-deleting 5 attributes will succeed even if all 5 are actively used by products. The permanent delete path is especially dangerous since `productAttributeValues` has `onDelete: "cascade"` -- it will silently wipe all product-attribute relationships.

### 19. `permanentlyDeleteAttribute` does not check for product usage

**File:** `packages/core/src/modules/attributes/attributes.service.ts` lines 209-213

```typescript
export async function permanentlyDeleteAttribute(db: Database, id: string) {
    await db.delete(productAttributes).where(eq(productAttributes.id, id));
}
```

Due to `onDelete: "cascade"` on the FK, this silently deletes all `productAttributeValues` rows for this attribute across all products. No usage check, no warning, no confirmation beyond the UI dialog. Should at minimum check for active products.

### 20. `restoreAttribute` does not check for name/slug collision with active attributes

**File:** `packages/core/src/modules/attributes/attributes.service.ts` lines 215-228

If an attribute "Brand" is soft-deleted and then a new attribute "Brand" is created, restoring the original will succeed but leave two active attributes with the same name. The `UNIQUE` constraint on `name` and `slug` columns will prevent this at the DB level (causing an unhandled error), but the service should check proactively and return a clear error.

### 21. `addAttributeValue` silently no-ops for duplicate preset values

**File:** `packages/core/src/modules/attributes/attributes.service.ts` lines 396-417

```typescript
if (!currentOptions.includes(value)) {
    const newOptions = [...currentOptions, value];
    await db.update(productAttributes).set({ options: newOptions })...
}
// No else -- silently does nothing
```

The API returns 200 with empty body `{}` regardless of whether the value was actually added. The admin should know if the value already exists.

### 22. No length limits on attribute `options` array

**Files:**
- `packages/core/src/modules/attributes/attributes.validation.ts` line 13
- `packages/core/src/modules/attributes/attributes.service.ts` line 410

The validation allows unlimited options: `z.array(z.string()).optional()`. The service appends without limit. Since options are stored as a JSON text column, a large options array (thousands of entries) could bloat the row and slow queries.

**Fix:** Add `.max(500)` or similar to the Zod schema.

---

## LLM-Friendliness

### Strengths

1. **Clean file organization** -- each service function has a clear name and single responsibility
2. **Good JSDoc-style comments** with section headers (`// Queries`, `// Mutations`, `// Attribute Values`)
3. **Barrel exports** via `index.ts` files at every level (module, components, hooks)
4. **Well-typed interfaces** in `types/index.ts` with explicit prop types for every component
5. **Consistent naming** -- files, functions, and types all follow `Attribute*` prefix pattern
6. **Error handling** uses domain-specific error classes (`NotFoundError`, `ConflictError`)
7. **Admin UI uses composition** -- small, focused components with clear prop contracts

### Weaknesses

1. **`sort as keyof` pattern** is non-obvious and unsafe -- an LLM generating similar code would propagate the vulnerability
2. **`listAttributeValues`** is 140 lines with interleaved concerns (pagination, preset merging, sample fetching) -- hard for an LLM to modify one concern without breaking others
3. **Public attribute routes** (`apps/api/src/routes/attributes.ts`) mix data access with route handling, making it harder for an LLM to know where to add new query logic
4. **Field name mismatch** (`productNames` vs `sampleProducts`) between type definition and API response is a trap for LLMs reading the types to understand the data shape

---

## Recommended Changes

### Priority 1 -- Security & Data Integrity

| # | Change | Files | Effort |
|---|--------|-------|--------|
| 1 | Add sort field allowlist in validation or service | `attributes.validation.ts`, `attributes.service.ts` | Small |
| 2 | Wrap `renameAttributeValue` and `deleteAttributeValue` in `db.batch()` | `attributes.service.ts` | Small |
| 3 | Add usage check to `permanentlyDeleteAttribute` and `bulkDeleteAttributes` | `attributes.service.ts` | Small |
| 4 | Add name/slug collision check to `restoreAttribute` | `attributes.service.ts` | Small |

### Priority 2 -- Correctness

| # | Change | Files | Effort |
|---|--------|-------|--------|
| 5 | Fix field name mismatch: `productNames` -> `sampleProducts` in viewer and type | `AttributeValuesViewer.tsx`, `types/index.ts` | Small |
| 6 | Fix `listAttributes` value count to exclude soft-deleted products | `attributes.service.ts` | Small |
| 7 | Fix `searchFiltersRoute` to scope attribute values to matching products (not just their categories) | `apps/api/src/routes/attributes.ts` | Medium |
| 8 | Change `addValueRoute` to return 201 via `created()` | `apps/api/src/routes/admin/attributes.ts` | Trivial |

### Priority 3 -- Performance

| # | Change | Files | Effort |
|---|--------|-------|--------|
| 9 | Eliminate N+1 in `listAttributeValues` by batching sample product fetch | `attributes.service.ts` | Medium |
| 10 | Add composite index on `(attribute_id, value)` for `product_attribute_values` | `packages/database/src/schema/products.ts` + migration | Small |
| 11 | Add LIMIT to filterable attributes unique values query | `apps/api/src/routes/attributes.ts` | Small |

### Priority 4 -- Architecture & Maintainability

| # | Change | Files | Effort |
|---|--------|-------|--------|
| 12 | Extract public attribute queries from route into core service functions | `apps/api/src/routes/attributes.ts` -> `packages/core/src/modules/attributes/` | Medium |
| 13 | Deduplicate category-by-id and category-by-slug attribute query logic | `apps/api/src/routes/attributes.ts` | Small |
| 14 | Tighten `attributeSchema` types (replace `z.any()` with proper types) | `apps/api/src/schemas/entities.ts` | Small |
| 15 | Add max length to options array in validation | `attributes.validation.ts` | Trivial |
| 16 | Make `Attribute.valueCount` required (not optional) | `types/index.ts` | Trivial |
| 17 | Add unit tests for attributes service (currently zero test coverage) | `tests/attributes.test.ts` (new) | Medium |
