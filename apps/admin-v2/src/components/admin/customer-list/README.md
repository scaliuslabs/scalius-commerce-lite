# Customer List

Admin component for the customer list page. Paginated, searchable, sortable table of customers with bulk actions and soft/permanent delete support.

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

Initial page load is SSR-rendered with data from the loader. All subsequent interactions (search, sort, paginate, CRUD) use client-side `fetch()` directly to `/api/v1/admin/customers`. URL query parameters (`page`, `limit`, `search`, `sort`, `order`, `trashed`) are synced via `history.pushState`.

## Features

### Search
- Server-side search across name, phone, email
- Debounced at 500ms
- Keyboard shortcut: press `/` to focus, `Escape` to clear and blur

### Sorting
- Sortable columns: name, totalOrders, totalSpent, lastOrderAt
- Toggle asc/desc on repeated click

### Selection & Bulk Actions
- Per-row checkbox selection with select-all (supports indeterminate state)
- Bulk soft-delete (active view) or bulk permanent delete (trash view) via `POST /bulk-delete`

### Trash View
- Toggle between active and trashed via button
- Navigates between `/admin/customers` and `/admin/customers?trashed=true`
- Trash view shows restore + permanent delete actions

### Pagination
- Page size selector: 10, 20, 50, 100 rows
- First/prev/next/last page buttons (first/last hidden on mobile)

### CRUD Actions
- **Create**: "Add New" button links to `/admin/customers/new`
- **Edit**: Dropdown action links to `/admin/customers/{id}/edit`
- **View history**: Customer name links to `/admin/customers/{id}/history`
- **Soft delete**: `DELETE /api/v1/admin/customers/{id}` with optimistic removal
- **Permanent delete**: `DELETE /api/v1/admin/customers/{id}/permanent` with confirmation
- **Restore**: `POST /api/v1/admin/customers/{id}/restore` with optimistic removal from trash

## Related Components

| Component | Path | Purpose |
|-----------|------|---------|
| `CustomerForm` | `apps/admin/src/components/admin/CustomerForm.tsx` | Create/edit form with react-hook-form + zod, international phone input (E.164), LocationSelector |
| `CustomerHistoryView` | `apps/admin/src/components/admin/CustomerHistoryView.tsx` | Detail page: profile card, recent orders table, change history timeline |

## Astro Pages

| Page | Path | Description |
|------|------|-------------|
| Customer list | `apps/admin/src/pages/admin/customers/index.astro` | SSR list with query param parsing |
| New customer | `apps/admin/src/pages/admin/customers/new.astro` | `CustomerForm` with empty defaults |
| Edit customer | `apps/admin/src/pages/admin/customers/[id]/edit.astro` | `CustomerForm` with populated values |
| Customer history | `apps/admin/src/pages/admin/customers/[id]/history.astro` | `CustomerHistoryView` with orders + history |

## Types

The `Customer` interface (in `useCustomerListState.ts`) includes:
- Core fields: `id`, `name`, `email` (nullable), `phone` (E.164 format), `address` (nullable)
- Location: `city`, `zone`, `area` (IDs), `cityName`, `zoneName`, `areaName` (display names)
- Stats: `totalOrders`, `totalSpent`, `lastOrderAt` (Date | null)
- Timestamps: `createdAt` (Date), `updatedAt` (Date), `deletedAt` (optional)

## Dependencies

- `@/hooks/use-currency` -- `useCurrency()` for currency symbol
- `@/lib/api-helpers` -- `unwrapEnvelope()`, `extractApiError()`
- `@/lib/client/navigate` -- `navigateTo()`
- `sonner` -- toast notifications

## Known Gaps

1. **Currency display**: Uses `useCurrency()` for symbol but `toLocaleString()` for number formatting -- not unified
2. **No createdAt/updatedAt columns in table**: Dates are not shown despite being sortable via URL params
3. **Location display truncation**: `formatLocation` result shown with `line-clamp-1`, no tooltip or expand
