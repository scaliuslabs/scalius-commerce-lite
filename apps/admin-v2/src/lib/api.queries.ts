/**
 * TanStack Query queryOptions wrappers for all GET server functions.
 *
 * Each wrapper creates a queryOptions object with a consistent queryKey
 * hierarchy and a queryFn that calls the corresponding server function.
 *
 * Query key convention:
 *   [domain]                          — singleton (e.g. dashboard)
 *   [domain, 'list', params]          — paginated list
 *   [domain, 'detail', id]            — single entity
 *   [domain, sub-domain, ...]         — nested resources
 */

import { queryOptions } from "@tanstack/react-query";
import type {
  DashboardData,
  Category,
  ProductListItem,
  ProductDetail,
  OrderDetail,
  Customer,
  Discount,
  Page,
  Widget,
  DeliveryProviderRecord,
  FraudCheckerProvider,
  AnalyticsScript,
} from "~/types/api-responses";
import {
  // Dashboard
  getDashboardData,
  // Products
  getProducts,
  getProduct,
  getProductStats,
  getProductVariants,
  getVariantSortOrder,
  // Categories
  getCategories,
  getCategory,
  getCategoryFormOptions,
  // Collections
  getCollections,
  getCollection,
  getCollectionFormOptions,
  // Orders
  getOrders,
  getOrder,
  getOrderFormData,
  getOrderItems,
  getOrderPayments,
  getOrderCod,
  getOrderShipments,
  // Customers
  getCustomers,
  getCustomer,
  getCustomerHistory,
  // Discounts
  getDiscounts,
  getDiscount,
  // Pages
  getPages,
  getPage,
  // Widgets
  getWidgets,
  getWidget,
  getWidgetHistory,
  // Attributes
  getAttributes,
  getAttributeValues,
  // Analytics
  getAnalyticsScripts,
  getAnalyticsScript,
  // Inventory
  getInventory,
  // Media
  getMediaList,
  getMediaFolders,
  // Navigation
  getNavigationItems,
  getNavigationPreviewProducts,
  // Fraud Checker
  getFraudCheckerProviders,
  // Abandoned Checkouts
  getAbandonedCheckouts,
  // RBAC
  getRbacRoles,
  getRbacPermissions,
  // Auth / Admin Users
  getAdminUsers,
  getAccountSecurity,
  get2faInfo,
  // Settings
  getSettingsByCategory,
  getGeneralSettings,
  getStorefrontUrl,
  getCurrencySettings,
  getSeoSettings,
  getSecuritySettings,
  getAuthSettings,
  getEmailSettings,
  getFirebaseSettings,
  getBusinessSettings,
  getThemeSettings,
  getSmsSettings,
  getOpenRouterSettings,
  getMetaConversionsSettings,
  getMetaConversionsLogs,
  getAllowedCountries,
  getPaymentMethods,
  getPaymentGatewaySettings,
  getNotificationChannels,
  getAdminNotificationChannels,
  getDeliveryProviders,
  getDeliveryLocations,
  getAllDeliveryLocations,
  getImportPathaoStatus,
  getCheckoutLanguages,
  getShippingMethods,
  getHeroSliders,
  // AI
  getAiPrompts,
  // Cache
  getCacheStats,
  getCacheLastCleared,
  getCacheGroups,
  // Setup
  getSetupStatus,
  // Firebase
  getFirebaseConfig,
} from "./api.functions";

// ═══════════════════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════════════════

export const dashboardQueryOptions = () =>
  queryOptions({
    queryKey: ["dashboard"],
    queryFn: () => getDashboardData() as Promise<DashboardData>,
  });

// ═══════════════════════════════════════════════════════════════════
//  PRODUCTS
// ═══════════════════════════════════════════════════════════════════

export const productsQueryOptions = (params: {
  page?: number;
  limit?: number;
  search?: string;
  categoryId?: string;
  sort?: string;
  order?: string;
  showTrashed?: boolean;
}) =>
  queryOptions({
    queryKey: ["products", "list", params],
    queryFn: () => getProducts({ data: params }),
  });

export const productQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["products", "detail", id],
    queryFn: () => getProduct({ data: { id } }),
  });

export const productStatsQueryOptions = () =>
  queryOptions({
    queryKey: ["products", "stats"],
    queryFn: () => getProductStats(),
  });

export const productVariantsQueryOptions = (productId: string) =>
  queryOptions({
    queryKey: ["products", "variants", productId],
    queryFn: () => getProductVariants({ data: { productId } }),
  });

export const variantSortOrderQueryOptions = (productId: string) =>
  queryOptions({
    queryKey: ["products", "variant-sort-order", productId],
    queryFn: () => getVariantSortOrder({ data: { productId } }),
  });

// ═══════════════════════════════════════════════════════════════════
//  CATEGORIES
// ═══════════════════════════════════════════════════════════════════

export const categoriesQueryOptions = (params: {
  page?: number;
  limit?: number;
  search?: string;
  sort?: string;
  order?: string;
  showTrashed?: boolean;
}) =>
  queryOptions({
    queryKey: ["categories", "list", params],
    queryFn: () => getCategories({ data: params }),
  });

export const categoryQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["categories", "detail", id],
    queryFn: () => getCategory({ data: { id } }),
  });

export const categoryFormOptionsQueryOptions = () =>
  queryOptions({
    queryKey: ["categories", "form-options"],
    queryFn: () => getCategoryFormOptions(),
  });

// ═══════════════════════════════════════════════════════════════════
//  COLLECTIONS
// ═══════════════════════════════════════════════════════════════════

export const collectionsQueryOptions = (params: {
  page?: number;
  limit?: number;
  search?: string;
  sort?: string;
  order?: string;
  showTrashed?: boolean;
  trashed?: boolean;
}) =>
  queryOptions({
    queryKey: ["collections", "list", params],
    queryFn: () => getCollections({ data: params }),
  });

export const collectionQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["collections", "detail", id],
    queryFn: () => getCollection({ data: { id } }),
  });

export const collectionFormOptionsQueryOptions = () =>
  queryOptions({
    queryKey: ["collections", "form-options"],
    queryFn: () => getCollectionFormOptions(),
  });

// ═══════════════════════════════════════════════════════════════════
//  ORDERS
// ═══════════════════════════════════════════════════════════════════

export const ordersQueryOptions = (params: {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
  sort?: string;
  order?: string;
  showTrashed?: boolean;
  trashed?: boolean;
  startDate?: string;
  endDate?: string;
  paymentStatus?: string;
  paymentMethod?: string;
  fulfillmentStatus?: string;
}) =>
  queryOptions({
    queryKey: ["orders", "list", params],
    queryFn: () => getOrders({ data: params }),
  });

export const orderQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["orders", "detail", id],
    queryFn: () => getOrder({ data: { id } }),
  });

export const orderFormDataQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["orders", "form-data", id],
    queryFn: () => getOrderFormData({ data: { id } }),
  });

export const orderItemsQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: ["orders", "items", orderId],
    queryFn: () => getOrderItems({ data: { orderId } }),
  });

export const orderPaymentsQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: ["orders", "payments", orderId],
    queryFn: () => getOrderPayments({ data: { orderId } }),
  });

export const orderCodQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: ["orders", "cod", orderId],
    queryFn: () => getOrderCod({ data: { orderId } }),
  });

export const orderShipmentsQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: ["orders", "shipments", orderId],
    queryFn: () => getOrderShipments({ data: { orderId } }),
  });

// ═══════════════════════════════════════════════════════════════════
//  CUSTOMERS
// ═══════════════════════════════════════════════════════════════════

export const customersQueryOptions = (params: {
  page?: number;
  limit?: number;
  search?: string;
  sort?: string;
  order?: string;
  showTrashed?: boolean;
  trashed?: boolean;
}) =>
  queryOptions({
    queryKey: ["customers", "list", params],
    queryFn: () => getCustomers({ data: params }),
  });

export const customerQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["customers", "detail", id],
    queryFn: () => getCustomer({ data: { id } }),
  });

export const customerHistoryQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["customers", "history", id],
    queryFn: () => getCustomerHistory({ data: { id } }),
  });

// ═══════════════════════════════════════════════════════════════════
//  DISCOUNTS
// ═══════════════════════════════════════════════════════════════════

export const discountsQueryOptions = (params: {
  page?: number;
  limit?: number;
  search?: string;
  sort?: string;
  order?: string;
  showTrashed?: boolean;
}) =>
  queryOptions({
    queryKey: ["discounts", "list", params],
    queryFn: () => getDiscounts({ data: params }),
  });

export const discountQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["discounts", "detail", id],
    queryFn: () => getDiscount({ data: { id } }),
  });

// ═══════════════════════════════════════════════════════════════════
//  PAGES
// ═══════════════════════════════════════════════════════════════════

export const pagesQueryOptions = (params: {
  page?: number;
  limit?: number;
  search?: string;
  sort?: string;
  order?: string;
  showTrashed?: boolean;
  trashed?: boolean;
}) =>
  queryOptions({
    queryKey: ["pages", "list", params],
    queryFn: () => getPages({ data: params }),
  });

export const pageQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["pages", "detail", id],
    queryFn: () => getPage({ data: { id } }),
  });

// ═══════════════════════════════════════════════════════════════════
//  WIDGETS
// ═══════════════════════════════════════════════════════════════════

export const widgetsQueryOptions = (params: {
  search?: string;
  showTrashed?: boolean;
}) =>
  queryOptions({
    queryKey: ["widgets", "list", params],
    queryFn: () => getWidgets({ data: params }),
  });

export const widgetQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["widgets", "detail", id],
    queryFn: () => getWidget({ data: { id } }),
  });

export const widgetHistoryQueryOptions = (widgetId: string) =>
  queryOptions({
    queryKey: ["widgets", "history", widgetId],
    queryFn: () => getWidgetHistory({ data: { widgetId } }),
  });

// ═══════════════════════════════════════════════════════════════════
//  ATTRIBUTES
// ═══════════════════════════════════════════════════════════════════

export const attributesQueryOptions = (params: {
  page?: number;
  limit?: number;
  search?: string;
  sort?: string;
  order?: string;
  trashed?: boolean;
}) =>
  queryOptions({
    queryKey: ["attributes", "list", params],
    queryFn: () => getAttributes({ data: params }),
  });

export const attributeValuesQueryOptions = (params: {
  attributeId?: string;
  id?: string;
  page?: number;
  limit?: number;
  search?: string;
  sort?: string;
}) =>
  queryOptions({
    queryKey: ["attributes", "values", params],
    queryFn: () => getAttributeValues({ data: params }),
  });

// ═══════════════════════════════════════════════════════════════════
//  ANALYTICS SCRIPTS
// ═══════════════════════════════════════════════════════════════════

export const analyticsScriptsQueryOptions = () =>
  queryOptions({
    queryKey: ["analytics", "list"],
    queryFn: () => getAnalyticsScripts(),
  });

export const analyticsScriptQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["analytics", "detail", id],
    queryFn: () => getAnalyticsScript({ data: { id } }),
  });

// ═══════════════════════════════════════════════════════════════════
//  INVENTORY
// ═══════════════════════════════════════════════════════════════════

export const inventoryQueryOptions = (params: {
  page?: number;
  limit?: number;
  search?: string;
  lowStock?: boolean;
  section?: string;
  status?: string;
  sort?: string;
  order?: string;
}) =>
  queryOptions({
    queryKey: ["inventory", "list", params],
    queryFn: () => getInventory({ data: params }),
  });

// ═══════════════════════════════════════════════════════════════════
//  MEDIA
// ═══════════════════════════════════════════════════════════════════

export const mediaListQueryOptions = (params: {
  page?: number;
  limit?: number;
  search?: string;
  folderId?: string;
  type?: string;
  sortBy?: string;
  sortOrder?: string;
}) =>
  queryOptions({
    queryKey: ["media", "list", params],
    queryFn: () => getMediaList({ data: params }),
  });

export const mediaFoldersQueryOptions = () =>
  queryOptions({
    queryKey: ["media", "folders"],
    queryFn: () => getMediaFolders(),
  });

// ═══════════════════════════════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════════════════════════════

export const navigationItemsQueryOptions = () =>
  queryOptions({
    queryKey: ["navigation", "items"],
    queryFn: () => getNavigationItems(),
  });

export const navigationPreviewProductsQueryOptions = (params: Record<string, string>) =>
  queryOptions({
    queryKey: ["navigation", "preview-products", params],
    queryFn: () => getNavigationPreviewProducts({ data: params }),
  });

// ═══════════════════════════════════════════════════════════════════
//  FRAUD CHECKER
// ═══════════════════════════════════════════════════════════════════

export const fraudCheckerProvidersQueryOptions = () =>
  queryOptions({
    queryKey: ["fraud-checker", "list"],
    queryFn: () => getFraudCheckerProviders(),
  });

// ═══════════════════════════════════════════════════════════════════
//  ABANDONED CHECKOUTS
// ═══════════════════════════════════════════════════════════════════

export const abandonedCheckoutsQueryOptions = (params: {
  page?: number;
  limit?: number;
  search?: string;
  sort?: string;
  order?: string;
}) =>
  queryOptions({
    queryKey: ["abandoned-checkouts", "list", params],
    queryFn: () => getAbandonedCheckouts({ data: params }),
  });

// ═══════════════════════════════════════════════════════════════════
//  RBAC
// ═══════════════════════════════════════════════════════════════════

export const rbacRolesQueryOptions = () =>
  queryOptions({
    queryKey: ["rbac", "roles"],
    queryFn: () => getRbacRoles(),
  });

export const rbacPermissionsQueryOptions = () =>
  queryOptions({
    queryKey: ["rbac", "permissions"],
    queryFn: () => getRbacPermissions(),
  });

// ═══════════════════════════════════════════════════════════════════
//  AUTH / ADMIN USERS
// ═══════════════════════════════════════════════════════════════════

export const adminUsersQueryOptions = () =>
  queryOptions({
    queryKey: ["admin-users", "list"],
    queryFn: () => getAdminUsers(),
  });

export const accountSecurityQueryOptions = () =>
  queryOptions({
    queryKey: ["auth", "account-security"],
    queryFn: () => getAccountSecurity(),
  });

export const twoFaInfoQueryOptions = () =>
  queryOptions({
    queryKey: ["auth", "2fa-info"],
    queryFn: () => get2faInfo(),
  });

// ═══════════════════════════════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════════════════════════════

export const settingsByCategoryQueryOptions = (category: string) =>
  queryOptions({
    queryKey: ["settings", category],
    queryFn: () => getSettingsByCategory({ data: { category } }),
  });

export const generalSettingsQueryOptions = () =>
  queryOptions({
    queryKey: ["settings", "general"],
    queryFn: () => getGeneralSettings(),
  });

export const storefrontUrlQueryOptions = () =>
  queryOptions({
    queryKey: ["settings", "storefront-url"],
    queryFn: () => getStorefrontUrl(),
  });

export const currencySettingsQueryOptions = () =>
  queryOptions({
    queryKey: ["settings", "currency"],
    queryFn: () => getCurrencySettings(),
  });

export const seoSettingsQueryOptions = () =>
  queryOptions({
    queryKey: ["settings", "seo"],
    queryFn: () => getSeoSettings(),
  });

export const securitySettingsQueryOptions = () =>
  queryOptions({
    queryKey: ["settings", "security"],
    queryFn: () => getSecuritySettings(),
  });

export const authSettingsQueryOptions = () =>
  queryOptions({
    queryKey: ["settings", "auth"],
    queryFn: () => getAuthSettings(),
  });

export const emailSettingsQueryOptions = () =>
  queryOptions({
    queryKey: ["settings", "email"],
    queryFn: () => getEmailSettings(),
  });

export const firebaseSettingsQueryOptions = () =>
  queryOptions({
    queryKey: ["settings", "firebase"],
    queryFn: () => getFirebaseSettings(),
  });

export const businessSettingsQueryOptions = () =>
  queryOptions({
    queryKey: ["settings", "business"],
    queryFn: () => getBusinessSettings(),
  });

export const themeSettingsQueryOptions = () =>
  queryOptions({
    queryKey: ["settings", "theme"],
    queryFn: () => getThemeSettings(),
  });

export const smsSettingsQueryOptions = () =>
  queryOptions({
    queryKey: ["settings", "sms"],
    queryFn: () => getSmsSettings(),
  });

export const openRouterSettingsQueryOptions = () =>
  queryOptions({
    queryKey: ["settings", "openrouter"],
    queryFn: () => getOpenRouterSettings(),
  });

export const metaConversionsSettingsQueryOptions = () =>
  queryOptions({
    queryKey: ["settings", "meta-conversions"],
    queryFn: () => getMetaConversionsSettings(),
  });

export const metaConversionsLogsQueryOptions = (params: {
  page?: number;
  limit?: number;
}) =>
  queryOptions({
    queryKey: ["settings", "meta-conversions-logs", params],
    queryFn: () => getMetaConversionsLogs({ data: params }),
  });

export const allowedCountriesQueryOptions = () =>
  queryOptions({
    queryKey: ["settings", "allowed-countries"],
    queryFn: () => getAllowedCountries(),
  });

export const paymentMethodsQueryOptions = () =>
  queryOptions({
    queryKey: ["settings", "payment-methods"],
    queryFn: () => getPaymentMethods(),
  });

export const paymentGatewaySettingsQueryOptions = (gateway: string) =>
  queryOptions({
    queryKey: ["settings", "payment-gateway", gateway],
    queryFn: () => getPaymentGatewaySettings({ data: { gateway } }),
  });

export const notificationChannelsQueryOptions = () =>
  queryOptions({
    queryKey: ["settings", "notification-channels"],
    queryFn: () => getNotificationChannels(),
  });

export const adminNotificationChannelsQueryOptions = () =>
  queryOptions({
    queryKey: ["settings", "admin-notification-channels"],
    queryFn: () => getAdminNotificationChannels(),
  });

export const deliveryProvidersQueryOptions = () =>
  queryOptions({
    queryKey: ["settings", "delivery-providers"],
    queryFn: () => getDeliveryProviders(),
  });

export const deliveryLocationsQueryOptions = (params: Record<string, string | number | boolean | undefined>) =>
  queryOptions({
    queryKey: ["settings", "delivery-locations", params],
    queryFn: () => getDeliveryLocations({ data: params }),
  });

export const allDeliveryLocationsQueryOptions = (params: { type?: string }) =>
  queryOptions({
    queryKey: ["settings", "delivery-locations-all", params],
    queryFn: () => getAllDeliveryLocations({ data: params }),
  });

export const importPathaoStatusQueryOptions = () =>
  queryOptions({
    queryKey: ["settings", "import-pathao-status"],
    queryFn: () => getImportPathaoStatus(),
  });

export const checkoutLanguagesQueryOptions = (params: Record<string, string | number | boolean | undefined>) =>
  queryOptions({
    queryKey: ["settings", "checkout-languages", params],
    queryFn: () => getCheckoutLanguages({ data: params }),
  });

export const shippingMethodsQueryOptions = (params: {
  page?: number;
  limit?: number;
  search?: string;
  sort?: string;
  order?: string;
  trashed?: boolean;
}) =>
  queryOptions({
    queryKey: ["settings", "shipping-methods", params],
    queryFn: () => getShippingMethods({ data: params }),
  });

export const heroSlidersQueryOptions = () =>
  queryOptions({
    queryKey: ["settings", "hero-sliders"],
    queryFn: () => getHeroSliders(),
  });

// ═══════════════════════════════════════════════════════════════════
//  AI
// ═══════════════════════════════════════════════════════════════════

export const aiPromptsQueryOptions = (type: string) =>
  queryOptions({
    queryKey: ["ai", "prompts", type],
    queryFn: () => getAiPrompts({ data: { type } }),
  });

// ═══════════════════════════════════════════════════════════════════
//  CACHE
// ═══════════════════════════════════════════════════════════════════

export const cacheStatsQueryOptions = () =>
  queryOptions({
    queryKey: ["cache", "stats"],
    queryFn: () => getCacheStats(),
  });

export const cacheLastClearedQueryOptions = () =>
  queryOptions({
    queryKey: ["cache", "last-cleared"],
    queryFn: () => getCacheLastCleared(),
  });

export const cacheGroupsQueryOptions = () =>
  queryOptions({
    queryKey: ["cache", "groups"],
    queryFn: () => getCacheGroups(),
  });

// ═══════════════════════════════════════════════════════════════════
//  SETUP
// ═══════════════════════════════════════════════════════════════════

export const setupStatusQueryOptions = () =>
  queryOptions({
    queryKey: ["setup", "status"],
    queryFn: () => getSetupStatus(),
  });

// ═══════════════════════════════════════════════════════════════════
//  FIREBASE CONFIG
// ═══════════════════════════════════════════════════════════════════

export const firebaseConfigQueryOptions = () =>
  queryOptions({
    queryKey: ["firebase", "config"],
    queryFn: () => getFirebaseConfig(),
  });
