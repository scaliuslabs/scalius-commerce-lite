# Collections

Curated product groups displayed on the storefront homepage, with manual and dynamic types, drag-and-drop reordering, and bulk operations.

## Overview

Collections are configurable product groupings shown on the storefront homepage. Each collection has a `type` ("manual" or "dynamic") that determines its display layout, a JSON `config` that specifies which products/categories to include, and a `sortOrder` for drag-and-drop positioning. The service layer provides admin CRUD with bulk activate/deactivate/delete/restore and reorder support.

## Collection Types

| Type | Admin Label | Storefront Layout | Description |
|------|-------------|-------------------|-------------|
| `"manual"` | Manual (Grid) | Large featured card + product grid | Admin-curated with optional featured product |
| `"dynamic"` | Dynamic (Carousel) | Horizontal scrolling carousel | Category-based or product-based, auto-populated |

Previously named `"collection1"` / `"collection2"` -- migrated in migration 0024.

## Config Schema

The `config` column stores a JSON object with this structure:

```typescript
{
  categoryIds: string[]     // Categories whose products to include
  productIds: string[]      // Specific product IDs to include
  featuredProductId?: string // Product shown prominently (manual type only)
  maxProducts: number       // 1-24, default 8
  title?: string            // Display title on storefront
  subtitle?: string         // Display subtitle on storefront
}
```

**Product resolution priority** (in the public API):
1. If `productIds` is non-empty: use those specific products, ignore `categoryIds`
2. If `categoryIds` is non-empty: fetch active products from those categories (newest first), limited by `maxProducts`
3. If only `featuredProductId`: resolve just that one product
4. If all empty: return empty product list

## Features

- **Drag-and-drop reordering**: `sortOrder` column, UI uses `@hello-pangea/dnd`, persisted via `/reorder` endpoint
- **Active/inactive toggle**: `isActive` controls storefront visibility, inline-editable in list
- **Inline name editing**: Collection names are editable directly in the list table (debounced 700ms auto-save)
- **Soft-delete with trash view**: Separate `/admin/collections/trash` page
- **Bulk operations**: Activate, deactivate, trash, permanent delete, restore
- **LIKE search**: Admin list uses SQL `LIKE %term%` (not FTS5)
- **Sortable columns**: name, type, isActive, updatedAt, sortOrder

## Data Flow

```
Admin UI (CollectionsList / CollectionForm)
  --> fetch("/api/v1/admin/collections/...")        (client-side)
  --> apps/api/src/routes/admin/collections.ts      (OpenAPIHono routes)
  --> packages/core/src/modules/collections/        (service layer - this module)
  --> @scalius/database/schema (collections table)

Storefront
  --> apps/storefront/src/lib/api/collections.ts    (edge-cached fetch wrapper)
  --> apps/api/src/routes/collections.ts            (public OpenAPI routes, cache middleware)
  --> @scalius/database/schema (collections, products, categories tables)
```

Note: The public collection routes resolve products directly in the route handler (not via this service module). They parse the JSON config, then batch-query products/categories/featured product from the DB.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports (re-exports service + schema) |
| `collections.schema.ts` | Zod schemas: `createCollectionSchema`, `updateCollectionSchema`, `collectionConfigSchema` |
| `collections.service.ts` | All DB queries and mutations (9 exported functions) |

## Schema (Zod)

**`createCollectionSchema`** (all fields required):
- `name`: string, 3-100 chars
- `type`: enum `["manual", "dynamic"]`
- `isActive`: boolean
- `config`: `{ categoryIds, productIds, featuredProductId?, maxProducts (1-24, default 8), title?, subtitle? }`

**`updateCollectionSchema`** (all fields optional):
- Same fields as create, but each is optional

## DB Schema

Table `collections` in `packages/database/src/schema/products.ts`:
- `id` (text PK, nanoid -- no prefix)
- `name` (text, not null)
- `type` (text, enum `["manual", "dynamic"]`, not null)
- `config` (text, JSON-serialized, not null)
- `sortOrder` (integer, default 0)
- `isActive` (integer/boolean, default true)
- `createdAt`, `updatedAt` (integer, unix timestamp, default `UNIX_NOW`)
- `deletedAt` (integer, nullable -- soft-delete)
- Index: `collections_deleted_at_idx`

## Service Functions

### Admin Queries
| Function | Signature | Notes |
|----------|-----------|-------|
| `listCollections()` | `(db, { page, limit, search, showTrashed, sort, order })` | LIKE search, sortable by name/type/isActive/updatedAt/sortOrder, default limit 20 |
| `getCollectionById()` | `(db, id)` | Active collections only (excludes deleted) |

### Mutations
| Function | Signature | Notes |
|----------|-----------|-------|
| `createCollection()` | `(db, data)` | Auto-assigns `sortOrder` as max+1, returns full row |
| `updateCollection()` | `(db, id, data)` | Partial update, returns full row |
| `deleteCollection()` | `(db, id)` | Soft-delete, throws `NotFoundError` if missing |
| `bulkDeleteCollections()` | `(db, ids, permanent?)` | Soft or hard delete |
| `bulkActivateCollections()` | `(db, ids)` | Sets `isActive = true` |
| `bulkDeactivateCollections()` | `(db, ids)` | Sets `isActive = false` |
| `restoreCollections()` | `(db, ids)` | Sets `deletedAt = null` |
| `reorderCollections()` | `(db, items)` | Updates `sortOrder` for each item (sequential, not batched) |

## API Endpoints

### Admin (requires auth, mounted at `/api/v1/admin/collections`)
| Method | Path | Handler |
|--------|------|---------|
| GET | `/form-options` | Categories + products for collection form dropdowns |
| GET | `/` | Paginated list with search, sort, trash filter |
| POST | `/` | Create collection |
| POST | `/bulk-delete` | Bulk soft or permanent delete |
| POST | `/bulk-activate` | Bulk activate |
| POST | `/bulk-deactivate` | Bulk deactivate |
| POST | `/bulk-restore` | Bulk restore |
| POST | `/reorder` | Update sort order for multiple collections |
| GET | `/{id}` | Get collection by ID |
| PUT | `/{id}` | Update collection |
| DELETE | `/{id}` | Soft-delete |
| DELETE | `/{id}/permanent` | Permanent delete (uses `bulkDeleteCollections([id], true)`) |
| POST | `/{id}/restore` | Restore single collection |

### Public (cached, mounted at `/api/v1/collections`)
| Method | Path | Handler |
|--------|------|---------|
| GET | `/` | List all active collections (sorted by `sortOrder`) |
| GET | `/{id}` | Get collection with resolved products, categories, featured product |

The public GET `/{id}` endpoint performs full product resolution:
- Parses `config` JSON from the collection row
- Batch-queries products (with primary image via correlated subquery), categories, and featured product
- Computes `discountedPrice` for each product
- Returns `{ collection, categories, products, featuredProduct? }`

## Admin UI Components

### List (`apps/admin/src/components/admin/collections-list/`)
- `CollectionsList.tsx` -- main orchestrator with statistics, toolbar, table, pagination, dialogs
- `components/CollectionRow.tsx` -- inline name editing (debounced), type badge, content source summary, active toggle, drag handle
- `components/CollectionStatistics.tsx` -- total/active/inactive stat cards
- `components/CollectionToolbar.tsx` -- search input, bulk action buttons (activate/deactivate/trash/restore/delete)
- `components/CollectionTable.tsx` -- drag-drop table using `@hello-pangea/dnd` (`DragDropContext` + `Droppable` + `Draggable`)
- `components/CollectionPagination.tsx` -- delegates to shared `AdminListPagination`
- `components/CollectionDeleteDialog.tsx` -- trash/permanent delete confirmation
- `hooks/useCollections.ts` -- fetch, pagination, search, sort state
- `hooks/useCollectionActions.ts` -- update, delete, restore, reorder handlers
- `hooks/useBulkActions.ts` -- multi-select state, bulk API calls
- `types/index.ts` -- all TypeScript interfaces and types

### Form (`apps/admin/src/components/admin/collection-form/`)
- `CollectionFormContainer.tsx` -- main form with react-hook-form + zod validation
- `ProductSelectionSection.tsx` -- category dropdown + product search (Command/Popover), badge chips for selected items
- `LayoutSettingsSection.tsx` -- display style selector, title/subtitle inputs, featured product dropdown (manual type only), max products input, active toggle
- `types.ts` -- form schema, type definitions, collection type labels/descriptions

### Astro Pages
- `/admin/collections` -- index with header, new/trash buttons, `CollectionsList`
- `/admin/collections/new` -- form with categories/products from `getCollectionFormOptions()`
- `/admin/collections/[id]/edit` -- edit form with pre-loaded data from `getCollectionEditData()`
- `/admin/collections/trash` -- trash view with `CollectionsList showTrashed={true}`

## Storefront Integration

- `apps/storefront/src/lib/api/collections.ts`: `getAllCollections()`, `getCollectionById()` -- both edge-cached with `CACHE_TTL.LONG`
- `getCollectionById()` returns `CollectionWithProducts` which merges collection metadata with resolved products, categories, and featured product
- Collections are consumed on the storefront homepage (`apps/storefront/src/pages/index.astro`)
- No dedicated `/collections/[id]` storefront page exists

## Dependencies

- `@scalius/database` -- `collections` table
- `@scalius/core/errors` -- `NotFoundError`
- `nanoid` -- ID generation (no prefix, unlike categories)

## Known Gaps

- **Reorder is sequential**: `reorderCollections()` issues one UPDATE per item in a loop rather than using `db.batch()` -- O(n) round trips
- **No FTS5 search**: Admin search uses SQL `LIKE %term%` instead of FTS5 (categories use FTS5)
- **Collection `type` in storefront types includes `"AllCategories"`**: The storefront `Collection` interface in `apps/storefront/src/lib/api/types.ts` includes `"AllCategories"` as a valid type, but neither the DB schema enum nor the service accepts it
- **`updateCollection()` uses `new Date()`**: Sets `updatedAt: new Date()` instead of `sql`unixepoch()`` like categories do -- both work with Drizzle's timestamp mode but the pattern is inconsistent
- **No product count on collection list**: Unlike categories which show product counts, the collection list shows a "content source" summary (N categories + M products from config) but not the actual resolved product count
- **Public routes duplicate product resolution logic**: The public collection routes in `apps/api/src/routes/collections.ts` contain ~200 lines of product resolution logic that could be extracted to the service module
- **`getCollectionById()` excludes deleted collections**: The service-layer `getCollectionById()` filters on `isNull(deletedAt)`, so the admin trash view's restore flow must fetch via the list endpoint instead
- **`deleteCollection()` / bulk operations use `new Date()`**: Soft-delete sets `deletedAt: new Date()` rather than `sql`unixepoch()`` -- same inconsistency as update
