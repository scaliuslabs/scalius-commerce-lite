# Admin Discount Components

React components for the admin discount management UI. Supports creating, editing, listing, and managing three discount types: Amount Off Products, Amount Off Order, and Free Shipping.

## Architecture

The discount creation flow uses a two-phase UI pattern:

1. **Type Selection**: `DiscountTypeSelector` renders three cards. On click, it dispatches a `discountTypeSelected` CustomEvent.
2. **Form Loading**: `discount-form-loader.ts` (in `apps/admin/src/lib/client/`) listens for the event and lazy-loads the appropriate form component via dynamic `import()` + `ReactDOM.createRoot()`.

The edit flow (`[id]/edit.astro`) skips the type selector and renders the correct form directly based on `discount.type` from the server loader.

## Component Map

### Top-Level Forms

| Component | File | Discount Type | Value Types |
|-----------|------|--------------|-------------|
| `AmountOffProductsForm` | `amount-off-products/` (7 files) | `amount_off_products` | percentage, fixed_amount |
| `AmountOffOrderForm` | `AmountOffOrderForm.tsx` | `amount_off_order` | percentage, fixed_amount |
| `FreeShippingForm` | `FreeShippingForm.tsx` | `free_shipping` | Always `free` (hardcoded) |

### Shared Components

| Component | File | Description |
|-----------|------|-------------|
| `ProductSelector` | `ProductSelector.tsx` | Searchable, paginated product picker with badge display. Fetches from `/api/v1/admin/products`. Uses `useCurrency()` for dynamic currency symbol. |
| `CollectionSelector` | `CollectionSelector.tsx` | Searchable collection picker with badge display. Initial load from `/api/v1/admin/collections?limit=50`, search from `/api/v1/admin/collections?search=...&limit=20`. |
| `DiscountTypeSelector` | `DiscountTypeSelector.tsx` | Card-based type picker. Emits `discountTypeSelected` CustomEvent with `{ type: string }` detail. |
| `utils.ts` | `utils.ts` | `generateDiscountCode()` -- generates 8-character random uppercase alphanumeric codes, excluding ambiguous characters (0, O, 1, I). Used by all three form types. |

### Amount Off Products Sub-Components

Split into card-based sections in `amount-off-products/`:

| Component | File | Description |
|-----------|------|-------------|
| `AmountOffProductsContainer` | `AmountOffProductsContainer.tsx` | Main form orchestrator. Manages selected products/collections state, form submission. |
| `DiscountDetailsSection` | `DiscountDetailsSection.tsx` | Code input with random generator (from `../utils.ts`), value type selector, discount value input. Uses `useCurrency()` for dynamic symbol. |
| `AppliesToSection` | `AppliesToSection.tsx` | Wraps ProductSelector and CollectionSelector. Validates at least one product or collection is selected. |
| `MinimumRequirementsSection` | `MinimumRequirementsSection.tsx` | Min purchase amount and min quantity inputs. |
| `UsageLimitsSection` | `UsageLimitsSection.tsx` | Max uses per order, total usage limit, one-per-customer toggle. |
| `CombinationsSection` | `CombinationsSection.tsx` | Three checkboxes for combineWith* flags. |
| `ActiveDatesSection` | `ActiveDatesSection.tsx` | Start/end date pickers with calendar popover. End date disabled before start date. |
| `SummaryCard` | `SummaryCard.tsx` | Live preview card showing current form values. Uses `useCurrency()` for dynamic symbol. |
| `types.ts` | `types.ts` | Zod schema, TypeScript interfaces (Product, Collection, FormValues), `handleOptionalNumberChange` helper. |

### Discount List Components

In `discount-list/`:

| Component | File | Description |
|-----------|------|-------------|
| `DiscountListContainer` | `DiscountListContainer.tsx` | Full list page: search, type filter, sortable table, pagination, bulk actions. Exported as `DiscountList`. |
| `DiscountRow` | `DiscountRow.tsx` | Single table row. Shows code (with tooltip summary), type badge, value, dates, usage progress bar, total discount amount, status, and action dropdown (edit, duplicate, activate/deactivate, delete). Uses `useCurrency()` for dynamic symbol. |
| `DiscountStatusBadge` | `DiscountStatusBadge.tsx` | Status badge with five states: Active (green, clickable toggle), Inactive (outline, clickable toggle), Scheduled (amber, when startDate > now), Expired (gray, when endDate < now), Deleted (in trash view). |
| `DiscountDeleteDialogs` | `DiscountDeleteDialogs.tsx` | Three AlertDialog variants: soft-delete confirmation, permanent delete confirmation, bulk action confirmation. |
| `useDiscountListFilters` | `hooks/useDiscountListFilters.ts` | State management hook for list: search, sort, pagination, selection, type filter, all CRUD actions via fetch including toggle-status. URL-driven (SSR pattern via `navigateTo`). |

## Form Validation

Each form has its own Zod schema. Key validation rules:

**AmountOffProductsForm** (`types.ts`):
- Code: min 1 char, max 50
- At least one product OR collection must be selected (enforced via `appliesTo` refine)
- discountValue: positive number
- Dates: startDate required, endDate optional

**AmountOffOrderForm**:
- Code: min 3 chars, max 50, regex `[a-zA-Z0-9_-]+`
- discountValue: positive number
- endDate must be after startDate (cross-field refine)
- Dates: startDate required (defaults to start of today), endDate optional

**FreeShippingForm**:
- Code: min 3 chars, max 50
- Hardcodes `type: "free_shipping"`, `valueType: "free"`, `discountValue: 100`
- minPurchaseAmount defaults to 1000
- Dates: startDate required, endDate optional

All forms use `useCurrency()` for dynamic currency symbol display (no hardcoded currency characters).

## Data Flow

### Create Flow
1. User selects type on `/admin/discounts/new`
2. Form lazy-loaded via `discount-form-loader.ts`
3. User fills form, submits
4. Component calls `POST /api/v1/admin/discounts` with payload including `type` field
5. On success, navigates to `/admin/discounts`

### Edit Flow
1. `[id]/edit.astro` calls `getDiscountEditData(id)` loader
2. Loader fetches discount via `apiGet("/discounts/{id}")` and form options via `apiGet("/collections/form-options")`
3. Correct form component rendered based on `discount.type`
4. On submit, component calls `PUT /api/v1/admin/discounts/{id}`
5. On success, navigates to `/admin/discounts`

### Duplicate Flow
1. User clicks "Duplicate" in discount row dropdown menu
2. Navigates to `/admin/discounts/{id}/edit?duplicate=true`
3. Edit page loads the discount data as a pre-populated form

### List Flow
1. `index.astro` calls `getDiscountsIndexData()` loader with URL search params
2. Server fetches from admin API with pagination, search, sort, trashed params
3. `DiscountListContainer` renders with SSR data
4. Client-side interactions (search, sort, page change) navigate via `navigateTo()` triggering full SSR re-render
5. Inline actions (delete, restore, toggle status) use direct fetch calls and optimistic UI updates

## API Endpoints Used

| Endpoint | Method | Used By |
|----------|--------|---------|
| `/api/v1/admin/discounts` | GET | List page loader |
| `/api/v1/admin/discounts` | POST | Create forms |
| `/api/v1/admin/discounts/{id}` | GET | Edit page loader |
| `/api/v1/admin/discounts/{id}` | PUT | Edit forms |
| `/api/v1/admin/discounts/{id}` | DELETE | List row action (soft-delete) |
| `/api/v1/admin/discounts/{id}/permanent` | DELETE | Trash view row action |
| `/api/v1/admin/discounts/{id}/restore` | POST | Trash view row action |
| `/api/v1/admin/discounts/{id}/toggle-status` | POST | Status badge click, row dropdown activate/deactivate |
| `/api/v1/admin/discounts/bulk-delete` | POST | Bulk selection action |
| `/api/v1/admin/discounts/bulk-restore` | POST | Bulk selection action (trash view) |
| `/api/v1/admin/products` | GET | ProductSelector search |
| `/api/v1/admin/collections` | GET | CollectionSelector initial load + search |
| `/api/v1/admin/collections/form-options` | GET | Edit page loader (resolves product IDs) |

## Files

```
discount/
  DiscountTypeSelector.tsx          -- Type selection cards (new page)
  AmountOffOrderForm.tsx            -- Full form for order-level discounts
  FreeShippingForm.tsx              -- Full form for free shipping discounts
  ProductSelector.tsx               -- Paginated product picker (shared)
  CollectionSelector.tsx            -- Collection picker (shared)
  utils.ts                          -- generateDiscountCode() shared helper
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

## Known Gaps

1. **Duplicate button navigates but no dedup logic**: The "Duplicate" action navigates to `/admin/discounts/{id}/edit?duplicate=true`, but the edit page does not read the `duplicate` query parameter. The form loads as a normal edit, not a duplicate (code won't be cleared, ID won't be removed).
2. **Code uniqueness not validated client-side**: Code uniqueness is only checked server-side on submit. No real-time availability check.
3. **Form schemas diverge**: The three form types have separate Zod schemas with slightly different validation rules (e.g., code min length is 1 vs 3, regex pattern only on AmountOffOrderForm). Should be unified.
4. **No time-of-day selection**: Start/end dates are date-only (no time picker). The schema stores unix timestamps, but the UI always uses midnight.
