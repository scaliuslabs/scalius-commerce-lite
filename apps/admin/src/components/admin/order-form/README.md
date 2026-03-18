# Order Form Components

Admin order creation and editing form: customer info, location cascading selects, product/variant item selection, pricing summary, and keyboard navigation.

## Component Tree

```
OrderForm (main component)
├── FormStickyHeader (save/cancel bar, Ctrl+Enter support)
└── Form (react-hook-form wrapper)
    └── OrderFormProvider (context provider for all child components)
        ├── CustomerInfoSection
        │   ├── Customer name input
        │   ├── Phone input (react-phone-number-input, E.164 output, country-restricted)
        │   ├── Email input
        │   ├── Shipping address textarea
        │   ├── City combobox (cascading)
        │   ├── Zone combobox (cascading, loads on city change)
        │   ├── Area combobox (cascading, loads on zone change)
        │   └── Notes textarea
        ├── OrderItemsSection
        │   ├── ProductSearch (searchable product popover with pagination)
        │   ├── ItemSelection (variant select, quantity input, add button)
        │   └── OrderItemsTable (product/variant/qty/price/total/remove)
        └── SummarySection
            ├── Shipping charge input
            ├── Discount amount input
            ├── Subtotal / Shipping / Discount / Grand Total display (from nanostore)
            └── Status selector (edit mode only, all OrderStatus values)
```

## Files

| File | Purpose |
|------|---------|
| `types.ts` | `Product`, `DeliveryLocation`, `OrderItem`, `OrderFormProps`, `orderFormSchema` (Zod), `OrderFormValues` type |
| `OrderFormContext.tsx` | `OrderFormProvider` + `useOrderForm()` hook. Centralizes form instance, products, locations, loading state, refs for keyboard navigation, and `handleKeyDown` for Enter-to-next-field. |
| `CustomerInfoSection.tsx` | Customer name, international phone input (`react-phone-number-input` with country flag dropdown, fetches allowed countries from `/api/v1/admin/settings/allowed-countries`, supports include/exclude modes), email, address, city/zone/area cascading selects, notes |
| `ItemSelection.tsx` | Variant selection dropdown (shows stock count and discounted price per variant), quantity input, add item button. Uses `useCurrency()` hook for currency symbol. |
| `ProductSearch.tsx` | Searchable product popover with "Load More" pagination (20 per page). Shows product name, price, discount badge, variant count. Client-side filtering. |
| `OrderItemsSection.tsx` | Container for product search + item selection + items table. Manages selected product/variant/quantity state. Applies product discount percentage to calculate item price before adding. Syncs items to nanostore via `updateOrderItems()`. |
| `OrderItemsTable.tsx` | Table of current order items showing product name, variant label (size/color), quantity, unit price, line total, remove button. Empty state with shopping bag icon. Uses `useCurrency()` for symbol. |
| `SummarySection.tsx` | Shipping charge input, discount amount input ("Applied on top of any item-specific discounts"), subtotal/shipping/discount/total summary panel (reads from `orderCalculations` nanostore). Edit mode renders status selector with all `OrderStatus` enum values. |

## Features

- **Zod validation**: `orderFormSchema` validates all fields with clear error messages. Phone: 7-16 chars (E.164 format from PhoneInput). Name: 3-100 chars. Address: 10-500 chars. Notes: max 500 chars.
- **Cascading location selects**: City -> Zone -> Area. Each level fetches from `/api/v1/admin/settings/delivery-locations?type={type}&parentId={parentId}`. Changing city clears zone/area. Changing zone clears area.
- **Location name enrichment**: Before submission, the form resolves city/zone/area IDs to names and includes them as `cityName`, `zoneName`, `areaName` hidden fields.
- **Nanostore sync**: Items, shipping charge, and discount amount are synced to `orderStore` (nanostores) for cross-component reactivity. The `SummarySection` reads from `orderCalculations` computed store.
- **Keyboard navigation**: Enter key advances to the next field via centralized refs in `OrderFormContext`. Ctrl+Enter submits the form. Combobox triggers are opened on Enter/ArrowDown. Escape closes popovers and returns focus to trigger.
- **International phone input**: Uses `react-phone-number-input` with country flag dropdown. Fetches allowed countries from API on mount (supports `include`/`exclude` modes). Outputs E.164 format directly -- no manual sanitization needed. Default country: first allowed or `BD`.
- **Product discount handling**: When adding an item, if the product has a `discountPercentage`, the price is reduced before insertion. This is a percentage-based discount only at the form level.
- **Edit mode**: Loads existing order data, includes status selector (renders all `OrderStatus` enum values), uses PUT method.
- **Create mode**: Generates order ID via `generateOrderId()`, uses POST method, defaults status to `pending`.

## Data Flow

### Create Order

1. Astro page `orders/new.astro` calls `getOrderFormProducts()` loader
2. Loader fetches all products with variants from `/api/v1/admin/products` (then detail per product)
3. `OrderForm` renders with empty defaults and product catalog
4. On submit: POST to `/api/v1/admin/orders` with enriched form values
5. Backend reserves then deducts inventory (see Orders README)
6. On success: navigates to `/admin/orders`

### Edit Order

1. Astro page `orders/[id]/edit.astro` calls `getOrderEditData(id)` loader
2. Loader fetches from `/api/v1/admin/orders/:id/form-data` which returns order + all products with variants
3. `OrderForm` renders with pre-filled values
4. On submit: PUT to `/api/v1/admin/orders/:id`
5. Backend adjusts inventory based on item changes and status transitions
6. On success: navigates to `/admin/orders`

## Validation Schema

```
orderFormSchema = {
  id: string (optional),
  customerName: string, 3-100 chars,
  customerPhone: string, 7-16 chars (E.164 format),
  customerEmail: email | null,
  shippingAddress: string, 10-500 chars,
  city: string, required,
  zone: string, required,
  area: string | null,
  cityName: string (optional, hidden),
  zoneName: string (optional, hidden),
  areaName: string | null (optional, hidden),
  notes: string, max 500 | null,
  items: [{ productId, variantId | null, quantity >= 1, price >= 0 }],
  discountAmount: number >= 0 | null (coerced),
  shippingCharge: number >= 0 (coerced),
  status: string (optional, edit mode only),
}
```

**Note:** The form-level `orderFormSchema` in `types.ts` is separate from `createOrderSchema` in `@scalius/core/modules/orders/orders.validation.ts`. Both accept E.164 format phone numbers. The `react-phone-number-input` component outputs E.164 directly, so no manual sanitization is needed.

## State Management

- **react-hook-form**: Main form state with Zod resolver
- **OrderFormContext**: Shared via React context (form, products, locations, loading state, refs, handleKeyDown, isEdit, isSubmitting)
- **Nanostores** (`orderStore.ts`): `orderItems`, `shippingCharge`, `discountAmount` atoms + `orderCalculations` computed map for cross-component reactivity

## Dependencies

- `react-hook-form` + `@hookform/resolvers/zod` -- form state and validation
- `zod` -- schema validation
- `react-phone-number-input` -- international phone input with country flag dropdown (E.164 output)
- `sonner` -- toast notifications
- `nanostores` + `@nanostores/react` -- `orderStore` for item/pricing atoms
- `@scalius/shared/order-utils` -- `generateOrderId()`
- `@/hooks/useCurrency` -- currency symbol for price formatting
- `@/components/ui/*` -- shadcn/ui primitives (Card, Form, Input, Textarea, Select, Popover, Command, Button, Badge, Table)
- `@/lib/client/navigate` -- `navigateTo()` for client-side navigation
- `@/components/admin/FormStickyHeader` -- shared sticky header component
- `@/types/api-responses` -- `OrderStatus` enum for status selector
