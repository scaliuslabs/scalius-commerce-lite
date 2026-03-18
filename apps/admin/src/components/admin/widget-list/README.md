# Widget List

Admin component for managing content widgets with status toggles, shortcode copy, placement display, OpenRouter API key configuration, and bulk operations.

## Architecture

```
widget-list/
  WidgetsList.tsx              -- main orchestrator (state, pagination, settings dialog)
  index.ts                     -- barrel export (WidgetsList + types)
  components/
    WidgetRow.tsx               -- table row: status toggle, edit link, shortcode copy, placement label
    WidgetStatistics.tsx        -- stat cards: total / active / inactive
    WidgetToolbar.tsx           -- search input + bulk action buttons + API key button
    WidgetTable.tsx             -- table shell with header, select-all, empty states
    WidgetDeleteDialog.tsx      -- trash/permanent delete confirmation
    index.ts                    -- barrel export for components
  hooks/
    useWidgets.ts               -- widget data state, reload trigger (navigateTo for full page refresh)
    useWidgetActions.ts         -- single-widget CRUD (update, soft-delete, permanent delete, restore)
    useBulkActions.ts           -- multi-select state + bulk API calls (trash, delete, restore, activate, deactivate)
    index.ts                    -- barrel export for hooks
  types/
    index.ts                    -- WidgetItem, CollectionOption, WidgetStatistics, prop interfaces, BulkAction union
```

## Data Flow

1. **Astro page** (`apps/admin/src/pages/admin/widgets/index.astro`) calls `getWidgetsListPageData()` from the loader, which fetches via the admin API proxy.
2. Widgets, collections, and stats are passed as `initialWidgets` / `initialCollections` / `initialStats` to `WidgetsList` (hydrated with `client:idle`).
3. `useWidgets` holds the widget array in state, initialized from props. `fetchWidgets()` triggers a full page navigation (via `navigateTo`) to reload SSR data.
4. Client-side search filtering is done in `WidgetsList` (no API call -- filters the in-memory array by name).
5. Client-side pagination slices the filtered array into pages.

## Features

### Widget Table
- Columns: checkbox, name, placement (with collection name), active/inactive toggle+badge, sort order, actions
- Actions per row: edit (link to `/admin/widgets/{id}`), copy shortcode, soft-delete
- Trash view: restore button, permanent delete button (no edit/shortcode)

### Shortcode Copy
Copies `[widget id="wid_xxx"]` to clipboard. Available from the row actions in the widget table.

### Status Toggle
Inline `Switch` component calls `PUT /admin/widgets/{id}` with `{ isActive: !current }`. Optimistic update via `setWidgets` state setter.

### Bulk Actions
- **Active view**: activate, deactivate, trash
- **Trash view**: restore, delete permanently
All go through `useBulkActions` which POSTs to the appropriate `/admin/widgets/bulk-*` endpoint.

### OpenRouter Settings
Settings dialog (accessed via "API Key" button in toolbar) allows storing an OpenRouter API key via `POST /admin/settings/openrouter`. This key is used by the AI assistant in the widget creation/edit form.

### Statistics Cards
Three stat cards (total, active, inactive) shown above the table in the active view. Hidden in trash view. Stats are computed from the widget array at load time.

## Pages

| Route | File | Description |
|-------|------|-------------|
| `/admin/widgets` | `apps/admin/src/pages/admin/widgets/index.astro` | Widget list (active) |
| `/admin/widgets/trash` | `apps/admin/src/pages/admin/widgets/trash.astro` | Widget list (trashed) |
| `/admin/widgets/create` | `apps/admin/src/pages/admin/widgets/[id].astro` | Create new widget (id="create") |
| `/admin/widgets/{id}` | `apps/admin/src/pages/admin/widgets/[id].astro` | Edit existing widget |

The `[id].astro` page handles both create and edit. When `id === "create"`, `getWidgetFormPageData` returns create-mode defaults. Otherwise, it fetches the widget by ID.

## Loader

`apps/admin/src/loaders/admin/widgets.ts` provides:
- `getWidgetsListPageData({ search, showTrashed })` -- fetches widget list + collections, computes stats
- `getWidgetFormPageData(id)` -- fetches single widget (or create-mode defaults) + collections + placement rules

## Dependencies

- Shared `BulkActionDialog` from `@/components/admin/shared/BulkActionDialog`
- Shared `AdminListPagination` from `@/components/admin/shared/AdminListPagination`
- `@scalius/shared/utils` -- `cn` utility
- `@/lib/client/navigate` -- `navigateTo` for Astro View Transitions-compatible navigation

## Known Gaps

- **Search is client-side only**: Filters the in-memory widget array by name substring. No FTS5 or server-side search. Works for small widget counts but would not scale.
- **No server-side pagination**: All widgets are fetched in one request, then paginated client-side.
- **Stats not dynamic**: Statistics are computed once from the initial data and do not update after mutations (activate/deactivate/delete). A full page reload updates them.
- **Trash view data issue**: See widgets service README -- the `listWidgets` service always filters `deletedAt IS NULL`, so trashed widgets may not appear.
