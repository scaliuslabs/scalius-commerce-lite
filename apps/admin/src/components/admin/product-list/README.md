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
- Configurable page size (via pagination component)
- Product row displays: thumbnail (optimized), name, SKU, active/inactive badge, free delivery badge, category, price, discount percentage, variant count, updated date
- Copy product shortcode to clipboard (`[product slug="..."]`)
- Row-level actions: view, edit, copy shortcode, move to trash
- Trash view: restore, permanent delete actions
- Bulk selection with select-all/indeterminate checkbox
- Bulk delete (soft or permanent) with confirmation dialog
- Dashboard stats cards: total products, active products, with images, categories count
- Product stats fetched server-side via `getProductStats` API call

## Data Flow

```
Astro SSR (products/index.astro)
  |--> getProductsIndexData() loader
  |      |--> Promise.all: getActiveCategories, apiGet(/products), apiGet(/products/stats)
  |      |--> Returns { categories, products, pagination, stats }
  |
  |--> <ProductList client:idle /> (hydrated React island)
        |--> useProductList hook
              |--> Initial state from SSR props
              |--> Client fetch: GET /api/v1/admin/products?page=&limit=&search=&category=&sort=&order=&trashed=
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
| `ProductListContainer.tsx` | Main container: wires `useProductList` hook to `ProductHeader`, `ProductToolbar`, `ProductTable`, `ProductPagination`, and delete confirmation dialogs |
| `ProductHeader.tsx` | Title, description, trash toggle button, add product button, stats cards grid (memoized) |
| `ProductToolbar.tsx` | Search input with `/` shortcut hint, category dropdown, clear filters button, bulk delete button (memoized) |
| `ProductTable.tsx` | Table with sortable column headers, select-all checkbox, product rows, loading/empty states |
| `ProductRow.tsx` | Individual product row: thumbnail, name+SKU, badges, category, price+discount, variant count, date, actions dropdown (memoized) |
| `ProductPagination.tsx` | Page navigation with page size selector, showing selected count |
| `hooks/useProductList.ts` | Core hook: all state management, fetch logic, URL sync, CRUD handlers, formatting utilities |

## API Endpoints Used

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/admin/products` | Fetch paginated product list (client-side, called by `useProductList.fetchProducts`) |
| DELETE | `/api/v1/admin/products/:id` | Soft delete single product |
| DELETE | `/api/v1/admin/products/:id/permanent` | Permanently delete single product |
| POST | `/api/v1/admin/products/:id/restore` | Restore soft-deleted product |
| POST | `/api/v1/admin/products/bulk-delete` | Bulk soft or permanent delete |
| GET | `/api/v1/admin/products/stats` | Product dashboard statistics (called by loader) |
| GET | `/api/v1/admin/categories/form-options` | Category list for filter dropdown (called by loader) |

## Known Gaps

1. **Client-side fetch does not use the admin proxy**: `useProductList.fetchProducts` (`hooks/useProductList.ts:134`) fetches from `/api/v1/admin/products` directly. In dev mode this goes through Vite proxy; the response is parsed directly without unwrapping the `{ success, data }` envelope. The code reads `data.products` and `data.pagination` directly from the JSON response, which works because in dev mode the Vite proxy passes through the raw API response (which already has `products` at the top level from `ok(c, result)` where result = `{ products, pagination }`).

2. **Discount display only shows percentage**: `ProductRow.tsx:140-144` shows `{product.discountPercentage}% off` but does not handle flat discounts. Products with `discountType: "flat"` and a non-zero `discountAmount` will show "0% off" or nothing, because `discountAmount` is not included in the `ProductListItem` type or the admin list API response.

3. **Stats are stale after mutations**: Dashboard stats (total products, active count, etc.) are fetched once during SSR. After deleting or restoring products client-side, the stats cards are not refreshed -- they still show the original counts.

4. **No optimistic UI for restore**: `handleRestore` (`hooks/useProductList.ts:436`) removes the product from the local list only after the API call succeeds. There is no optimistic removal. Deletion operations do the same -- they wait for the API before updating local state.

5. **Date formatting assumes valid Date objects**: `formatDate` (`hooks/useProductList.ts:544`) checks `instanceof Date` and `isNaN(getTime())` but the client fetch in `fetchProducts` (`hooks/useProductList.ts:152-153`) creates `new Date(p.createdAt)` from raw API values which may be Unix timestamps (numbers) rather than ISO strings, potentially producing incorrect dates if the API returns raw seconds.

## Dependencies

### This module depends on:
- `sonner` -- toast notifications
- `lucide-react` -- icons (Package, Trash2, Plus, Eye, Pencil, Search, etc.)
- `@scalius/shared/utils` -- `cn` utility
- `@scalius/shared/image-optimizer` -- `getOptimizedImageUrl` for product thumbnails
- Admin UI components: `@/components/ui/*` (Card, Button, Table, Badge, Checkbox, Input, Select, AlertDialog, DropdownMenu)
- `@/components/admin/shared/StatCard` -- stats display cards
- `@/hooks/useCurrency` -- currency symbol for price formatting
- `@/lib/client/navigate` -- `navigateTo` for client-side page transitions

### Depends on this module:
- `apps/admin/src/pages/admin/products/index.astro` -- product listing page
