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
        │   ├── Phone input
        │   ├── Email input
        │   ├── Shipping address textarea
        │   ├── City combobox (cascading)
        │   ├── Zone combobox (cascading, loads on city change)
        │   ├── Area combobox (cascading, loads on zone change)
        │   └── Notes textarea
        ├── OrderItemsSection
        │   ├── ItemSelection / ProductSearch (add items)
        │   └── OrderItemsTable (quantity, price, remove)
        └── SummarySection
            ├── Subtotal (computed)
            ├── Shipping charge input
            ├── Discount amount input
            ├── Total (computed)
            └── Status selector (edit mode only)
```

## Files

| File | Purpose |
|------|---------|
| `types.ts` | `Product`, `DeliveryLocation`, `OrderItem`, `OrderFormProps`, `orderFormSchema` (Zod), `OrderFormValues` type |
| `OrderFormContext.tsx` | `OrderFormProvider` + `useOrderForm()` hook. Centralizes form instance, products, locations, loading state, refs for keyboard navigation, and `handleKeyDown` for Enter-to-next-field. |
| `CustomerInfoSection.tsx` | Customer name, international phone input (react-phone-number-input, E.164 output), email, address, city/zone/area cascading selects, notes |
| `ItemSelection.tsx` | Product picker with variant selection for adding items to the order |
| `ProductSearch.tsx` | Searchable product list with variant drill-down |
| `OrderItemsSection.tsx` | Container for item selection + items table |
| `OrderItemsTable.tsx` | Editable table of order items (quantity, price per unit, remove button) |
| `SummarySection.tsx` | Shipping charge, discount, subtotal/total calculation, status selector |

## Features

- **Zod validation**: `orderFormSchema` validates all fields with clear error messages. Phone: 7-16 chars (E.164 format from PhoneInput). Name: 3-100 chars. Address: 10-500 chars. Notes: max 500 chars.
- **Cascading location selects**: City -> Zone -> Area. Each level fetches from `/api/v1/admin/settings/delivery-locations?type={type}&parentId={parentId}`. Changing city clears zone/area. Changing zone clears area.
- **Location name enrichment**: Before submission, the form resolves city/zone/area IDs to names and includes them as `cityName`, `zoneName`, `areaName` hidden fields.
- **Nanostore sync**: Items, shipping charge, and discount amount are synced to `orderStore` (nanostores) for potential cross-component access.
- **Keyboard navigation**: Enter key advances to the next field. Ctrl+Enter submits the form. Combobox triggers are opened on Enter focus.
- **International phone input**: Uses `react-phone-number-input` with country flag dropdown. Outputs E.164 format directly -- no manual sanitization needed.
- **Edit mode**: Loads existing order data, includes status selector, uses PUT method.
- **Create mode**: Generates order ID via `generateOrderId()`, uses POST method, defaults status to `pending`.

## Data Flow

### Create Order

1. Astro page `orders/new.astro` calls `getOrderFormProducts()` loader
2. Loader fetches all products with variants from `/api/v1/admin/products`
3. `OrderForm` renders with empty defaults and product catalog
4. On submit: POST to `/api/v1/admin/orders` with enriched form values
5. On success: navigates to `/admin/orders`

### Edit Order

1. Astro page `orders/[id]/edit.astro` calls `getOrderEditData(id)` loader
2. Loader fetches from `/api/v1/admin/orders/:id/form-data` which returns order + all products with variants
3. `OrderForm` renders with pre-filled values
4. On submit: PUT to `/api/v1/admin/orders/:id`
5. On success: navigates to `/admin/orders`

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

**Note:** The form-level `orderFormSchema` in `types.ts` is separate from `createOrderSchema` in `@scalius/core/modules/orders/orders.validation.ts`. Both now accept E.164 format phone numbers (7-16 chars). The `react-phone-number-input` component outputs E.164 directly, so no manual sanitization is needed.

## State Management

- **react-hook-form**: Main form state with Zod resolver
- **OrderFormContext**: Shared via React context (form, products, locations, refs)
- **Nanostores** (`orderStore.ts`): `orderItems`, `shippingCharge`, `discountAmount`, `orderCalculations` atoms for cross-component reactivity

## Dependencies

- `react-hook-form` + `@hookform/resolvers/zod` -- form state and validation
- `zod` -- schema validation
- `react-phone-number-input` -- international phone input with country flag dropdown (E.164 output)
- `sonner` -- toast notifications
- `nanostores` -- `orderStore` for item/pricing atoms
- `@scalius/shared/order-utils` -- `generateOrderId()`
- `@/components/ui/*` -- shadcn/ui primitives
- `@/lib/client/navigate` -- `navigateTo()` for client-side navigation
- `@/components/admin/FormStickyHeader` -- shared sticky header component
