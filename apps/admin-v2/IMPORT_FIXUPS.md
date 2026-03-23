# Import Fixups Required for admin-v2 Components

All files below were copied from `apps/admin/src/components/admin/` and contain
`@/` imports that must be adapted for TanStack Start. The `@/` alias in the old
Astro admin resolves to `apps/admin/src/`. In admin-v2, the equivalent alias is
`~/` (or a reconfigured `@/` in tsconfig paths).

---

## Priority 1 -- `@/lib/api-browser` (needs server function rewrite)

These files call the browser-side fetch wrapper directly. They must be rewritten
to use TanStack Start server functions instead.

- `src/components/admin/FraudCheckerSettings.tsx`
- `src/components/admin/widgets/WidgetForm.tsx`

## Priority 2 -- `@/lib/auth-client` (needs auth integration)

- `src/components/admin/account-settings/TwoFactorSetup.tsx`

## Priority 3 -- `@/lib/api-helpers` (81 occurrences -- bulk rewrite)

These import helper functions (`fetchApi`, `fetchPaginated`, toast wrappers,
etc.) from the old Astro admin's `lib/api-helpers`. The helpers themselves need
to be ported to admin-v2's lib directory and wired to server functions.

- `src/components/admin/AbandonedCheckoutsManager.tsx`
- `src/components/admin/account-settings/ChangePasswordForm.tsx`
- `src/components/admin/account-settings/hooks/useAdminUsers.ts`
- `src/components/admin/account-settings/ProfileHeader.tsx`
- `src/components/admin/AnalyticsForm.tsx`
- `src/components/admin/AnalyticsList.tsx`
- `src/components/admin/attributes-manager/components/AttributeValueEditor.tsx`
- `src/components/admin/attributes-manager/components/AttributeValuesViewer.tsx`
- `src/components/admin/attributes-manager/hooks/useAttributeActions.ts`
- `src/components/admin/attributes-manager/hooks/useAttributes.ts`
- `src/components/admin/attributes-manager/hooks/useBulkActions.ts`
- `src/components/admin/CacheManager.tsx`
- `src/components/admin/CacheNukeButton.tsx`
- `src/components/admin/categories/hooks/useCategoryList.ts`
- `src/components/admin/CategoryForm.tsx`
- `src/components/admin/checkout-languages/hooks/useLanguages.ts`
- `src/components/admin/collection-form/CollectionFormContainer.tsx`
- `src/components/admin/collections-list/hooks/useBulkActions.ts`
- `src/components/admin/collections-list/hooks/useCollectionActions.ts`
- `src/components/admin/collections-list/hooks/useCollections.ts`
- `src/components/admin/customer-list/hooks/useCustomerListActions.ts`
- `src/components/admin/CustomerForm.tsx`
- `src/components/admin/delivery-locations/hooks/useDeliveryLocations.ts`
- `src/components/admin/delivery-providers/DeliveryProvidersContainer.tsx`
- `src/components/admin/discount/CollectionSelector.tsx`
- `src/components/admin/discount/discount-list/hooks/useDiscountListFilters.ts`
- `src/components/admin/discount/ProductSelector.tsx`
- `src/components/admin/footer-builder/FooterBuilder.tsx`
- `src/components/admin/header-builder/HeaderBuilder.tsx`
- `src/components/admin/hero-slider/HeroSliderContainer.tsx`
- `src/components/admin/InventoryManager.tsx`
- `src/components/admin/LocationSelector.tsx`
- `src/components/admin/media-manager/api/mediaClient.ts`
- `src/components/admin/meta-conversions/hooks/useMetaConversionsLogs.ts`
- `src/components/admin/meta-conversions/hooks/useMetaConversionsSettings.ts`
- `src/components/admin/navigation/AddNavItemDialog.tsx`
- `src/components/admin/order-form/CustomerInfoSection.tsx`
- `src/components/admin/order-list/FraudCheckIndicator.tsx`
- `src/components/admin/order-list/hooks/useOrderListApi.ts`
- `src/components/admin/order-list/OrderItemsPopover.tsx`
- `src/components/admin/OrderForm.tsx`
- `src/components/admin/orderview/OrderStatusCard.tsx`
- `src/components/admin/orderview/PaymentCard.tsx`
- `src/components/admin/orderview/ShipmentCard.tsx`
- `src/components/admin/PageForm.tsx`
- `src/components/admin/pages-list/hooks/useBulkActions.ts`
- `src/components/admin/pages-list/hooks/usePageActions.ts`
- `src/components/admin/pages-list/hooks/usePages.ts`
- `src/components/admin/product-form/AttributeManager.tsx`
- `src/components/admin/product-form/hooks/useProductSubmit.ts`
- `src/components/admin/product-form/hooks/useProductVariants.ts`
- `src/components/admin/product-form/OrganizationCard.tsx`
- `src/components/admin/product-form/variants/hooks/useVariantOperations.ts`
- `src/components/admin/product-form/variants/VariantSortModal.tsx`
- `src/components/admin/product-list/hooks/useProductList.ts`
- `src/components/admin/RolesManagement.tsx`
- `src/components/admin/scanner/ScannerApp.tsx`
- `src/components/admin/SecuritySettingsBuilder.tsx`
- `src/components/admin/SeoSettingsBuilder.tsx`
- `src/components/admin/settings/AllowedCountriesBuilder.tsx`
- `src/components/admin/settings/AuthSettingsBuilder.tsx`
- `src/components/admin/settings/BusinessSettingsBuilder.tsx`
- `src/components/admin/settings/CheckoutFlowSettings.tsx`
- `src/components/admin/settings/CurrencySettingsBuilder.tsx`
- `src/components/admin/settings/EmailSettingsForm.tsx`
- `src/components/admin/settings/FirebaseSettingsForm.tsx`
- `src/components/admin/settings/NotificationChannelsBuilder.tsx`
- `src/components/admin/settings/PaymentGatewaysManager.tsx`
- `src/components/admin/settings/ThemeSettingsPage.tsx`
- `src/components/admin/ShipmentForm.tsx`
- `src/components/admin/ShipmentList.tsx`
- `src/components/admin/shipping-methods/hooks/useShippingMethods.ts`
- `src/components/admin/StorefrontUrlBuilder.tsx`
- `src/components/admin/UserPermissionEditor.tsx`
- `src/components/admin/widget-list/hooks/useBulkActions.ts`
- `src/components/admin/widget-list/hooks/useWidgetActions.ts`
- `src/components/admin/widget-list/WidgetsList.tsx`
- `src/components/admin/widgets/widget-form/useAiContext.ts`
- `src/components/admin/widgets/widget-form/useAiGenerator.ts`
- `src/components/admin/widgets/widget-form/useAiImprover.ts`

## Priority 4 -- `@/lib/client` (32 occurrences -- needs alias or rewrite)

These import from the old admin's `lib/client` module (likely the API client
instance). Must be pointed at the new admin-v2 client setup.

- `src/components/admin/account-settings/ProfileHeader.tsx`
- `src/components/admin/AnalyticsForm.tsx`
- `src/components/admin/AnalyticsList.tsx`
- `src/components/admin/categories/CategoryHeader.tsx`
- `src/components/admin/categories/CategoryTable.tsx`
- `src/components/admin/categories/hooks/useCategoryList.ts`
- `src/components/admin/CategoryForm.tsx`
- `src/components/admin/collection-form/CollectionFormContainer.tsx`
- `src/components/admin/collections-list/CollectionsList.tsx`
- `src/components/admin/customer-list/hooks/useCustomerListActions.ts`
- `src/components/admin/CustomerForm.tsx`
- `src/components/admin/DeliveryShipmentManager.tsx`
- `src/components/admin/discount/amount-off-products/AmountOffProductsContainer.tsx`
- `src/components/admin/discount/AmountOffOrderForm.tsx`
- `src/components/admin/discount/discount-list/DiscountListContainer.tsx`
- `src/components/admin/discount/discount-list/DiscountRow.tsx`
- `src/components/admin/discount/discount-list/hooks/useDiscountListFilters.ts`
- `src/components/admin/discount/FreeShippingForm.tsx`
- `src/components/admin/order-form/README.md`
- `src/components/admin/order-list/OrderListContainer.tsx`
- `src/components/admin/order-list/OrderMobileCard.tsx`
- `src/components/admin/OrderForm.tsx`
- `src/components/admin/orderview/OrderStatusCard.tsx`
- `src/components/admin/orderview/PaymentCard.tsx`
- `src/components/admin/orderview/ShipmentCard.tsx`
- `src/components/admin/PageForm.tsx`
- `src/components/admin/product-form/hooks/useProductSubmit.ts`
- `src/components/admin/product-list/hooks/useProductList.ts`
- `src/components/admin/product-list/ProductHeader.tsx`
- `src/components/admin/product-list/ProductTable.tsx`
- `src/components/admin/widget-list/hooks/useWidgets.ts`
- `src/components/admin/widget-list/WidgetsList.tsx`
- `src/components/admin/widgets/WidgetForm.tsx`

## Priority 5 -- `@/hooks/` (53 occurrences -- copy + alias fix)

These import shared hooks (`use-currency`, `use-storefront-url`, `use-debounce`,
`use-shipment-status`, `use-debounced-callback`). The hooks must be copied to
admin-v2 and import paths updated.

Breakdown by hook:
- `use-currency` (30 files)
- `use-storefront-url` (7 files)
- `use-debounce` (7 files)
- `use-shipment-status` (1 file)
- `use-debounced-callback` (1 file)

Full file list:
- `src/components/admin/AbandonedCheckoutsManager.tsx`
- `src/components/admin/attributes-manager/AttributesManager.tsx`
- `src/components/admin/attributes-manager/components/AttributeRow.tsx`
- `src/components/admin/categories/CategoryListContainer.tsx`
- `src/components/admin/CategoryForm.tsx`
- `src/components/admin/collections-list/CollectionsList.tsx`
- `src/components/admin/collections-list/components/CollectionRow.tsx`
- `src/components/admin/customer-list/CustomerListContainer.tsx`
- `src/components/admin/CustomerHistoryView.tsx`
- `src/components/admin/DashboardStats.tsx`
- `src/components/admin/discount/amount-off-products/AmountOffProductsContainer.tsx`
- `src/components/admin/discount/AmountOffOrderForm.tsx`
- `src/components/admin/discount/discount-list/DiscountListContainer.tsx`
- `src/components/admin/discount/FreeShippingForm.tsx`
- `src/components/admin/discount/ProductSelector.tsx`
- `src/components/admin/header-builder/HeaderBuilder.tsx`
- `src/components/admin/hero-slider/HeroSliderContainer.tsx`
- `src/components/admin/order-form/ItemSelection.tsx`
- `src/components/admin/order-form/OrderItemsTable.tsx`
- `src/components/admin/order-form/ProductSearch.tsx`
- `src/components/admin/order-form/SummarySection.tsx`
- `src/components/admin/order-list/OrderItemsPopover.tsx`
- `src/components/admin/order-list/OrderMobileCard.tsx`
- `src/components/admin/order-list/OrderTableRow.tsx`
- `src/components/admin/orderview/OrderItemsCard.tsx`
- `src/components/admin/orderview/OrderViewHeader.tsx`
- `src/components/admin/orderview/PaymentCard.tsx`
- `src/components/admin/PageForm.tsx`
- `src/components/admin/pages-list/components/PageRow.tsx`
- `src/components/admin/pages-list/hooks/usePages.ts`
- `src/components/admin/product-form/PricingAvailabilitySection.tsx`
- `src/components/admin/product-form/PricingCard.tsx`
- `src/components/admin/product-form/variants/bulk-generator/BulkVariantGeneratorDialog.tsx`
- `src/components/admin/product-form/variants/VariantDisplayRow.tsx`
- `src/components/admin/product-form/variants/VariantFormRow.tsx`
- `src/components/admin/product-form/variants/VariantManager.tsx`
- `src/components/admin/product-form/variants/VariantTemplateSelector.tsx`
- `src/components/admin/product-list/hooks/useProductList.ts`
- `src/components/admin/ProductForm.tsx`
- `src/components/admin/ProductView.tsx`
- `src/components/admin/RecentOrders.tsx`
- `src/components/admin/ShipmentStatusIndicator.tsx`
- `src/components/admin/shipping-methods/ShippingMethodsContainer.tsx`
- `src/components/admin/widgets/widget-form/useAiContext.ts`

## Priority 6 -- `@/types/` (20 occurrences -- copy type files)

These import from the old admin's type definition files (`api-responses`, etc.).
Must be copied or re-exported from SDK types.

- `src/components/admin/AbandonedCheckoutsManager.tsx`
- `src/components/admin/attributes-manager/types/index.ts`
- `src/components/admin/collections-list/types/index.ts`
- `src/components/admin/DeliveryShipmentManager.tsx`
- `src/components/admin/FraudCheckerSettings.tsx`
- `src/components/admin/order-form/SummarySection.tsx`
- `src/components/admin/OrderForm.tsx`
- `src/components/admin/orderview/ShipmentCard.tsx`
- `src/components/admin/orderview/types.ts`
- `src/components/admin/pages-list/types/index.ts`
- `src/components/admin/product-form/AttributeManager.tsx`
- `src/components/admin/ShipmentForm.tsx`
- `src/components/admin/widget-list/types/index.ts`
- `src/components/admin/widgets/widget-form/AiAssistant.tsx`
- `src/components/admin/widgets/widget-form/types.ts`
- `src/components/admin/widgets/widget-form/useAiContext.ts`
- `src/components/admin/widgets/widget-form/useAiGenerator.ts`
- `src/components/admin/widgets/widget-form/WidgetHistoryModal.tsx`
- `src/components/admin/widgets/widget-form/WidgetPlacement.tsx`
- `src/components/admin/widgets/WidgetForm.tsx`

## Priority 7 -- `@/contexts/` (5 occurrences -- rebuild context providers)

- `src/components/admin/account-settings/AccountSettingsContainer.tsx`
- `src/components/admin/account-settings/AdminUsersManager.tsx`
- `src/components/admin/AccountSettingsWithPermissions.tsx`
- `src/components/admin/PermissionGate.tsx`
- `src/components/admin/RolesManagement.tsx`

## Priority 8 -- `@/store/` (3 occurrences -- port stores)

- `src/components/admin/order-form/OrderItemsSection.tsx`
- `src/components/admin/order-form/OrderItemsTable.tsx`
- `src/components/admin/OrderForm.tsx`

## Priority 9 -- `@/components/ui/` (159 files -- alias resolution)

159 files import from `@/components/ui/`. These should work once the `@/` or `~/`
path alias is configured in admin-v2's tsconfig to resolve to `src/`. This is the
lowest priority since it is a config-level fix, not a per-file rewrite.

---

## Summary

| Category | Files | Action |
|----------|-------|--------|
| `@/lib/api-browser` | 2 | Rewrite to server functions |
| `@/lib/auth-client` | 1 | Wire to new auth setup |
| `@/lib/api-helpers` | 81 | Port helpers + wire to server functions |
| `@/lib/client` | 32 | Point to new API client |
| `@/hooks/` | 53 | Copy hooks + fix paths |
| `@/types/` | 20 | Copy types or use SDK types |
| `@/contexts/` | 5 | Rebuild context providers |
| `@/store/` | 3 | Port stores |
| `@/components/ui/` | 159 | tsconfig alias fix |
| **Astro-specific** | 0 | None found (sidebar already removed) |
