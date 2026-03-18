# customer-list

React component module for the admin customer list page. Renders a paginated, searchable, sortable table of customers with bulk actions and soft/permanent delete support.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel export -- re-exports `CustomerListContainer` as `CustomerList` |
| `CustomerListContainer.tsx` | Top-level orchestrator: wires state + actions hooks, renders Card layout with header, search bar, bulk action bar, table, pagination, and delete dialog |
| `CustomerTable.tsx` | Table rendering: sortable column headers, `CustomerRow` (memoized) with contact info / location / stats, dropdown actions (edit, trash, restore, permanent delete), empty state |
| `DeleteCustomerDialog.tsx` | AlertDialog for single and bulk delete confirmation. Adapts messaging for trash vs permanent delete mode |
| `hooks/useCustomerListState.ts` | State management: display customers, pagination, search query, sort, selection, dialog state, keyboard shortcut (`/` to focus search, `Escape` to clear). Exports `Customer`, `CustomerListPagination`, `SortField` types |
| `hooks/useCustomerListActions.ts` | Side effects: `fetchCustomers` (client-side fetch to `/api/v1/admin/customers`), debounced search (500ms), sort/page/limit changes, CRUD API calls (delete, permanent delete, restore, bulk delete), optimistic UI updates, URL state sync via `pushState`, toast notifications |

## Data Flow

```
index.astro (SSR)
  -> loader: getCustomersIndexData (apiGet to admin proxy)
  -> passes customers[] + pagination as props

CustomerListContainer (client:idle)
  -> useCustomerListState (initial data from SSR props)
  -> useCustomerListActions (client-side fetch for subsequent interactions)
  -> CustomerTable (renders rows)
  -> DeleteCustomerDialog (confirmation modals)
```

Initial page load is SSR-rendered with data from the loader. All subsequent interactions (search, sort, paginate, CRUD) use client-side `fetch()` directly to the API worker at `/api/v1/admin/customers`. The response envelope is unwrapped: `json.data` is extracted if present, falling back to `json` for backward compatibility.

URL query parameters (`page`, `limit`, `search`, `sort`, `order`, `trashed`) are synced to the browser address bar via `history.pushState` on every client-side fetch, enabling shareable/bookmarkable filtered views.

## Features

### Search
- FTS5 full-text search across name, phone, email (server-side)
- Debounced at 500ms to avoid excessive API calls
- Keyboard shortcut: press `/` to focus, `Escape` to clear and blur
- Resets to page 1 on search query change

### Sorting
- Sortable columns: name, totalOrders, totalSpent, lastOrderAt
- Toggle asc/desc on repeated click; defaults to asc on first click
- Visual indicators: ArrowUp/ArrowDown for active sort, ArrowUpDown for inactive

### Selection & Bulk Actions
- Per-row checkbox selection with select-all (supports indeterminate state)
- Bulk action bar appears when selection is non-empty
- Bulk soft-delete (active view) or bulk permanent delete (trash view) via `POST /bulk-delete`

### Trash View
- Toggle between active customers and trashed customers via button
- Navigates between `/admin/customers` and `/admin/customers?trashed=true`
- Trash view shows restore + permanent delete actions instead of edit + soft delete
- Permanent delete shows destructive styling and irreversibility warning

### Pagination
- Page size selector: 10, 20, 50, 100 rows
- First/prev/next/last page buttons (first/last hidden on mobile)
- Displays "X of Y selected" when rows are selected, "Page X of Y" otherwise

### CRUD Actions
- **Create**: "Add New" button links to `/admin/customers/new`
- **Edit**: Dropdown action links to `/admin/customers/{id}/edit`
- **View history**: Customer name links to `/admin/customers/{id}/history`
- **Soft delete**: `DELETE /api/v1/admin/customers/{id}` with optimistic removal from list
- **Permanent delete**: `DELETE /api/v1/admin/customers/{id}/permanent` with confirmation dialog
- **Restore**: `POST /api/v1/admin/customers/{id}/restore` with optimistic removal from trash list
- All mutations use optimistic UI (remove from displayed list immediately) and show toast notifications

## Related Components

| Component | Path | Purpose |
|-----------|------|---------|
| `CustomerForm` | `apps/admin/src/components/admin/CustomerForm.tsx` | Create/edit form with react-hook-form + zod validation, international phone input (react-phone-number-input, E.164 output), LocationSelector for city/zone/area cascading dropdowns |
| `CustomerHistoryView` | `apps/admin/src/components/admin/CustomerHistoryView.tsx` | Detail page: profile card (contact, address, stats), recent orders table with load-more pagination, change history timeline with ScrollArea |

## Astro Pages

| Page | Path | Description |
|------|------|-------------|
| Customer list | `apps/admin/src/pages/admin/customers/index.astro` | SSR list with query param parsing, renders `CustomerList` |
| New customer | `apps/admin/src/pages/admin/customers/new.astro` | Renders `CustomerForm` with empty defaults |
| Edit customer | `apps/admin/src/pages/admin/customers/[id]/edit.astro` | Loads customer via `getCustomerEditData`, renders `CustomerForm` with populated values. Redirects to list if not found |
| Customer history | `apps/admin/src/pages/admin/customers/[id]/history.astro` | Loads customer + history + orders via `getCustomerHistoryData`, renders `CustomerHistoryView`. Redirects to list if not found |

## Loader

`apps/admin/src/loaders/admin/customers.ts` provides three data-fetching functions:

- `getCustomersIndexData()` -- fetches paginated list via `apiGet("/customers")`, converts timestamp strings to Date objects
- `getCustomerEditData()` -- fetches single customer via `apiGet("/customers/{id}")`, normalizes nullable location names to empty strings
- `getCustomerHistoryData()` -- fetches customer + history + orders via `apiGet("/customers/{id}/history")`, converts all timestamps to Date objects

## Types

The `Customer` interface (in `useCustomerListState.ts`) includes:
- Core fields: `id`, `name`, `email` (nullable), `phone` (E.164 format), `address` (nullable)
- Location: `city`, `zone`, `area` (IDs), `cityName`, `zoneName`, `areaName` (display names)
- Stats: `totalOrders`, `totalSpent`, `lastOrderAt` (Date | null)
- Timestamps: `createdAt` (Date), `updatedAt` (Date), `deletedAt` (optional)

## Known Gaps

1. **Currency display**: Uses `useCurrency()` hook for the symbol but `toLocaleString()` for number formatting. The currency formatting is not unified.

2. **No createdAt/updatedAt columns in table**: The table displays name, orders, total spent, last order, and actions. Created/updated dates are not shown despite being sortable (via `sort=createdAt` or `sort=updatedAt` URL param).

3. **Location display in table**: The `formatLocation` helper concatenates address, area, zone, city names but the result is shown with `line-clamp-1`, so longer addresses are truncated with no tooltip or expand option.

4. **Customer history view client-side pagination**: Orders are loaded in full from the API (no server-side pagination on the history endpoint) and paginated client-side with a "Load More" button (5 at a time). For customers with many orders, the initial payload could be large.
