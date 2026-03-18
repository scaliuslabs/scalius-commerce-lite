# Categories List

Admin component for browsing, searching, and managing product categories with soft-delete, bulk operations, and trash view.

## Overview

Paginated category list with FTS5 search (debounced), sortable columns, bulk select with trash/restore/permanent-delete, product count per category, image preview, and inline keyboard shortcuts. Server-side rendered initial data via Astro loader, then client-side fetch for subsequent interactions.

## Architecture

```
CategoryList (orchestrator -- CategoryListContainer.tsx)
  |-- CategoryHeader           title, stat cards, trash toggle, add button
  |-- CategoryToolbar          search input (/ shortcut), bulk action buttons
  |-- CategoryTable            sortable table with checkboxes, image, product count, row actions
  |   |-- CategoryRow          individual row (memoized)
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
- FTS5-powered server-side search via `GET /api/v1/admin/categories?search=...`
- Debounced: 500ms timeout before triggering fetch
- Keyboard shortcut: `/` focuses search input, `Escape` clears and blurs
- Clear button shown when filters are active

### Sortable Columns
- Category Info (name), Last Updated (updatedAt)
- Toggle asc/desc on click, sort icons indicate current state
- Triggers new fetch with sort params

### Product Count
- Each category row shows active product count (from batched query in service layer)
- Clickable "view" link navigates to `/admin/products?category={id}`

### Image Preview
- 44x44px rounded thumbnail with `getOptimizedImageUrl()` for CDN resizing
- Placeholder icon when no image

### Row Actions (dropdown menu)
- Active view: Edit, View on Website (storefront link), View Products, Move to Trash
- Trash view: Restore, Delete Permanently

### Bulk Operations
- Multi-select via checkboxes (per-row + select-all header with indeterminate state)
- Active view: "Trash (N)" button
- Trash view: "Restore (N)" + "Delete (N)" buttons
- Each action has its own confirmation dialog

### Trash Support
- Single `?trashed=true` query param toggles between active and trash views
- Toggle button in header switches view via client-side navigation
- Trash view shows restore/permanent-delete instead of edit/trash actions

### Statistics Cards (header)
- Total Categories, Products, With Images
- Uses shared `StatCard` component
- Hidden in trash view

### Pagination
- Page sizes: 10, 20, 50, 100
- First/prev/next/last buttons with tooltips
- Shows "X of Y row(s) selected" or "Showing N-M of T"

## Data Flow

```
Astro page (index.astro)
  --> getCategoriesIndexData() loader (SSR)
    --> apiGet("/categories") + apiGet("/products/stats") in parallel
  --> CategoryList (client:idle, SSR data as props)
    --> useCategoryList hook
      --> fetch("/api/v1/admin/categories?...") for subsequent interactions
      --> fetch("/api/v1/admin/categories/{id}") for single delete
      --> fetch("/api/v1/admin/categories/{id}/permanent") for permanent delete
      --> fetch("/api/v1/admin/categories/{id}/restore") for restore
      --> fetch("/api/v1/admin/categories/bulk-delete") for bulk delete
      --> fetch("/api/v1/admin/categories/bulk-restore") for bulk restore
```

### URL State
- Search, sort, order, page, limit, trashed params are pushed to browser URL via `history.pushState`
- Initial state is read from URL on mount

## Astro Pages

| Page | Route | Description |
|------|-------|-------------|
| `index.astro` | `/admin/categories` | SSR loader, `CategoryList` with `?trashed=true` support |
| `new.astro` | `/admin/categories/new` | `CategoryForm` with empty defaults |
| `[id]/edit.astro` | `/admin/categories/{id}/edit` | `CategoryForm` pre-populated via `getCategoryEditData()` |

No separate trash page -- reuses index with `?trashed=true` query param.

## CategoryForm (separate file)

Located at `apps/admin/src/components/admin/CategoryForm.tsx`:

### Layout
- 2/3 + 1/3 responsive grid
- Left: name input, description (TipTap rich text, lazy-loaded), category image (MediaManager, collapsible)
- Right: slug with `/categories/` prefix + storefront preview link, SEO section (collapsible) with meta title/description + character counters

### Behavior
- Auto-slug from name (new categories only, stops if slug manually edited)
- Zod validation matching the core schema
- Handles slug conflict errors from API
- Handles Zod validation error arrays from API
- Redirects to `/admin/categories` after successful save (500ms delay)
- `FormStickyHeader` with save/cancel/new-category buttons

## Dependencies

- `@scalius/shared/utils` -- `cn()`
- `@scalius/shared/image-optimizer` -- `getOptimizedImageUrl()`
- `@/hooks/use-storefront-url` -- `getStorefrontPath()` for storefront links
- `@/lib/client/navigate` -- `navigateTo()` client-side navigation
- `@/components/admin/shared/StatCard` -- stat cards in header
- `@/components/admin/FormStickyHeader` -- sticky save/cancel bar
- `@/components/admin/product-form/CollapsibleCard` -- collapsible card sections
- `sonner` -- toast notifications
- `react-hook-form` + `@hookform/resolvers/zod` -- form state (CategoryForm)
- TipTap editor -- lazy-loaded for description field

## Envelope Handling

The `useCategoryList` hook reads the response directly (`data.categories`, `data.pagination`) without explicit envelope unwrapping. In dev mode, the Vite proxy returns the admin-proxy-unwrapped format (`{ success, categories, pagination }`). In production, responses go through the admin proxy which unwraps `{ success, data: { categories, pagination } }` to `{ success, categories, pagination }`.

## Known Gaps

- **No drag-and-drop**: Unlike collections, categories have no `sortOrder` column and no reorder support -- they're sorted by name/createdAt/updatedAt only
- **No inline editing**: Name, slug, etc. require navigating to the edit form (collections allow inline name editing)
- **No active/inactive toggle**: Categories don't have an `isActive` field (all non-deleted categories are active)
- **Stats come from products/stats endpoint**: The `getCategoriesIndexData()` loader fetches `ProductStats` for the header stat cards, which must contain `totalCategories`/`categoriesWithImages`/`totalProducts` fields
- **Product count not updated after delete**: When a category is deleted client-side, it's removed from the list but product counts for remaining categories are not refreshed
