# Collections List

Admin component for managing product collections with drag-and-drop reordering, inline editing, and bulk operations.

## Architecture

```
CollectionsList (orchestrator)
  |-- CollectionStatistics      stat cards (total/active/inactive)
  |-- CollectionToolbar         search + bulk action buttons
  |-- CollectionTable           drag-drop table with sortable columns
  |   |-- CollectionRow         inline editing, drag handle, status toggle, actions
  |-- CollectionPagination      page nav + page size selector
  |-- CollectionDeleteDialog    trash/permanent delete confirmation
  |-- BulkActionDialog          shared bulk action confirmation (from @/components/admin/shared)
```

## Files

```
collections-list/
  index.ts                      -- barrel exports (CollectionsList + types)
  CollectionsList.tsx            -- main orchestrator, wires hooks to components
  components/
    index.ts                    -- component barrel exports
    CollectionRow.tsx           -- row with inline name edit, drag handle, type badge, content summary, active toggle, actions
    CollectionStatistics.tsx    -- total/active/inactive stat cards (hidden in trash view)
    CollectionToolbar.tsx       -- search input + context-aware bulk action buttons
    CollectionTable.tsx         -- DragDropContext/Droppable/Draggable table, sortable columns, empty states
    CollectionPagination.tsx    -- delegates to shared AdminListPagination
    CollectionDeleteDialog.tsx  -- AlertDialog for trash/permanent delete confirmation
  hooks/
    index.ts                   -- hook barrel exports
    useCollections.ts          -- fetch collections, pagination state, page/size changes
    useCollectionActions.ts    -- update (inline), delete (soft/permanent), restore, reorder
    useBulkActions.ts          -- multi-select state, bulk API calls (trash/delete/restore/activate/deactivate)
  types/
    index.ts                   -- all TypeScript interfaces: CollectionItem, CollectionConfig, Pagination, SortField, BulkAction, prop types
```

## Features

### Drag-and-Drop Reordering
- Uses `@hello-pangea/dnd` (React Beautiful DND fork)
- `GripVertical` handle on each row (hidden in trash view)
- Optimistic UI update: reorders local state immediately, then persists via `POST /api/v1/admin/collections/reorder`
- Reverts to server state on failure

### Inline Editing
- Collection name: editable `Input` in each row, debounced 700ms, auto-saves via `PUT /api/v1/admin/collections/{id}`
- Active toggle: `Switch` component, saves immediately on change
- Per-row saving indicator (`Loader2` spinner)

### Bulk Actions
- Multi-select via checkboxes (per-row + select-all header)
- Actions vary by view:
  - Active view: Activate, Deactivate, Trash
  - Trash view: Restore, Delete Permanently
- Uses shared `BulkActionDialog` for confirmation

### Content Source Display
- Parses collection `config` JSON to show summary: "N categories + M products" or "N specific products" or "No products"

### Sortable Columns
- Name, Type, Status (isActive) -- click column header to toggle asc/desc
- Default sort: `sortOrder` ascending

## Data Flow

```
Astro page (index.astro / trash.astro)
  --> CollectionsList (client:idle, showTrashed prop)
    --> useCollections hook: fetch("/api/v1/admin/collections?...")
    --> useCollectionActions hook: PUT/DELETE/POST for individual ops
    --> useBulkActions hook: POST for bulk ops
```

### API Endpoints Used

| Action | Method | Endpoint |
|--------|--------|----------|
| List | GET | `/api/v1/admin/collections` |
| Update (inline) | PUT | `/api/v1/admin/collections/{id}` |
| Soft delete | DELETE | `/api/v1/admin/collections/{id}` |
| Permanent delete | DELETE | `/api/v1/admin/collections/{id}/permanent` |
| Restore | POST | `/api/v1/admin/collections/{id}/restore` |
| Reorder | POST | `/api/v1/admin/collections/reorder` |
| Bulk trash/delete | POST | `/api/v1/admin/collections/bulk-delete` |
| Bulk activate | POST | `/api/v1/admin/collections/bulk-activate` |
| Bulk deactivate | POST | `/api/v1/admin/collections/bulk-deactivate` |
| Bulk restore | POST | `/api/v1/admin/collections/bulk-restore` |

## Astro Pages

| Page | Route | Description |
|------|-------|-------------|
| `index.astro` | `/admin/collections` | Header with title, New/Trash buttons, `CollectionsList showTrashed={false}` |
| `trash.astro` | `/admin/collections/trash` | Header with title, View Active button, `CollectionsList showTrashed={true}` |

## Dependencies

- `@hello-pangea/dnd` -- drag-and-drop
- `@/hooks/use-debounce` -- debounced search and inline name editing
- `@/components/admin/shared/BulkActionDialog` -- shared bulk action confirmation
- `@/components/admin/shared/AdminListPagination` -- shared pagination
- `@scalius/shared/utils` -- `cn()` utility
- `@/lib/api-helpers` -- `unwrapEnvelope()`, `extractApiError()`
- `@/lib/client/navigate` -- `navigateTo()` client-side navigation
- `sonner` -- toast notifications

## Known Gaps

- **No SSR data loading**: Unlike the categories list, `CollectionsList` fetches all data client-side on mount -- causes a loading spinner flash
