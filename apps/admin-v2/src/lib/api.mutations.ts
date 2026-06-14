/**
 * TanStack Query mutation hooks for common admin operations.
 *
 * Each hook wraps a POST/PUT/DELETE server function with:
 * - Automatic cache invalidation on success
 * - Toast notifications for success/error
 * - Typed inputs
 *
 * Covers the domains used by the 5 reference routes (dashboard, products,
 * orders, categories, settings). Additional mutation hooks for other
 * domains should be added here as routes are converted.
 */

import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { getServerFnError } from "~/lib/api-helpers";
import { queryKeys } from "./query-keys";
import {
  // Widgets
  createWidget,
  updateWidget,
  deleteWidget,
  permanentDeleteWidget,
  restoreWidget,
  bulkDeleteWidgets,
  bulkRestoreWidgets,
  // Widget History
  createWidgetHistorySnapshot,
  deleteWidgetHistory,
  restoreWidgetHistory,
  type BulkDeleteWidgetsInput,
  type CreateWidgetHistorySnapshotInput,
  type CreateWidgetInput,
  type DeleteWidgetHistoryInput,
  type RestoreWidgetHistoryInput,
  type UpdateWidgetInput,
} from "./api-functions/widgets";
import {
  bulkDeleteCustomers,
  createCustomer,
  deleteCustomer,
  permanentDeleteCustomer,
  restoreCustomer,
  updateCustomer,
  type BulkDeleteCustomersInput,
  type CreateCustomerInput,
  type UpdateCustomerInput,
} from "./api-functions/customers";
import {
  bulkCreateProductVariants,
  bulkDeleteProducts,
  bulkDeleteProductVariants,
  bulkUpdateProductVariants,
  createProduct,
  createProductVariant,
  deleteProduct,
  deleteProductVariant,
  duplicateProductVariant,
  permanentDeleteProduct,
  restoreProduct,
  updateProduct,
  updateProductVariant,
  type BulkProductVariantInput,
  type CreateProductInput,
  type ProductVariantInput,
  type ProductVariantUpdateInput,
  type UpdateProductInput,
} from "./api-functions/products";
import {
  bulkDeleteOrders,
  createOrder,
  createOrderShipment,
  refundOrder,
  restoreOrder,
  returnOrder,
  updateFulfillmentStatus,
  updateOrder,
  updateOrderCod,
  updateOrderStatus,
  type BulkDeleteOrdersInput,
  type CreateOrderInput,
  type CreateOrderShipmentInput,
  type RefundOrderInput,
  type ReturnOrderInput,
  type UpdateFulfillmentStatusInput,
  type UpdateOrderCodInput,
  type UpdateOrderInput,
  type UpdateOrderStatusInput,
} from "./api-functions/orders";
import {
  bulkDeleteCategories,
  bulkRestoreCategories,
  createCategory,
  deleteCategory,
  deleteCategoryPermanent,
  restoreCategory,
  updateCategory,
  type CreateCategoryInput,
  type UpdateCategoryInput,
} from "./api-functions/categories";
import {
  bulkDeleteCollections,
  bulkRestoreCollections,
  createCollection,
  deleteCollection,
  deleteCollectionPermanent,
  reorderCollections,
  restoreCollection,
  updateCollection,
  type CreateCollectionInput,
  type UpdateCollectionInput,
} from "./api-functions/collections";
import {
  saveFooterConfig,
  saveHeaderConfig,
  type FooterConfigInput,
  type HeaderConfigInput,
} from "./api-functions/settings";
import {
  createAnalyticsScript,
  deleteAnalyticsScript,
  updateAnalyticsScript,
} from "./api-functions/analytics";
import {
  bulkDeleteAttributes,
  bulkRestoreAttributes,
  createAttribute,
  deleteAttribute,
  deleteAttributePermanent,
  restoreAttribute,
  updateAttribute,
  type CreateAttributeInput,
  type UpdateAttributeInput,
} from "./api-functions/attributes";
import {
  bulkDeleteDiscounts,
  bulkRestoreDiscounts,
  createDiscount,
  deleteDiscount,
  permanentDeleteDiscount,
  restoreDiscount,
  toggleDiscountStatus,
  updateDiscount,
  type CreateDiscountInput,
  type DiscountDto,
  type UpdateDiscountInput,
} from "./api-functions/discounts";
import {
  createMediaFolder,
  deleteMedia,
  deleteMediaFolder,
  moveMediaFiles,
  renameMediaFolder,
  updateMedia,
  type CreateMediaFolderInput,
  type MoveMediaFilesInput,
  type RenameMediaFolderInput,
  type UpdateMediaInput,
} from "./api-functions/media";
import {
  bulkDeletePages,
  bulkRestorePages,
  createPage,
  deletePage,
  permanentDeletePage,
  restorePage,
  updatePage,
  type CreatePageInput,
  type UpdatePageInput,
} from "./api-functions/pages";
import {
  type SettingsPayload,
  updateAuthSettings,
  updateBusinessSettings,
  updateCurrencySettings,
  updateEmailSettings,
  updateFirebaseSettings,
  updateMediaSettings,
  updateSecuritySettings,
  updateSeoSettings,
  updateSettingsByCategory,
  updateSmsSettings,
  updateStorefrontUrl,
  updateThemeSettings,
} from "./api-functions/settings";
import {
  createCheckoutLanguage,
  deleteCheckoutLanguage,
  restoreCheckoutLanguage,
  softDeleteCheckoutLanguage,
  type CheckoutLanguageWriteInput,
  updateCheckoutLanguage,
} from "./api-functions/checkout-languages";
import {
  bulkDeleteDeliveryLocations,
  cleanAllDeliveryLocations,
  createDeliveryLocation,
  deleteDeliveryLocation,
  type DeliveryLocationWriteInput,
  updateDeliveryLocation,
} from "./api-functions/delivery";
import {
  createShippingMethod,
  deleteShippingMethod,
  permanentDeleteShippingMethod,
  restoreShippingMethod,
  type ShippingMethodWriteInput,
  updateShippingMethod,
} from "./api-functions/shipping-methods";

type DateTransportValue = string | number | Date;

type DiscountMutationInput = Omit<
  CreateDiscountInput,
  "startDate" | "endDate"
> & {
  startDate: DateTransportValue;
  endDate?: DateTransportValue | null;
};

type UpdateDiscountMutationInput = { id: string } & DiscountMutationInput;

function serializeDateTransport(value: DateTransportValue): string | number {
  return value instanceof Date ? value.toISOString() : value;
}

function serializeOptionalDateTransport(
  value: DateTransportValue | null | undefined,
): string | number | null {
  return value == null ? null : serializeDateTransport(value);
}

function serializeCreateDiscountInput(
  data: DiscountMutationInput,
): CreateDiscountInput {
  return {
    ...data,
    startDate: serializeDateTransport(data.startDate),
    endDate: serializeOptionalDateTransport(data.endDate),
  };
}

function serializeUpdateDiscountInput(
  data: UpdateDiscountMutationInput,
): UpdateDiscountInput {
  return {
    ...data,
    startDate: serializeDateTransport(data.startDate),
    endDate: serializeOptionalDateTransport(data.endDate),
  };
}

function invalidateDashboardQueries(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
}

function invalidateProductStatsQueries(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: queryKeys.products.stats() });
}

// ═══════════════════════════════════════════════════════════════════
//  PRODUCTS
// ═══════════════════════════════════════════════════════════════════

export function useCreateProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateProductInput) => createProduct({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
      invalidateProductStatsQueries(queryClient);
      invalidateDashboardQueries(queryClient);
      toast.success("Product created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create product")),
  });
}

export function useUpdateProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateProductInput) => updateProduct({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
      invalidateProductStatsQueries(queryClient);
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.detail(variables.id),
      });
      toast.success("Product updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update product")),
  });
}

export function useDeleteProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteProduct({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
      invalidateProductStatsQueries(queryClient);
      invalidateDashboardQueries(queryClient);
      queryClient.removeQueries({ queryKey: queryKeys.products.detail(id) });
      toast.success("Product moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete product")),
  });
}

export function usePermanentDeleteProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => permanentDeleteProduct({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
      invalidateProductStatsQueries(queryClient);
      invalidateDashboardQueries(queryClient);
      queryClient.removeQueries({ queryKey: queryKeys.products.detail(id) });
      toast.success("Product permanently deleted");
    },
    onError: (err) =>
      toast.error(
        getServerFnError(err, "Failed to permanently delete product"),
      ),
  });
}

export function useRestoreProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreProduct({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
      invalidateProductStatsQueries(queryClient);
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.detail(id),
      });
      toast.success("Product restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore product")),
  });
}

export function useBulkDeleteProducts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { productIds: string[]; permanent?: boolean }) =>
      bulkDeleteProducts({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.products.list() });
      invalidateProductStatsQueries(queryClient);
      invalidateDashboardQueries(queryClient);
      toast.success(
        variables.permanent
          ? `${variables.productIds.length} products permanently deleted`
          : `${variables.productIds.length} products moved to trash`,
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete products")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  CATEGORIES
// ═══════════════════════════════════════════════════════════════════

export function useCreateCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateCategoryInput) => createCategory({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.formOptions(),
      });
      invalidateProductStatsQueries(queryClient);
      toast.success("Category created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create category")),
  });
}

export function useUpdateCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateCategoryInput) => updateCategory({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.detail(variables.id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.formOptions(),
      });
      invalidateProductStatsQueries(queryClient);
      toast.success("Category updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update category")),
  });
}

export function useDeleteCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteCategory({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.formOptions(),
      });
      invalidateProductStatsQueries(queryClient);
      queryClient.removeQueries({ queryKey: queryKeys.categories.detail(id) });
      toast.success("Category moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete category")),
  });
}

export function usePermanentDeleteCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteCategoryPermanent({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.formOptions(),
      });
      invalidateProductStatsQueries(queryClient);
      queryClient.removeQueries({ queryKey: queryKeys.categories.detail(id) });
      toast.success("Category permanently deleted");
    },
    onError: (err) =>
      toast.error(
        getServerFnError(err, "Failed to permanently delete category"),
      ),
  });
}

export function useRestoreCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreCategory({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.formOptions(),
      });
      invalidateProductStatsQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.detail(id),
      });
      toast.success("Category restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore category")),
  });
}

export function useBulkDeleteCategories() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { categoryIds: string[]; permanent?: boolean }) =>
      bulkDeleteCategories({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.formOptions(),
      });
      invalidateProductStatsQueries(queryClient);
      toast.success(
        variables.permanent
          ? `${variables.categoryIds.length} categories permanently deleted`
          : `${variables.categoryIds.length} categories moved to trash`,
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete categories")),
  });
}

export function useBulkRestoreCategories() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (categoryIds: string[]) =>
      bulkRestoreCategories({ data: { categoryIds } }),
    onSuccess: (_data, categoryIds) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.formOptions(),
      });
      invalidateProductStatsQueries(queryClient);
      toast.success(`${categoryIds.length} categories restored`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore categories")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  ORDERS
// ═══════════════════════════════════════════════════════════════════

export function useCreateOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateOrderInput) => createOrder({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      toast.success("Order created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create order")),
  });
}

export function useUpdateOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateOrderInput) => updateOrder({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.id),
      });
      toast.success("Order updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update order")),
  });
}

export function useUpdateOrderStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateOrderStatusInput) => updateOrderStatus({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      toast.success(`Order status updated to ${variables.status}`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update order status")),
  });
}

export function useCreateOrderShipment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateOrderShipmentInput) =>
      createOrderShipment({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.shipments(variables.orderId),
      });
      toast.success("Shipment created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create shipment")),
  });
}

export function useUpdateFulfillmentStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateFulfillmentStatusInput) =>
      updateFulfillmentStatus({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      invalidateDashboardQueries(queryClient);
      toast.success("Fulfillment status updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update fulfillment status")),
  });
}

export function useRefundOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: RefundOrderInput) => refundOrder({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.payments(variables.orderId),
      });
      toast.success("Refund processed");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to process refund")),
  });
}

export function useUpdateOrderCod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateOrderCodInput) => updateOrderCod({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.payments(variables.orderId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.cod(variables.orderId),
      });
      toast.success("COD action recorded");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to record COD action")),
  });
}

export function useReturnOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ReturnOrderInput) => returnOrder({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      toast.success("Return processed");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to process return")),
  });
}

export function useRestoreOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreOrder({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(id) });
      toast.success("Order restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore order")),
  });
}

export function useBulkDeleteOrders() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: BulkDeleteOrdersInput) => bulkDeleteOrders({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      toast.success(
        variables.permanent
          ? `${variables.orderIds.length} orders permanently deleted`
          : `${variables.orderIds.length} orders moved to trash`,
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete orders")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════════════════════════════

export function useUpdateSettings(category: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: SettingsPayload) =>
      updateSettingsByCategory({ data: { category, settings } }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.byCategory(category),
      });
      toast.success("Settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update settings")),
  });
}

export function useSaveHeaderConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: HeaderConfigInput) => saveHeaderConfig({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.general() });
      toast.success("Header config saved");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to save header config")),
  });
}

export function useSaveFooterConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: FooterConfigInput) => saveFooterConfig({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.general() });
      toast.success("Footer config saved");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to save footer config")),
  });
}

export function useUpdateStorefrontUrl() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (storefrontUrl: string) =>
      updateStorefrontUrl({ data: { storefrontUrl } }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.storefrontUrl(),
      });
      toast.success("Storefront URL updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update storefront URL")),
  });
}

export function useUpdateCurrencySettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SettingsPayload) =>
      updateCurrencySettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.currency(),
      });
      toast.success("Currency settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update currency settings")),
  });
}

export function useUpdateSeoSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SettingsPayload) => updateSeoSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.seo() });
      toast.success("SEO settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update SEO settings")),
  });
}

export function useUpdateSecuritySettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SettingsPayload) =>
      updateSecuritySettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.security(),
      });
      toast.success("Security settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update security settings")),
  });
}

export function useUpdateAuthSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SettingsPayload) => updateAuthSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.auth() });
      toast.success("Auth settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update auth settings")),
  });
}

export function useUpdateEmailSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SettingsPayload) =>
      updateEmailSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.email() });
      toast.success("Email settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update email settings")),
  });
}

export function useUpdateFirebaseSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SettingsPayload) =>
      updateFirebaseSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.firebase(),
      });
      toast.success("Firebase settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update Firebase settings")),
  });
}

export function useUpdateBusinessSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SettingsPayload) =>
      updateBusinessSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.business(),
      });
      toast.success("Business settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update business settings")),
  });
}

export function useUpdateThemeSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SettingsPayload) =>
      updateThemeSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.theme() });
      toast.success("Theme settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update theme settings")),
  });
}

export function useUpdateMediaSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SettingsPayload) =>
      updateMediaSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.media() });
      toast.success("Media settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update media settings")),
  });
}

export function useUpdateSmsSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SettingsPayload) => updateSmsSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.sms() });
      toast.success("SMS settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update SMS settings")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  CUSTOMERS
// ═══════════════════════════════════════════════════════════════════

export function useCreateCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateCustomerInput) => createCustomer({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.customers.list() });
      invalidateDashboardQueries(queryClient);
      toast.success("Customer created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create customer")),
  });
}

export function useUpdateCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateCustomerInput) => updateCustomer({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.customers.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.customers.detail(variables.id),
      });
      toast.success("Customer updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update customer")),
  });
}

export function useDeleteCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteCustomer({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.customers.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.removeQueries({ queryKey: queryKeys.customers.detail(id) });
      toast.success("Customer moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete customer")),
  });
}

export function usePermanentDeleteCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => permanentDeleteCustomer({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.customers.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.removeQueries({ queryKey: queryKeys.customers.detail(id) });
      toast.success("Customer permanently deleted");
    },
    onError: (err) =>
      toast.error(
        getServerFnError(err, "Failed to permanently delete customer"),
      ),
  });
}

export function useRestoreCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreCustomer({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.customers.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.customers.detail(id),
      });
      toast.success("Customer restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore customer")),
  });
}

export function useBulkDeleteCustomers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: BulkDeleteCustomersInput) => bulkDeleteCustomers({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.customers.list() });
      invalidateDashboardQueries(queryClient);
      toast.success(
        variables.permanent
          ? `${variables.customerIds.length} customers permanently deleted`
          : `${variables.customerIds.length} customers moved to trash`,
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete customers")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  DISCOUNTS
// ═══════════════════════════════════════════════════════════════════

export function useCreateDiscount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: DiscountMutationInput) =>
      createDiscount({ data: serializeCreateDiscountInput(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discounts.list() });
      toast.success("Discount created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create discount")),
  });
}

export function useUpdateDiscount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateDiscountMutationInput) =>
      updateDiscount({ data: serializeUpdateDiscountInput(data) }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discounts.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.discounts.detail(variables.id),
      });
      toast.success("Discount updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update discount")),
  });
}

export function useDeleteDiscount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteDiscount({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discounts.list() });
      queryClient.removeQueries({ queryKey: queryKeys.discounts.detail(id) });
      toast.success("Discount moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete discount")),
  });
}

export function usePermanentDeleteDiscount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => permanentDeleteDiscount({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discounts.list() });
      queryClient.removeQueries({ queryKey: queryKeys.discounts.detail(id) });
      toast.success("Discount permanently deleted");
    },
    onError: (err) =>
      toast.error(
        getServerFnError(err, "Failed to permanently delete discount"),
      ),
  });
}

export function useRestoreDiscount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreDiscount({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discounts.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.discounts.detail(id),
      });
      toast.success("Discount restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore discount")),
  });
}

export function useToggleDiscountStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string; isActive: boolean }) =>
      toggleDiscountStatus({ data }),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.discounts.detail(variables.id),
      });
      const previous = queryClient.getQueryData(
        queryKeys.discounts.detail(variables.id),
      );
      queryClient.setQueryData<DiscountDto | undefined>(
        queryKeys.discounts.detail(variables.id),
        (old) => (old ? { ...old, isActive: variables.isActive } : old),
      );
      return { previous };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discounts.list() });
      toast.success("Discount status updated");
    },
    onError: (err, variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          queryKeys.discounts.detail(variables.id),
          context.previous,
        );
      }
      toast.error(getServerFnError(err, "Failed to toggle discount status"));
    },
    onSettled: (_data, _err, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.discounts.detail(variables.id),
      });
    },
  });
}

export function useBulkDeleteDiscounts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      discountIds?: string[];
      ids?: string[];
      permanent?: boolean;
    }) =>
      bulkDeleteDiscounts({
        data: {
          discountIds: data.discountIds ?? data.ids ?? [],
          permanent: data.permanent,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discounts.list() });
      toast.success("Discounts deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete discounts")),
  });
}

export function useBulkRestoreDiscounts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { discountIds?: string[]; ids?: string[] }) =>
      bulkRestoreDiscounts({
        data: { discountIds: data.discountIds ?? data.ids ?? [] },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discounts.list() });
      toast.success("Discounts restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore discounts")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  PAGES
// ═══════════════════════════════════════════════════════════════════

export function useCreatePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreatePageInput) => createPage({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      toast.success("Page created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create page")),
  });
}

export function useUpdatePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdatePageInput) => updatePage({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.pages.detail(variables.id),
      });
      toast.success("Page updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update page")),
  });
}

export function useDeletePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deletePage({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      queryClient.removeQueries({ queryKey: queryKeys.pages.detail(id) });
      toast.success("Page moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete page")),
  });
}

export function usePermanentDeletePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => permanentDeletePage({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      queryClient.removeQueries({ queryKey: queryKeys.pages.detail(id) });
      toast.success("Page permanently deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to permanently delete page")),
  });
}

export function useRestorePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restorePage({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.detail(id) });
      toast.success("Page restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore page")),
  });
}

export function useBulkDeletePages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { pageIds: string[]; permanent?: boolean }) =>
      bulkDeletePages({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      toast.success(
        variables.permanent
          ? `${variables.pageIds.length} pages permanently deleted`
          : `${variables.pageIds.length} pages moved to trash`,
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete pages")),
  });
}

export function useBulkRestorePages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => bulkRestorePages({ data: { ids } }),
    onSuccess: (_data, ids) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      toast.success(`${ids.length} pages restored`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore pages")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  WIDGETS
// ═══════════════════════════════════════════════════════════════════

export function useCreateWidget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateWidgetInput) => createWidget({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.widgets.list() });
      toast.success("Widget created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create widget")),
  });
}

export function useUpdateWidget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateWidgetInput) => updateWidget({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.widgets.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.widgets.detail(variables.id),
      });
      toast.success("Widget updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update widget")),
  });
}

export function useDeleteWidget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteWidget({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.widgets.list() });
      queryClient.removeQueries({ queryKey: queryKeys.widgets.detail(id) });
      toast.success("Widget moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete widget")),
  });
}

export function usePermanentDeleteWidget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => permanentDeleteWidget({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.widgets.list() });
      queryClient.removeQueries({ queryKey: queryKeys.widgets.detail(id) });
      toast.success("Widget permanently deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to permanently delete widget")),
  });
}

export function useRestoreWidget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreWidget({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.widgets.list() });
      queryClient.invalidateQueries({ queryKey: queryKeys.widgets.detail(id) });
      toast.success("Widget restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore widget")),
  });
}

export function useBulkDeleteWidgets() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: BulkDeleteWidgetsInput) => bulkDeleteWidgets({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.widgets.list() });
      toast.success(
        variables.permanent
          ? `${variables.ids.length} widgets permanently deleted`
          : `${variables.ids.length} widgets moved to trash`,
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete widgets")),
  });
}

export function useBulkRestoreWidgets() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => bulkRestoreWidgets({ data: { ids } }),
    onSuccess: (_data, ids) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.widgets.list() });
      toast.success(`${ids.length} widgets restored`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore widgets")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  ANALYTICS
// ═══════════════════════════════════════════════════════════════════

export function useCreateAnalyticsScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      createAnalyticsScript({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics.list() });
      toast.success("Analytics script created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create analytics script")),
  });
}

export function useUpdateAnalyticsScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string } & Record<string, unknown>) =>
      updateAnalyticsScript({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.analytics.detail(variables.id),
      });
      toast.success("Analytics script updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update analytics script")),
  });
}

export function useDeleteAnalyticsScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteAnalyticsScript({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics.list() });
      queryClient.removeQueries({ queryKey: queryKeys.analytics.detail(id) });
      toast.success("Analytics script deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete analytics script")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  COLLECTIONS
// ═══════════════════════════════════════════════════════════════════

export function useCreateCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateCollectionInput) => createCollection({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.formOptions(),
      });
      toast.success("Collection created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create collection")),
  });
}

export function useUpdateCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateCollectionInput) => updateCollection({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.detail(variables.id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.formOptions(),
      });
      toast.success("Collection updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update collection")),
  });
}

export function useDeleteCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteCollection({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.formOptions(),
      });
      queryClient.removeQueries({ queryKey: queryKeys.collections.detail(id) });
      toast.success("Collection moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete collection")),
  });
}

export function usePermanentDeleteCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteCollectionPermanent({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.formOptions(),
      });
      queryClient.removeQueries({ queryKey: queryKeys.collections.detail(id) });
      toast.success("Collection permanently deleted");
    },
    onError: (err) =>
      toast.error(
        getServerFnError(err, "Failed to permanently delete collection"),
      ),
  });
}

export function useRestoreCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreCollection({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.formOptions(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.detail(id),
      });
      toast.success("Collection restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore collection")),
  });
}

export function useReorderCollections() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { items: { id: string; sortOrder: number }[] }) =>
      reorderCollections({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections.list() });
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to reorder collections")),
  });
}

export function useBulkDeleteCollections() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { ids: string[]; permanent?: boolean }) =>
      bulkDeleteCollections({
        data: { collectionIds: data.ids, permanent: data.permanent },
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.formOptions(),
      });
      toast.success(
        `${variables.ids.length} collection(s) ${variables.permanent ? "permanently deleted" : "moved to trash"}`,
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete collections")),
  });
}

export function useBulkRestoreCollections() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { ids: string[] }) => bulkRestoreCollections({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.formOptions(),
      });
      toast.success(`${variables.ids.length} collection(s) restored`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore collections")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  ATTRIBUTES
// ═══════════════════════════════════════════════════════════════════

export function useCreateAttribute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateAttributeInput) => createAttribute({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attributes.list() });
      toast.success("Attribute created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create attribute")),
  });
}

export function useUpdateAttribute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateAttributeInput) => updateAttribute({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attributes.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.attributes.detail(variables.id),
      });
      toast.success("Attribute updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update attribute")),
  });
}

export function useDeleteAttribute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteAttribute({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attributes.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.attributes.values(),
      });
      queryClient.removeQueries({ queryKey: queryKeys.attributes.detail(id) });
      toast.success("Attribute moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete attribute")),
  });
}

export function usePermanentDeleteAttribute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteAttributePermanent({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attributes.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.attributes.values(),
      });
      queryClient.removeQueries({ queryKey: queryKeys.attributes.detail(id) });
      toast.success("Attribute permanently deleted");
    },
    onError: (err) =>
      toast.error(
        getServerFnError(err, "Failed to permanently delete attribute"),
      ),
  });
}

export function useRestoreAttribute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreAttribute({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attributes.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.attributes.values(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.attributes.detail(id),
      });
      toast.success("Attribute restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore attribute")),
  });
}

export function useBulkDeleteAttributes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { ids: string[]; permanent?: boolean }) =>
      bulkDeleteAttributes({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attributes.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.attributes.values(),
      });
      toast.success(
        `${variables.ids.length} attribute(s) ${variables.permanent ? "permanently deleted" : "moved to trash"}`,
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete attributes")),
  });
}

export function useBulkRestoreAttributes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { ids: string[] }) => bulkRestoreAttributes({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attributes.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.attributes.values(),
      });
      toast.success(`${variables.ids.length} attribute(s) restored`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore attributes")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  PRODUCT VARIANTS
// ═══════════════════════════════════════════════════════════════════

export function useCreateProductVariant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      productId: string;
      variant: ProductVariantInput;
    }) => createProductVariant({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.detail(variables.productId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.variants(variables.productId),
      });
      toast.success("Variant created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create variant")),
  });
}

export function useUpdateProductVariant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      productId: string;
      variantId: string;
      variant: ProductVariantInput;
    }) => updateProductVariant({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.detail(variables.productId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.variants(variables.productId),
      });
      toast.success("Variant updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update variant")),
  });
}

export function useDeleteProductVariant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { productId: string; variantId: string }) =>
      deleteProductVariant({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.detail(variables.productId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.variants(variables.productId),
      });
      toast.success("Variant deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete variant")),
  });
}

export function useBulkCreateProductVariants() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      productId: string;
      variants: BulkProductVariantInput[];
    }) => bulkCreateProductVariants({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.detail(variables.productId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.variants(variables.productId),
      });
      toast.success("Variants created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create variants")),
  });
}

export function useBulkUpdateProductVariants() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      productId: string;
      updates: ProductVariantUpdateInput[];
    }) => bulkUpdateProductVariants({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.detail(variables.productId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.variants(variables.productId),
      });
      toast.success("Variants updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update variants")),
  });
}

export function useBulkDeleteProductVariants() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { productId: string; variantIds: string[] }) =>
      bulkDeleteProductVariants({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.detail(variables.productId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.variants(variables.productId),
      });
      toast.success(`${variables.variantIds.length} variants deleted`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete variants")),
  });
}

export function useDuplicateProductVariant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { productId: string; variantId: string }) =>
      duplicateProductVariant({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.detail(variables.productId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.variants(variables.productId),
      });
      toast.success("Variant duplicated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to duplicate variant")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  MEDIA
// ═══════════════════════════════════════════════════════════════════

export function useDeleteMedia() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) => deleteMedia({ data: { fileId } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.media.list() });
      queryClient.invalidateQueries({ queryKey: queryKeys.media.folders() });
      toast.success("File deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete file")),
  });
}

export function useUpdateMedia() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateMediaInput) => updateMedia({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.media.list() });
      toast.success("File updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update file")),
  });
}

export function useMoveMediaFiles() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: MoveMediaFilesInput) => moveMediaFiles({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.media.list() });
      queryClient.invalidateQueries({ queryKey: queryKeys.media.folders() });
      toast.success("Files moved");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to move files")),
  });
}

export function useCreateMediaFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateMediaFolderInput) => createMediaFolder({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.media.folders() });
      toast.success("Folder created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create folder")),
  });
}

export function useDeleteMediaFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (folderId: string) => deleteMediaFolder({ data: { folderId } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.media.folders() });
      queryClient.invalidateQueries({ queryKey: queryKeys.media.list() });
      toast.success("Folder deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete folder")),
  });
}

export function useRenameMediaFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: RenameMediaFolderInput) => renameMediaFolder({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.media.folders() });
      toast.success("Folder renamed");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to rename folder")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  WIDGET HISTORY
// ═══════════════════════════════════════════════════════════════════

export function useCreateWidgetHistorySnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateWidgetHistorySnapshotInput) =>
      createWidgetHistorySnapshot({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.widgets.history(variables.widgetId),
      });
      toast.success("History snapshot created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create history snapshot")),
  });
}

export function useDeleteWidgetHistory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: DeleteWidgetHistoryInput) => deleteWidgetHistory({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.widgets.history(variables.widgetId),
      });
      toast.success("History entry deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete history entry")),
  });
}

export function useRestoreWidgetHistory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: RestoreWidgetHistoryInput) =>
      restoreWidgetHistory({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.widgets.history(variables.widgetId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.widgets.detail(variables.widgetId),
      });
      toast.success("Widget restored from history");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore from history")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  CHECKOUT LANGUAGES
// ═══════════════════════════════════════════════════════════════════

export function useCreateCheckoutLanguage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CheckoutLanguageWriteInput) =>
      createCheckoutLanguage({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.checkoutLanguages(),
      });
      toast.success("Checkout language created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create checkout language")),
  });
}

export function useUpdateCheckoutLanguage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string; update: CheckoutLanguageWriteInput }) =>
      updateCheckoutLanguage({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.checkoutLanguages(),
      });
      toast.success("Checkout language updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update checkout language")),
  });
}

export function useSoftDeleteCheckoutLanguage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string }) => softDeleteCheckoutLanguage({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.checkoutLanguages(),
      });
      toast.success("Checkout language moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to move to trash")),
  });
}

export function useDeleteCheckoutLanguage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string }) => deleteCheckoutLanguage({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.checkoutLanguages(),
      });
      toast.success("Checkout language permanently deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to permanently delete")),
  });
}

export function useRestoreCheckoutLanguage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string }) => restoreCheckoutLanguage({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.checkoutLanguages(),
      });
      toast.success("Checkout language restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore language")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  SHIPPING METHODS
// ═══════════════════════════════════════════════════════════════════

export function useCreateShippingMethod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ShippingMethodWriteInput) =>
      createShippingMethod({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.shippingMethods(),
      });
      toast.success("Shipping method created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create shipping method")),
  });
}

export function useUpdateShippingMethod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string; update: ShippingMethodWriteInput }) =>
      updateShippingMethod({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.shippingMethods(),
      });
      toast.success("Shipping method updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update shipping method")),
  });
}

export function useDeleteShippingMethod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string }) => deleteShippingMethod({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.shippingMethods(),
      });
      toast.success("Shipping method moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to move to trash")),
  });
}

export function usePermanentDeleteShippingMethod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string }) =>
      permanentDeleteShippingMethod({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.shippingMethods(),
      });
      toast.success("Shipping method permanently deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to permanently delete method")),
  });
}

export function useRestoreShippingMethod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string }) => restoreShippingMethod({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.shippingMethods(),
      });
      toast.success("Shipping method restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore shipping method")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  DELIVERY LOCATIONS
// ═══════════════════════════════════════════════════════════════════

export function useCreateDeliveryLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: DeliveryLocationWriteInput) =>
      createDeliveryLocation({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.deliveryLocations(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.deliveryLocationsAll(),
      });
      toast.success("Location created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create location")),
  });
}

export function useUpdateDeliveryLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string; update: Partial<DeliveryLocationWriteInput> }) =>
      updateDeliveryLocation({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.deliveryLocations(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.deliveryLocationsAll(),
      });
      toast.success("Location updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update location")),
  });
}

export function useDeleteDeliveryLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string }) => deleteDeliveryLocation({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.deliveryLocations(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.deliveryLocationsAll(),
      });
      toast.success("Location deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete location")),
  });
}

export function useBulkDeleteDeliveryLocations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { ids: string[] }) =>
      bulkDeleteDeliveryLocations({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.deliveryLocations(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.deliveryLocationsAll(),
      });
      toast.success(`${variables.ids.length} location(s) deleted`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete locations")),
  });
}

export function useCleanAllDeliveryLocations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => cleanAllDeliveryLocations(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.deliveryLocations(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.deliveryLocationsAll(),
      });
      toast.success("All delivery locations cleared");
    },
    onError: (err) =>
      toast.error(
        getServerFnError(err, "Failed to clean all delivery locations"),
      ),
  });
}
