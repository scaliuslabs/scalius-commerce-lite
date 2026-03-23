# Categories List

Admin component for browsing, searching, and managing product categories with soft-delete, bulk operations, and trash view.

## Architecture

```
CategoryList (orchestrator -- CategoryListContainer.tsx)
  |-- CategoryHeader           title, stat cards, trash toggle, add button
  |-- CategoryToolbar          search input (/ shortcut), bulk action buttons
  |-- CategoryTable            sortable table with checkboxes, image, product count, row actions
  |-- CategoryPagination       page nav + page size selector
  |-- AlertDialog x3           single delete, bulk delete, bulk restore confirmations
```

All state management lives in `hooks/useCategoryList.ts`.

## Files

```
categories/
  index.ts                     -- barrel export (CategoryList)
  CategoryListContainer.tsx    -- main orchestrator, wires hook to sub-components + dialogs
  CategoryHeader.tsx           -- title/description, stat cards (total/products/with images), trash toggle, add button
  CategoryToolbar.tsx          -- search form with / keyboard shortcut, bulk trash/restore/delete buttons
  CategoryTable.tsx            -- sortable table header, loading overlay, empty states, CategoryRow per item
  CategoryPagination.tsx       -- first/prev/next/last with tooltips, page size selector (10/20/50/100)
  hooks/
    useCategoryList.ts         -- all state, fetch, debounced search, CRUD handlers, derived state
```

The form component lives separately at `apps/admin/src/components/admin/CategoryForm.tsx`.

## Features

### SSR Initial Data
- Astro page calls `getCategoriesIndexData()` loader (fetches categories + product stats in parallel)
- Passes pre-rendered data as props to `CategoryList` (client:idle)
- Subsequent interactions (search, sort, paginate, CRUD) use client-side fetch

### Search
- Server-side search via `GET /api/v1/admin/categories?search=...`
- Debounced: 500ms timeout before triggering fetch
- Keyboard shortcut: `/` focuses search input, `Escape` clears and blurs

### Sortable Columns
- Category Info (name), Last Updated (updatedAt)
- Toggle asc/desc on click

### Row Actions (dropdown menu)
- Active view: Edit, View on Website (storefront link via `useStorefrontUrl`), View Products, Move to Trash
- Trash view: Restore, Delete Permanently

### Delete Guards
- Soft-delete and permanent-delete both check for products assigned to the category
- If products are still assigned, the API returns an error with affected product names and a suggestion message

### Bulk Operations
- Multi-select via checkboxes (per-row + select-all header with indeterminate state)
- Active view: "Trash (N)" button
- Trash view: "Restore (N)" + "Delete (N)" buttons
- Each action has its own confirmation dialog

### Trash Support
- `?trashed=true` query param toggles between active and trash views
- Toggle button in header via `navigateTo()` client-side navigation

### Statistics Cards (header)
- Total Categories, Products, With Images
- Uses shared `StatCard` component
- Hidden in trash view

### Pagination
- Page sizes: 10, 20, 50, 100
- First/prev/next/last buttons with tooltips

## Data Flow

```
Astro page (index.astro)
  --> getCategoriesIndexData() loader (SSR)
  --> CategoryList (client:idle, SSR data as props)
    --> useCategoryList hook
      --> fetch("/api/v1/admin/categories?...") for subsequent interactions
      --> DELETE/POST for individual and bulk operations
```

### URL State
- Search, sort, order, page, limit, trashed params are pushed to browser URL via `history.pushState`
- Initial state is read from URL on mount

## API Endpoints Used

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/admin/categories` | List with pagination/search/sort/trashed |
| DELETE | `/api/v1/admin/categories/{id}` | Soft-delete |
| DELETE | `/api/v1/admin/categories/{id}/permanent` | Hard-delete |
| POST | `/api/v1/admin/categories/{id}/restore` | Restore |
| POST | `/api/v1/admin/categories/bulk-delete` | Bulk delete (with `permanent` flag) |
| POST | `/api/v1/admin/categories/bulk-restore` | Bulk restore |

## Astro Pages

| Page | Route | Description |
|------|-------|-------------|
| `index.astro` | `/admin/categories` | SSR loader, `CategoryList` with `?trashed=true` support |
| `new.astro` | `/admin/categories/new` | `CategoryForm` with empty defaults |
| `[id]/edit.astro` | `/admin/categories/{id}/edit` | `CategoryForm` pre-populated via `getCategoryEditData()` |

## Dependencies

- `@scalius/shared/utils` -- `cn()`
- `@scalius/shared/image-optimizer` -- `getOptimizedImageUrl()`
- `@/hooks/use-storefront-url` -- `getStorefrontPath()` for storefront links
- `@/lib/client/navigate` -- `navigateTo()` client-side navigation
- `@/lib/api-helpers` -- `unwrapEnvelope()`, `extractApiError()`
- `sonner` -- toast notifications

## Known Gaps

- **No drag-and-drop**: Categories have no `sortOrder` column -- sorted by name/createdAt/updatedAt only
- **No inline editing**: Name, slug, etc. require navigating to the edit form
- **No active/inactive toggle**: All non-deleted categories are active
- **Product count not updated after delete**: When a category is deleted client-side, product counts for remaining categories are not refreshed
