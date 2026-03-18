# Product List (Admin)

React component suite for the admin product listing page. Server-rendered initial data via Astro, then client-side pagination/search/sort/filter with URL state synchronization.

## Features

- Server-side initial render: Astro page fetches products, categories, stats via `getProductsIndexData` loader, passes as props
- Client-side data fetching for pagination, search, sort, and filter changes (no full page reload)
- URL state sync: search, category, sort, order, page, limit, trashed params are pushed to browser history
- Debounced search (500ms) with keyboard shortcut (`/` to focus, `Escape` to clear)
- FTS5 full-text search + barcode search (handled server-side)
- Category filter dropdown
- Column sorting: name, price, category, createdAt, updatedAt
- Configurable page size (10, 20, 50, 100) via pagination dropdown
- Product row displays: thumbnail (optimized), name, SKU, active/inactive badge, free delivery badge, category, price with discount display (both percentage and flat), variant count, updated date
- Flat discount display: shows "{amount} off" for flat discounts, "{percentage}% off" for percentage discounts
- `ProductListItem` type includes `discountType` (`"percentage" | "flat" | null`) and `discountAmount` (`number | null`) alongside `discountPercentage`
- Copy product shortcode to clipboard (`[product slug="..."]`)
- Row-level actions: view, edit, copy shortcode, move to trash
- Trash view: restore, permanent delete actions
- Bulk selection with select-all/indeterminate checkbox
- Bulk delete (soft or permanent) with confirmation dialog
- Dashboard stats cards: total products, active products, with images, categories count
- Product stats fetched server-side via `getProductStats` API call
- Currency formatting uses `useCurrency` hook (dynamic symbol)
- Price formatting uses Indian number format (`en-IN`) with 2 decimal places

## Data Flow

```
Astro SSR (products/index.astro)
  |--> getProductsIndexData() loader
  |      |--> Promise.all: getActiveCategories, apiGet(/products), apiGet(/products/stats)
  |      |--> Converts timestamps to Date objects
  |      |--> Returns { categories, products, pagination, stats }
  |
  |--> <ProductList client:idle /> (hydrated React island)
        |--> useProductList hook
              |--> Initial state from SSR props
              |--> Client fetch: GET /api/v1/admin/products?page=&limit=&search=&category=&sort=&order=&trashed=
              |--> Parses createdAt/updatedAt from response into Date objects
              |--> URL pushState on every filter/sort/page change
              |--> Delete: DELETE /api/v1/admin/products/:id
              |--> Permanent delete: DELETE /api/v1/admin/products/:id/permanent
              |--> Restore: POST /api/v1/admin/products/:id/restore
              |--> Bulk delete: POST /api/v1/admin/products/bulk-delete
```

## Files

| File | Description |
|------|-------------|
| `index.ts` | Single export: `ProductList` from `ProductListContainer` |
| `ProductListContainer.tsx` | Main container: wires `useProductList` hook to `ProductHeader`, `ProductToolbar`, `ProductTable`, `ProductPagination`, and delete confirmation dialogs (single + bulk) |
| `ProductHeader.tsx` | Title, description, trash toggle button, add product button, stats cards grid (4 StatCards: total, active, with-images, categories). Memoized. |
| `ProductToolbar.tsx` | Search input with `/` shortcut hint, category dropdown, clear filters button, bulk delete button showing selected count. Memoized. |
| `ProductTable.tsx` | Table with sortable column headers (name, category, price, updatedAt), select-all checkbox, product rows via `ProductRow`, loading overlay, empty states (no products / no matches / empty trash). Memoized. |
| `ProductRow.tsx` | Individual product row: thumbnail (via `getOptimizedImageUrl`), name+SKU, active/free-delivery badges, category, price with discount (flat or percentage), variant count, formatted date, actions dropdown (view/edit/copy-shortcode/trash or restore/permanent-delete). Memoized. |
| `ProductPagination.tsx` | Page navigation (first/prev/next/last) with tooltips, page size selector dropdown, showing range or selected count. Hidden when totalPages <= 1. Memoized. |
| `hooks/useProductList.ts` | Core hook: all state management, fetch logic, URL sync, CRUD handlers, formatting utilities. Exports `ProductListItem`, `SortField`, `SortOrder`, `Category`, `Pagination`, `ProductStats` types and `ALL_CATEGORIES` constant. |

## API Endpoints Used

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/admin/products` | Fetch paginated product list (client-side, called by `useProductList.fetchProducts`). Response includes `discountType`, `discountAmount`, `discountPercentage` per product. |
| DELETE | `/api/v1/admin/products/:id` | Soft delete single product |
| DELETE | `/api/v1/admin/products/:id/permanent` | Permanently delete single product |
| POST | `/api/v1/admin/products/:id/restore` | Restore soft-deleted product |
| POST | `/api/v1/admin/products/bulk-delete` | Bulk soft or permanent delete |
| GET | `/api/v1/admin/products/stats` | Product dashboard statistics (called by loader) |
| GET | `/api/v1/admin/categories/form-options` | Category list for filter dropdown (called by loader) |

## Known Gaps

1. **Client-side fetch does not use the admin proxy**: `useProductList.fetchProducts` fetches from `/api/v1/admin/products` directly. In dev mode this goes through Vite proxy; the response is parsed directly without unwrapping the `{ success, data }` envelope. The code reads `data.products` and `data.pagination` directly from the JSON response, which works because in dev mode the Vite proxy passes through the raw API response (which already has `products` at the top level from `ok(c, result)` where result = `{ products, pagination }`).

2. **Stats are stale after mutations**: Dashboard stats (total products, active count, etc.) are fetched once during SSR. After deleting or restoring products client-side, the stats cards are not refreshed -- they still show the original counts.

3. **No optimistic UI for restore**: `handleRestore` removes the product from the local list only after the API call succeeds. There is no optimistic removal. Deletion operations do the same -- they wait for the API before updating local state.

4. **Date formatting assumes valid Date objects**: `formatDate` checks `instanceof Date` and `isNaN(getTime())` but the client fetch in `fetchProducts` creates `new Date(p.createdAt)` from raw API values which may be Unix timestamps (numbers) rather than ISO strings, potentially producing incorrect dates if the API returns raw seconds.

## Dependencies

### This module depends on:
- `sonner` -- toast notifications
- `lucide-react` -- icons (Package, Trash2, Plus, Eye, Pencil, Search, Copy, MoreHorizontal, ArrowUpDown, etc.)
- `@scalius/shared/utils` -- `cn` utility
- `@scalius/shared/image-optimizer` -- `getOptimizedImageUrl` for product thumbnails
- Admin UI components: `@/components/ui/*` (Card, Button, Table, Badge, Checkbox, Input, Select, AlertDialog, DropdownMenu, Tooltip)
- `@/components/admin/shared/StatCard` -- stats display cards
- `@/hooks/useCurrency` -- currency symbol for price formatting
- `@/lib/client/navigate` -- `navigateTo` for client-side page transitions

### Depends on this module:
- `apps/admin/src/pages/admin/products/index.astro` -- product listing page
