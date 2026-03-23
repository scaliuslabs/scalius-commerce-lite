# Checkout Languages Components

Admin UI for managing checkout form i18n -- language packs that control all labels, placeholders, and field visibility on the storefront checkout page.

## Files

| File | Description |
|------|-------------|
| `index.ts` | Barrel export: `CheckoutLanguagesContainer` aliased as `CheckoutLanguagesManager` |
| `CheckoutLanguagesContainer.tsx` | Top-level container with search, trash toggle, add button. Orchestrates table, form dialog, and action dialogs |
| `LanguagesTable.tsx` | Table view of languages with sortable columns, action buttons (edit, set active, soft-delete, permanent delete, restore). Handles both active and trashed views |
| `LanguageFormDialog.tsx` | Create/edit dialog with three tabs: Field Labels, Messages & Text, Field Visibility. Syncs form state via `useEffect` when `editingLanguage` prop changes |
| `LanguageActionsDialog.tsx` | Confirmation dialogs for soft-delete, permanent delete, and restore actions |
| `hooks/useLanguages.ts` | Core hook managing all state: fetch, pagination, search, sort, trash toggle, CRUD operations. Syncs URL params with state. Uses `unwrapEnvelope()` and `extractApiError()` from `@/lib/api-helpers` |

## Data Model

### `ManagerCheckoutLanguage`
```typescript
{
  id: string;
  name: string;           // e.g. "English", "Bangla"
  code: string;           // e.g. "en", "bn"
  isActive: boolean;      // only one can be active at a time
  isDefault: boolean;     // fallback language
  languageData?: Record<string, string>;   // 30+ label/placeholder strings
  fieldVisibility?: Record<string, boolean>; // showEmailField, showOrderNotesField, showAreaField
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}
```

### Default Language Data (30+ keys)
Covers all checkout form strings: pageTitle, checkoutSectionTitle, cartSectionTitle, customerNameLabel/Placeholder, customerPhoneLabel/Placeholder/Help, customerEmailLabel/Placeholder, shippingAddressLabel/Placeholder, cityLabel, zoneLabel, areaLabel, shippingMethodLabel, orderNotesLabel/Placeholder, continueShoppingText, subtotalText, shippingText, discountText, totalText, discountCodePlaceholder, applyDiscountText, removeDiscountText, placeOrderText, processingText, emptyCartText, termsText, processingOrderTitle/Message, requiredFieldIndicator.

### Default Field Visibility
```typescript
{ showEmailField: true, showOrderNotesField: true, showAreaField: true }
```

## LanguageFormDialog Details

The form dialog uses `useEffect` to sync form data when the `editingLanguage` prop changes. The `getInitialFormData()` helper merges the editing language's data with defaults:
```typescript
languageData: { ...defaultLanguageData, ...(lang.languageData || {}) }
fieldVisibility: { ...defaultFieldVisibility, ...(lang.fieldVisibility || {}) }
```

Three tabs:
1. **Field Labels**: 12 editable fields including `customerPhoneHelp` for phone number help text
2. **Messages & Text**: Page title, section title, button text, terms text
3. **Field Visibility**: Toggle switches for email, order notes, and area fields

## Behavior

- **Single active**: Setting one language as active deactivates all others (enforced by API)
- **Single default**: Setting one language as default removes default from all others (enforced by API)
- **Soft-delete**: PATCH sets `deletedAt`. Can be restored or permanently deleted
- **URL-synced state**: Search, sort, page, trashed filters are synced to URL query params via `window.history.pushState`
- **Pagination**: Server-side pagination with configurable page size

## API Endpoints Used

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/settings/checkout-languages?page=&limit=&search=&sort=&order=&trashed=` | List with pagination |
| POST | `/admin/settings/checkout-languages` | Create new language |
| PUT | `/admin/settings/checkout-languages/{id}` | Update language |
| PATCH | `/admin/settings/checkout-languages/{id}` | Soft-delete |
| DELETE | `/admin/settings/checkout-languages/{id}` | Hard-delete (204) |
| POST | `/admin/settings/checkout-languages/{id}/restore` | Restore from trash |

## Dependencies

- shadcn/ui components (Card, Input, Button, Table, Dialog, AlertDialog, Badge, Checkbox, Tabs, Switch, Label, Textarea)
- `lucide-react` for icons
- `sonner` for toast notifications
