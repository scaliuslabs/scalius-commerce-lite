// @ts-nocheck — Known TanStack Start issue: TS2345 on handler types when Register includes router context (QueryClient).
// See: https://github.com/TanStack/router/issues/6185
/**
 * TanStack Start server functions for ALL admin API endpoints.
 *
 * These replace the old Astro loaders (SSR) + api-browser.ts (client-side).
 * In TanStack Start, server functions are callable from anywhere:
 * route loaders, components, event handlers. On the client they become
 * fetch requests automatically.
 *
 * Grouped by domain. Each function wraps an API endpoint via the
 * server-only api.server.ts helpers.
 */

import { createServerFn } from "@tanstack/react-start";
import {
  apiGet,
  apiGetText,
  apiPost,
  apiPut,
  apiPatch,
  apiDelete,
  apiBaseGet,
  apiBasePost,
} from "./api.server";

// TanStack Start's .handler() has overly strict generics with async functions.
// This cast helper satisfies the type checker without changing runtime behavior.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// ═══════════════════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════════════════

export const getDashboardData = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<{
      stats: Record<string, unknown>;
      recentOrders: unknown[];
      dailyActivityData: unknown[];
    }>("/dashboard");
  },
);

// ═══════════════════════════════════════════════════════════════════
//  PRODUCTS
// ═══════════════════════════════════════════════════════════════════

export const getProducts = createServerFn({ method: "GET" })
  .inputValidator(
    (data: {
      page?: number;
      limit?: number;
      search?: string;
      categoryId?: string;
      sort?: string;
      order?: string;
      showTrashed?: boolean;
    }) => data,
  )
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    if (data.page) params.page = String(data.page);
    if (data.limit) params.limit = String(data.limit);
    if (data.search) params.search = data.search;
    if (data.categoryId) params.category = data.categoryId;
    if (data.sort) params.sort = data.sort;
    if (data.order) params.order = data.order;
    if (data.showTrashed) params.trashed = "true";
    return apiGet<{ products: unknown[]; pagination: unknown }>("/products", params);
  });

export const getProduct = createServerFn({ method: "GET" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<Record<string, unknown>>(`/products/${data.id}`);
  });

export const getProductStats = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<Record<string, unknown>>("/products/stats");
  });

export const createProduct = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost<Record<string, unknown>>("/products", data);
  });

export const updateProduct = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string } & Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPut<Record<string, unknown>>(`/products/${data.id}`, data);
  });

export const deleteProduct = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/products/${data.id}`);
  });

export const permanentDeleteProduct = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/products/${data.id}/permanent`);
  });

export const restoreProduct = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiPost(`/products/${data.id}/restore`);
  });

export const bulkDeleteProducts = createServerFn({ method: "POST" })
  .inputValidator((data: { productIds: string[]; permanent?: boolean }) => data)
  .handler(async ({ data }) => {
    return apiPost("/products/bulk-delete", { productIds: data.productIds, permanent: data.permanent });
  });

// ─── Product Variants ────────────────────────────────────────────

export const getProductVariants = createServerFn({ method: "GET" })
  .inputValidator((data: { productId: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<unknown[]>(`/products/${data.productId}/variants`);
  });

export const createProductVariant = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { productId: string; variant: Record<string, unknown> }) => data,
  )
  .handler(async ({ data }) => {
    return apiPost(`/products/${data.productId}/variants`, data.variant);
  });

export const updateProductVariant = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      productId: string;
      variantId: string;
      variant: Record<string, unknown>;
    }) => data,
  )
  .handler(async ({ data }) => {
    return apiPut(
      `/products/${data.productId}/variants/${data.variantId}`,
      data.variant,
    );
  });

export const deleteProductVariant = createServerFn({ method: "POST" })
  .inputValidator((data: { productId: string; variantId: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(
      `/products/${data.productId}/variants/${data.variantId}`,
    );
  });

export const bulkCreateProductVariants = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { productId: string; variants: Record<string, unknown>[] }) => data,
  )
  .handler(async ({ data }) => {
    return apiPost(`/products/${data.productId}/variants/bulk-create`, {
      variants: data.variants,
    });
  });

export const bulkUpdateProductVariants = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { productId: string; updates: Record<string, unknown>[] }) => data,
  )
  .handler(async ({ data }) => {
    return apiPost(`/products/${data.productId}/variants/bulk-update`, {
      updates: data.updates,
    });
  });

export const bulkDeleteProductVariants = createServerFn({ method: "POST" })
  .inputValidator((data: { productId: string; variantIds: string[] }) => data)
  .handler(async ({ data }) => {
    return apiPost(`/products/${data.productId}/variants/bulk-delete`, {
      variantIds: data.variantIds,
    });
  });

export const duplicateProductVariant = createServerFn({ method: "POST" })
  .inputValidator((data: { productId: string; variantId: string }) => data)
  .handler(async ({ data }) => {
    return apiPost(
      `/products/${data.productId}/variants/${data.variantId}/duplicate`,
    );
  });

export const getVariantSortOrder = createServerFn({ method: "GET" })
  .inputValidator((data: { productId: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<Record<string, unknown>>(
      `/products/${data.productId}/variants/sort-order`,
    );
  });

export const updateVariantSortOrder = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      productId: string;
      colors: { value: string; sortOrder: number }[];
      sizes: { value: string; sortOrder: number }[];
    }) => data,
  )
  .handler(async ({ data }) => {
    return apiPost(`/products/${data.productId}/variants/sort-order`, {
      colors: data.colors,
      sizes: data.sizes,
    });
  });

// ═══════════════════════════════════════════════════════════════════
//  CATEGORIES
// ═══════════════════════════════════════════════════════════════════

export const getCategories = createServerFn({ method: "GET" })
  .inputValidator(
    (data: {
      page?: number;
      limit?: number;
      search?: string;
      sort?: string;
      order?: string;
      showTrashed?: boolean;
    }) => data,
  )
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    if (data.page) params.page = String(data.page);
    if (data.limit) params.limit = String(data.limit);
    if (data.search) params.search = data.search;
    if (data.sort) params.sort = data.sort;
    if (data.order) params.order = data.order;
    if (data.showTrashed) params.trashed = "true";
    return apiGet<{ categories: unknown[]; pagination: unknown }>(
      "/categories",
      params,
    );
  });

export const getCategory = createServerFn({ method: "GET" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<Record<string, unknown>>(`/categories/${data.id}`);
  });

export const getCategoryFormOptions = createServerFn({
  method: "GET",
}).handler(async () => {
  return apiGet<{ categories: Array<{ id: string; name: string }> }>(
    "/categories/form-options",
  );
});

export const createCategory = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost<Record<string, unknown>>("/categories", data);
  });

export const updateCategory = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string } & Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPut<Record<string, unknown>>(`/categories/${data.id}`, data);
  });

export const deleteCategory = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/categories/${data.id}`);
  });

export const deleteCategoryPermanent = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/categories/${data.id}/permanent`);
  });

export const restoreCategory = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiPost(`/categories/${data.id}/restore`);
  });

export const bulkDeleteCategories = createServerFn({ method: "POST" })
  .inputValidator((data: { categoryIds: string[]; permanent?: boolean }) => data)
  .handler(async ({ data }) => {
    return apiPost("/categories/bulk-delete", { ids: data.categoryIds, permanent: data.permanent });
  });

export const bulkRestoreCategories = createServerFn({ method: "POST" })
  .inputValidator((data: { categoryIds: string[] }) => data)
  .handler(async ({ data }) => {
    return apiPost("/categories/bulk-restore", { ids: data.categoryIds });
  });

// ═══════════════════════════════════════════════════════════════════
//  COLLECTIONS
// ═══════════════════════════════════════════════════════════════════

export const getCollections = createServerFn({ method: "GET" })
  .inputValidator(
    (data: {
      page?: number;
      limit?: number;
      search?: string;
      sort?: string;
      order?: string;
      showTrashed?: boolean;
      trashed?: boolean;
    }) => data,
  )
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    if (data.page) params.page = String(data.page);
    if (data.limit) params.limit = String(data.limit);
    if (data.search) params.search = data.search;
    if (data.sort) params.sort = data.sort;
    if (data.order) params.order = data.order;
    if (data.showTrashed || data.trashed) params.trashed = "true";
    return apiGet<unknown>("/collections", params);
  });

export const getCollection = createServerFn({ method: "GET" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<Record<string, unknown>>(`/collections/${data.id}`);
  });

export const getCollectionFormOptions = createServerFn({
  method: "GET",
}).handler(async () => {
  return apiGet<{ categories: unknown[]; products: unknown[] }>(
    "/collections/form-options",
  );
});

export const createCollection = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost<Record<string, unknown>>("/collections", data);
  });

export const updateCollection = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string } & Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPut<Record<string, unknown>>(`/collections/${data.id}`, data);
  });

export const deleteCollection = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/collections/${data.id}`);
  });

export const deleteCollectionPermanent = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/collections/${data.id}/permanent`);
  });

export const restoreCollection = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiPost(`/collections/${data.id}/restore`);
  });

export const reorderCollections = createServerFn({ method: "POST" })
  .inputValidator((data: { items: { id: string; sortOrder: number }[] }) => data)
  .handler(async ({ data }) => {
    return apiPost("/collections/reorder", { items: data.items });
  });

export const bulkDeleteCollections = createServerFn({ method: "POST" })
  .inputValidator((data: { collectionIds: string[]; permanent?: boolean }) => data)
  .handler(async ({ data }) => {
    return apiPost("/collections/bulk-delete", data);
  });

export const bulkRestoreCollections = createServerFn({ method: "POST" })
  .inputValidator((data: { ids: string[] }) => data)
  .handler(async ({ data }) => {
    return apiPost("/collections/bulk-restore", data);
  });

export const bulkActivateCollections = createServerFn({ method: "POST" })
  .inputValidator((data: { ids: string[] }) => data)
  .handler(async ({ data }) => {
    return apiPost("/collections/bulk-activate", data);
  });

export const bulkDeactivateCollections = createServerFn({ method: "POST" })
  .inputValidator((data: { ids: string[] }) => data)
  .handler(async ({ data }) => {
    return apiPost("/collections/bulk-deactivate", data);
  });

// ═══════════════════════════════════════════════════════════════════
//  ORDERS
// ═══════════════════════════════════════════════════════════════════

export const getOrders = createServerFn({ method: "GET" })
  .inputValidator(
    (data: {
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
    }) => data,
  )
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    if (data.page) params.page = String(data.page);
    if (data.limit) params.limit = String(data.limit);
    if (data.search) params.search = data.search;
    if (data.status) params.status = data.status;
    if (data.sort) params.sort = data.sort;
    if (data.order) params.order = data.order;
    if (data.showTrashed || data.trashed) params.trashed = "true";
    if (data.startDate) params.startDate = data.startDate;
    if (data.endDate) params.endDate = data.endDate;
    if (data.paymentStatus) params.paymentStatus = data.paymentStatus;
    if (data.paymentMethod) params.paymentMethod = data.paymentMethod;
    if (data.fulfillmentStatus) params.fulfillmentStatus = data.fulfillmentStatus;
    return apiGet<{ orders: unknown[]; pagination: unknown }>("/orders", params);
  });

export const getOrder = createServerFn({ method: "GET" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<Record<string, unknown>>(`/orders/${data.id}`);
  });

export const getOrderFormData = createServerFn({ method: "GET" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<Record<string, unknown>>(`/orders/${data.id}/form-data`);
  });

export const getOrderItems = createServerFn({ method: "GET" })
  .inputValidator((data: { orderId: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<unknown[]>(`/orders/${data.orderId}/items`);
  });

export const createOrder = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost<Record<string, unknown>>("/orders", data);
  });

export const updateOrder = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string } & Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPut<Record<string, unknown>>(`/orders/${data.id}`, data);
  });

export const updateOrderStatus = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { orderId: string; status: string; note?: string }) => data,
  )
  .handler(async ({ data }) => {
    return apiPost(`/orders/${data.orderId}/status`, {
      status: data.status,
      note: data.note,
    });
  });

export const returnOrder = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { orderId: string; reason?: string; items?: unknown[]; autoRefund?: boolean }) => data,
  )
  .handler(async ({ data }) => {
    return apiPost(`/orders/${data.orderId}/return`, {
      reason: data.reason,
      items: data.items,
      autoRefund: data.autoRefund,
    });
  });

export const restoreOrder = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiPost(`/orders/${data.id}/restore`);
  });

export const bulkDeleteOrders = createServerFn({ method: "POST" })
  .inputValidator((data: { orderIds: string[]; permanent?: boolean }) => data)
  .handler(async ({ data }) => {
    return apiPost("/orders/bulk-delete", { orderIds: data.orderIds, permanent: data.permanent });
  });

// ─── Order Payments ──────────────────────────────────────────────

export const getOrderPayments = createServerFn({ method: "GET" })
  .inputValidator((data: { orderId: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<unknown[]>(`/orders/${data.orderId}/payments`);
  });

export const getOrderCod = createServerFn({ method: "GET" })
  .inputValidator((data: { orderId: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<Record<string, unknown>>(`/orders/${data.orderId}/cod`);
  });

export const updateOrderCod = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { orderId: string; action: string } & Record<string, unknown>) =>
      data,
  )
  .handler(async ({ data }) => {
    const { orderId, ...body } = data;
    return apiPost(`/orders/${orderId}/cod`, body);
  });

export const refundOrder = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { orderId: string; amount?: number; reason?: string }) => data,
  )
  .handler(async ({ data }) => {
    return apiPost(`/orders/${data.orderId}/refund`, {
      amount: data.amount,
      reason: data.reason,
    });
  });

// ─── Order Shipments ─────────────────────────────────────────────

export const getOrderShipments = createServerFn({ method: "GET" })
  .inputValidator((data: { orderId: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<unknown[]>(`/orders/${data.orderId}/shipments`);
  });

export const createOrderShipment = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { orderId: string; shipment?: Record<string, unknown>; providerId?: string; options?: Record<string, unknown> }) => data,
  )
  .handler(async ({ data }) => {
    const body = data.shipment || { providerId: data.providerId, options: data.options };
    return apiPost(`/orders/${data.orderId}/shipments`, body);
  });

export const updateShipment = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { shipmentId: string; update: Record<string, unknown> }) => data,
  )
  .handler(async ({ data }) => {
    return apiPut(`/shipments/${data.shipmentId}`, data.update);
  });

export const refreshShipmentStatus = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { orderId: string; shipmentId: string }) => data,
  )
  .handler(async ({ data }) => {
    return apiPost<Record<string, unknown>>(
      `/orders/${data.orderId}/shipments/${data.shipmentId}/refresh`,
      {},
    );
  });

export const deleteShipment = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { orderId: string; shipmentId: string }) => data,
  )
  .handler(async ({ data }) => {
    return apiDelete(
      `/orders/${data.orderId}/shipments/${data.shipmentId}`,
    );
  });

// ═══════════════════════════════════════════════════════════════════
//  CUSTOMERS
// ═══════════════════════════════════════════════════════════════════

export const getCustomers = createServerFn({ method: "GET" })
  .inputValidator(
    (data: {
      page?: number;
      limit?: number;
      search?: string;
      sort?: string;
      order?: string;
      showTrashed?: boolean;
      trashed?: boolean;
    }) => data,
  )
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    if (data.page) params.page = String(data.page);
    if (data.limit) params.limit = String(data.limit);
    if (data.search) params.search = data.search;
    if (data.sort) params.sort = data.sort;
    if (data.order) params.order = data.order;
    if (data.showTrashed || data.trashed) params.trashed = "true";
    return apiGet<{ customers: unknown[]; pagination: unknown }>(
      "/customers",
      params,
    );
  });

export const getCustomer = createServerFn({ method: "GET" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<Record<string, unknown>>(`/customers/${data.id}`);
  });

export const getCustomerHistory = createServerFn({ method: "GET" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<Record<string, unknown>>(`/customers/${data.id}/history`);
  });

export const createCustomer = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost<Record<string, unknown>>("/customers", data);
  });

export const updateCustomer = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string } & Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPut<Record<string, unknown>>(`/customers/${data.id}`, data);
  });

export const deleteCustomer = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/customers/${data.id}`);
  });

export const permanentDeleteCustomer = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/customers/${data.id}/permanent`);
  });

export const deleteCustomerPermanent = permanentDeleteCustomer;

export const restoreCustomer = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiPost(`/customers/${data.id}/restore`);
  });

export const bulkDeleteCustomers = createServerFn({ method: "POST" })
  .inputValidator((data: { customerIds: string[]; permanent?: boolean }) => data)
  .handler(async ({ data }) => {
    return apiPost("/customers/bulk-delete", { ids: data.customerIds, permanent: data.permanent });
  });

// ═══════════════════════════════════════════════════════════════════
//  DISCOUNTS
// ═══════════════════════════════════════════════════════════════════

export const getDiscounts = createServerFn({ method: "GET" })
  .inputValidator(
    (data: {
      page?: number;
      limit?: number;
      search?: string;
      sort?: string;
      order?: string;
      showTrashed?: boolean;
    }) => data,
  )
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    if (data.page) params.page = String(data.page);
    if (data.limit) params.limit = String(data.limit);
    if (data.search) params.search = data.search;
    if (data.sort) params.sort = data.sort;
    if (data.order) params.order = data.order;
    if (data.showTrashed) params.trashed = "true";
    return apiGet<{ discounts: unknown[]; pagination: unknown }>(
      "/discounts",
      params,
    );
  });

export const getDiscount = createServerFn({ method: "GET" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<Record<string, unknown>>(`/discounts/${data.id}`);
  });

export const createDiscount = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost<Record<string, unknown>>("/discounts", data);
  });

export const updateDiscount = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string } & Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPut<Record<string, unknown>>(`/discounts/${data.id}`, data);
  });

export const deleteDiscount = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/discounts/${data.id}`);
  });

export const permanentDeleteDiscount = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/discounts/${data.id}/permanent`);
  });

export const deleteDiscountPermanent = permanentDeleteDiscount;

export const restoreDiscount = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiPost(`/discounts/${data.id}/restore`);
  });

export const toggleDiscountStatus = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string; isActive?: boolean }) => data)
  .handler(async ({ data }) => {
    return apiPost(`/discounts/${data.id}/toggle-status`, { isActive: data.isActive });
  });

export const bulkDeleteDiscounts = createServerFn({ method: "POST" })
  .inputValidator((data: { discountIds?: string[]; ids?: string[]; permanent?: boolean }) => data)
  .handler(async ({ data }) => {
    const ids = data.discountIds || data.ids || [];
    return apiPost("/discounts/bulk-delete", { ids, permanent: data.permanent });
  });

export const bulkRestoreDiscounts = createServerFn({ method: "POST" })
  .inputValidator((data: { discountIds?: string[]; ids?: string[] }) => data)
  .handler(async ({ data }) => {
    const ids = data.discountIds || data.ids || [];
    return apiPost("/discounts/bulk-restore", { ids });
  });

// ═══════════════════════════════════════════════════════════════════
//  PAGES
// ═══════════════════════════════════════════════════════════════════

export const getPages = createServerFn({ method: "GET" })
  .inputValidator(
    (data: {
      page?: number;
      limit?: number;
      search?: string;
      sort?: string;
      order?: string;
      showTrashed?: boolean;
      trashed?: boolean;
    }) => data,
  )
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    if (data.page) params.page = String(data.page);
    if (data.limit) params.limit = String(data.limit);
    if (data.search) params.search = data.search;
    if (data.sort) params.sort = data.sort;
    if (data.order) params.order = data.order;
    if (data.showTrashed || data.trashed) params.trashed = "true";
    return apiGet<{ pages: unknown[]; pagination: unknown }>("/pages", params);
  });

export const getPage = createServerFn({ method: "GET" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<Record<string, unknown>>(`/pages/${data.id}`);
  });

export const createPage = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost<Record<string, unknown>>("/pages", data);
  });

export const updatePage = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string } & Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPut<Record<string, unknown>>(`/pages/${data.id}`, data);
  });

export const deletePage = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/pages/${data.id}`);
  });

export const permanentDeletePage = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/pages/${data.id}/permanent`);
  });

export const restorePage = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiPost(`/pages/${data.id}/restore`);
  });

export const bulkDeletePages = createServerFn({ method: "POST" })
  .inputValidator((data: { pageIds: string[]; permanent?: boolean }) => data)
  .handler(async ({ data }) => {
    return apiPost("/pages/bulk-delete", data);
  });

export const bulkRestorePages = createServerFn({ method: "POST" })
  .inputValidator((data: { ids: string[] }) => data)
  .handler(async ({ data }) => {
    return apiPost("/pages/bulk-restore", data);
  });

export const bulkPublishPages = createServerFn({ method: "POST" })
  .inputValidator((data: { ids: string[] }) => data)
  .handler(async ({ data }) => {
    return apiPost("/pages/bulk-publish", data);
  });

export const bulkUnpublishPages = createServerFn({ method: "POST" })
  .inputValidator((data: { ids: string[] }) => data)
  .handler(async ({ data }) => {
    return apiPost("/pages/bulk-unpublish", data);
  });

// ═══════════════════════════════════════════════════════════════════
//  WIDGETS
// ═══════════════════════════════════════════════════════════════════

export const getWidgets = createServerFn({ method: "GET" })
  .inputValidator(
    (data: { search?: string; showTrashed?: boolean }) => data,
  )
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    if (data.search) params.search = data.search;
    if (data.showTrashed) params.trashed = "true";
    return apiGet<{
      widgets: unknown[];
      availableCollections: unknown[];
    }>("/widgets", params);
  });

export const getWidget = createServerFn({ method: "GET" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<Record<string, unknown>>(`/widgets/${data.id}`);
  });

export const createWidget = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost<Record<string, unknown>>("/widgets", data);
  });

export const updateWidget = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string } & Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPut<Record<string, unknown>>(`/widgets/${data.id}`, data);
  });

export const deleteWidget = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/widgets/${data.id}`);
  });

export const permanentDeleteWidget = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/widgets/${data.id}/permanent`);
  });

export const restoreWidget = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiPost(`/widgets/${data.id}/restore`);
  });

// ─── Widget History ──────────────────────────────────────────────

export const getWidgetHistory = createServerFn({ method: "GET" })
  .inputValidator((data: { widgetId: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<unknown[]>(`/widgets/${data.widgetId}/history`);
  });

export const createWidgetHistorySnapshot = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { widgetId: string; snapshot: Record<string, unknown> }) => data,
  )
  .handler(async ({ data }) => {
    return apiPost(`/widgets/${data.widgetId}/history`, data.snapshot);
  });

export const restoreWidgetHistory = createServerFn({ method: "POST" })
  .inputValidator((data: { widgetId: string; historyId: string }) => data)
  .handler(async ({ data }) => {
    return apiPost(`/widgets/${data.widgetId}/history/restore`, {
      historyId: data.historyId,
    });
  });

export const deleteWidgetHistory = createServerFn({ method: "POST" })
  .inputValidator((data: { widgetId: string; historyId: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/widgets/${data.widgetId}/history/${data.historyId}`);
  });

export const bulkDeleteWidgets = createServerFn({ method: "POST" })
  .inputValidator((data: { ids: string[]; permanent?: boolean }) => data)
  .handler(async ({ data }) => {
    return apiPost("/widgets/bulk-delete", data);
  });

export const bulkRestoreWidgets = createServerFn({ method: "POST" })
  .inputValidator((data: { ids: string[] }) => data)
  .handler(async ({ data }) => {
    return apiPost("/widgets/bulk-restore", data);
  });

export const bulkActivateWidgets = createServerFn({ method: "POST" })
  .inputValidator((data: { ids: string[] }) => data)
  .handler(async ({ data }) => {
    return apiPost("/widgets/bulk-activate", data);
  });

export const bulkDeactivateWidgets = createServerFn({ method: "POST" })
  .inputValidator((data: { ids: string[] }) => data)
  .handler(async ({ data }) => {
    return apiPost("/widgets/bulk-deactivate", data);
  });

// ═══════════════════════════════════════════════════════════════════
//  ATTRIBUTES
// ═══════════════════════════════════════════════════════════════════

export const getAttributes = createServerFn({ method: "GET" })
  .inputValidator(
    (data: {
      page?: number;
      limit?: number;
      search?: string;
      sort?: string;
      order?: string;
      trashed?: boolean;
    }) => data,
  )
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    if (data.page) params.page = String(data.page);
    if (data.limit) params.limit = String(data.limit);
    if (data.search) params.search = data.search;
    if (data.sort) params.sort = data.sort;
    if (data.order) params.order = data.order;
    if (data.trashed) params.trashed = "true";
    return apiGet<unknown[]>("/attributes", params);
  });

export const createAttribute = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost<Record<string, unknown>>("/attributes", data);
  });

export const updateAttribute = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string; [key: string]: unknown }) => data)
  .handler(async ({ data }) => {
    const { id, ...rest } = data;
    return apiPut(`/attributes/${id}`, rest);
  });

export const deleteAttribute = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/attributes/${data.id}`);
  });

export const deleteAttributePermanent = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/attributes/${data.id}/permanent`);
  });

export const restoreAttribute = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiPost(`/attributes/${data.id}/restore`);
  });

export const bulkDeleteAttributes = createServerFn({ method: "POST" })
  .inputValidator((data: { ids: string[]; permanent?: boolean }) => data)
  .handler(async ({ data }) => {
    return apiPost("/attributes/bulk-delete", data);
  });

export const bulkRestoreAttributes = createServerFn({ method: "POST" })
  .inputValidator((data: { ids: string[] }) => data)
  .handler(async ({ data }) => {
    return apiPost("/attributes/bulk-restore", data);
  });

export const getAttributeValues = createServerFn({ method: "GET" })
  .inputValidator((data: { attributeId?: string; id?: string; page?: number; limit?: number; search?: string; sort?: string }) => data)
  .handler(async ({ data }) => {
    const attributeId = data.attributeId || data.id || "";
    const params: Record<string, string> = {};
    if (data.page) params.page = String(data.page);
    if (data.limit) params.limit = String(data.limit);
    if (data.search) params.search = data.search;
    if (data.sort) params.sort = data.sort;
    return apiGet<unknown[]>(`/attributes/${attributeId}/values`, params);
  });

export const updateAttributeValues = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { attributeId: string; values: unknown[] }) => data,
  )
  .handler(async ({ data }) => {
    return apiPost(`/attributes/${data.attributeId}/values`, {
      values: data.values,
    });
  });

export const renameAttributeValue = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { attributeId: string; oldValue: string; newValue: string }) => data,
  )
  .handler(async ({ data }) => {
    return apiPut(`/attributes/${data.attributeId}/values`, {
      oldValue: data.oldValue,
      newValue: data.newValue,
    });
  });

export const addAttributeValue = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { attributeId: string; value: string }) => data,
  )
  .handler(async ({ data }) => {
    return apiPost(`/attributes/${data.attributeId}/values`, {
      value: data.value,
    });
  });

export const removeAttributeValue = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { attributeId: string; value: string }) => data,
  )
  .handler(async ({ data }) => {
    return apiDelete(`/attributes/${data.attributeId}/values`, {
      value: data.value,
    });
  });

// ═══════════════════════════════════════════════════════════════════
//  ANALYTICS SCRIPTS
// ═══════════════════════════════════════════════════════════════════

export const getAnalyticsScripts = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<unknown[]>("/analytics");
  });

export const getAnalyticsScript = createServerFn({ method: "GET" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<Record<string, unknown>>(`/analytics/${data.id}`);
  });

export const createAnalyticsScript = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost<Record<string, unknown>>("/analytics", data);
  });

export const updateAnalyticsScript = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string } & Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPut<Record<string, unknown>>(`/analytics/${data.id}`, data);
  });

export const deleteAnalyticsScript = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/analytics/${data.id}`);
  });

export const toggleAnalyticsScript = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiPost(`/analytics/${data.id}/toggle`);
  });

// ═══════════════════════════════════════════════════════════════════
//  INVENTORY
// ═══════════════════════════════════════════════════════════════════

export const getInventory = createServerFn({ method: "GET" })
  .inputValidator(
    (data: {
      page?: number;
      limit?: number;
      search?: string;
      lowStock?: boolean;
      section?: string;
      status?: string;
      sort?: string;
      order?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    if (data.page) params.page = String(data.page);
    if (data.limit) params.limit = String(data.limit);
    if (data.search) params.search = data.search;
    if (data.lowStock) params.lowStock = "true";
    if (data.section) params.section = data.section;
    if (data.status) params.status = data.status;
    if (data.sort) params.sort = data.sort;
    if (data.order) params.order = data.order;
    return apiGet<unknown>("/inventory", params);
  });

export const adjustInventory = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      variantId: string;
      delta: number;
      reason?: string;
      notes?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    const { variantId, ...body } = data;
    return apiPost(`/inventory/${variantId}/adjust`, body);
  });

export const stockAdjust = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/inventory/stock-adjust", data);
  });

export const stockSet = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/inventory/stock-set", data);
  });

// ═══════════════════════════════════════════════════════════════════
//  MEDIA
// ═══════════════════════════════════════════════════════════════════

export const getMediaList = createServerFn({ method: "GET" })
  .inputValidator(
    (data: {
      page?: number;
      limit?: number;
      search?: string;
      folderId?: string;
      type?: string;
      sortBy?: string;
      sortOrder?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    if (data.page) params.page = String(data.page);
    if (data.limit) params.limit = String(data.limit);
    if (data.search) params.search = data.search;
    if (data.folderId) params.folderId = data.folderId;
    if (data.type) params.type = data.type;
    if (data.sortBy) params.sortBy = data.sortBy;
    if (data.sortOrder) params.sortOrder = data.sortOrder;
    return apiGet<unknown>("/media", params);
  });

export const deleteMedia = createServerFn({ method: "POST" })
  .inputValidator((data: { fileId: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/media/${data.fileId}`);
  });

export const updateMedia = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { fileId: string; update: Record<string, unknown> }) => data,
  )
  .handler(async ({ data }) => {
    return apiPut(`/media/${data.fileId}`, data.update);
  });

export const getMediaFolders = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<unknown[]>("/media/folders");
  });

export const createMediaFolder = createServerFn({ method: "POST" })
  .inputValidator((data: { name: string; parentId?: string }) => data)
  .handler(async ({ data }) => {
    return apiPost("/media/folders", data);
  });

export const renameMediaFolder = createServerFn({ method: "POST" })
  .inputValidator((data: { folderId: string; name: string }) => data)
  .handler(async ({ data }) => {
    return apiPut(`/media/folders/${data.folderId}`, { name: data.name });
  });

export const moveMediaFiles = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { fileIds: string[]; targetFolderId: string | null }) => data,
  )
  .handler(async ({ data }) => {
    return apiPost("/media/move", data);
  });

export const deleteMediaFolder = createServerFn({ method: "POST" })
  .inputValidator((data: { folderId: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/media/folders/${data.folderId}`);
  });

// ═══════════════════════════════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════════════════════════════

export const getNavigationItems = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<unknown[]>("/navigation/items");
  });

export const getNavigationPreviewProducts = createServerFn({ method: "GET" })
  .inputValidator((data: Record<string, string>) => data)
  .handler(async ({ data }) => {
    return apiGet<Record<string, unknown>>("/navigation/preview-products", data);
  });

// ═══════════════════════════════════════════════════════════════════
//  FRAUD CHECKER
// ═══════════════════════════════════════════════════════════════════

export const getFraudCheckerProviders = createServerFn({
  method: "GET",
}).handler(async () => {
  return apiGet<unknown[]>("/fraud-checker");
});

export const createFraudCheckerProvider = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost<Record<string, unknown>>("/fraud-checker", data);
  });

export const updateFraudCheckerProvider = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string } & Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPut<Record<string, unknown>>("/fraud-checker", data);
  });

export const deleteFraudCheckerProvider = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/fraud-checker/${data.id}`);
  });

export const testFraudCheckerProvider = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiPost<Record<string, unknown>>(
      `/fraud-checker/${data.id}/test`,
      {},
    );
  });

export const fraudCheckerLookup = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/fraud-checker/lookup", data);
  });

// ═══════════════════════════════════════════════════════════════════
//  ABANDONED CHECKOUTS
// ═══════════════════════════════════════════════════════════════════

export const getAbandonedCheckouts = createServerFn({ method: "GET" })
  .inputValidator(
    (data: { page?: number; limit?: number; search?: string; sort?: string; order?: string }) => data,
  )
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    if (data.page) params.page = String(data.page);
    if (data.limit) params.limit = String(data.limit);
    if (data.search) params.search = data.search;
    if (data.sort) params.sort = data.sort;
    if (data.order) params.order = data.order;
    return apiGet<unknown>("/abandoned-checkouts", params);
  });

export const deleteAbandonedCheckouts = createServerFn({ method: "POST" })
  .inputValidator((data: { ids: string[] }) => data)
  .handler(async ({ data }) => {
    return apiDelete("/abandoned-checkouts", data);
  });

// ═══════════════════════════════════════════════════════════════════
//  RBAC (Roles & Permissions)
// ═══════════════════════════════════════════════════════════════════

export const getRbacRoles = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<unknown[]>("/rbac/roles");
  });

export const getRbacPermissions = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<unknown[]>("/rbac/permissions");
  });

export const createRbacRole = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost<Record<string, unknown>>("/rbac/roles", data);
  });

export const updateRbacRole = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { roleId: string; update: Record<string, unknown> }) => data,
  )
  .handler(async ({ data }) => {
    return apiPut<Record<string, unknown>>(
      `/rbac/roles/${data.roleId}`,
      data.update,
    );
  });

export const deleteRbacRole = createServerFn({ method: "POST" })
  .inputValidator((data: { roleId: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/rbac/roles/${data.roleId}`);
  });

export const assignUserRole = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { userId: string; roleId: string }) => data,
  )
  .handler(async ({ data }) => {
    return apiPost("/rbac/user-roles", data);
  });

export const removeUserRole = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { userId: string; roleId: string }) => data,
  )
  .handler(async ({ data }) => {
    return apiDelete("/rbac/user-roles", data);
  });

export const assignUserPermission = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { userId: string; permissionId: string }) => data,
  )
  .handler(async ({ data }) => {
    return apiPost("/rbac/user-permissions", data);
  });

export const removeUserPermission = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { userId: string; permissionId: string }) => data,
  )
  .handler(async ({ data }) => {
    return apiDelete("/rbac/user-permissions", data);
  });

// ═══════════════════════════════════════════════════════════════════
//  AUTH / ADMIN USERS
// ═══════════════════════════════════════════════════════════════════

export const getAdminUsers = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<unknown[]>("/auth/users");
  });

export const createAdminUser = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost<Record<string, unknown>>("/auth/users", data);
  });

export const deleteAdminUser = createServerFn({ method: "POST" })
  .inputValidator((data: { userId: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/auth/users/${data.userId}`);
  });

export const updateProfile = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/auth/update-profile", data);
  });

export const changePassword = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      currentPassword: string;
      newPassword: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    return apiPost("/auth/change-password", data);
  });

export const getAccountSecurity = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<{
      twoFactorMethod: string | null;
      isSuperAdmin: boolean;
    }>("/auth/account-security");
  });

// ─── 2FA ─────────────────────────────────────────────────────────

export const set2faMethod = createServerFn({ method: "POST" })
  .inputValidator((data: { method: string | null }) => data)
  .handler(async ({ data }) => {
    return apiPost("/auth/2fa/method", data);
  });

export const mark2faVerified = createServerFn({ method: "POST" }).handler(
  async () => {
    return apiPost("/auth/2fa/mark-verified", {});
  });

export const get2faInfo = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<Record<string, unknown>>("/auth/2fa/info");
  });

// ═══════════════════════════════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════════════════════════════

// ─── Generic settings getter/setter ──────────────────────────────

export const getSettingsByCategory = createServerFn({ method: "GET" })
  .inputValidator((data: { category: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<Record<string, unknown>>(`/settings/${data.category}`);
  });

export const updateSettingsByCategory = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { category: string; settings: Record<string, unknown> }) => data,
  )
  .handler(async ({ data }) => {
    return apiPost(`/settings/${data.category}`, data.settings);
  });

// ─── Specific settings endpoints ─────────────────────────────────

export const getGeneralSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<Record<string, unknown>>("/settings/general");
  });

export const getStorefrontUrl = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<{ storefrontUrl: string }>("/settings/storefront-url");
  });

export const updateStorefrontUrl = createServerFn({ method: "POST" })
  .inputValidator((data: { storefrontUrl: string }) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/storefront-url", data);
  });

export const getCurrencySettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<Record<string, unknown>>("/settings/currency");
  });

export const updateCurrencySettings = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/currency", data);
  });

export const getSeoSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<Record<string, unknown>>("/settings/seo");
  });

export const updateSeoSettings = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/seo", data);
  });

export const getSecuritySettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<Record<string, unknown>>("/settings/security");
  });

export const updateSecuritySettings = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/security", data);
  });

export const getAuthSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<Record<string, unknown>>("/settings/auth");
  });

export const updateAuthSettings = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/auth", data);
  });

export const getEmailSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<Record<string, unknown>>("/settings/email");
  });

export const updateEmailSettings = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/email", data);
  });

export const getFirebaseSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<Record<string, unknown>>("/settings/firebase");
  });

export const updateFirebaseSettings = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/firebase", data);
  });

export const getBusinessSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<Record<string, unknown>>("/settings/business");
  });

export const updateBusinessSettings = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/business", data);
  });

export const getThemeSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<Record<string, unknown>>("/settings/theme");
  });

export const updateThemeSettings = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/theme", data);
  });

export const getSmsSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<Record<string, unknown>>("/settings/sms");
  });

export const updateSmsSettings = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/sms", data);
  });

export const getOpenRouterSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<Record<string, unknown>>("/settings/openrouter");
  });

export const updateOpenRouterSettings = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/openrouter", data);
  });

export const getMetaConversionsSettings = createServerFn({
  method: "GET",
}).handler(async () => {
  return apiGet<Record<string, unknown>>("/settings/meta-conversions");
});

export const updateMetaConversionsSettings = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/meta-conversions", data);
  });

export const getMetaConversionsLogs = createServerFn({ method: "GET" })
  .inputValidator((data: { page?: number; limit?: number }) => data)
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    if (data.page) params.page = String(data.page);
    if (data.limit) params.limit = String(data.limit);
    return apiGet<Record<string, unknown>>("/settings/meta-conversions/logs", params);
  });

export const clearMetaConversionsLogs = createServerFn({ method: "POST" }).handler(
  async () => {
    return apiDelete("/settings/meta-conversions/logs");
  });

export const cleanupMetaConversionsLogs = createServerFn({ method: "POST" }).handler(
  async () => {
    return apiPost("/settings/meta-conversions/logs");
  });

export const getAllowedCountries = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<unknown>("/settings/allowed-countries");
  });

export const updateAllowedCountries = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/allowed-countries", data);
  });

// ─── Payment Methods ─────────────────────────────────────────────

export const getPaymentMethods = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<unknown>("/settings/payment-methods");
  });

export const updatePaymentMethods = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/payment-methods", data);
  });

export const getPaymentGatewaySettings = createServerFn({ method: "GET" })
  .inputValidator((data: { gateway: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<Record<string, unknown>>(`/settings/${data.gateway}`);
  });

export const updatePaymentGatewaySettings = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { gateway: string; settings: Record<string, unknown> }) => data,
  )
  .handler(async ({ data }) => {
    return apiPost(`/settings/${data.gateway}`, data.settings);
  });

// ─── Notification Channels ───────────────────────────────────────

export const getNotificationChannels = createServerFn({
  method: "GET",
}).handler(async () => {
  return apiGet<unknown>("/settings/notification-channels");
});

export const updateNotificationChannels = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/notification-channels", data);
  });

export const getAdminNotificationChannels = createServerFn({
  method: "GET",
}).handler(async () => {
  return apiGet<unknown>("/settings/notification-channels/admin-channels");
});

export const updateAdminNotificationChannels = createServerFn({
  method: "POST",
})
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/notification-channels/admin-channels", data);
  });

// ─── Delivery Providers ──────────────────────────────────────────

export const getDeliveryProviders = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<unknown[]>("/settings/delivery-providers");
  });

export const createDeliveryProvider = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/delivery-providers", data);
  });

export const updateDeliveryProvider = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { id: string; update: Record<string, unknown> }) => data,
  )
  .handler(async ({ data }) => {
    return apiPut(`/settings/delivery-providers/${data.id}`, data.update);
  });

export const deleteDeliveryProvider = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/settings/delivery-providers/${data.id}`);
  });

// ─── Delivery Locations ──────────────────────────────────────────

export const getDeliveryLocations = createServerFn({ method: "GET" })
  .inputValidator((data: Record<string, string | number | boolean | undefined>) => data)
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined && v !== "") params[k] = String(v);
    }
    return apiGet<unknown>("/settings/delivery-locations", params);
  });

export const getAllDeliveryLocations = createServerFn({ method: "GET" })
  .inputValidator((data: { type?: string }) => data)
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    if (data.type) params.type = data.type;
    return apiGet<unknown>("/settings/delivery-locations/all", params);
  });

export const updateDeliveryLocation = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { id: string; update: Record<string, unknown> }) => data,
  )
  .handler(async ({ data }) => {
    return apiPut(`/settings/delivery-locations/${data.id}`, data.update);
  });

export const createDeliveryLocation = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/delivery-locations", data);
  });

export const importPathaoLocations = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/delivery-locations/import-pathao", data);
  });

export const getImportPathaoStatus = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<unknown>("/settings/delivery-locations/import-pathao/status");
  });

export const resetImportPathao = createServerFn({ method: "POST" }).handler(
  async () => {
    return apiDelete("/settings/delivery-locations/import-pathao");
  });

export const deleteDeliveryLocation = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/settings/delivery-locations/${data.id}`);
  });

export const bulkDeleteDeliveryLocations = createServerFn({ method: "POST" })
  .inputValidator((data: { ids: string[] }) => data)
  .handler(async ({ data }) => {
    return apiDelete("/settings/delivery-locations", data);
  });

export const cleanAllDeliveryLocations = createServerFn({ method: "POST" }).handler(
  async () => {
    return apiDelete("/settings/delivery-locations/all");
  });

// ─── Delivery Provider Testing ──────────────────────────────────

export const testDeliveryProvider = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiPost(`/settings/delivery-providers/${data.id}`);
  });

export const testDeliveryCredentials = createServerFn({ method: "POST" })
  .inputValidator((data: { type: string; credentials: Record<string, string>; config: Record<string, string | number>; name: string }) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/delivery-providers/create-test", data);
  });

export const saveDeliveryProvider = createServerFn({ method: "POST" })
  .inputValidator((data: { provider: Record<string, unknown> }) => data)
  .handler(async ({ data }) => {
    const provider = data.provider;
    if (provider.id) {
      return apiPut("/settings/delivery-providers", provider);
    }
    return apiPost("/settings/delivery-providers", provider);
  });

// ─── Checkout Languages ─────────────────────────────────────────

export const getCheckoutLanguages = createServerFn({ method: "GET" })
  .inputValidator((data: Record<string, string | number | boolean | undefined>) => data)
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined && v !== "") params[k] = String(v);
    }
    return apiGet<unknown>("/settings/checkout-languages", params);
  });

export const createCheckoutLanguage = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/checkout-languages", data);
  });

export const updateCheckoutLanguage = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string; update: Record<string, unknown> }) => data)
  .handler(async ({ data }) => {
    return apiPut(`/settings/checkout-languages/${data.id}`, data.update);
  });

export const softDeleteCheckoutLanguage = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiPatch(`/settings/checkout-languages/${data.id}`);
  });

export const deleteCheckoutLanguage = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/settings/checkout-languages/${data.id}`);
  });

export const restoreCheckoutLanguage = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiPost(`/settings/checkout-languages/${data.id}/restore`);
  });

// ─── Shipping Methods ────────────────────────────────────────────

export const getShippingMethods = createServerFn({ method: "GET" })
  .inputValidator(
    (data: { page?: number; limit?: number; search?: string; sort?: string; order?: string; trashed?: boolean }) => data,
  )
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    if (data.page) params.page = String(data.page);
    if (data.limit) params.limit = String(data.limit);
    if (data.search) params.search = data.search;
    if (data.sort) params.sort = data.sort;
    if (data.order) params.order = data.order;
    if (data.trashed) params.trashed = "true";
    return apiGet("/settings/shipping-methods", params);
  });

export const createShippingMethod = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/shipping-methods", data);
  });

export const updateShippingMethod = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { id: string; update: Record<string, unknown> }) => data,
  )
  .handler(async ({ data }) => {
    return apiPut(`/settings/shipping-methods/${data.id}`, data.update);
  });

export const deleteShippingMethod = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/settings/shipping-methods/${data.id}`);
  });

export const permanentDeleteShippingMethod = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiDelete(`/settings/shipping-methods/${data.id}/permanent-delete`);
  });

export const restoreShippingMethod = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiPost(`/settings/shipping-methods/${data.id}/restore`);
  });

// ─── Header/Footer Config ────────────────────────────────────────

export const saveHeaderConfig = createServerFn({ method: "POST" })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .inputValidator((data: any) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/header", data as Record<string, unknown>);
  });

export const saveFooterConfig = createServerFn({ method: "POST" })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .inputValidator((data: any) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/footer", data as Record<string, unknown>);
  });

// ─── Hero Sliders ────────────────────────────────────────────────

export const getHeroSliders = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<unknown[]>("/settings/hero-sliders");
  });

export const createHeroSlider = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/settings/hero-sliders", data);
  });

export const updateHeroSlider = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { id: string; update: Record<string, unknown> }) => data,
  )
  .handler(async ({ data }) => {
    return apiPut(`/settings/hero-sliders/${data.id}`, data.update);
  });

// ═══════════════════════════════════════════════════════════════════
//  AI (OpenRouter / Prompts / Context)
// ═══════════════════════════════════════════════════════════════════

export const getAiPrompts = createServerFn({ method: "GET" })
  .inputValidator((data: { type: string }) => data)
  .handler(async ({ data }) => {
    return apiGetText("/ai-prompts", { type: data.type });
  });

export const getAiContextBatchDetails = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiPost("/ai-context/batch-details", data);
  });

// ═══════════════════════════════════════════════════════════════════
//  CACHE (non-admin endpoints)
// ═══════════════════════════════════════════════════════════════════

export const getCacheStats = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiBaseGet<Record<string, unknown>>("/cache/stats");
  });

export const getCacheLastCleared = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiBaseGet<unknown>("/cache/last-cleared");
  });

export const getCacheGroups = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiBaseGet<unknown>("/cache/groups");
  });

export const clearCache = createServerFn({ method: "POST" }).handler(
  async () => {
    return apiBasePost("/cache/clear");
  });

export const clearCacheGroup = createServerFn({ method: "POST" })
  .inputValidator((data: { groupName: string }) => data)
  .handler(async ({ data }) => {
    return apiBasePost(`/cache/clear-${data.groupName}`);
  });

// ═══════════════════════════════════════════════════════════════════
//  SETUP (non-admin endpoint)
// ═══════════════════════════════════════════════════════════════════

export const getSetupStatus = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiBaseGet<{ adminExists: boolean }>("/setup");
  });

export const runSetup = createServerFn({ method: "POST" })
  .inputValidator((data: Record<string, unknown>) => data)
  .handler(async ({ data }) => {
    return apiBasePost("/setup", data);
  });

// ═══════════════════════════════════════════════════════════════════
//  FIREBASE CONFIG (non-admin endpoint)
// ═══════════════════════════════════════════════════════════════════

export const getFirebaseConfig = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiBaseGet<Record<string, string>>("/auth/firebase-config");
  });
