# Collections

Curated product groups displayed on the storefront homepage, with manual and dynamic types, drag-and-drop reordering, product resolution, and bulk operations.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports (re-exports service + validation) |
| `collection-config.ts` | Pure canonical parser/stringifier for the JSON `config` column |
| `collections.validation.ts` | Zod schemas: `createCollectionSchema`, `updateCollectionSchema`, `collectionConfigSchema` |
| `collections.service.ts` | All DB queries, mutations, lookup helpers, and product resolution |

## Collection Types

| Type | Description |
|------|-------------|
| `"manual"` | Admin-curated with optional featured product, grid layout |
| `"dynamic"` | Category-based or product-based, auto-populated, carousel layout |

## Config Schema

The `config` column stores a JSON object:

```typescript
{
  categoryIds: string[]      // Categories whose products to include
  productIds: string[]       // Specific product IDs to include
  featuredProductId?: string  // Product shown prominently (manual type only)
  maxProducts: number        // 1-24, default 8
  title?: string             // Display title on storefront
  subtitle?: string          // Display subtitle on storefront
}
```

All reads and writes must pass through `normalizeCollectionConfig()` or
`stringifyCollectionConfig()` from `collection-config.ts`. The helper guarantees
arrays are always present, clamps `maxProducts` to 1-24, drops invalid product
IDs, and maps the retired `specificProductIds` field into canonical
`productIds`. Admin edit, public collection routes, and storefront
product resolution should not call `JSON.parse(collection.config)` directly.

## Validation (`collections.validation.ts`)

**`createCollectionSchema`** (all required):
- `name`: string, 3-100 chars
- `type`: enum `["manual", "dynamic"]`
- `isActive`: boolean
- `config`: collectionConfigSchema (categoryIds, productIds, featuredProductId?, maxProducts 1-24 default 8, title?, subtitle?)

**`updateCollectionSchema`** (all optional): Same fields.

**Exported types:** `CreateCollectionInput`, `UpdateCollectionInput`

## Admin Service Functions

### Queries

| Function | Signature | Notes |
|----------|-----------|-------|
| `listCollections` | `(db, { page?, limit?, search?, showTrashed?, sort?, order? })` | LIKE search, sortable by name/type/isActive/updatedAt/sortOrder (whitelist-validated), default limit 20 |
| `getCollectionById` | `(db, id)` | Excludes soft-deleted collections; returns null if not found |
| `getCollectionsByIds` | `(db, ids)` | Batch lookup by IDs, preserving requested order and excluding soft-deleted collections |
| `getCollectionCategoryOptions` | `(db)` | Lightweight non-deleted category options for collection builders |
| `listCollectionProductOptions` | `(db, { page?, limit?, search?, categoryIds? })` | Stable name/ID pagination for the collection picker; FTS search and OR-matched categories run in one two-statement D1 batch. Category IDs are deduplicated and capped at 90 so search/limit/offset binds stay below D1's 100-parameter ceiling. |

The admin collection picker calls only `listCollectionProductOptions` through
`GET /admin/collections/product-options`. Search is debounced and every filter
combination owns a TanStack Query cache key, so a slower older request cannot
replace a newer search. Load-more follows authoritative `pagination`; lookup
failures remain distinct from an empty result. Selected product labels are
resolved separately by ID and retained independently of picker pages.

### Mutations

| Function | Signature | Notes |
|----------|-----------|-------|
| `createCollection` | `(db, data)` | Auto-assigns `sortOrder` as max+1 among active. ID: bare `nanoid()`. Returns full row via `.returning().get()` |
| `updateCollection` | `(db, id, data)` | Partial update, existence check. Sets `updatedAt` via `unixepoch()`. Returns full row. Throws `NotFoundError`. |
| `deleteCollection` | `(db, id)` | Soft-delete. Sets both `deletedAt` and `updatedAt` via `unixepoch()`. Throws `NotFoundError`. |
| `bulkDeleteCollections` | `(db, ids, permanent?)` | Soft or hard delete. Timestamps via `unixepoch()`. |
| `bulkActivateCollections` | `(db, ids)` | Sets `isActive = true`, updates timestamp |
| `bulkDeactivateCollections` | `(db, ids)` | Sets `isActive = false`, updates timestamp |
| `restoreCollections` | `(db, ids)` | Sets `deletedAt = null`, updates timestamp |
| `reorderCollections` | `(db, items)` | Updates `sortOrder` for each item using `db.batch()` |

## Product Resolution

The service provides product resolution for the storefront, computing `discountedPrice` for each product using `calculateDiscountedPrice()` from `@scalius/shared/price-utils`.

### Types

- **`ResolvedProduct`**: Product with computed `discountedPrice`, primary image URL (via correlated subquery), `hasVariants` flag
- **`CollectionProductResult`**: `{ products, categories, featuredProduct }`

### Functions

| Function | Signature | Notes |
|----------|-----------|-------|
| `resolveCollectionProducts` | `(db, config)` | Resolve products for a single collection. Priority: productIds > categoryIds. Featured product resolved independently. Limits by `maxProducts` (1-24, default 8). |
| `resolveCollectionProductsBatch` | `(db, parsedCollections)` | Batch-resolve products for multiple collections in 2 D1 round-trips (4 batched queries). Returns `Map<collectionId, CollectionProductResult>`. Avoids N+1 queries for homepage. |

**Resolution priority:**
1. If `productIds` non-empty: fetch those specific products, ignore `categoryIds`
2. If `categoryIds` non-empty: fetch active products from those categories (newest first)
3. If only `featuredProductId`: resolve just that product
4. If all empty: return empty result

## Dependencies

- `@scalius/database` -- `collections`, `products`, `categories`, `productImages`, `productVariants` (the latter two via correlated subqueries)
- `@scalius/core/errors` -- `NotFoundError`
- `@scalius/shared/price-utils` -- `calculateDiscountedPrice()`
- `nanoid` -- ID generation (no prefix)
