# Shipping Methods Admin UI

Admin dashboard components for CRUD management of shipping methods. Split into container, table, form dialog, bulk actions bar, and a custom hook.

## Overview

The shipping methods UI lives under the admin settings section. It provides a full management interface with:
- Paginated, sortable, searchable table of shipping methods
- Create / edit dialog with form validation
- Soft-delete (trash) with dedicated trash view
- Restore from trash and permanent delete
- Bulk actions (trash, permanent delete, restore) with confirmation dialogs
- Row selection via checkboxes with select-all support

## Files

| File                                | Purpose                                                                                    |
|-------------------------------------|--------------------------------------------------------------------------------------------|
| `index.ts`                          | Barrel export: re-exports `ShippingMethodsContainer` as `ShippingMethodsManager`           |
| `ShippingMethodsContainer.tsx`      | Top-level container -- wires hook state to child components, manages dialog open/close state, handles single-delete and bulk-action confirmation flows |
| `MethodsTable.tsx`                  | Sortable data table with checkbox selection, memoized `MethodRow`, sort icons, empty/loading states, and per-row action dropdown (edit/trash or restore/permanent-delete) |
| `MethodFormDialog.tsx`              | Dialog for create/edit -- fields: name (required), fee (required, number), description (optional), isActive (checkbox), sortOrder (number). Resets form state on open based on `editingMethod` |
| `BulkActionsBar.tsx`                | Conditional action buttons (trash/restore/permanent-delete) that appear when rows are selected, plus two `AlertDialog` confirmation modals for bulk delete and bulk restore |
| `hooks/useShippingMethods.ts`       | All data fetching, state management, and API calls. Manages: methods list, pagination, search, sort, selection, trash toggle, CRUD operations, and bulk actions |

## Data Flow

```
ShippingMethodsContainer
  ├── useShippingMethods() hook  ──>  GET  /api/v1/admin/settings/shipping-methods
  ├── MethodsTable                    (renders data, emits sort/edit/delete/restore/selection events)
  ├── MethodFormDialog                POST /api/v1/admin/settings/shipping-methods     (create)
  │                                   PUT  /api/v1/admin/settings/shipping-methods/:id (update)
  ├── BulkActionsBar                  (loops over selected IDs, calls individual endpoints)
  └── AlertDialog (x2)               (single-item soft-delete and permanent-delete confirmations)
```

## API Endpoints Consumed

All requests go through the admin Vite proxy to the API worker.

| Method   | Path                                              | Action                              |
|----------|---------------------------------------------------|-------------------------------------|
| `GET`    | `/api/v1/admin/settings/shipping-methods`         | List (paginated, searchable, sortable, trash filter) |
| `POST`   | `/api/v1/admin/settings/shipping-methods`         | Create new method                   |
| `GET`    | `/api/v1/admin/settings/shipping-methods/:id`     | Get single method                   |
| `PUT`    | `/api/v1/admin/settings/shipping-methods/:id`     | Update method                       |
| `DELETE` | `/api/v1/admin/settings/shipping-methods/:id`     | Soft-delete (sets `deletedAt`)      |
| `POST`   | `/api/v1/admin/settings/shipping-methods/:id/restore` | Restore soft-deleted method     |
| `DELETE` | `/api/v1/admin/settings/shipping-methods/:id/permanent-delete` | Hard delete from DB     |

## Shipping Method Schema

From `packages/database/src/schema/system.ts` -- `shipping_methods` table:

| Column       | Type      | Default  | Notes                                 |
|--------------|-----------|----------|---------------------------------------|
| `id`         | text PK   |          | Format: `sm_` + nanoid                |
| `name`       | text      |          | Required, unique                      |
| `fee`        | real      | 0        | Shipping cost (displayed with currency symbol from `useCurrency()` hook) |
| `description`| text      | null     | Optional, max 255 chars               |
| `is_active`  | boolean   | true     | Whether method appears on storefront  |
| `sort_order` | integer   | 0        | Display ordering                      |
| `created_at` | timestamp | now      |                                       |
| `updated_at` | timestamp | now      |                                       |
| `deleted_at` | timestamp | null     | Soft-delete marker                    |

Index: `deleted_at`

## Storefront Public Endpoint

A separate public route exists for storefront consumption:

| Method | Path                     | Notes                                                              |
|--------|--------------------------|--------------------------------------------------------------------|
| `GET`  | `/api/v1/shipping-methods` | Returns active, non-deleted methods ordered by `sortOrder` then `name`. Cached 5 minutes via `cacheMiddleware`. |

This endpoint is defined in `apps/api/src/routes/shipping-methods.ts` and is independent of the admin CRUD routes.

## Hook Details (`useShippingMethods`)

The hook manages all state and side effects:

- **URL sync**: reads `search`, `sort`, `order`, `trashed` from URL params on mount; pushes state changes back to URL via `history.pushState()`
- **Envelope unwrap**: handles `{ success, data }` envelope from API proxy (`json.data ?? json`)
- **Bulk operations**: iterates selected IDs sequentially (no batch endpoint), reports partial success/failure counts via toast
- **Selection state**: `selectAllCheckedState` returns `true`, `false`, or `"indeterminate"` based on current selection vs. page items

## Sorting

Table supports sorting by: `name`, `fee`, `isActive`, `sortOrder`, `createdAt`, `updatedAt`. Sort is sent as query params to the API, which applies ordering via Drizzle ORM. Toggle between `asc`/`desc` by clicking the same column header.

## Known Gaps

- **No bulk API endpoint** -- bulk trash/delete/restore loops over individual endpoints sequentially, which could be slow with many selections
- **Name uniqueness check in update is inverted** -- the admin shipping API update handler checks for a method with the same name AND the same ID (should exclude the current ID), so the duplicate name check during update may not catch actual conflicts
- **No optimistic locking** -- shipping method updates do not use version checking, so concurrent edits overwrite silently
- **Form validation is minimal** -- relies on HTML `required` attribute and Zod on the API side; no client-side error display for API validation failures beyond toast
