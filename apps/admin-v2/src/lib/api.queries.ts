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
import { queryKeys } from "./query-keys";
import type { WidgetsQueryInput } from "./api-functions/widgets";
import type { CustomersQueryInput } from "./api-functions/customers";
import type { ProductsQueryInput } from "./api-functions/products";
import type { OrdersQueryInput } from "./api-functions/orders";
import type { CategoriesQueryInput } from "./api-functions/categories";
import type { CollectionsQueryInput } from "./api-functions/collections";
import type {
  AttributesQueryInput,
  AttributeValuesQueryInput,
} from "./api-functions/attributes";
import type { DiscountsQueryInput } from "./api-functions/discounts";
import type { NavigationPreviewProductsInput } from "./api-functions/navigation";
import type { PagesQueryInput } from "./api-functions/pages";
import type { CheckoutLanguagesQueryInput } from "./api-functions/checkout-languages";
import type { InventoryQueryInput } from "./api-functions/inventory";
import type { MediaListQueryInput } from "./api-functions/media";
import type { DeliveryLocationsQueryInput } from "./api-functions/delivery";
import type { ShippingMethodsQueryInput } from "./api-functions/shipping-methods";

const aiApi = () => import("./api-functions/ai");
const analyticsApi = () => import("./api-functions/analytics");
const attributesApi = () => import("./api-functions/attributes");
const authManagementApi = () => import("./api-functions/auth-management");
const cacheApi = () => import("./api-functions/cache");
const categoriesApi = () => import("./api-functions/categories");
const checkoutLanguagesApi = () => import("./api-functions/checkout-languages");
const collectionsApi = () => import("./api-functions/collections");
const customersApi = () => import("./api-functions/customers");
const dashboardApi = () => import("./api-functions/dashboard");
const deliveryApi = () => import("./api-functions/delivery");
const discountsApi = () => import("./api-functions/discounts");
const firebaseApi = () => import("./api-functions/firebase");
const fraudCheckerApi = () => import("./api-functions/fraud-checker");
const heroSlidersApi = () => import("./api-functions/hero-sliders");
const inventoryApi = () => import("./api-functions/inventory");
const mediaApi = () => import("./api-functions/media");
const navigationApi = () => import("./api-functions/navigation");
const ordersApi = () => import("./api-functions/orders");
const pagesApi = () => import("./api-functions/pages");
const productsApi = () => import("./api-functions/products");
const rbacApi = () => import("./api-functions/rbac");
const settingsApi = () => import("./api-functions/settings");
const shippingMethodsApi = () => import("./api-functions/shipping-methods");
const widgetsApi = () => import("./api-functions/widgets");

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
    queryFn: () => dashboardApi().then((api) => api.getDashboardData()),
    staleTime: STALE.MODERATE,
  });

export const dashboardSummaryQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.dashboard.summary(),
    queryFn: () => dashboardApi().then((api) => api.getDashboardSummary()),
    staleTime: STALE.MODERATE,
  });

export const dashboardActivityQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.dashboard.activity(),
    queryFn: () => dashboardApi().then((api) => api.getDashboardActivity()),
    staleTime: STALE.MODERATE,
  });

// ═══════════════════════════════════════════════════════════════════
//  PRODUCTS
// ═══════════════════════════════════════════════════════════════════

export const productsQueryOptions = (params: ProductsQueryInput) =>
  queryOptions({
    queryKey: queryKeys.products.list(params),
    queryFn: () => productsApi().then((api) => api.getProducts({ data: params })),
    staleTime: STALE.MODERATE,
  });

export const productQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.products.detail(id),
    queryFn: () => productsApi().then((api) => api.getProduct({ data: { id } })),
    staleTime: 0,
  });

export const productStatsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.products.stats(),
    queryFn: () => productsApi().then((api) => api.getProductStats()),
    staleTime: STALE.MODERATE,
  });

export const productVariantsQueryOptions = (productId: string) =>
  queryOptions({
    queryKey: queryKeys.products.variants(productId),
    queryFn: () =>
      productsApi().then((api) =>
        api.getProductVariants({ data: { productId } }),
      ),
    staleTime: STALE.MODERATE,
  });

export const variantSortOrderQueryOptions = (productId: string) =>
  queryOptions({
    queryKey: queryKeys.products.variantSortOrder(productId),
    queryFn: () =>
      productsApi().then((api) =>
        api.getVariantSortOrder({ data: { productId } }),
      ),
    staleTime: STALE.MODERATE,
  });

// ═══════════════════════════════════════════════════════════════════
//  CATEGORIES
// ═══════════════════════════════════════════════════════════════════

export const categoriesQueryOptions = (params: CategoriesQueryInput) =>
  queryOptions({
    queryKey: queryKeys.categories.list(params),
    queryFn: () =>
      categoriesApi().then((api) => api.getCategories({ data: params })),
    staleTime: STALE.MODERATE,
  });

export const categoryQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.categories.detail(id),
    queryFn: () =>
      categoriesApi().then((api) => api.getCategory({ data: { id } })),
    staleTime: 0,
  });

export const categoryFormOptionsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.categories.formOptions(),
    queryFn: () => categoriesApi().then((api) => api.getCategoryFormOptions()),
    staleTime: STALE.LOOKUP,
  });

// ═══════════════════════════════════════════════════════════════════
//  COLLECTIONS
// ═══════════════════════════════════════════════════════════════════

export const collectionsQueryOptions = (params: CollectionsQueryInput) =>
  queryOptions({
    queryKey: queryKeys.collections.list(params),
    queryFn: () =>
      collectionsApi().then((api) => api.getCollections({ data: params })),
    staleTime: STALE.MODERATE,
  });

export const collectionQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.collections.detail(id),
    queryFn: () =>
      collectionsApi().then((api) => api.getCollection({ data: { id } })),
    staleTime: 0,
  });

export const collectionFormOptionsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.collections.formOptions(),
    queryFn: () =>
      collectionsApi().then((api) => api.getCollectionFormOptions()),
    staleTime: STALE.LOOKUP,
  });

// ═══════════════════════════════════════════════════════════════════
//  ORDERS
// ═══════════════════════════════════════════════════════════════════

export const ordersQueryOptions = (params: OrdersQueryInput) =>
  queryOptions({
    queryKey: queryKeys.orders.list(params),
    queryFn: () => ordersApi().then((api) => api.getOrders({ data: params })),
    staleTime: STALE.FAST,
  });

export const orderQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.orders.detail(id),
    queryFn: () => ordersApi().then((api) => api.getOrder({ data: { id } })),
    staleTime: 0,
  });

export const orderFormDataQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.orders.formData(id),
    queryFn: () =>
      ordersApi().then((api) => api.getOrderFormData({ data: { id } })),
    staleTime: 0,
  });

export const orderItemsQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: queryKeys.orders.items(orderId),
    queryFn: () =>
      ordersApi().then((api) => api.getOrderItems({ data: { orderId } })),
    staleTime: STALE.FAST,
  });

export const orderPaymentsQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: queryKeys.orders.payments(orderId),
    queryFn: () =>
      ordersApi().then((api) => api.getOrderPayments({ data: { orderId } })),
    staleTime: 0,
  });

export const orderCodQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: queryKeys.orders.cod(orderId),
    queryFn: () =>
      ordersApi().then((api) => api.getOrderCod({ data: { orderId } })),
    staleTime: 0,
  });

export const orderShipmentsQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: queryKeys.orders.shipments(orderId),
    queryFn: () =>
      ordersApi().then((api) => api.getOrderShipments({ data: { orderId } })),
    staleTime: 0,
  });

// ═══════════════════════════════════════════════════════════════════
//  CUSTOMERS
// ═══════════════════════════════════════════════════════════════════

export const customersQueryOptions = (params: CustomersQueryInput) =>
  queryOptions({
    queryKey: queryKeys.customers.list(params),
    queryFn: () =>
      customersApi().then((api) => api.getCustomers({ data: params })),
    staleTime: STALE.MODERATE,
  });

export const customerQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.customers.detail(id),
    queryFn: () =>
      customersApi().then((api) => api.getCustomer({ data: { id } })),
    staleTime: 0,
  });

export const customerHistoryQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.customers.history(id),
    queryFn: () =>
      customersApi().then((api) =>
        api.getCustomerHistory({ data: { id } }),
      ),
    staleTime: 0,
  });

// ═══════════════════════════════════════════════════════════════════
//  DISCOUNTS
// ═══════════════════════════════════════════════════════════════════

export const discountsQueryOptions = (params: DiscountsQueryInput) =>
  queryOptions({
    queryKey: queryKeys.discounts.list(params),
    queryFn: () =>
      discountsApi().then((api) => api.getDiscounts({ data: params })),
    staleTime: STALE.MODERATE,
  });

export const discountQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.discounts.detail(id),
    queryFn: () =>
      discountsApi().then((api) => api.getDiscount({ data: { id } })),
    staleTime: 0,
  });

// ═══════════════════════════════════════════════════════════════════
//  PAGES
// ═══════════════════════════════════════════════════════════════════

export const pagesQueryOptions = (params: PagesQueryInput) =>
  queryOptions({
    queryKey: queryKeys.pages.list(params),
    queryFn: () => pagesApi().then((api) => api.getPages({ data: params })),
    staleTime: STALE.MODERATE,
  });

export const pageQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.pages.detail(id),
    queryFn: () => pagesApi().then((api) => api.getPage({ data: { id } })),
    staleTime: 0,
  });

// ═══════════════════════════════════════════════════════════════════
//  WIDGETS
// ═══════════════════════════════════════════════════════════════════

export const widgetsQueryOptions = (params: WidgetsQueryInput) =>
  queryOptions({
    queryKey: queryKeys.widgets.list(params),
    queryFn: () => widgetsApi().then((api) => api.getWidgets({ data: params })),
    staleTime: STALE.MODERATE,
  });

export const widgetQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.widgets.detail(id),
    queryFn: () => widgetsApi().then((api) => api.getWidget({ data: { id } })),
    staleTime: 0,
  });

export const widgetHistoryQueryOptions = (widgetId: string) =>
  queryOptions({
    queryKey: queryKeys.widgets.history(widgetId),
    queryFn: () =>
      widgetsApi().then((api) => api.getWidgetHistory({ data: { widgetId } })),
    staleTime: STALE.SLOW,
  });

// ═══════════════════════════════════════════════════════════════════
//  ATTRIBUTES
// ═══════════════════════════════════════════════════════════════════

export const attributesQueryOptions = (params: AttributesQueryInput) =>
  queryOptions({
    queryKey: queryKeys.attributes.list(params),
    queryFn: () =>
      attributesApi().then((api) => api.getAttributes({ data: params })),
    staleTime: STALE.LOOKUP,
  });

export const attributeValuesQueryOptions = (params: AttributeValuesQueryInput) =>
  queryOptions({
    queryKey: queryKeys.attributes.values(params),
    queryFn: () =>
      attributesApi().then((api) => api.getAttributeValues({ data: params })),
    staleTime: STALE.LOOKUP,
  });

// ═══════════════════════════════════════════════════════════════════
//  ANALYTICS SCRIPTS
// ═══════════════════════════════════════════════════════════════════

export const analyticsScriptsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.analytics.list(),
    queryFn: () => analyticsApi().then((api) => api.getAnalyticsScripts()),
    staleTime: STALE.LOOKUP,
  });

export const analyticsScriptQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.analytics.detail(id),
    queryFn: () =>
      analyticsApi().then((api) => api.getAnalyticsScript({ data: { id } })),
    staleTime: 0,
  });

// ═══════════════════════════════════════════════════════════════════
//  INVENTORY
// ═══════════════════════════════════════════════════════════════════

export const inventoryQueryOptions = (params: InventoryQueryInput) =>
  queryOptions({
    queryKey: queryKeys.inventory.list(params),
    queryFn: () =>
      inventoryApi().then((api) => api.getInventory({ data: params })),
    staleTime: STALE.FAST,
  });

// ═══════════════════════════════════════════════════════════════════
//  MEDIA
// ═══════════════════════════════════════════════════════════════════

export const mediaListQueryOptions = (params: MediaListQueryInput) =>
  queryOptions({
    queryKey: queryKeys.media.list(params),
    queryFn: () => mediaApi().then((api) => api.getMediaList({ data: params })),
    staleTime: STALE.SLOW,
  });

export const mediaFoldersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.media.folders(),
    queryFn: () => mediaApi().then((api) => api.getMediaFolders()),
    staleTime: STALE.SLOW,
  });

// ═══════════════════════════════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════════════════════════════

export const navigationItemsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.navigation.items(),
    queryFn: () => navigationApi().then((api) => api.getNavigationItems()),
    staleTime: STALE.LOOKUP,
  });

export const navigationPreviewProductsQueryOptions = (
  params: NavigationPreviewProductsInput,
) =>
  queryOptions({
    queryKey: queryKeys.navigation.previewProducts(params),
    queryFn: () =>
      navigationApi().then((api) =>
        api.getNavigationPreviewProducts({ data: params }),
      ),
    staleTime: STALE.SLOW,
  });

// ═══════════════════════════════════════════════════════════════════
//  FRAUD CHECKER
// ═══════════════════════════════════════════════════════════════════

export const fraudCheckerProvidersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.fraudChecker.list(),
    queryFn: () =>
      fraudCheckerApi().then((api) => api.getFraudCheckerProviders()),
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
    queryFn: () => rbacApi().then((api) => api.getRbacRoles()),
    staleTime: STALE.CONFIG,
  });

export const rbacPermissionsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.rbac.permissions(),
    queryFn: () => rbacApi().then((api) => api.getRbacPermissions()),
    staleTime: STALE.CONFIG,
  });

// ═══════════════════════════════════════════════════════════════════
//  AUTH / ADMIN USERS
// ═══════════════════════════════════════════════════════════════════

export const adminUsersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.adminUsers.list(),
    queryFn: () => authManagementApi().then((api) => api.getAdminUsers()),
    staleTime: STALE.LOOKUP,
  });

export const accountSecurityQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.auth.accountSecurity(),
    queryFn: () =>
      authManagementApi().then((api) => api.getAccountSecurity()),
    staleTime: STALE.LOOKUP,
  });

export const twoFaInfoQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.auth.twoFaInfo(),
    queryFn: () => authManagementApi().then((api) => api.get2faInfo()),
    staleTime: STALE.LOOKUP,
  });

// ═══════════════════════════════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════════════════════════════

export const settingsByCategoryQueryOptions = (category: string) =>
  queryOptions({
    queryKey: queryKeys.settings.byCategory(category),
    queryFn: () =>
      settingsApi().then((api) =>
        api.getSettingsByCategory({ data: { category } }),
      ),
    staleTime: STALE.CONFIG,
  });

export const generalSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.general(),
    queryFn: () => settingsApi().then((api) => api.getGeneralSettings()),
    staleTime: STALE.CONFIG,
  });

export const storefrontUrlQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.storefrontUrl(),
    queryFn: () => settingsApi().then((api) => api.getStorefrontUrl()),
    staleTime: STALE.CONFIG,
  });

export const currencySettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.currency(),
    queryFn: () => settingsApi().then((api) => api.getCurrencySettings()),
    staleTime: STALE.CONFIG,
  });

export const seoSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.seo(),
    queryFn: () => settingsApi().then((api) => api.getSeoSettings()),
    staleTime: STALE.CONFIG,
  });

export const securitySettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.security(),
    queryFn: () => settingsApi().then((api) => api.getSecuritySettings()),
    staleTime: STALE.CONFIG,
  });

export const authSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.auth(),
    queryFn: () => settingsApi().then((api) => api.getAuthSettings()),
    staleTime: STALE.CONFIG,
  });

export const emailSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.email(),
    queryFn: () => settingsApi().then((api) => api.getEmailSettings()),
    staleTime: STALE.CONFIG,
  });

export const firebaseSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.firebase(),
    queryFn: () => settingsApi().then((api) => api.getFirebaseSettings()),
    staleTime: STALE.CONFIG,
  });

export const businessSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.business(),
    queryFn: () => settingsApi().then((api) => api.getBusinessSettings()),
    staleTime: STALE.CONFIG,
  });

export const themeSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.theme(),
    queryFn: () => settingsApi().then((api) => api.getThemeSettings()),
    staleTime: STALE.CONFIG,
  });

export const mediaSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.media(),
    queryFn: () => settingsApi().then((api) => api.getMediaSettings()),
    staleTime: STALE.CONFIG,
  });

export const smsSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.sms(),
    queryFn: () => settingsApi().then((api) => api.getSmsSettings()),
    staleTime: STALE.CONFIG,
  });

export const metaConversionsSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.metaConversions(),
    queryFn: () =>
      settingsApi().then((api) => api.getMetaConversionsSettings()),
    staleTime: STALE.CONFIG,
  });

export const metaConversionsLogsQueryOptions = (params: {
  page?: number;
  limit?: number;
}) =>
  queryOptions({
    queryKey: queryKeys.settings.metaConversionsLogs(params),
    queryFn: () =>
      settingsApi().then((api) =>
        api.getMetaConversionsLogs({ data: params }),
      ),
    staleTime: STALE.MODERATE,
  });

export const allowedCountriesQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.allowedCountries(),
    queryFn: () => settingsApi().then((api) => api.getAllowedCountries()),
    staleTime: STALE.CONFIG,
  });

export const paymentMethodsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.paymentMethods(),
    queryFn: () => settingsApi().then((api) => api.getPaymentMethods()),
    staleTime: STALE.CONFIG,
  });

export const paymentGatewaySettingsQueryOptions = (gateway: string) =>
  queryOptions({
    queryKey: queryKeys.settings.paymentGateway(gateway),
    queryFn: () =>
      settingsApi().then((api) =>
        api.getPaymentGatewaySettings({ data: { gateway } }),
      ),
    staleTime: STALE.CONFIG,
  });

export const notificationChannelsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.notificationChannels(),
    queryFn: () => settingsApi().then((api) => api.getNotificationChannels()),
    staleTime: STALE.CONFIG,
  });

export const adminNotificationChannelsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.adminNotificationChannels(),
    queryFn: () =>
      settingsApi().then((api) => api.getAdminNotificationChannels()),
    staleTime: STALE.CONFIG,
  });

export const deliveryProvidersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.deliveryProviders(),
    queryFn: () => deliveryApi().then((api) => api.getDeliveryProviders()),
    staleTime: STALE.CONFIG,
  });

export const deliveryLocationsQueryOptions = (
  params: DeliveryLocationsQueryInput,
) =>
  queryOptions({
    queryKey: queryKeys.settings.deliveryLocations(params),
    queryFn: () =>
      deliveryApi().then((api) => api.getDeliveryLocations({ data: params })),
    staleTime: STALE.LOOKUP,
  });

export const allDeliveryLocationsQueryOptions = (
  params: { type?: string },
) =>
  queryOptions({
    queryKey: queryKeys.settings.deliveryLocationsAll(params),
    queryFn: () =>
      deliveryApi().then((api) =>
        api.getAllDeliveryLocations({ data: params }),
      ),
    staleTime: STALE.LOOKUP,
  });

export const importPathaoStatusQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.importPathaoStatus(),
    queryFn: () => deliveryApi().then((api) => api.getImportPathaoStatus()),
    staleTime: STALE.LOOKUP,
  });

export const checkoutLanguagesQueryOptions = (
  params: CheckoutLanguagesQueryInput,
) =>
  queryOptions({
    queryKey: queryKeys.settings.checkoutLanguages(params),
    queryFn: () =>
      checkoutLanguagesApi().then((api) =>
        api.getCheckoutLanguages({ data: params }),
      ),
    staleTime: STALE.CONFIG,
  });

export const shippingMethodsQueryOptions = (
  params: ShippingMethodsQueryInput,
) =>
  queryOptions({
    queryKey: queryKeys.settings.shippingMethods(params),
    queryFn: () =>
      shippingMethodsApi().then((api) =>
        api.getShippingMethods({ data: params }),
      ),
    staleTime: STALE.CONFIG,
  });

export const heroSlidersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.heroSliders(),
    queryFn: () => heroSlidersApi().then((api) => api.getHeroSliders()),
    staleTime: STALE.CONFIG,
  });

// ═══════════════════════════════════════════════════════════════════
//  AI
// ═══════════════════════════════════════════════════════════════════

export const aiPromptsQueryOptions = (type: string) =>
  queryOptions({
    queryKey: queryKeys.ai.prompts(type),
    queryFn: () => aiApi().then((api) => api.getAiPrompts({ data: { type } })),
    staleTime: STALE.LOOKUP,
  });

// ═══════════════════════════════════════════════════════════════════
//  CACHE
// ═══════════════════════════════════════════════════════════════════

export const cacheStatsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.cache.stats(),
    queryFn: () => cacheApi().then((api) => api.getCacheStats()),
    staleTime: STALE.REALTIME,
  });

export const cacheLastClearedQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.cache.lastCleared(),
    queryFn: () => cacheApi().then((api) => api.getCacheLastCleared()),
    staleTime: STALE.REALTIME,
  });

export const cacheGroupsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.cache.groups(),
    queryFn: () => cacheApi().then((api) => api.getCacheGroups()),
    staleTime: STALE.REALTIME,
  });

// ═══════════════════════════════════════════════════════════════════
//  SETUP
// ═══════════════════════════════════════════════════════════════════

export const setupStatusQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.setup.status(),
    queryFn: () => authManagementApi().then((api) => api.getSetupStatus()),
    staleTime: STALE.STATIC,
  });

// ═══════════════════════════════════════════════════════════════════
//  FIREBASE CONFIG
// ═══════════════════════════════════════════════════════════════════

export const firebaseConfigQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.firebase.config(),
    queryFn: () => firebaseApi().then((api) => api.getFirebaseConfig()),
    staleTime: STALE.CONFIG,
  });
