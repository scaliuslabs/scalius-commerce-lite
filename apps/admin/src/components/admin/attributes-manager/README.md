# Attributes Manager

Admin UI for managing product attributes (e.g. Brand, Color, Size). Supports CRUD, inline editing, soft-delete/trash/restore, bulk operations, and value management.

## Files

```
attributes-manager/
  index.ts                           -- barrel exports (AttributesManager, types)
  AttributesManager.tsx              -- main orchestrator: wires hooks, dialogs, state
  components/
    index.ts                         -- re-exports all components
    AttributeRow.tsx                 -- table row with inline name/slug editing, filterable toggle
    AttributeStatistics.tsx          -- stat cards: total, filterable count, total values
    AttributeToolbar.tsx             -- search input + bulk action buttons + "Add Attribute"
    AttributeTable.tsx               -- sortable table with checkbox selection, loading/empty states
    AttributePagination.tsx          -- thin wrapper around shared AdminListPagination
    AttributeCreateDialog.tsx        -- create dialog: name (auto-slug), slug, filterable switch, predefined values
    AttributeDeleteDialog.tsx        -- delete/trash confirmation AlertDialog
    AttributeValuesViewer.tsx        -- read-only dialog: all unique values with product counts + sample products
    AttributeValueEditor.tsx         -- edit dialog: rename, delete, add values with inline editing
  hooks/
    index.ts                         -- re-exports all hooks
    useAttributes.ts                 -- fetch, pagination, search, sort state
    useAttributeActions.ts           -- single-item CRUD: update, create, delete, restore
    useBulkActions.ts                -- multi-select: bulk trash, delete, restore
  types/
    index.ts                         -- all TypeScript interfaces
```

External dependency: `BulkActionDialog` from `@/components/admin/shared/BulkActionDialog`.

## Database Tables

**`product_attributes`** (defined in `packages/database/src/schema/products.ts`)

| Column     | Type         | Notes                                    |
|------------|-------------|------------------------------------------|
| id         | text PK     | `"attr_" + nanoid()`                     |
| name       | text UNIQUE | Display name (e.g. "Brand")              |
| slug       | text UNIQUE | URL-safe identifier (e.g. "brand")       |
| filterable | integer     | Boolean. Default: true. Controls storefront filter visibility. |
| options    | text JSON   | `string[]` -- predefined/preset values (e.g. `["Red","Blue"]`) |
| createdAt  | timestamp   | Unix seconds                             |
| updatedAt  | timestamp   | Unix seconds                             |
| deletedAt  | timestamp   | Soft delete                              |

Index: `product_attributes_slug_idx`

**`product_attribute_values`** (join table, defined in same file)

| Column      | Type      | Notes                                                  |
|-------------|-----------|--------------------------------------------------------|
| id          | text PK   |                                                        |
| productId   | text FK   | References `products.id`, ON DELETE CASCADE            |
| attributeId | text FK   | References `product_attributes.id`, ON DELETE CASCADE  |
| value       | text      | The actual value (e.g. "Red", "Nike")                  |
| createdAt   | timestamp | Unix seconds                                           |

Constraints: UNIQUE on `(productId, attributeId)` -- one value per attribute per product.
Index: `product_attribute_values_product_id_idx`

## Admin API Endpoints

All mounted under `/api/v1/admin/attributes` (admin-only, auth required).
Defined in `apps/api/src/routes/admin/attributes.ts`. All routes use `OpenAPIHono` / `createRoute()`.

| Method   | Path                      | Description                                       | Response         |
|----------|---------------------------|---------------------------------------------------|------------------|
| GET      | `/`                       | List attributes (paginated, search, sort, trashed) | 200 `{attributes, pagination}` |
| POST     | `/`                       | Create attribute                                  | 201 `{attribute}` |
| PUT      | `/{id}`                   | Update attribute (name, slug, filterable, options) | 200 `{attribute}` |
| DELETE   | `/{id}`                   | Soft-delete (checks product usage first, blocks if in use) | 204 |
| DELETE   | `/{id}/permanent`         | Hard-delete                                       | 204              |
| POST     | `/{id}/restore`           | Restore soft-deleted attribute                    | 200 `{message}`  |
| POST     | `/bulk-delete`            | Bulk soft-delete or hard-delete (`permanent: bool`) | 204            |
| POST     | `/bulk-restore`           | Bulk restore                                      | 204              |
| GET      | `/{id}/values`            | List unique values with product counts + sample products + preset flag | 200 `{attributeId, attributeName, values, totalValues, page, totalPages}` |
| POST     | `/{id}/values`            | Add preset value to `options` array               | 200 `{}`         |
| PUT      | `/{id}/values`            | Rename value across all products + options array  | 200 `{message}`  |
| DELETE   | `/{id}/values`            | Delete value from all products + options array    | 200 `{message}`  |

### List Details

- Query params: `page`, `limit`, `search` (name OR slug LIKE), `sort` (column), `order` (asc/desc), `trashed` (true/false)
- Enriches each attribute with `valueCount` (distinct values from `product_attribute_values`)

### Delete Protection

Soft-delete (`DELETE /{id}`) checks `product_attribute_values` for usage. If the attribute is assigned to any product, returns a `ConflictError` listing up to 5 product names. Hard-delete (`DELETE /{id}/permanent`) skips this check.

### Value Management

- **List values** (`GET /{id}/values`): aggregates all rows from `product_attribute_values` joined with `products`, groups by value, counts products, collects up to 5 sample product names, merges with `options` array to mark preset values. Supports search filter, sort by createdAt, pagination.
- **Add value** (`POST /{id}/values`): appends to `productAttributes.options` JSON array (preset). Does not create `productAttributeValues` rows -- those are created when assigning to products.
- **Rename value** (`PUT /{id}/values`): updates all `productAttributeValues` rows + renames in `options` array.
- **Delete value** (`DELETE /{id}/values`): deletes all `productAttributeValues` rows + removes from `options` array.

## Public (Storefront) API Endpoints

Defined in `apps/api/src/routes/attributes.ts`. Used by storefront for product filtering.

| Method | Path                                | Cache TTL | Description                                        |
|--------|-------------------------------------|-----------|----------------------------------------------------|
| GET    | `/attributes/filterable`            | 3600s     | All filterable attributes with unique values        |
| GET    | `/attributes/category/{categoryId}` | 1800s     | Filterable attributes for products in a category (by ID) |
| GET    | `/attributes/category-slug/{slug}`  | 1800s     | Same but by category slug (resolves to ID first)   |
| GET    | `/attributes/search-filters`        | none      | Filterable attributes for FTS5 search results (optional categoryId) |

All return `{filters: [{id, name, slug, values: string[]}]}`. Values are sorted alphabetically.

`search-filters` uses `ftsMatch("products_fts", "products", query)` from `@scalius/core/search` to find matching products (limit 100), then gets attributes from those products' categories.

## Hooks

### useAttributes(showTrashed, searchQuery, sortField, sortOrder)

- Fetches `GET /api/v1/admin/attributes` with all params
- Handles both API envelope formats (`json.data` vs top-level)
- Returns: `attributes`, `setAttributes`, `pagination`, `isLoading`, `fetchAttributes`, `goToPage`, `changePageSize`
- Auto-refetches when any dependency changes (via useEffect on fetchAttributes callback)

### useAttributeActions(onRefresh, setAttributes)

- `handleUpdate(id, data)` -- `PUT /{id}`, optimistic local update, reverts on error
- `handleCreate(newAttribute, onSuccess)` -- `POST /`, validates name+slug non-empty
- `handleDelete(id, name, showTrashed)` -- `DELETE /{id}` (soft) or `DELETE /{id}/permanent` (from trash view)
- `handleRestore(id)` -- `POST /{id}/restore`
- Tracks: `savingStates` (per-attribute), `isActionLoading`, `isCreating`

### useBulkActions(onRefresh)

- `handleBulkAction(action)` -- maps `"trash"` and `"delete"` to `/bulk-delete` (with `permanent` flag), `"restore"` to `/bulk-restore`
- `toggleSelection(id)` -- Set-based toggle
- `toggleSelectAll(ids)` -- all or none
- Returns: `selectedIds: Set<string>`, `bulkAction`, `isActionLoading`, `setBulkAction`, `handleBulkAction`, `toggleSelection`, `toggleSelectAll`

## Component Details

### AttributesManager (orchestrator)

- Wires all hooks together: `useAttributes`, `useAttributeActions`, `useBulkActions`
- Manages dialog states: create, delete, viewValues, editValues
- Computes inline statistics (filterable count, total value count from current page)
- Auto-generates slug from name on create (lowercase, hyphens, alphanumeric only)
- `showTrashed` prop controls trash view vs active view

### AttributeRow

- Inline editing: name and slug inputs with 700ms debounce auto-save
- Filterable toggle via Switch with immediate save
- Value count badge (clickable to open viewer if > 0)
- Actions: Edit Values (Edit3 icon), Delete/Trash (Trash2 icon)
- Trash view actions: Restore (Undo icon), Permanent Delete (XCircle icon)
- Disabled states when `deletedAt` is set or action is loading
- Per-row saving spinner in input fields

### AttributeTable

- Sortable column headers: Name, Slug, Filterable (with ArrowUpDown icons, active column highlighted)
- Select-all checkbox in header
- Loading state: centered spinner
- Empty state: icon + message + "Add Attribute" CTA (varies for trash/search/initial)

### AttributeCreateDialog

- Name input (auto-generates slug)
- Slug input (editable, monospace)
- Predefined values: text input + Add button, Enter key to add. Renders as removable Badge chips. Stored in `options` JSON array.
- Filterable switch (default: true)
- Validates: name min 2 chars, slug min 2 chars, slug format `^[a-z0-9]+(?:-[a-z0-9]+)*$`
- Checks for existing name/slug conflict server-side

### AttributeValuesViewer (read-only)

- Fetches `GET /{id}/values` on open
- Statistics: unique values count, total products count
- Search filter on values
- Table: Value, Product Count (badge), Example Products (up to 3 badges + "+N more")

### AttributeValueEditor

- Same layout as viewer but with edit capabilities
- Inline rename: click Edit3 icon, input appears in-cell with Check/X buttons, Enter/Escape keys
- Add new value: toggles input field with Check/X, Enter/Escape keys. Calls `POST /{id}/values`.
- Delete value: AlertDialog confirmation. Calls `DELETE /{id}/values`. Warning: removes from all products.
- Rename: calls `PUT /{id}/values` (updates all product_attribute_values rows + options array)
- Preset badge ("Predefined") shown for values that exist in the attribute's `options` array

### AttributeStatistics

- Three stat cards in a responsive grid: Total Attributes, Filterable, Total Values
- Uses lucide icons (Tags, Filter, Info) with colored backgrounds
- Only shown for active view (not trash)

### AttributeToolbar

- Search input with Search icon
- Selected count badge with context-appropriate bulk action buttons
- Active view: "Trash" bulk button
- Trash view: "Restore" + "Delete" (permanent) bulk buttons
- "Add Attribute" button (active view only)

### AttributePagination

- Delegates to shared `AdminListPagination` component
- Supports page navigation + page size selector
- Shows first/last page buttons

## Astro Page

File: `apps/admin/src/pages/admin/attributes/index.astro`

- Reads `?trashed=true` query param to toggle between active and trash views
- Toggle link: "View Trash" / "View Active"
- Renders `<AttributesManager client:idle showTrashed={showTrashed} />`

## Known Gaps

- **No core service layer** -- all attribute CRUD logic lives directly in the API route file (`apps/api/src/routes/admin/attributes.ts`), not in a `@scalius/core` service module. This is inconsistent with the media domain which has `MediaService`.
- **Statistics from current page only** -- `filterableCount` and `totalValueCount` in the AttributesManager are computed from `attributes` array (current page), not from the full dataset. Misleading when paginated.
- **Single value per product per attribute** -- the `UNIQUE(productId, attributeId)` constraint on `product_attribute_values` means each product can only have one value per attribute. Multi-value attributes (e.g. a product available in multiple colors) are not supported.
- **Options array is untyped in DB** -- stored as `text JSON`, no validation on read. The API casts with `as string[]`.
- **Value rename is not atomic** -- updating `productAttributeValues` and `productAttributes.options` are separate queries (not batched). A failure between them could leave inconsistent state.
- **Bulk delete ignores usage checks** -- `POST /bulk-delete` does not check if attributes are in use by products. Only single `DELETE /{id}` checks for usage.
- **No attribute groups or categories** -- attributes are a flat list. No way to group related attributes (e.g. "Physical" group for Size/Weight/Color).
- **Search-filters endpoint uses category-level attributes** -- `GET /attributes/search-filters` finds products via FTS5, then gets attributes from products in matching categories. This means it returns all attributes for those categories, not just attributes used by the specific matching products.
