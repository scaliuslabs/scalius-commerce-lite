# Attributes

Product attribute CRUD, value management, and public storefront filter queries.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports (re-exports service, public, validation) |
| `attributes.service.ts` | Admin CRUD for attributes and their values |
| `attributes.public.ts` | Public/storefront queries for filterable attributes |
| `attributes.validation.ts` | Zod schemas and types for attribute operations |

## Validation Schemas (`attributes.validation.ts`)

| Schema | Fields |
|--------|--------|
| `createAttributeSchema` | name (min 2), slug (min 2, regex `^[a-z0-9]+(?:-[a-z0-9]+)*$`), filterable (default true), options (string array, max 500, optional) |
| `updateAttributeSchema` | Same fields, all optional. Options can be nullable. |
| `bulkActionSchema` | ids (string array, min 1), permanent (default false) |
| `addValueSchema` | value (min 1) |
| `updateValueSchema` | oldValue (min 1), newValue (min 1) |
| `deleteValueSchema` | value (min 1) |

**Exported types:** `CreateAttributeInput`, `UpdateAttributeInput`

## Admin Service (`attributes.service.ts`)

### Attribute CRUD

| Function | Signature | Notes |
|----------|-----------|-------|
| `listAttributes` | `(db, { page?, limit?, search?, sort?, order?, showTrashed? })` | Paginated with LIKE search on name/slug, sortable by name/slug/filterable/createdAt/updatedAt, includes valueCount per attribute. Whitelist-validated sort fields. |
| `createAttribute` | `(db, data: CreateAttributeInput)` | Checks for existing name/slug conflicts (including soft-deleted -- throws specific error for deleted conflicts). ID format: `attr_{nanoid}`. |
| `updateAttribute` | `(db, id, data: UpdateAttributeInput)` | Checks for name/slug conflicts excluding self. Throws `NotFoundError` if missing. |
| `deleteAttribute` | `(db, id)` | Soft-delete. Rejects if attribute is in use by products (checks first 5, reports count and product names). Throws `ConflictError`. |
| `permanentlyDeleteAttribute` | `(db, id)` | Hard delete from DB. |
| `restoreAttribute` | `(db, id)` | Clears `deletedAt`. Checks for active conflicts on name/slug before restoring. Throws `ConflictError` if conflict exists. |
| `bulkDeleteAttributes` | `(db, ids, permanent?)` | Soft or hard delete array of IDs. |
| `bulkRestoreAttributes` | `(db, ids)` | Sets `deletedAt = null` for array of IDs. |

### Attribute Values

| Function | Signature | Notes |
|----------|-----------|-------|
| `listAttributeValues` | `(db, attributeId, { search?, sort?, page?, limit? })` | Paginated distinct values with product counts, sample product names (up to 5), preset flag. Merges unused preset options at end. |
| `addAttributeValue` | `(db, attributeId, value)` | Adds value to the attribute's `options` array. Throws `ConflictError` if already exists. |
| `renameAttributeValue` | `(db, attributeId, oldValue, newValue)` | Uses `db.batch()` to atomically rename value in `productAttributeValues` table AND in the attribute's `options` array. |
| `deleteAttributeValue` | `(db, attributeId, value)` | Uses `db.batch()` to atomically delete from `productAttributeValues` and remove from `options` array. |

## Public Queries (`attributes.public.ts`)

| Function | Signature | Notes |
|----------|-----------|-------|
| `resolvePublicAttributeFilters` | `(db, queryParams, standardQueryKeys)` | Resolves raw public query params into attribute filters by excluding route-owned query keys and accepting only known product attribute slugs. Shared by product and category product routes. |
| `getPublicFilterableAttributes` | `(db)` | Returns all filterable attributes with distinct values from active, non-deleted products. For global filter sidebar. |
| `getPublicAttributesByCategory` | `(db, categoryId)` | Filterable attributes scoped to a specific category. Only includes values on active products in that category. |
| `getPublicAttributesByProductIds` | `(db, productIds)` | Filterable attributes scoped to a set of product IDs. Used for search results filtering. |

All public queries return `{ filters: PublicAttributeFilter[] }` where each filter has `{ id, name, slug, values: string[] }`. Values are sorted alphabetically.
The API `/attributes/search-filters` route is KV-cached with the `api:attributes:search-filters` prefix and invalidated by both search/product and attribute cache groups.

**Exported types:** `PublicAttributeFilter`, `PublicAttributeQueryFilter`

## Dependencies

- `@scalius/database` -- `productAttributes`, `productAttributeValues`, `products`
- `@scalius/core/errors` -- `NotFoundError`, `ConflictError`
- `nanoid` -- ID generation (`attr_` prefix)
