# Admin Discount Components

React components for the admin discount management UI. Supports creating, editing, listing, and managing three discount types: Amount Off Products, Amount Off Order, and Free Shipping.

## Architecture

The discount creation flow uses a two-phase UI pattern:

1. **Type Selection**: `DiscountTypeSelector` renders three cards. On click, it dispatches a `discountTypeSelected` CustomEvent.
2. **Form Loading**: `discount-form-loader.ts` (in `apps/admin/src/lib/client/`) listens for the event and lazy-loads the appropriate form component via dynamic `import()` + `ReactDOM.createRoot()`.

The edit flow (`[id]/edit.astro`) skips the type selector and renders the correct form directly based on `discount.type` from the server loader.

## Files

```
discount/
  DiscountTypeSelector.tsx          -- Type selection cards (new page)
  AmountOffOrderForm.tsx            -- Full form for order-level discounts
  FreeShippingForm.tsx              -- Full form for free shipping discounts
  ProductSelector.tsx               -- Paginated product picker (shared)
  CollectionSelector.tsx            -- Collection picker (shared)
  utils.ts                          -- generateDiscountCode() shared helper
  shared-validation.ts              -- Shared Zod schemas: discountCodeSchema, sharedDiscountFields, refineEndDateAfterStart()
  amount-off-products/
    index.ts                        -- Re-exports AmountOffProductsContainer as AmountOffProductsForm
    types.ts                        -- Zod schema, TS interfaces, helper
    AmountOffProductsContainer.tsx  -- Main form container
    DiscountDetailsSection.tsx      -- Code + value type + value inputs
    AppliesToSection.tsx            -- Product/collection selection
    MinimumRequirementsSection.tsx  -- Min purchase + min quantity
    UsageLimitsSection.tsx          -- Max uses + per-customer limit
    CombinationsSection.tsx         -- Combine-with checkboxes
    ActiveDatesSection.tsx          -- Start/end date pickers
    SummaryCard.tsx                 -- Live preview card
  discount-list/
    index.ts                        -- Re-exports DiscountListContainer as DiscountList
    DiscountListContainer.tsx       -- Main list with table, search, filters, pagination
    DiscountRow.tsx                 -- Individual table row with actions
    DiscountStatusBadge.tsx         -- Status display with toggle
    DiscountDeleteDialogs.tsx       -- Confirmation dialogs for delete operations
    hooks/
      useDiscountListFilters.ts     -- State + action management hook
```

## Shared Validation (`shared-validation.ts`)

Consolidates validation rules shared across all three discount form types:

- `discountCodeSchema` -- 3-50 chars, alphanumeric + underscores + hyphens
- `sharedDiscountFields` -- minPurchaseAmount, maxUsesPerOrder, maxUses, limitOnePerCustomer, startDate, endDate, isActive
- `refineEndDateAfterStart()` -- cross-field refinement ensuring endDate >= startDate

## Component Map

### Top-Level Forms

| Component | File | Discount Type | Value Types |
|-----------|------|--------------|-------------|
| `AmountOffProductsForm` | `amount-off-products/` (9 files) | `amount_off_products` | percentage, fixed_amount |
| `AmountOffOrderForm` | `AmountOffOrderForm.tsx` | `amount_off_order` | percentage, fixed_amount |
| `FreeShippingForm` | `FreeShippingForm.tsx` | `free_shipping` | Always `free` (hardcoded) |

### Shared Components

| Component | File | Description |
|-----------|------|-------------|
| `ProductSelector` | `ProductSelector.tsx` | Searchable, paginated product picker with badge display. Uses `useCurrency()` for dynamic currency symbol. |
| `CollectionSelector` | `CollectionSelector.tsx` | Searchable collection picker with badge display. |
| `DiscountTypeSelector` | `DiscountTypeSelector.tsx` | Card-based type picker. Emits `discountTypeSelected` CustomEvent. |
| `utils.ts` | `utils.ts` | `generateDiscountCode()` -- 8-character random uppercase alphanumeric, excluding ambiguous characters (0, O, 1, I). |

### Discount List Components

| Component | File | Description |
|-----------|------|-------------|
| `DiscountListContainer` | `DiscountListContainer.tsx` | Full list page: search, type filter, sortable table, pagination, bulk actions. Exported as `DiscountList`. |
| `DiscountRow` | `DiscountRow.tsx` | Table row with code, type badge, value, dates, usage progress bar, total discount amount, status, action dropdown. Uses `useCurrency()`. |
| `DiscountStatusBadge` | `DiscountStatusBadge.tsx` | Five states: Active (green), Inactive (outline), Scheduled (amber), Expired (gray), Deleted. Active/Inactive are clickable toggles. |
| `DiscountDeleteDialogs` | `DiscountDeleteDialogs.tsx` | Three AlertDialog variants: soft-delete, permanent delete, bulk action. |
| `useDiscountListFilters` | `hooks/useDiscountListFilters.ts` | State management hook for list: search, sort, pagination, selection, type filter, CRUD actions. URL-driven (SSR pattern via `navigateTo`). |

## Data Flow

### Create Flow
1. User selects type on `/admin/discounts/new`
2. Form lazy-loaded via `discount-form-loader.ts`
3. User fills form, submits
4. `POST /api/v1/admin/discounts` with payload including `type` field
5. On success, navigates to `/admin/discounts`

### Edit Flow
1. `[id]/edit.astro` calls `getDiscountEditData(id)` loader
2. Loader fetches discount and form options
3. Correct form component rendered based on `discount.type`
4. On submit, `PUT /api/v1/admin/discounts/{id}`

### List Flow
1. `index.astro` calls `getDiscountsIndexData()` loader with URL search params
2. `DiscountListContainer` renders with SSR data
3. Client-side interactions navigate via `navigateTo()` for SSR re-render
4. Inline actions (delete, restore, toggle status) use direct fetch with optimistic UI

## API Endpoints Used

| Endpoint | Method | Used By |
|----------|--------|---------|
| `/api/v1/admin/discounts` | GET | List page loader |
| `/api/v1/admin/discounts` | POST | Create forms |
| `/api/v1/admin/discounts/{id}` | GET | Edit page loader |
| `/api/v1/admin/discounts/{id}` | PUT | Edit forms |
| `/api/v1/admin/discounts/{id}` | DELETE | Soft-delete |
| `/api/v1/admin/discounts/{id}/permanent` | DELETE | Permanent delete (trash view) |
| `/api/v1/admin/discounts/{id}/restore` | POST | Restore (trash view) |
| `/api/v1/admin/discounts/{id}/toggle-status` | POST | Status badge toggle |
| `/api/v1/admin/discounts/bulk-delete` | POST | Bulk selection action |
| `/api/v1/admin/discounts/bulk-restore` | POST | Bulk restore (trash view) |
| `/api/v1/admin/products` | GET | ProductSelector search |
| `/api/v1/admin/collections` | GET | CollectionSelector |

## Known Gaps

1. **Duplicate button navigates but no dedup logic**: The "Duplicate" action navigates to `/admin/discounts/{id}/edit?duplicate=true`, but the edit page does not read the `duplicate` query parameter.
2. **Code uniqueness not validated client-side**: Only checked server-side on submit.
3. **No time-of-day selection**: Start/end dates are date-only (no time picker). Stores as unix timestamps but the UI always uses midnight.
