# Product Form (Admin)

React component suite for creating and editing products in the admin dashboard. Uses react-hook-form with Zod validation, TipTap rich text editor (lazy-loaded), drag-and-drop image reordering, and a full variant management system with bulk operations.

## Features

- Two-column responsive layout: main content (title, description, images) left, settings (status, organization, pricing, SEO, attributes) right
- Sticky header with breadcrumb navigation, unsaved changes indicator, save/discard/new-product actions
- TipTap rich text editor for product description (lazy-loaded via `React.lazy`)
- Additional info sections: arbitrary titled rich content blocks with drag-and-drop reordering (dnd-kit), add/remove/collapse. Items use `{id, title, content, sortOrder}` shape matching the API and database schema.
- Product images via MediaManager with drag-and-drop reordering (DraggableImageGallery), duplicate detection
- Variant-specific image mapping: optional toggle that maps images to variant colors by position order, stored as HTML comment `<!--variant_images:enabled-->` in metaDescription
- Auto-slug generation from product name (new products only, stops when user edits slug manually)
- Category combobox with inline category creation (POST to /api/v1/admin/categories)
- Discount support: percentage (capped 0-100) or flat amount, with automatic clearing of the unused discount field on type switch
- SEO section with meta title/description fields and character counters (recommended 60/160, max 70/200)
- Product attributes: searchable combobox for adding global attributes, inline value selector with pagination and search, inline attribute creation
- Form submission via fetch to `/api/v1/admin/products` (POST for create, PUT for update), with server-side validation error mapping back to form fields
- Post-create redirect to edit page with `?new=true` query param
- Variant manager (edit mode only): full CRUD, bulk create/delete/update, import/export, duplicate, sort order modal, stats display, inline editing, bulk edit mode
- All catch blocks typed with `: unknown`
- Form `defaultValues` accepts `attributes` (`{attributeId, value}[]`) and `additionalInfo` (`{id, title, content}[]`) passed through from the loader without remapping

## Data Flow

```
ProductForm.tsx
  |-- useForm<ProductFormValues> (react-hook-form + zodResolver)
  |-- useProductSubmit hook
  |     |--> formatFormValuesForSubmission() -- cleans discount fields, adds variant images marker, serializes dates, adds sortOrder from array index
  |     |--> fetch(POST|PUT /api/v1/admin/products[/:id])
  |     |--> On success: toast + redirect (create) or reset form dirty state (edit)
  |     |--> On slug conflict: setError on slug field + alert dialog
  |
  |-- useProductVariants hook (edit mode)
  |     |--> fetch(GET /api/v1/admin/products/:id/variants)
  |     |--> Unwraps response envelope: checks json.data if present
  |     |--> Extracts unique color options for image mapping
  |     |--> Refreshes on "variantChanged" CustomEvent
  |
  |-- VariantManager (edit mode, separate Astro island)
        |--> useVariantOperations hook -- all variant API calls
        |--> Local state management with optimistic updates + rollback on failure
        |--> Dispatches "variantChanged" CustomEvent on mutations

Admin Loader (loaders/admin/products.ts)
  |-- getProductEditData(id)
  |     |--> apiGet(/products/:id) -> ProductDetail
  |     |--> Maps images: altText -> filename
  |     |--> Passes attributes and additionalInfo through as-is from API response
  |     |--> Filters out soft-deleted variants client-side
  |
  |-- getProductViewData(id)
        |--> apiGet(/products/:id) -> ProductDetail
        |--> Maps images: altText -> alt
        |--> Passes additionalInfo through as-is from API response
```

## Files

### Root

| File | Description |
|------|-------------|
| `index.ts` | Barrel exports for all components, hooks, types, and utils |
| `types.ts` | `productFormSchema` (Zod), `ProductFormValues` type, `Category` and `ProductImage` interfaces. Schema includes `attributes` (`{attributeId, value}[]`) and `additionalInfo` (`{id, title, content}[]`). Discount percentage capped at 0-100. |
| `utils.ts` | `extractUniqueColors`, `cleanMetaDescription`, `hasVariantImagesEnabled`, `addVariantImagesMarker`, `formatFormValuesForSubmission` (cleans discount fields based on type, adds sortOrder to additionalInfo from array index), `generateSlug` |

### Section Components

| File | Description |
|------|-------------|
| `TitleDescriptionSection.tsx` | Product name input + tabbed description/additional-info editor |
| `ProductImagesSection.tsx` | Collapsible image card with MediaManager, DraggableImageGallery, variant color mapping toggle |
| `PricingCard.tsx` | Base price input + discount type selector (percentage/flat) with value input |
| `StatusCard.tsx` | Active/draft toggle, free delivery toggle, storefront link (edit mode) |
| `OrganizationCard.tsx` | Category combobox (with inline create) + URL slug input (auto-generated for new) |
| `SeoSection.tsx` | Meta title + meta description with character counters, inside CollapsibleCard |
| `AttributesSection.tsx` | Wrapper around AttributeManager inside CollapsibleCard |
| `BasicInfoSection.tsx` | Exported but not used by current ProductForm layout (legacy) |
| `PricingAvailabilitySection.tsx` | Exported but not used by current ProductForm layout (legacy) |
| `AdditionalInfoSection.tsx` | Standalone additional info section (used via TitleDescriptionSection tabs) |

### Shared Components

| File | Description |
|------|-------------|
| `ProductStickyHeader.tsx` | Fixed header bar with breadcrumbs, unsaved indicator, discard/new/save buttons |
| `ProductFormActions.tsx` | Submit/cancel action buttons (exported but ProductStickyHeader is used instead) |
| `InfoBanner.tsx` | Info message banner (shown on new product page with "Next Steps" message) |
| `CollapsibleCard.tsx` | Reusable card with chevron toggle for expand/collapse |

### Manager Components

| File | Description |
|------|-------------|
| `AdditionalInfoManager.tsx` | Rich content section manager: add/remove/reorder sections with dnd-kit, each with title input + TipTap editor. Items use `item-{nanoid}` IDs for new items, preserved IDs for existing |
| `AttributeManager.tsx` | Attribute assignment manager: fetches all attributes from API, combobox for adding/creating attributes, value selector with paginated search and inline value creation |

### Hooks

| File | Description |
|------|-------------|
| `hooks/useProductSubmit.ts` | Form submission logic: formats values, POSTs/PUTs to API, handles slug conflicts, Zod errors, redirects. Catch blocks typed `: unknown`. |
| `hooks/useProductVariants.ts` | Fetches variants for edit mode, unwraps response envelope (`json.data`), extracts unique colors for image mapping, refreshes on variantChanged event. Catch blocks typed `: unknown`. |

### Variants Subsystem

| File | Description |
|------|-------------|
| `variants/index.ts` | Barrel exports for all variant components, hooks, and utils |
| `variants/types.ts` | `ProductVariant`, `variantFormSchema`, `VariantFormValues`, `BulkVariantOptions`, `BulkGeneratedVariant`, `VariantTemplate`, `CsvVariantRow`, `CsvImportResult`, `SkuTemplate`, `SKU_VARIABLES`, filter/sort types |
| `variants/VariantManager.tsx` | Main variant orchestrator: local state, filter/sort, CRUD delegation, bulk edit mode, delete confirmations, sort modal |
| `variants/VariantTable.tsx` | Table with checkbox selection, header, conditional row rendering (display/edit/bulk-edit), add-variant button |
| `variants/VariantDisplayRow.tsx` | Read-only variant row with SKU, size, color, weight, price, stock, available, discount, updated date, actions dropdown |
| `variants/VariantFormRow.tsx` | Inline edit/create form row with Zod validation, all variant fields |
| `variants/VariantBulkEditRow.tsx` | Inline bulk edit row with editable fields, tracks draft changes |
| `variants/VariantActionsToolbar.tsx` | Toolbar with search, sort selector, add/bulk-generate/import/bulk-edit/bulk-delete actions |
| `variants/VariantStatsDisplay.tsx` | Summary stats: total stock, total value, average price, low/out-of-stock counts |
| `variants/VariantDeleteDialogs.tsx` | AlertDialog confirmations for single and bulk variant deletion |
| `variants/VariantSortModal.tsx` | Modal to reorder color/size sort order (fetches/saves via API) |
| `variants/VariantTemplateSelector.tsx` | Template selection UI for variant creation |
| `variants/SkuTemplateConfig.tsx` | SKU template configuration with variable placeholders |
| `variants/VariantImportExport.tsx` | CSV import/export for variants |
| `variants/hooks/useVariantOperations.ts` | API client hook: create, update, delete, bulkDelete, bulkCreate, bulkUpdate, duplicate -- all with toast notifications and loading state |
| `variants/hooks/useVariantTemplates.ts` | Template management hook |
| `variants/utils/variantHelpers.ts` | `filterVariants`, `sortVariants`, `generateVariantCombinations`, `calculateEffectivePrice`, `getStockStatus`, `getVariantStats`, `isSkuUnique`, `hasDiscount`, `getDiscountDisplay` |
| `variants/utils/skuGenerator.ts` | SKU generation from template strings with variable substitution |
| `variants/utils/csvHelpers.ts` | CSV parsing/generation helpers for variant import/export |
| `variants/bulk-generator/BulkVariantGeneratorDialog.tsx` | Dialog for generating variant combinations from sizes x colors |
| `variants/bulk-generator/VariantAttributeInput.tsx` | Tag input for sizes/colors in bulk generator |
| `variants/bulk-generator/VariantConfigSection.tsx` | Base price/stock/weight/SKU template/discount config for bulk generator |
| `variants/bulk-generator/VariantPreviewTable.tsx` | Preview table showing generated variants before creation |
| `variants/bulk-generator/index.ts` | Barrel export for `BulkVariantGenerator` |

## Known Gaps

1. **`additionalInfo` missing `sortOrder` in form schema**: The `productFormSchema` in `types.ts` defines additionalInfo items with `id`, `title`, `content` but no `sortOrder`. The `formatFormValuesForSubmission` util adds `sortOrder` from array index at submit time (`utils.ts:94`). If items are reordered via drag-and-drop, the sortOrder is derived from position, which is correct -- but the schema doesn't validate it.

2. **`BasicInfoSection` and `PricingAvailabilitySection` are exported but unused**: These components are listed in `index.ts` but the current `ProductForm.tsx` uses `TitleDescriptionSection`, `PricingCard`, `StatusCard`, and `OrganizationCard` instead. They appear to be legacy components from a previous layout.

3. **Variant images marker in metaDescription**: The feature flag for variant-specific images is stored by appending `<!--variant_images:enabled-->` to the product's `metaDescription` field. This means the SEO field carries non-SEO data. Both admin (`cleanMetaDescription`) and storefront must strip this marker before displaying.

4. **Admin form submits directly to `/api/v1/admin/products`**: The `useProductSubmit` hook constructs the API URL as `/api/v1/admin/products/${values.id}`. In dev mode this goes through Vite proxy; in production it goes through the admin worker proxy which unwraps the response envelope. The hook checks `response.ok` but parses the response body without accounting for the `{ success, data }` envelope difference between dev and prod.

5. **Attribute value creation fires-and-forgets**: In `AttributeManager.tsx`, when creating a new attribute value, the POST call to the attributes API has an empty catch block. If the API call fails, the value is still set locally in the form but won't persist as a preset option.

## Dependencies

### This module depends on:
- `react-hook-form` + `@hookform/resolvers/zod` -- form state management
- `zod` -- validation schemas
- `sonner` -- toast notifications
- `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` -- drag-and-drop for additional info and images
- `nanoid` -- ID generation for new additional info items
- `lucide-react` -- icons
- `@scalius/shared/utils` -- `cn` utility
- `@scalius/shared/barcode-utils` -- `generateEAN13` for bulk variant barcode generation
- `@scalius/shared/image-optimizer` -- `getOptimizedImageUrl` (used in ProductView)
- Admin UI components: `@/components/ui/*` (shadcn/ui), `@/components/admin/media-manager`, `@/components/admin/DraggableImageGallery`
- `@/hooks/useCurrency` -- currency symbol
- `@/hooks/use-storefront-url` -- storefront URL generation
- `@/lib/client/navigate` -- client-side navigation

### Depends on this module:
- `apps/admin/src/components/admin/ProductForm.tsx` -- main form component
- `apps/admin/src/pages/admin/products/new.astro` -- new product page
- `apps/admin/src/pages/admin/products/[id]/edit.astro` -- edit product page (form + variant manager)
