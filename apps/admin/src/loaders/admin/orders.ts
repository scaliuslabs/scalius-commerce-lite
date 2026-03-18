import { apiGet } from "@/lib/api-fetch";
import type {
  Order,
  PaginationResponse,
  ProductListItem,
  OrderDetail,
  OrderFormData,
  ProductDetail,
  ProductVariant,
  EnhancedShipment,
  DeliveryProviderRecord,
} from "@/types/api-responses";

export async function getOrdersIndexData(options: {
  page: number;
  limit: number;
  search: string;
  status?: string;
  showTrashed: boolean;
  sort: "customerName" | "totalAmount" | "status" | "createdAt" | "updatedAt";
  order: "asc" | "desc";
}) {
  const params: Record<string, string> = {
    page: String(options.page),
    limit: String(options.limit),
    sort: options.sort,
    order: options.order,
  };
  if (options.search) params.search = options.search;
  if (options.status) params.status = options.status;
  if (options.showTrashed) params.trashed = "true";

  const result = await apiGet<{ orders: Order[]; pagination: PaginationResponse }>("/orders", params);

  const ordersWithDates = result.orders.map((order) => ({
    ...order,
    createdAt:
      order.createdAt instanceof Date
        ? order.createdAt
        : new Date(order.createdAt),
    updatedAt:
      order.updatedAt instanceof Date
        ? order.updatedAt
        : new Date(order.updatedAt),
  }));

  return { orders: ordersWithDates, pagination: result.pagination };
}

export async function getOrderFormProducts() {
  try {
    const result = await apiGet<{ products: ProductListItem[]; pagination: PaginationResponse }>("/products", {
      page: "1",
      limit: "999",
    });

    const productsWithVariants = await Promise.all(
      (result.products || []).map(async (product) => {
        try {
          const detail = await apiGet<ProductDetail>("/products/" + product.id);
          return {
            id: product.id,
            name: product.name,
            price: product.price,
            discountPercentage: product.discountPercentage ?? null,
            variants: (detail.variants || [])
              .filter((v: ProductVariant) => !v.deletedAt)
              .map((v: ProductVariant) => ({
                id: v.id,
                size: v.size,
                color: v.color,
                weight: v.weight,
                sku: v.sku,
                price: v.price,
                stock: v.stock,
              })),
          };
        } catch {
          return {
            id: product.id,
            name: product.name,
            price: product.price,
            discountPercentage: product.discountPercentage ?? null,
            variants: [],
          };
        }
      }),
    );

    return productsWithVariants;
  } catch {
    return [];
  }
}

export async function getOrderViewData(id: string) {
  const result = await apiGet<OrderDetail>("/orders/" + id).catch(() => null);
  if (!result) return null;

  const {
    items,
    cityName,
    zoneName,
    areaName,
    latestShipment: _latestShipment,
    ...orderFields
  } = result;

  const totalAmount = result.totalAmount;

  return {
    order: orderFields,
    items: items || [],
    totalAmount,
    cityName: cityName || "",
    zoneName: zoneName || "",
    areaName: areaName || null,
  };
}

export async function getOrderEditData(id: string) {
  const result = await apiGet<OrderFormData>("/orders/" + id + "/form-data").catch(() => null);
  if (!result) return null;

  return result;
}

export async function getOrderShipments(orderId: string) {
  try {
    const result = await apiGet<EnhancedShipment[]>("/orders/" + orderId + "/shipments");
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

export async function getDeliveryProviders() {
  try {
    const result = await apiGet<DeliveryProviderRecord[]>("/settings/delivery-providers");
    const all = Array.isArray(result) ? result : [];
    return all.filter((p) => p.isActive);
  } catch {
    return [];
  }
}
