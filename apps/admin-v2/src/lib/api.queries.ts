/**
 * TanStack Query queryOptions wrappers for all GET server functions.
 *
 * Each wrapper creates a queryOptions object with a consistent queryKey
 * hierarchy and a queryFn that calls the corresponding server function.
 *
 * All query keys are sourced from the centralized `queryKeys` factory
 * in `~/lib/query-keys.ts` to ensure consistency with mutation invalidation.
 */

import { queryOptions } from "@tanstack/react-query";
import type { DashboardData } from "~/types/api-responses";
import { queryKeys } from "./query-keys";
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
  // Inventory
  getInventory,
  // Media
  getMediaList,
  getMediaFolders,
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
  getMediaSettings,
  getSmsSettings,
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
  // Setup
  getSetupStatus,
  // Firebase
  getFirebaseConfig,
} from "./api.functions";
import {
  getAnalyticsScript,
  getAnalyticsScripts,
} from "./api-functions/analytics";
import {
  getCacheGroups,
  getCacheLastCleared,
  getCacheStats,
} from "./api-functions/cache";
import {
  getNavigationItems,
  getNavigationPreviewProducts,
  type NavigationPreviewProductsInput,
} from "./api-functions/navigation";
import { getFraudCheckerProviders } from "./api-functions/fraud-checker";

// Query staleTime constants (how long data is considered fresh)
const STALE = {
  REALTIME: 1000 * 10, // 10s — data that changes frequently
  FAST: 1000 * 30, // 30s — orders, inventory
  MODERATE: 1000 * 60 * 2, // 2min — lists, dashboard
  SLOW: 1000 * 60 * 5, // 5min — entity details, media
  LOOKUP: 1000 * 60 * 10, // 10min — form options, lookups
  CONFIG: 1000 * 60 * 30, // 30min — settings, RBAC
  STATIC: 1000 * 60 * 60, // 1hr — setup status
} as const;

// Detail queries use staleTime: 0 (always stale) combined with
// staleTime: Infinity in route loaders. This implements stale-while-revalidate:
// - Loader serves cached data instantly (never blocks if cache exists)
// - Component triggers background refetch immediately after render
// - UI updates seamlessly when fresh data arrives
// Result: blazing-fast navigation + always-fresh data.

// ═══════════════════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════════════════

export const dashboardQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.dashboard.all,
    queryFn: () => getDashboardData() as Promise<DashboardData>,
    staleTime: STALE.MODERATE,
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
    queryKey: queryKeys.products.list(params),
    queryFn: () => getProducts({ data: params }),
    staleTime: STALE.MODERATE,
  });

export const productQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.products.detail(id),
    queryFn: () => getProduct({ data: { id } }),
    staleTime: 0,
  });

export const productStatsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.products.stats(),
    queryFn: () => getProductStats(),
    staleTime: STALE.MODERATE,
  });

export const productVariantsQueryOptions = (productId: string) =>
  queryOptions({
    queryKey: queryKeys.products.variants(productId),
    queryFn: () => getProductVariants({ data: { productId } }),
    staleTime: STALE.MODERATE,
  });

export const variantSortOrderQueryOptions = (productId: string) =>
  queryOptions({
    queryKey: queryKeys.products.variantSortOrder(productId),
    queryFn: () => getVariantSortOrder({ data: { productId } }),
    staleTime: STALE.MODERATE,
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
    queryKey: queryKeys.categories.list(params),
    queryFn: () => getCategories({ data: params }),
    staleTime: STALE.MODERATE,
  });

export const categoryQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.categories.detail(id),
    queryFn: () => getCategory({ data: { id } }),
    staleTime: 0,
  });

export const categoryFormOptionsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.categories.formOptions(),
    queryFn: () => getCategoryFormOptions(),
    staleTime: STALE.LOOKUP,
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
    queryKey: queryKeys.collections.list(params),
    queryFn: () => getCollections({ data: params }),
    staleTime: STALE.MODERATE,
  });

export const collectionQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.collections.detail(id),
    queryFn: () => getCollection({ data: { id } }),
    staleTime: 0,
  });

export const collectionFormOptionsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.collections.formOptions(),
    queryFn: () => getCollectionFormOptions(),
    staleTime: STALE.LOOKUP,
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
    queryKey: queryKeys.orders.list(params),
    queryFn: () => getOrders({ data: params }),
    staleTime: STALE.FAST,
  });

export const orderQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.orders.detail(id),
    queryFn: () => getOrder({ data: { id } }),
    staleTime: 0,
  });

export const orderFormDataQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.orders.formData(id),
    queryFn: () => getOrderFormData({ data: { id } }),
    staleTime: 0,
  });

export const orderItemsQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: queryKeys.orders.items(orderId),
    queryFn: () => getOrderItems({ data: { orderId } }),
    staleTime: STALE.FAST,
  });

export const orderPaymentsQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: queryKeys.orders.payments(orderId),
    queryFn: () => getOrderPayments({ data: { orderId } }),
    staleTime: 0,
  });

export const orderCodQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: queryKeys.orders.cod(orderId),
    queryFn: () => getOrderCod({ data: { orderId } }),
    staleTime: 0,
  });

export const orderShipmentsQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: queryKeys.orders.shipments(orderId),
    queryFn: () => getOrderShipments({ data: { orderId } }),
    staleTime: 0,
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
    queryKey: queryKeys.customers.list(params),
    queryFn: () => getCustomers({ data: params }),
    staleTime: STALE.MODERATE,
  });

export const customerQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.customers.detail(id),
    queryFn: () => getCustomer({ data: { id } }),
    staleTime: 0,
  });

export const customerHistoryQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.customers.history(id),
    queryFn: () => getCustomerHistory({ data: { id } }),
    staleTime: 0,
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
    queryKey: queryKeys.discounts.list(params),
    queryFn: () => getDiscounts({ data: params }),
    staleTime: STALE.MODERATE,
  });

export const discountQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.discounts.detail(id),
    queryFn: () => getDiscount({ data: { id } }),
    staleTime: 0,
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
    queryKey: queryKeys.pages.list(params),
    queryFn: () => getPages({ data: params }),
    staleTime: STALE.MODERATE,
  });

export const pageQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.pages.detail(id),
    queryFn: () => getPage({ data: { id } }),
    staleTime: 0,
  });

// ═══════════════════════════════════════════════════════════════════
//  WIDGETS
// ═══════════════════════════════════════════════════════════════════

export const widgetsQueryOptions = (params: {
  search?: string;
  showTrashed?: boolean;
}) =>
  queryOptions({
    queryKey: queryKeys.widgets.list(params),
    queryFn: () => getWidgets({ data: params }),
    staleTime: STALE.MODERATE,
  });

export const widgetQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.widgets.detail(id),
    queryFn: () => getWidget({ data: { id } }),
    staleTime: 0,
  });

export const widgetHistoryQueryOptions = (widgetId: string) =>
  queryOptions({
    queryKey: queryKeys.widgets.history(widgetId),
    queryFn: () => getWidgetHistory({ data: { widgetId } }),
    staleTime: STALE.SLOW,
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
    queryKey: queryKeys.attributes.list(params),
    queryFn: () => getAttributes({ data: params }),
    staleTime: STALE.LOOKUP,
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
    queryKey: queryKeys.attributes.values(params),
    queryFn: () => getAttributeValues({ data: params }),
    staleTime: STALE.LOOKUP,
  });

// ═══════════════════════════════════════════════════════════════════
//  ANALYTICS SCRIPTS
// ═══════════════════════════════════════════════════════════════════

export const analyticsScriptsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.analytics.list(),
    queryFn: () => getAnalyticsScripts(),
    staleTime: STALE.LOOKUP,
  });

export const analyticsScriptQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.analytics.detail(id),
    queryFn: () => getAnalyticsScript({ data: { id } }),
    staleTime: 0,
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
    queryKey: queryKeys.inventory.list(params),
    queryFn: () => getInventory({ data: params }),
    staleTime: STALE.FAST,
  });

// ═══════════════════════════════════════════════════════════════════
//  MEDIA
// ═══════════════════════════════════════════════════════════════════

export const mediaListQueryOptions = (params: {
  page?: number;
  limit?: number;
  search?: string;
  folderId?: string;
  mimeType?: string;
  type?: string;
  sortBy?: string;
  sortOrder?: string;
}) =>
  queryOptions({
    queryKey: queryKeys.media.list(params),
    queryFn: () => getMediaList({ data: params }),
    staleTime: STALE.SLOW,
  });

export const mediaFoldersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.media.folders(),
    queryFn: () => getMediaFolders(),
    staleTime: STALE.SLOW,
  });

// ═══════════════════════════════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════════════════════════════

export const navigationItemsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.navigation.items(),
    queryFn: () => getNavigationItems(),
    staleTime: STALE.LOOKUP,
  });

export const navigationPreviewProductsQueryOptions = (
  params: NavigationPreviewProductsInput,
) =>
  queryOptions({
    queryKey: queryKeys.navigation.previewProducts(params),
    queryFn: () => getNavigationPreviewProducts({ data: params }),
    staleTime: STALE.SLOW,
  });

// ═══════════════════════════════════════════════════════════════════
//  FRAUD CHECKER
// ═══════════════════════════════════════════════════════════════════

export const fraudCheckerProvidersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.fraudChecker.list(),
    queryFn: () => getFraudCheckerProviders(),
    staleTime: STALE.LOOKUP,
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
    queryKey: queryKeys.abandonedCheckouts.list(params),
    queryFn: async () => {
      // Fetch via admin API proxy (standard JSON) instead of server function RPC.
      // The checkoutData field contains large serialized order objects that can
      // break TanStack Start's custom RPC serialization.
      const sp = new URLSearchParams();
      if (params.page) sp.set("page", String(params.page));
      if (params.limit) sp.set("limit", String(params.limit));
      if (params.search) sp.set("search", params.search);
      if (params.sort) sp.set("sort", params.sort);
      if (params.order) sp.set("order", params.order);
      const res = await fetch(
        `/api/v1/admin/abandoned-checkouts?${sp.toString()}`,
      );
      if (!res.ok)
        throw new Error(`Failed to fetch abandoned checkouts: ${res.status}`);
      const body = (await res.json()) as { success: boolean; data?: unknown };
      return (body.data ?? body) as {
        checkouts: unknown[];
        pagination: unknown;
      };
    },
    staleTime: STALE.MODERATE,
  });

// ═══════════════════════════════════════════════════════════════════
//  RBAC
// ═══════════════════════════════════════════════════════════════════

export const rbacRolesQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.rbac.roles(),
    queryFn: () => getRbacRoles(),
    staleTime: STALE.CONFIG,
  });

export const rbacPermissionsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.rbac.permissions(),
    queryFn: () => getRbacPermissions(),
    staleTime: STALE.CONFIG,
  });

// ═══════════════════════════════════════════════════════════════════
//  AUTH / ADMIN USERS
// ═══════════════════════════════════════════════════════════════════

export const adminUsersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.adminUsers.list(),
    queryFn: () => getAdminUsers(),
    staleTime: STALE.LOOKUP,
  });

export const accountSecurityQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.auth.accountSecurity(),
    queryFn: () => getAccountSecurity(),
    staleTime: STALE.LOOKUP,
  });

export const twoFaInfoQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.auth.twoFaInfo(),
    queryFn: () => get2faInfo(),
    staleTime: STALE.LOOKUP,
  });

// ═══════════════════════════════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════════════════════════════

export const settingsByCategoryQueryOptions = (category: string) =>
  queryOptions({
    queryKey: queryKeys.settings.byCategory(category),
    queryFn: () => getSettingsByCategory({ data: { category } }),
    staleTime: STALE.CONFIG,
  });

export const generalSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.general(),
    queryFn: () => getGeneralSettings(),
    staleTime: STALE.CONFIG,
  });

export const storefrontUrlQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.storefrontUrl(),
    queryFn: () => getStorefrontUrl(),
    staleTime: STALE.CONFIG,
  });

export const currencySettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.currency(),
    queryFn: () => getCurrencySettings(),
    staleTime: STALE.CONFIG,
  });

export const seoSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.seo(),
    queryFn: () => getSeoSettings(),
    staleTime: STALE.CONFIG,
  });

export const securitySettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.security(),
    queryFn: () => getSecuritySettings(),
    staleTime: STALE.CONFIG,
  });

export const authSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.auth(),
    queryFn: () => getAuthSettings(),
    staleTime: STALE.CONFIG,
  });

export const emailSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.email(),
    queryFn: () => getEmailSettings(),
    staleTime: STALE.CONFIG,
  });

export const firebaseSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.firebase(),
    queryFn: () => getFirebaseSettings(),
    staleTime: STALE.CONFIG,
  });

export const businessSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.business(),
    queryFn: () => getBusinessSettings(),
    staleTime: STALE.CONFIG,
  });

export const themeSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.theme(),
    queryFn: () => getThemeSettings(),
    staleTime: STALE.CONFIG,
  });

export const mediaSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.media(),
    queryFn: () => getMediaSettings(),
    staleTime: STALE.CONFIG,
  });

export const smsSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.sms(),
    queryFn: () => getSmsSettings(),
    staleTime: STALE.CONFIG,
  });

export const metaConversionsSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.metaConversions(),
    queryFn: () => getMetaConversionsSettings(),
    staleTime: STALE.CONFIG,
  });

export const metaConversionsLogsQueryOptions = (params: {
  page?: number;
  limit?: number;
}) =>
  queryOptions({
    queryKey: queryKeys.settings.metaConversionsLogs(params),
    queryFn: () => getMetaConversionsLogs({ data: params }),
    staleTime: STALE.MODERATE,
  });

export const allowedCountriesQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.allowedCountries(),
    queryFn: () => getAllowedCountries(),
    staleTime: STALE.CONFIG,
  });

export const paymentMethodsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.paymentMethods(),
    queryFn: () => getPaymentMethods(),
    staleTime: STALE.CONFIG,
  });

export const paymentGatewaySettingsQueryOptions = (gateway: string) =>
  queryOptions({
    queryKey: queryKeys.settings.paymentGateway(gateway),
    queryFn: () => getPaymentGatewaySettings({ data: { gateway } }),
    staleTime: STALE.CONFIG,
  });

export const notificationChannelsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.notificationChannels(),
    queryFn: () => getNotificationChannels(),
    staleTime: STALE.CONFIG,
  });

export const adminNotificationChannelsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.adminNotificationChannels(),
    queryFn: () => getAdminNotificationChannels(),
    staleTime: STALE.CONFIG,
  });

export const deliveryProvidersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.deliveryProviders(),
    queryFn: () => getDeliveryProviders(),
    staleTime: STALE.CONFIG,
  });

export const deliveryLocationsQueryOptions = (
  params: Record<string, string | number | boolean | undefined>,
) =>
  queryOptions({
    queryKey: queryKeys.settings.deliveryLocations(params),
    queryFn: () => getDeliveryLocations({ data: params }),
    staleTime: STALE.LOOKUP,
  });

export const allDeliveryLocationsQueryOptions = (params: { type?: string }) =>
  queryOptions({
    queryKey: queryKeys.settings.deliveryLocationsAll(params),
    queryFn: () => getAllDeliveryLocations({ data: params }),
    staleTime: STALE.LOOKUP,
  });

export const importPathaoStatusQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.importPathaoStatus(),
    queryFn: () => getImportPathaoStatus(),
    staleTime: STALE.LOOKUP,
  });

export const checkoutLanguagesQueryOptions = (
  params: Record<string, string | number | boolean | undefined>,
) =>
  queryOptions({
    queryKey: queryKeys.settings.checkoutLanguages(params),
    queryFn: () => getCheckoutLanguages({ data: params }),
    staleTime: STALE.CONFIG,
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
    queryKey: queryKeys.settings.shippingMethods(params),
    queryFn: () => getShippingMethods({ data: params }),
    staleTime: STALE.CONFIG,
  });

export const heroSlidersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.heroSliders(),
    queryFn: () => getHeroSliders(),
    staleTime: STALE.CONFIG,
  });

// ═══════════════════════════════════════════════════════════════════
//  AI
// ═══════════════════════════════════════════════════════════════════

export const aiPromptsQueryOptions = (type: string) =>
  queryOptions({
    queryKey: queryKeys.ai.prompts(type),
    queryFn: () => getAiPrompts({ data: { type } }),
    staleTime: STALE.LOOKUP,
  });

// ═══════════════════════════════════════════════════════════════════
//  CACHE
// ═══════════════════════════════════════════════════════════════════

export const cacheStatsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.cache.stats(),
    queryFn: () => getCacheStats(),
    staleTime: STALE.REALTIME,
  });

export const cacheLastClearedQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.cache.lastCleared(),
    queryFn: () => getCacheLastCleared(),
    staleTime: STALE.REALTIME,
  });

export const cacheGroupsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.cache.groups(),
    queryFn: () => getCacheGroups(),
    staleTime: STALE.REALTIME,
  });

// ═══════════════════════════════════════════════════════════════════
//  SETUP
// ═══════════════════════════════════════════════════════════════════

export const setupStatusQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.setup.status(),
    queryFn: () => getSetupStatus(),
    staleTime: STALE.STATIC,
  });

// ═══════════════════════════════════════════════════════════════════
//  FIREBASE CONFIG
// ═══════════════════════════════════════════════════════════════════

export const firebaseConfigQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.firebase.config(),
    queryFn: () => getFirebaseConfig(),
    staleTime: STALE.CONFIG,
  });
