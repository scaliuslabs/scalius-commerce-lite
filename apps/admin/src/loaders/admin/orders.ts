import { apiGet } from "@/lib/api-server";
import type { OrderListItem } from "@scalius/core/modules/orders";
import type {
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

  const result = await apiGet<{ orders: OrderListItem[]; pagination: PaginationResponse }>("/orders", params);

  const ordersWithDates: OrderListItem[] = result.orders.map((order) => ({
    ...order,
    createdAt:
      order.createdAt instanceof Date
        ? order.createdAt
        : new Date(order.createdAt as unknown as string),
    updatedAt:
      order.updatedAt instanceof Date
        ? order.updatedAt
        : new Date(order.updatedAt as unknown as string),
  }));

  return { orders: ordersWithDates, pagination: result.pagination };
}

export async function getOrderFormProducts() {
  try {
    // Limit to 100 products to avoid excessive API calls.
    // Each product requires a detail fetch for variant data (no batch endpoint).
    const MAX_PRODUCTS = 100;
    const BATCH_SIZE = 10;

    const result = await apiGet<{ products: ProductListItem[]; pagination: PaginationResponse }>("/products", {
      page: "1",
      limit: String(MAX_PRODUCTS),
    });

    const products = result.products || [];
    const productsWithVariants: Array<{
      id: string;
      name: string;
      price: number;
      discountPercentage: number | null;
      variants: Array<{
        id: string;
        size: string | null;
        color: string | null;
        weight: number | null;
        sku: string;
        price: number;
        stock: number;
      }>;
    }> = [];

    // Fetch variant details in batches to avoid overwhelming the API
    for (let i = 0; i < products.length; i += BATCH_SIZE) {
      const batch = products.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (product) => {
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
                  weight: typeof v.weight === "string" ? parseFloat(v.weight) || null : (v.weight ?? null),
                  sku: v.sku || "",
                  price: v.price ?? 0,
                  stock: v.stock ?? 0,
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
      productsWithVariants.push(...batchResults);
    }

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

  return {
    ...result,
    productsWithVariants: result.productsWithVariants.map((p) => ({
      ...p,
      variants: p.variants.map((v) => ({
        ...v,
        sku: v.sku || "",
        price: v.price ?? 0,
      })),
    })),
  };
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
