# 13 -- Collections Domain Audit

## 1. Overview

The Collections domain manages curated groups of products displayed on the storefront homepage. Collections come in two types -- **manual** (grid layout with optional featured product) and **dynamic** (horizontal carousel). The admin can configure each collection to source products by explicit product IDs, by category IDs, or a mix (though the resolution logic enforces a strict priority). Collections support drag-and-drop reordering, soft delete with trash/restore, and bulk operations.

### Files Audited

| Layer | File | Purpose |
|-------|------|---------|
| Schema | `packages/database/src/schema/products.ts` (lines 125-141) | `collections` table definition |
| Core service | `packages/core/src/modules/collections/collections.service.ts` | All DB queries + mutations |
| Core validation | `packages/core/src/modules/collections/collections.validation.ts` | Zod schemas for create/update |
| Core barrel | `packages/core/src/modules/collections/index.ts` | Re-exports |
| API admin routes | `apps/api/src/routes/admin/collections.ts` | 11 admin endpoints |
| API public routes | `apps/api/src/routes/collections.ts` | 2 public endpoints (list + detail) |
| API storefront | `apps/api/src/routes/storefront.ts` | Consolidated homepage endpoint |
| Core storefront | `packages/core/src/modules/storefront/storefront.service.ts` | `getHomepageData()` resolves collections with products |
| Storefront API client | `apps/storefront/src/lib/api/collections.ts` | `getAllCollections()`, `getCollectionById()` |
| Storefront types | `apps/storefront/src/lib/api/types.ts` | `Collection`, `CollectionWithProducts` |
| Storefront rendering | `apps/storefront/src/components/collection1.astro` | Manual/grid layout |
| Storefront rendering | `apps/storefront/src/components/collection2.astro` | Dynamic/carousel layout |
| Storefront homepage | `apps/storefront/src/pages/index.astro` | Dispatches collection1 vs collection2 |
| Admin list | `apps/admin/src/components/admin/collections-list/` | 14 files: container, table, row, toolbar, stats, pagination, dialogs, hooks, types |
| Admin form | `apps/admin/src/components/admin/collection-form/` | 5 files: container, product selection, layout settings, types |

---

## 2. Manual vs Dynamic Collections

### How It Works

The `type` field (`"manual"` | `"dynamic"`) is a **display hint only** -- it controls which Astro component renders on the storefront:

- `"manual"` -> `collection1.astro` (grid layout with optional featured product)
- `"dynamic"` -> `collection2.astro` (horizontal carousel via `ProductCarousel.tsx`)

Both types use the **same config schema** (`collectionConfigSchema`) with `categoryIds`, `productIds`, `featuredProductId`, `maxProducts`, `title`, `subtitle`. The product resolution logic is identical for both types -- the `type` field does not influence which products are fetched.

### Product Resolution Priority

In both `apps/api/src/routes/collections.ts` (public detail endpoint) and `packages/core/src/modules/storefront/storefront.service.ts` (homepage endpoint):

1. **productIds present** -> Fetch those specific products, ignore categoryIds
2. **categoryIds present (no productIds)** -> Fetch products from those categories
3. **Neither** -> Empty collection (skipped on homepage)

### Assessment

The separation is **clean and intentional**. The `type` field is purely a UI concern. The data model correctly avoids coupling display layout to data fetching. One minor inconsistency: the admin form only shows the "Featured Product" selector when `type === "manual"`, but the API and storefront resolve `featuredProductId` regardless of type. This is fine since the carousel component does not render a featured product, but a dynamic collection with a `featuredProductId` in config would silently waste a DB query.

---

## 3. Product Association Model

Collections do **not** use a join table. Product/category associations are stored as JSON arrays inside `config` (a `TEXT` column storing stringified JSON):

```
config: { categoryIds: string[], productIds: string[], featuredProductId?: string, maxProducts: number, ... }
```

### Pros

- Simple schema -- no `collection_products` or `collection_categories` junction tables
- Flexible -- config can hold arbitrary display metadata alongside product references
- Good for small-to-medium catalogs

### Cons

- No foreign key integrity -- deleting a product or category does not cascade to collections
- No efficient reverse lookup ("which collections contain product X?")
- JSON parsing required on every read
- Cannot leverage DB-level joins for product resolution; requires application-level lookup

### Current Impact

The storefront service handles this correctly via batched queries and in-memory lookups (`specificProductsById`, `productsByCategoryId` Maps). Orphaned IDs in config are silently filtered out during resolution. This is acceptable for the current scale.

---

## 4. Admin Components Analysis

### List Page (`collections-list/`)

Well-structured with the established project pattern:

| Component | Role |
|-----------|------|
| `CollectionsList.tsx` | Orchestrator -- wires hooks to components |
| `CollectionTable.tsx` | Table with DnD via `@hello-pangea/dnd` |
| `CollectionRow.tsx` | Inline editing (name via debounce, isActive via switch) |
| `CollectionToolbar.tsx` | Search + conditional bulk action buttons |
| `CollectionStatistics.tsx` | Total / Active / Inactive stat cards |
| `CollectionPagination.tsx` | Delegates to shared `AdminListPagination` |
| `CollectionDeleteDialog.tsx` | Soft vs permanent delete confirmation |
| `BulkActionDialog` | Shared component for bulk operations |

**Hooks:**
- `useCollections` -- fetches + pagination state
- `useCollectionActions` -- CRUD operations (update, delete, restore, reorder)
- `useBulkActions` -- bulk selection + operations

**Notable features:**
- Drag-and-drop reordering with optimistic UI (reverts on API failure)
- Inline name editing with 700ms debounce
- Inline active toggle
- Separate trash view (`showTrashed` prop)
- `CollectionRow` uses `forwardRef` for DnD compatibility

### Form Page (`collection-form/`)

| Component | Role |
|-----------|------|
| `CollectionFormContainer.tsx` | react-hook-form orchestrator |
| `ProductSelectionSection.tsx` | Category selector + product search popover (cmdk) |
| `LayoutSettingsSection.tsx` | Type, title, subtitle, featured product, max products |
| `types.ts` | Form schema, interfaces, collection type definitions |

The form fetches available categories and products from `/admin/collections/form-options` and provides multi-select for both. Category selection filters the product list (helpful UX).

---

## 5. Layer Separation

### Core -> API -> UI Chain

**Clean separation. The layers are well-defined:**

- **Core service** (`collections.service.ts`): Pure DB queries. Accepts `Database` as first param. No HTTP concerns. Throws typed `NotFoundError`.
- **API routes** (`admin/collections.ts`): Thin HTTP layer. Gets `db` from context, calls service, uses `ok()`/`created()`/`noContent()` response helpers. Handles error mapping.
- **Admin UI**: Fetches via browser-side `fetch()` to `/api/v1/admin/collections/*`. Uses `unwrapEnvelope()` to handle the response envelope.
- **Storefront**: Two paths:
  1. **Homepage**: `getHomepageData()` in `storefront.service.ts` fetches collections + resolves products in batched queries. Consumed by `index.astro`.
  2. **Standalone**: `collections.ts` public routes with per-collection product resolution. Consumed by `apps/storefront/src/lib/api/collections.ts`.

**One concern:** The public `GET /collections/:id` route in `apps/api/src/routes/collections.ts` contains ~300 lines of inline product resolution logic (image subqueries, discount calculations, batch queries). This is business logic that should live in a core service function, not in the route handler. The storefront service (`storefront.service.ts`) implements the same resolution logic independently, creating duplication.

---

## 6. Validation Consistency

### Schema Comparison

| Field | Core `createCollectionSchema` | Core `updateCollectionSchema` | Form `collectionFormSchema` |
|-------|-------------------------------|-------------------------------|----------------------------|
| `id` | -- | -- | `z.string().optional()` |
| `name` | `z.string().min(3).max(100)` | same, `.optional()` | same |
| `type` | `z.enum(["manual","dynamic"])` | same, `.optional()` | same |
| `isActive` | `z.boolean()` | same, `.optional()` | same |
| `config.categoryIds` | `z.array(z.string()).optional().default([])` | same | `z.array(z.string())` (required) |
| `config.productIds` | `z.array(z.string()).optional().default([])` | same | `z.array(z.string())` (required) |
| `config.maxProducts` | `z.number().int().min(1).max(24).optional().default(8)` | same | `z.number().int().min(1).max(24)` (required) |
| `config.featuredProductId` | `z.string().optional()` | same | `z.string().optional()` |
| `config.title` | `z.string().optional()` | same | `z.string().optional()` |
| `config.subtitle` | `z.string().optional()` | same | `z.string().optional()` |

**Divergence:** The core validation uses `.optional().default([])` for `categoryIds`/`productIds` while the form schema uses required arrays. This is not a bug -- the form always initializes arrays, and `default([])` on the core schema means missing fields get empty arrays. However, the inconsistency could cause confusion for future maintainers.

### Storefront Type Divergence

**Bug found:** The storefront `Collection` interface in `apps/storefront/src/lib/api/types.ts` line 182 includes `"AllCategories"` as a valid type:

```typescript
type: "manual" | "dynamic" | "AllCategories";
```

Neither the DB schema enum nor any service or validation schema accepts `"AllCategories"`. The existing README (`collections/README.md` line 193) already documents this as a known issue. This phantom type means TypeScript will never flag a missing branch for `"AllCategories"` in storefront rendering code, but it also silently permits the type without any runtime path to handle it.

---

## 7. Soft Delete (Trash/Restore)

### Implementation

- **Soft delete**: `deleteCollection()` sets `deletedAt = new Date()` + `updatedAt`
- **Bulk soft delete**: `bulkDeleteCollections(db, ids, false)` -- same pattern
- **Permanent delete**: `bulkDeleteCollections(db, ids, true)` -- actual `DELETE FROM`
- **Restore**: `restoreCollections(db, ids)` -- sets `deletedAt = null`, `updatedAt`
- **Single restore route**: `POST /{id}/restore` -- correctly avoids calling `getCollectionById()` (which filters `deletedAt IS NULL`)

### Admin UI Pattern

- List page accepts `showTrashed` prop
- Trash view shows Restore + Permanent Delete buttons per row
- Normal view shows Trash (soft delete) button per row
- Bulk actions: trash, delete, restore, activate, deactivate

### Assessment

The trash/restore pattern is **complete and consistent**. The comment on the restore route handler (line 224) is a good defensive note. The service function `deleteCollection()` does an existence check before soft-deleting (throwing `NotFoundError`), but `bulkDeleteCollections` does not -- it silently succeeds for nonexistent IDs. This is acceptable for bulk operations.

---

## 8. LLM-Friendliness

### Naming

- File names are clear: `collections.service.ts`, `collections.validation.ts`
- Component names follow a consistent `Collection{Purpose}` pattern
- Hook names follow `use{Purpose}` convention
- Type names are descriptive and unambiguous

### File Organization

- Core module: 3 files (service, validation, index) -- clean barrel export
- Admin list: well-decomposed into components/, hooks/, types/ subdirectories
- Admin form: 5 files with clear separation (container, sections, types)
- Each component file has a header comment explaining its role

### Areas for Improvement

- `CollectionRow.tsx` uses `forwardRef<HTMLTableRowElement, CollectionRowProps & any>` -- the `& any` escape hatch defeats type safety and is confusing for an LLM trying to understand the prop contract
- `collection1.astro` and `collection2.astro` are named by number rather than by purpose. Better names would be `CollectionGrid.astro` and `CollectionCarousel.astro`
- The public route file `apps/api/src/routes/collections.ts` contains 439 lines of inline business logic; splitting resolution into a service function would improve navigability

---

## 9. Issues Found

### P1 -- Storefront Phantom Type `"AllCategories"`

**File:** `apps/storefront/src/lib/api/types.ts:182`

The `Collection.type` union includes `"AllCategories"` which is not a valid value in the DB schema, core validation, or any service. If a collection somehow had this type, neither `isCollection1()` nor `isCollection2()` in `index.astro` would match, and the collection would silently not render. Remove `"AllCategories"` from the union.

### P2 -- Duplicated Product Resolution Logic

**Files:**
- `apps/api/src/routes/collections.ts` (public GET /:id, lines 122-436)
- `packages/core/src/modules/storefront/storefront.service.ts` (getHomepageData)

Both implement the same productIds-vs-categoryIds resolution with image subqueries, discount calculations, and featured product logic. The public route should delegate to a core service function (e.g., `resolveCollectionProducts(db, config)`) rather than inlining 300+ lines of query logic.

### P2 -- `config` Stored as Stringified JSON

**File:** `packages/database/src/schema/products.ts:129`

The `config` column is `text("config")` and is manually `JSON.stringify()`/`JSON.parse()`-ed everywhere. Drizzle supports `text("config", { mode: "json" }).$type<CollectionConfig>()` which would auto-serialize/deserialize and provide type safety at the schema level. Currently, the service, admin route, and public route all do raw `JSON.parse(collection.config)` without try/catch in most places. The `CollectionRow.tsx` has a try/catch, but the public route and service do not guard against malformed JSON.

### P3 -- Reorder Uses Sequential Queries

**File:** `packages/core/src/modules/collections/collections.service.ts:189-194`

```typescript
for (const item of items) {
    await db.update(collections).set({ sortOrder: item.sortOrder, ... }).where(eq(collections.id, item.id));
}
```

This issues N sequential D1 queries. For 10-20 collections this is fine, but it should use `db.batch()` to issue them in a single round-trip, consistent with how batching is done elsewhere in the codebase (e.g., `storefront.service.ts`).

### P3 -- `updateCollection` Does Not Verify Existence

**File:** `packages/core/src/modules/collections/collections.service.ts:120-137`

`updateCollection()` does not check if the collection exists before updating. If the ID is invalid, `.returning().get()` returns `undefined`, which propagates as a successful 200 response with an undefined body. The API route should either check existence first or validate the return value.

### P3 -- Bulk Endpoint Parameter Inconsistency

**Files:** `apps/api/src/routes/admin/collections.ts`

- Bulk delete: `{ collectionIds: string[], permanent: boolean }`
- Bulk activate/deactivate/restore: `{ ids: string[] }`

The parameter name for the ID array is inconsistent (`collectionIds` vs `ids`). The `useBulkActions` hook correctly handles this difference, but it is a footgun for future API consumers.

### P4 -- Admin `Collection` Type Has `config: string`

**File:** `apps/admin/src/types/api-responses.ts:84`

The admin `Collection` type defines `config` as `string` (matching the raw DB column), but `CollectionRow.tsx` does `JSON.parse(collection.config)` inline. The form types define a typed `config` object. There is no shared typed representation for the parsed config in the admin layer.

### P4 -- `unixToDate` / `formatTimestamp` in Public Route

**File:** `apps/api/src/routes/collections.ts:23-45`

Helper functions for timestamp formatting are defined inline in the route file. These belong in a shared utility. The storefront service does not format timestamps at all (returns raw values), creating an inconsistency between the two public endpoints that serve collection data.

---

## 10. Recommendations

### Short-term

1. **Remove `"AllCategories"` from storefront `Collection.type`** -- one-line fix in `apps/storefront/src/lib/api/types.ts`
2. **Add JSON parse guard** in the public collection route and storefront service -- wrap `JSON.parse(collection.config)` in try/catch to avoid 500s on corrupt data
3. **Normalize bulk endpoint parameter names** -- use `ids` consistently across all bulk endpoints (breaking change, coordinate with admin UI)

### Medium-term

4. **Extract `resolveCollectionProducts()` into core** -- create `packages/core/src/modules/collections/collections.storefront.ts` with the product resolution logic, eliminating duplication between the public route and storefront service
5. **Switch config to Drizzle JSON mode** -- `text("config", { mode: "json" }).$type<CollectionConfig>()` eliminates manual stringify/parse and adds type safety
6. **Batch reorder queries** -- use `db.batch()` in `reorderCollections()`
7. **Validate update target exists** -- `updateCollection()` should throw `NotFoundError` if the collection does not exist

### Long-term

8. **Rename storefront components** -- `collection1.astro` -> `CollectionGrid.astro`, `collection2.astro` -> `CollectionCarousel.astro`
9. **Add `collection_products` junction table** (if catalog grows) -- enables reverse lookups, FK integrity, and DB-level joins for product resolution
10. **Remove `& any` from `CollectionRow`** -- type the DnD spread props properly

---

## 11. Data Flow Summary

```
Admin Create/Edit:
  CollectionFormContainer.tsx
    -> POST/PUT /api/v1/admin/collections[/:id]
    -> admin/collections.ts route (validates with zod)
    -> collections.service.ts createCollection/updateCollection
    -> D1 insert/update (config stringified)

Admin List:
  CollectionsList.tsx
    -> useCollections hook -> GET /api/v1/admin/collections?params
    -> admin/collections.ts route -> collections.service.ts listCollections
    -> D1 select with pagination/sort/search/trash filter

Storefront Homepage:
  index.astro
    -> getHomepageData() [edge-cached]
    -> GET /api/v1/storefront/homepage [server-cached]
    -> storefront.service.ts getHomepageData(db)
    -> Batch 1: collections metadata
    -> Batch 2: products by category + specific products + featured products
    -> Assemble CollectionWithProducts[]
    -> Dispatch to collection1.astro (manual) or collection2.astro (dynamic)

Storefront Standalone:
  getAllCollections() / getCollectionById() [edge-cached]
    -> GET /api/v1/collections[/:id] [server-cached]
    -> collections.ts route (inline product resolution)
    -> D1 batch queries per collection
```

---

## 12. Verdict

The Collections domain is **well-structured and functional**. The manual/dynamic split is clean, the admin UI follows established patterns with good UX (inline editing, DnD reorder, trash/restore), and the layer separation is mostly sound. The main architectural debt is the duplicated product resolution logic between two API paths and the raw JSON config handling. Neither is urgent, but extracting a shared `resolveCollectionProducts()` into core would be the highest-impact improvement.
