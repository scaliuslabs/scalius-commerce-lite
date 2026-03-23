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

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getServerFnError } from "~/lib/api-helpers";
import {
  // Products
  createProduct,
  updateProduct,
  deleteProduct,
  permanentDeleteProduct,
  restoreProduct,
  bulkDeleteProducts,
  // Categories
  createCategory,
  updateCategory,
  deleteCategory,
  deleteCategoryPermanent,
  restoreCategory,
  bulkDeleteCategories,
  bulkRestoreCategories,
  // Orders
  createOrder,
  updateOrder,
  updateOrderStatus,
  createOrderShipment,
  updateOrderCod,
  refundOrder,
  returnOrder,
  restoreOrder,
  bulkDeleteOrders,
  // Customers
  createCustomer,
  updateCustomer,
  deleteCustomer,
  permanentDeleteCustomer,
  restoreCustomer,
  bulkDeleteCustomers,
  // Discounts
  createDiscount,
  updateDiscount,
  deleteDiscount,
  permanentDeleteDiscount,
  restoreDiscount,
  toggleDiscountStatus,
  bulkDeleteDiscounts,
  bulkRestoreDiscounts,
  // Pages
  createPage,
  updatePage,
  deletePage,
  permanentDeletePage,
  restorePage,
  bulkDeletePages,
  bulkRestorePages,
  // Widgets
  createWidget,
  updateWidget,
  deleteWidget,
  restoreWidget,
  bulkDeleteWidgets,
  bulkRestoreWidgets,
  // Analytics
  createAnalyticsScript,
  updateAnalyticsScript,
  deleteAnalyticsScript,
  // Settings
  updateSettingsByCategory,
  saveHeaderConfig,
  saveFooterConfig,
  updateStorefrontUrl,
  updateCurrencySettings,
  updateSeoSettings,
  updateSecuritySettings,
  updateAuthSettings,
  updateEmailSettings,
  updateFirebaseSettings,
  updateBusinessSettings,
  updateThemeSettings,
  updateSmsSettings,
} from "./api.functions";

// ═══════════════════════════════════════════════════════════════════
//  PRODUCTS
// ═══════════════════════════════════════════════════════════════════

export function useCreateProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      createProduct({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success("Product created");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to create product")),
  });
}

export function useUpdateProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string } & Record<string, unknown>) =>
      updateProduct({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["products", "detail", variables.id] });
      toast.success("Product updated");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to update product")),
  });
}

export function useDeleteProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteProduct({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success("Product moved to trash");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to delete product")),
  });
}

export function usePermanentDeleteProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => permanentDeleteProduct({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success("Product permanently deleted");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to permanently delete product")),
  });
}

export function useRestoreProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreProduct({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success("Product restored");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to restore product")),
  });
}

export function useBulkDeleteProducts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { productIds: string[]; permanent?: boolean }) =>
      bulkDeleteProducts({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success(
        variables.permanent
          ? `${variables.productIds.length} products permanently deleted`
          : `${variables.productIds.length} products moved to trash`,
      );
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to delete products")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  CATEGORIES
// ═══════════════════════════════════════════════════════════════════

export function useCreateCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      createCategory({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      toast.success("Category created");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to create category")),
  });
}

export function useUpdateCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string } & Record<string, unknown>) =>
      updateCategory({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      queryClient.invalidateQueries({ queryKey: ["categories", "detail", variables.id] });
      toast.success("Category updated");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to update category")),
  });
}

export function useDeleteCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteCategory({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      toast.success("Category moved to trash");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to delete category")),
  });
}

export function usePermanentDeleteCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteCategoryPermanent({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      toast.success("Category permanently deleted");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to permanently delete category")),
  });
}

export function useRestoreCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreCategory({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      toast.success("Category restored");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to restore category")),
  });
}

export function useBulkDeleteCategories() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { categoryIds: string[]; permanent?: boolean }) =>
      bulkDeleteCategories({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      toast.success(
        variables.permanent
          ? `${variables.categoryIds.length} categories permanently deleted`
          : `${variables.categoryIds.length} categories moved to trash`,
      );
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to delete categories")),
  });
}

export function useBulkRestoreCategories() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (categoryIds: string[]) =>
      bulkRestoreCategories({ data: { categoryIds } }),
    onSuccess: (_data, categoryIds) => {
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      toast.success(`${categoryIds.length} categories restored`);
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to restore categories")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  ORDERS
// ═══════════════════════════════════════════════════════════════════

export function useCreateOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      createOrder({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      toast.success("Order created");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to create order")),
  });
}

export function useUpdateOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string } & Record<string, unknown>) =>
      updateOrder({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["orders", "detail", variables.id] });
      toast.success("Order updated");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to update order")),
  });
}

export function useUpdateOrderStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { orderId: string; status: string; note?: string }) =>
      updateOrderStatus({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["orders", "detail", variables.orderId] });
      toast.success(`Order status updated to ${variables.status}`);
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to update order status")),
  });
}

export function useCreateOrderShipment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      orderId: string;
      shipment?: Record<string, unknown>;
      providerId?: string;
      options?: Record<string, unknown>;
    }) => createOrderShipment({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["orders", "detail", variables.orderId] });
      queryClient.invalidateQueries({ queryKey: ["orders", "shipments", variables.orderId] });
      toast.success("Shipment created");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to create shipment")),
  });
}

export function useRefundOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { orderId: string; amount?: number; reason?: string }) =>
      refundOrder({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["orders", "detail", variables.orderId] });
      queryClient.invalidateQueries({ queryKey: ["orders", "payments", variables.orderId] });
      toast.success("Refund processed");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to process refund")),
  });
}

export function useUpdateOrderCod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { orderId: string; action: string } & Record<string, unknown>) =>
      updateOrderCod({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["orders", "detail", variables.orderId] });
      queryClient.invalidateQueries({ queryKey: ["orders", "payments", variables.orderId] });
      queryClient.invalidateQueries({ queryKey: ["orders", "cod", variables.orderId] });
      toast.success("COD action recorded");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to record COD action")),
  });
}

export function useReturnOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      orderId: string;
      reason?: string;
      items?: unknown[];
      autoRefund?: boolean;
    }) => returnOrder({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["orders", "detail", variables.orderId] });
      toast.success("Return processed");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to process return")),
  });
}

export function useRestoreOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreOrder({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      toast.success("Order restored");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to restore order")),
  });
}

export function useBulkDeleteOrders() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { orderIds: string[]; permanent?: boolean }) =>
      bulkDeleteOrders({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      toast.success(
        variables.permanent
          ? `${variables.orderIds.length} orders permanently deleted`
          : `${variables.orderIds.length} orders moved to trash`,
      );
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to delete orders")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════════════════════════════

export function useUpdateSettings(category: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: Record<string, unknown>) =>
      updateSettingsByCategory({ data: { category, settings } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", category] });
      toast.success("Settings updated");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to update settings")),
  });
}

export function useSaveHeaderConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mutationFn: (data: any) => saveHeaderConfig({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "general"] });
      toast.success("Header config saved");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to save header config")),
  });
}

export function useSaveFooterConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mutationFn: (data: any) => saveFooterConfig({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "general"] });
      toast.success("Footer config saved");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to save footer config")),
  });
}

export function useUpdateStorefrontUrl() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (storefrontUrl: string) =>
      updateStorefrontUrl({ data: { storefrontUrl } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "storefront-url"] });
      toast.success("Storefront URL updated");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to update storefront URL")),
  });
}

export function useUpdateCurrencySettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      updateCurrencySettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "currency"] });
      toast.success("Currency settings updated");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to update currency settings")),
  });
}

export function useUpdateSeoSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      updateSeoSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "seo"] });
      toast.success("SEO settings updated");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to update SEO settings")),
  });
}

export function useUpdateSecuritySettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      updateSecuritySettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "security"] });
      toast.success("Security settings updated");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to update security settings")),
  });
}

export function useUpdateAuthSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      updateAuthSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "auth"] });
      toast.success("Auth settings updated");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to update auth settings")),
  });
}

export function useUpdateEmailSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      updateEmailSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "email"] });
      toast.success("Email settings updated");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to update email settings")),
  });
}

export function useUpdateFirebaseSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      updateFirebaseSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "firebase"] });
      toast.success("Firebase settings updated");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to update Firebase settings")),
  });
}

export function useUpdateBusinessSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      updateBusinessSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "business"] });
      toast.success("Business settings updated");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to update business settings")),
  });
}

export function useUpdateThemeSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      updateThemeSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "theme"] });
      toast.success("Theme settings updated");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to update theme settings")),
  });
}

export function useUpdateSmsSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      updateSmsSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "sms"] });
      toast.success("SMS settings updated");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to update SMS settings")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  CUSTOMERS
// ═══════════════════════════════════════════════════════════════════

export function useCreateCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      createCustomer({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      toast.success("Customer created");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to create customer")),
  });
}

export function useUpdateCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string } & Record<string, unknown>) =>
      updateCustomer({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["customers", "detail", variables.id] });
      toast.success("Customer updated");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to update customer")),
  });
}

export function useDeleteCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteCustomer({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      toast.success("Customer moved to trash");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to delete customer")),
  });
}

export function usePermanentDeleteCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => permanentDeleteCustomer({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      toast.success("Customer permanently deleted");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to permanently delete customer")),
  });
}

export function useRestoreCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreCustomer({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      toast.success("Customer restored");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to restore customer")),
  });
}

export function useBulkDeleteCustomers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { customerIds: string[]; permanent?: boolean }) =>
      bulkDeleteCustomers({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      toast.success(
        variables.permanent
          ? `${variables.customerIds.length} customers permanently deleted`
          : `${variables.customerIds.length} customers moved to trash`,
      );
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to delete customers")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  DISCOUNTS
// ═══════════════════════════════════════════════════════════════════

export function useCreateDiscount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      createDiscount({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["discounts"] });
      toast.success("Discount created");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to create discount")),
  });
}

export function useUpdateDiscount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string } & Record<string, unknown>) =>
      updateDiscount({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["discounts"] });
      queryClient.invalidateQueries({ queryKey: ["discounts", "detail", variables.id] });
      toast.success("Discount updated");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to update discount")),
  });
}

export function useDeleteDiscount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteDiscount({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["discounts"] });
      toast.success("Discount moved to trash");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to delete discount")),
  });
}

export function usePermanentDeleteDiscount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => permanentDeleteDiscount({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["discounts"] });
      toast.success("Discount permanently deleted");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to permanently delete discount")),
  });
}

export function useRestoreDiscount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreDiscount({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["discounts"] });
      toast.success("Discount restored");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to restore discount")),
  });
}

export function useToggleDiscountStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string; isActive?: boolean }) =>
      toggleDiscountStatus({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["discounts"] });
      queryClient.invalidateQueries({ queryKey: ["discounts", "detail", variables.id] });
      toast.success("Discount status toggled");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to toggle discount status")),
  });
}

export function useBulkDeleteDiscounts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { discountIds?: string[]; ids?: string[]; permanent?: boolean }) =>
      bulkDeleteDiscounts({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["discounts"] });
      toast.success("Discounts deleted");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to delete discounts")),
  });
}

export function useBulkRestoreDiscounts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { discountIds?: string[]; ids?: string[] }) =>
      bulkRestoreDiscounts({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["discounts"] });
      toast.success("Discounts restored");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to restore discounts")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  PAGES
// ═══════════════════════════════════════════════════════════════════

export function useCreatePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      createPage({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      toast.success("Page created");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to create page")),
  });
}

export function useUpdatePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string } & Record<string, unknown>) =>
      updatePage({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      queryClient.invalidateQueries({ queryKey: ["pages", "detail", variables.id] });
      toast.success("Page updated");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to update page")),
  });
}

export function useDeletePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deletePage({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      toast.success("Page moved to trash");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to delete page")),
  });
}

export function usePermanentDeletePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => permanentDeletePage({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      toast.success("Page permanently deleted");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to permanently delete page")),
  });
}

export function useRestorePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restorePage({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      toast.success("Page restored");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to restore page")),
  });
}

export function useBulkDeletePages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { pageIds: string[]; permanent?: boolean }) =>
      bulkDeletePages({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      toast.success(
        variables.permanent
          ? `${variables.pageIds.length} pages permanently deleted`
          : `${variables.pageIds.length} pages moved to trash`,
      );
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to delete pages")),
  });
}

export function useBulkRestorePages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => bulkRestorePages({ data: { ids } }),
    onSuccess: (_data, ids) => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      toast.success(`${ids.length} pages restored`);
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to restore pages")),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  WIDGETS
// ═══════════════════════════════════════════════════════════════════

export function useCreateWidget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      createWidget({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["widgets"] });
      toast.success("Widget created");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to create widget")),
  });
}

export function useUpdateWidget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string } & Record<string, unknown>) =>
      updateWidget({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["widgets"] });
      queryClient.invalidateQueries({ queryKey: ["widgets", "detail", variables.id] });
      toast.success("Widget updated");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to update widget")),
  });
}

export function useDeleteWidget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteWidget({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["widgets"] });
      toast.success("Widget moved to trash");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to delete widget")),
  });
}

export function useRestoreWidget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreWidget({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["widgets"] });
      toast.success("Widget restored");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to restore widget")),
  });
}

export function useBulkDeleteWidgets() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { ids: string[]; permanent?: boolean }) =>
      bulkDeleteWidgets({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["widgets"] });
      toast.success(
        variables.permanent
          ? `${variables.ids.length} widgets permanently deleted`
          : `${variables.ids.length} widgets moved to trash`,
      );
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to delete widgets")),
  });
}

export function useBulkRestoreWidgets() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => bulkRestoreWidgets({ data: { ids } }),
    onSuccess: (_data, ids) => {
      queryClient.invalidateQueries({ queryKey: ["widgets"] });
      toast.success(`${ids.length} widgets restored`);
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to restore widgets")),
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
      queryClient.invalidateQueries({ queryKey: ["analytics"] });
      toast.success("Analytics script created");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to create analytics script")),
  });
}

export function useUpdateAnalyticsScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string } & Record<string, unknown>) =>
      updateAnalyticsScript({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["analytics"] });
      queryClient.invalidateQueries({ queryKey: ["analytics", "detail", variables.id] });
      toast.success("Analytics script updated");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to update analytics script")),
  });
}

export function useDeleteAnalyticsScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteAnalyticsScript({ data: { id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["analytics"] });
      toast.success("Analytics script deleted");
    },
    onError: (err) => toast.error(getServerFnError(err, "Failed to delete analytics script")),
  });
}
