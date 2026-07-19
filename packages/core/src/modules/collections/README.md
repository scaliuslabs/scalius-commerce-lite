# Collections

Curated product groups with independent public-page and homepage placement, manual and dynamic membership, drag-and-drop ordering, product resolution, and bulk operations.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports (re-exports service + validation) |
| `collection-config.ts` | Pure canonical parser/stringifier for the JSON `config` column |
| `collections.validation.ts` | Zod schemas: `createCollectionSchema`, `updateCollectionSchema`, `collectionConfigSchema` |
| `collections.service.ts` | All DB queries, mutations, lookup helpers, and product resolution |

## Collection Types

| Presentation | Description |
|--------------|-------------|
| `"grid"` | Featured-grid presentation |
| `"carousel"` | Horizontally scrolling presentation |

Membership is independent from presentation. `config.source` is `manual` for
an explicitly ordered product list or `dynamic` for category-backed automatic
membership. Runtime reads and writes require this canonical source; migration
0010 converts the earlier demo-era representation once.

## Config Schema

The `config` column stores a JSON object:

```typescript
{
  source: "manual" | "dynamic" // Membership semantics, independent of layout
  categoryIds: string[]      // Categories whose products to include
  productIds: string[]       // Specific product IDs to include
  featuredProductId?: string  // Product shown prominently (manual type only)
  showOnHomepage: boolean    // Explicit homepage placement; default false
  maxProducts: number        // 1-24, default 8
  title?: string             // Display title on storefront
  subtitle?: string          // Display subtitle on storefront
}
```

All reads and writes must pass through `normalizeCollectionConfig()` or
`stringifyCollectionConfig()` from `collection-config.ts`. The helper guarantees
arrays are always present, clamps `maxProducts` to 1-24, drops invalid product
IDs, and ignores retired compatibility fields. Admin edit, public collection routes, and storefront
product resolution should not call `JSON.parse(collection.config)` directly.

`isActive` publishes the collection page. It never implies homepage placement.
Only active, non-deleted collections with `config.showOnHomepage === true` enter
the homepage batch resolver. The public collection config projection deliberately
omits this internal composition flag.

## Validation (`collections.validation.ts`)

**`createCollectionSchema`** (all required):
- `name`: string, 3-100 chars
- `presentation`: enum `["grid", "carousel"]`
- `isActive`: boolean
- `config`: collectionConfigSchema (source, categoryIds, productIds, featuredProductId?, showOnHomepage default false, maxProducts 1-24 default 8, title?, subtitle?)

**`updateCollectionSchema`** (all optional): Same fields.

**Exported types:** `CreateCollectionInput`, `UpdateCollectionInput`

## Admin Service Functions

### Queries

| Function | Signature | Notes |
|----------|-----------|-------|
| `listCollections` | `(db, { page?, limit?, search?, showTrashed?, sort?, order? })` | LIKE search, sortable by name/presentation/isActive/updatedAt/sortOrder (whitelist-validated), default limit 20 |
| `getCollectionById` | `(db, id)` | Excludes soft-deleted collections; returns null if not found |
| `getCollectionsByIds` | `(db, ids)` | Batch lookup by IDs, preserving requested order, excluding soft-deleted collections, and capped at 90 IDs |
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
| `resolveCollectionProducts` | `(db, config)` | Resolve products from explicit `config.source`. Manual order is preserved; dynamic membership uses selected categories. Featured product resolves independently. Limits by `maxProducts` (1-24, default 8). |
| `resolveCollectionProductsBatch` | `(db, parsedCollections)` | Batch-resolve products for multiple collections in 2 D1 round-trips (4 batched queries). Returns `Map<collectionId, CollectionProductResult>`. Avoids N+1 queries for homepage. |

Only the selected membership source is buyer-visible. Stale selections from the
other mode are retained for reversible admin switching but cannot leak into the
storefront projection. Active manual collections require a product; active
dynamic collections require a category.

## Dependencies

- `@scalius/database` -- `collections`, `products`, `categories`, `productVariants`, `productMedia`, and `media`; image-only collection surfaces use the shared product image representation resolver
- `@scalius/core/errors` -- `NotFoundError`
- `@scalius/shared/price-utils` -- `calculateDiscountedPrice()`
- `nanoid` -- ID generation (no prefix)
