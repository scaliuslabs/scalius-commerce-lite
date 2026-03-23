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

## Hooks

### useAttributes(showTrashed, searchQuery, sortField, sortOrder)

- Fetches `GET /api/v1/admin/attributes` with all params
- Uses `unwrapEnvelope()` from `@/lib/api-helpers` for response parsing
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

### AttributeTable

- Sortable column headers: Name, Slug, Filterable (with ArrowUpDown icons)
- Select-all checkbox in header
- Loading state: centered spinner
- Empty state: icon + message + "Add Attribute" CTA (varies for trash/search/initial)

### AttributeCreateDialog

- Name input (auto-generates slug)
- Slug input (editable, monospace)
- Predefined values: text input + Add button, Enter key to add. Renders as removable Badge chips. Stored in `options` JSON array.
- Filterable switch (default: true)

### AttributeValuesViewer (read-only)

- Fetches `GET /{id}/values` on open
- Statistics: unique values count, total products count
- Search filter on values
- Table: Value, Product Count (badge), Example Products (up to 3 badges + "+N more")

### AttributeValueEditor

- Same layout as viewer but with edit capabilities
- Inline rename: click Edit3 icon, input appears with Check/X buttons
- Add new value: calls `POST /{id}/values`
- Delete value: AlertDialog confirmation, calls `DELETE /{id}/values`
- Rename: calls `PUT /{id}/values` (updates all product_attribute_values rows + options array)
- Preset badge ("Predefined") shown for values in the attribute's `options` array

### AttributeStatistics

- Three stat cards: Total Attributes, Filterable, Total Values
- Uses lucide icons (Tags, Filter, Info)
- Only shown for active view (not trash)

### AttributePagination

- Delegates to shared `AdminListPagination` component

## API Endpoints Used

All mounted under `/api/v1/admin/attributes` (admin-only, auth required).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List attributes (paginated, search, sort, trashed) |
| POST | `/` | Create attribute |
| PUT | `/{id}` | Update attribute (name, slug, filterable, options) |
| DELETE | `/{id}` | Soft-delete (checks product usage first) |
| DELETE | `/{id}/permanent` | Hard-delete |
| POST | `/{id}/restore` | Restore soft-deleted attribute |
| POST | `/bulk-delete` | Bulk soft-delete or hard-delete (`permanent: bool`) |
| POST | `/bulk-restore` | Bulk restore |
| GET | `/{id}/values` | List unique values with product counts |
| POST | `/{id}/values` | Add preset value to `options` array |
| PUT | `/{id}/values` | Rename value across all products + options |
| DELETE | `/{id}/values` | Delete value from all products + options |

## Astro Page

File: `apps/admin/src/pages/admin/attributes/index.astro`

- Reads `?trashed=true` query param to toggle between active and trash views
- Renders `<AttributesManager client:idle showTrashed={showTrashed} />`

## Known Gaps

- **Statistics from current page only** -- `filterableCount` and `totalValueCount` are computed from the current page, not the full dataset
- **Single value per product per attribute** -- the `UNIQUE(productId, attributeId)` constraint means each product can only have one value per attribute
- **Value rename is not atomic** -- updating `productAttributeValues` and `productAttributes.options` are separate queries
- **Bulk delete ignores usage checks** -- `POST /bulk-delete` does not check if attributes are in use by products
