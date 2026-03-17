# Phase 3: Deep-Read Findings

**Date:** 2026-03-17
**Purpose:** Line-by-line analysis corrections to the implementation plan, based on 6 parallel deep-read agents covering all 18 target components, Wave 2/3 files, and core services.

## Plan Corrections Required

### Toast Migration — Actual Scope

**29 files use old useToast pattern** (import from `@/hooks/use-toast` or `@/components/ui/use-toast`):

Wave 1 Agent 1 files (migrate during split):
1. `CategoryList.tsx`
2. `ProductList.tsx`

Wave 1 Agent 2 files (migrate during split):
3. `OrderList.tsx`
4. `CustomerList.tsx`
5. `DiscountList.tsx`
6. `AmountOffProductsForm.tsx`

Wave 1 Agent 3 files (migrate during split):
7. `CheckoutLanguagesManager.tsx`
8. `ShippingMethodsManager.tsx`

Wave 1 Agent 4 files (migrate during split):
9. `HeroSliderManager.tsx`

Already using sonner (NO migration needed):
- AccountSettings.tsx, DeliveryLocationsManager.tsx, DeliveryProviderSettings.tsx
- PaymentGatewaysManager.tsx, MetaConversionsManager.tsx, WidgetForm.tsx
- DeliveryShipmentManager.tsx, use-shipment-status.ts, CollectionForm.tsx

Wave 2 Agent 5 files (remaining 20):
10. `orderview/OrderStatusCard.tsx`
11. `orderview/ShipmentCard.tsx`
12. `orderview/PaymentCard.tsx`
13. `discount/FreeShippingForm.tsx`
14. `discount/AmountOffOrderForm.tsx`
15. `order-list/BulkShipDialog.tsx`
16. `order-list/OrderItemsPopover.tsx`
17. `order-list/FraudCheckIndicator.tsx`
18. `widget-list/WidgetsList.tsx`
19. `widget-list/hooks/useBulkActions.ts`
20. `widget-list/hooks/useWidgetActions.ts`
21. `product-form/ProductImagesSection.tsx`
22. `product-form/hooks/useProductSubmit.ts`
23. `product-form/variants/VariantSortModal.tsx`
24. `product-form/variants/hooks/useVariantOperations.ts`
25. `header-builder/HeaderBuilder.tsx`
26. `footer-builder/FooterBuilder.tsx`
27. `StorefrontUrlBuilder.tsx`
28. `SeoSettingsBuilder.tsx`
29. `SecuritySettingsBuilder.tsx`

Special case:
- `AnalyticsList.tsx` uses `alert()` not useToast — migrate to sonner

## Component Split Blueprints (Corrected)

### CategoryList (1,438 lines)
- **Data**: Props from Astro + client-side `fetch()` to `/api/v1/admin/categories`
- **State**: 180+ lines (11 useState, 6 useEffect, 19 useCallback, 3 useMemo)
- **Inline components**: YES — `StatCard` (lines 774-819) — Vercel HIGH violation
- **Toast**: useToast from `@/hooks/use-toast`
- **Any types**: 2 (`(c: any)` line 187, `(p: any)` line 542)
- **Split**: Container + CategoryTable + CategoryHeader + CategoryToolbar + CategoryPagination + useCategoryList hook
- **Shared pattern**: StatCard is identical in CategoryList and ProductList — extract once, share

### ProductList (1,386 lines)
- **Data**: Props from Astro + client-side `fetch()` to `/api/v1/admin/products`
- **State**: 170+ lines (similar structure to CategoryList)
- **Inline components**: YES — `StatCard` (lines 118-144) + `ProductRow` (lines 146-334, memoized)
- **Toast**: useToast from `@/hooks/use-toast`
- **Schema imports**: `ProductListItem` from `@scalius/core/modules/products`
- **Any types**: 3 (`(p: any)` line 416, `error: any` lines 687, 774)
- **Split**: Container + ProductTable + ProductRow (extract to file) + ProductHeader + ProductToolbar + ProductPagination + useProductList hook

### CollectionForm (653 lines)
- **Data**: Props from Astro (categories, products, defaultValues, isEdit) + form submission
- **State**: 40+ lines (lightweight — useForm + 3 useState)
- **Inline components**: NO
- **Toast**: Already uses sonner directly — NO MIGRATION NEEDED
- **Any types**: 0
- **Split**: Container + ProductSelectionSection + CollectionTypeSection + LayoutSettingsSection

### BulkVariantGenerator (706 lines)
- **Data**: Props only (existingVariants, onGenerate callback) — no API calls
- **State**: 60+ lines (13 useState, useMemo for preview)
- **Inline components**: NO (but code duplication between sizes/colors sections)
- **Toast**: None
- **Any types**: 0
- **Split**: Dialog + VariantAttributeInput (reusable for sizes AND colors) + VariantPreviewTable + VariantConfigSection

### OrderList (822 lines)
- **Data**: Props from Astro + client-side `fetch()` to `/api/v1/admin/orders`
- **State**: 110+ lines (18 useState, 5 useRef, 18 useCallback, 6 useEffect)
- **ALREADY HAS 5 sub-components** in `order-list/` directory (OrderTable, OrderListToolbar, OrderListPagination, BulkShipDialog, DeleteOrderDialog)
- **Toast**: useToast from `@/hooks/use-toast`
- **Any types**: 5 (`Record<string, any>` line 62, `(data: any)` line 156, etc.)
- **Split**: Refactor into OrderListContainer + extract useOrderListState hook + useOrderListApi hook. DO NOT recreate existing sub-components.

### CustomerList (960 lines)
- **Data**: Props from Astro + client-side `fetch()` to `/api/v1/admin/customers`
- **State**: 130+ lines (11 useState, 3 useRef, 8 useCallback, 8 useEffect)
- **Inline components**: YES — dropdown menu, renderEmptyState(), inline alerts
- **Toast**: useToast from `@/hooks/use-toast`
- **Any types**: 4 (`(c: any)` lines 186-190)
- **Split**: Container + CustomerTable + DeleteCustomerDialog + useCustomerListState hook + useCustomerListActions hook

### DiscountList (1,367 lines)
- **Data**: Props from Astro. Client handlers use `navigateTo()` for SSR reload — NO CLIENT-SIDE FETCH
- **State**: 70 lines (9 useState, 3 useEffect, 6 useCallback)
- **Inline components**: YES — `DiscountRow` (memoized, lines 157-466) — 309 lines
- **Toast**: useToast from `@/hooks/use-toast`
- **Any types**: 2 (response parsing, loader)
- **Split**: Container + extract DiscountRow to file + DiscountStatusBadge + DiscountDeleteDialogs + useDiscountListFilters hook. PRESERVE navigateTo() SSR pattern.

### AmountOffProductsForm (905 lines)
- **Data**: Props from Astro (defaultValues, selectedProducts, selectedCollections) + form submission
- **State**: 80 lines (useForm + 4 useState + 2 useEffect)
- **Inline components**: NO
- **Toast**: useToast from `@/hooks/use-toast`
- **Any types**: 0 (well-typed with Zod)
- **Split**: Container + 8 section components (DiscountDetails, AppliesTo, MinRequirements, UsageLimits, Combinations, ActiveDates, Summary, Actions)

### AccountSettings (1,419 lines)
- **Data**: Props (user) + direct `fetch()` to auth endpoints
- **State**: 35+ across 4 inline sub-functions
- **Inline components**: YES — 4 sub-functions (ProfileHeaderCard, ChangePasswordSection, TwoFactorSection, AdminUsersSection)
- **Toast**: Already uses **sonner** — NO MIGRATION NEEDED
- **Reload**: Line 203 — window.location.reload() after profile update
- **Any types**: 0
- **Split**: Container (tabs only) + ProfileHeader + ChangePasswordForm + TwoFactorSetup + AdminUsersManager + useAdminUsers hook

### CheckoutLanguagesManager (1,392 lines)
- **Data**: Client-only, `fetch()` to `/api/v1/admin/settings/checkout/languages`
- **State**: 90+ lines (15+ useState, useRef)
- **Inline components**: NO
- **Toast**: useToast from `@/hooks/use-toast`
- **Schema imports**: `CheckoutLanguage` from `@scalius/database/schema`
- **Any types**: 8+ (error handlers + API response parsing)
- **Split**: Container + LanguagesTable + LanguageFormDialog + LanguageActionsDialog + useLanguages hook

### ShippingMethodsManager (1,270 lines)
- **Data**: Client-only, `fetch()` to `/api/v1/admin/settings/shipping/methods`
- **State**: 80+ lines (17+ useState)
- **Inline components**: NO
- **Toast**: useToast from `@/hooks/use-toast`
- **Any types**: 2 (error handlers)
- **Split**: Container + MethodsTable + MethodFormDialog + BulkActionsDialog + useShippingMethods hook

### PaymentGatewaysManager (510 lines)
- **Data**: Client-only, lazy-loads gateway credentials on accordion expand
- **State**: 35+ lines (20+ useState)
- **Inline components**: YES — 12 inline components (StripeLogo, SSLCommerzLogo, PolarLogo, CODLogo, PasswordInput, LiveWarning, SaveBtn, SandboxToggle, ExtLink, StripeForm, SSLForm, PolarForm, PolarSetupGuide)
- **Toast**: Already uses **sonner** — NO MIGRATION NEEDED
- **StripeSettingsForm + SSLCommerzSettingsForm already exist** as separate files
- **Any types**: 1 (`as any` line 260)
- **Split**: Extract PolarSettingsForm + PaymentGatewayCard + GatewayLogos + utility components (PasswordInput, LiveWarning, SaveBtn, SandboxToggle, ExtLink)

### MetaConversionsManager (835 lines)
- **Data**: SSR props (initialSettings) + fallback client fetch
- **State**: 50+ lines (14+ useState, 3 useEffect)
- **Inline components**: YES — StatusBadge, Pagination (80 lines), LogDetails
- **Toast**: Already uses **sonner** — NO MIGRATION NEEDED
- **Schema imports**: `MetaConversionsSettings, MetaConversionsLog` from `@scalius/database/schema`
- **Any types**: 2 (`safeJsonParse` returns any, dual envelope at line 372)
- **BUG**: Line 372 `data.data || data` — dual envelope handling suggests uncertainty about proxy
- **Split**: Container + MetaConversionsSettingsForm + MetaConversionsLogs + LogTable + LogDetails + Pagination + StatusBadge + useMetaConversionsSettings hook + useMetaConversionsLogs hook

### DeliveryLocationsManager (1,419 lines)
- **Data**: Self-contained, client-only `fetch()` — no Astro loader
- **State**: 360 lines (23 useState, 4 useCallback, 4 useEffect, 1 useRef)
- **Inline components**: YES — LocationsTable already extracted (272 lines)
- **Toast**: Already uses **sonner** — NO MIGRATION NEEDED
- **Any types**: 3 (`Record<string, any>` line 64, `err: any` line 214, `p: any` line 148)
- **Split**: Container + LocationFormDialog + DeleteConfirmationDialogs + PathaoImportPanel

### DeliveryProviderSettings (1,132 lines)
- **Data**: SSR props from loader + client-side mutations
- **State**: 250 lines (13 useState)
- **Inline components**: YES — ProviderIcon (50 lines)
- **Toast**: Already uses **sonner** — NO MIGRATION NEEDED
- **Schema imports**: `DeliveryProviderRecord, DeliveryProviderType` from `@scalius/database/schema`
- **Any types**: 3 (`credentials: any`, `config: any`, `fallback: any`)
- **Split**: Container + ProviderListSidebar + ProviderDetailPanel

### HeroSliderManager (662 lines)
- **Data**: Self-contained, client-only `fetch()` — no Astro loader
- **State**: 120 lines (5 useState, custom useDebouncedCallback hook)
- **Inline components**: YES — SortableSlide (113 lines), SlideOverlay (39 lines), useDebouncedCallback (20 lines)
- **Toast**: useToast from `@/hooks/use-toast`
- **Math.random()**: Line 393 — confirmed
- **Any types**: 0
- **Split**: Container + SliderTab + SortableSlide + SlideOverlay + helpers (with crypto.randomUUID) + extract useDebouncedCallback to shared hooks

### VariantManager (520 lines)
- **Data**: SSR props (variants) + useVariantOperations hook for CRUD
- **State**: 250 lines (12 useState, useMemo, useEffect)
- **ALREADY well-split**: 11 sibling files (VariantTable, VariantFormRow, VariantDisplayRow, VariantActionsToolbar, VariantSortModal, BulkVariantGenerator, VariantImportExport, hooks/, utils/)
- **Toast**: None directly (delegated to useVariantOperations which uses useToast)
- **Any types**: 2 (`Record<string, any>` line 68, `any` in hook line 181)
- **Split**: Only extract VariantStatsDisplay + VariantDeleteDialogs. Minimal work.

### tiptap-editor (953 lines) — Wave 3
- **Structure**: ToolbarButton (35 lines) + MenuBar (588 lines!) + TiptapEditor (269 lines)
- **MenuBar breakdown**: Link/Image/Video popovers + alignment/heading/lists + TablePopover (190 lines) + undo/redo/fullscreen
- **Toast**: None
- **Any types**: 0
- **Split**: ToolbarButton + MenuBar (with TablePopover extracted) + TiptapExtensions config + useFullscreenCSS hook + TiptapEditor core

## Schema Deduplication — Exact Matches

**pages.service.ts lines 16-32** = exact duplicate of **pages.validation.ts lines 8-25**
- Solution: Delete from service, import from validation

**widgets.service.ts lines 16-53** = exact duplicate of **widgets.validation.ts lines 9-46**
- Solution: Delete from service, import from validation

## Core Services — Test Blueprint Summary

### Orders
- State machine: 10 order statuses, CANCELLED→PENDING allowed (admin reactivation)
- createOrder: atomic (db.batch) — customer + order + items
- updateOrder: optimistic locking (version field), inventory transitions
- Inventory transitions: reserved→deducted on ship, reserved→restored on cancel

### Inventory
- CAS: stockVersion field, MAX_RETRIES=3, exponential backoff
- reserveStockBatch: atomic via db.batch, validates ALL before writing, rollback on any CAS fail
- releaseReservation: idempotent via MAX(0, ...), always succeeds
- Three pools: regular, preorder, backorder — each with different validation

### Payments
- processPaymentConfirmed: idempotent via gateway ID check + paymentStatus check
- Atomic batch: insert payment + update order + inventory deduction
- COD: recordCODCollection is idempotent (checks existing succeeded payment)
- Refund: cumulative limit enforced (totalRefunded + newRefund ≤ paidAmount)
- Full refund releases inventory, partial does NOT

### Discounts
- CRUD with soft delete/restore
- Validation at order time: minPurchaseAmount, maxUses, limitOnePerCustomer, expired check
- Queue handler Phase 1b: re-checks per-customer limit (narrows race window)
- Code uniqueness enforced (ConflictError on duplicate)
