import { apiGet } from "@/lib/api-fetch";

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

  const result = await apiGet<{ orders: any[]; pagination: any }>("/orders", params);

  // The API already enriches orders with location names and timestamps.
  // Convert timestamps to Date objects for admin pages.
  const ordersWithDates = result.orders.map((order: any) => ({
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
  // Fetch all products with variants for the order form product picker.
  // Uses the products list endpoint (high limit to get all) since there's
  // no dedicated form-options endpoint for orders.
  try {
    const result = await apiGet<{ products: any[]; pagination: any }>("/products", {
      page: "1",
      limit: "999",
    });

    // The order form expects products with { id, name, price, discountPercentage, variants[] }.
    // The products list endpoint returns products with basic fields.
    // Fetch each product's detail for variant data.
    const productsWithVariants = await Promise.all(
      (result.products || []).map(async (product: any) => {
        try {
          const detail = await apiGet<any>("/products/" + product.id);
          return {
            id: product.id,
            name: product.name,
            price: product.price,
            discountPercentage: product.discountPercentage ?? null,
            variants: (detail.variants || [])
              .filter((v: any) => !v.deletedAt)
              .map((v: any) => ({
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
  const result = await apiGet<any>("/orders/" + id).catch(() => null);
  if (!result) return null;

  // The API returns a flat object with all fields at top level.
  // The page expects { order, items, totalAmount, cityName, zoneName, areaName }.
  // Transform API shape back to what the page destructures.
  const {
    items,
    cityName,
    zoneName,
    areaName,
    latestShipment: _latestShipment,
    ...orderFields
  } = result;

  const totalAmount = (items || []).reduce(
    (sum: number, item: any) => sum + item.price * item.quantity,
    0,
  );

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
  const result = await apiGet<any>("/orders/" + id + "/form-data").catch(() => null);
  if (!result) return null;

  return result;
}

export async function getOrderShipments(orderId: string) {
  try {
    const result = await apiGet<any>("/orders/" + orderId + "/shipments");
    // API returns ok(c, enhancedShipments) where enhancedShipments is an array.
    // apiGet unwraps the envelope — result is the array directly.
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

export async function getDeliveryProviders() {
  try {
    const result = await apiGet<any>("/settings/delivery-providers");
    // API returns ok(c, maskedProviders) — an array.
    // apiGet unwraps the envelope — result is the array directly.
    // Filter to active providers only (matches old getActiveProviders() behavior).
    const all = Array.isArray(result) ? result : [];
    return all.filter((p: any) => p.isActive);
  } catch {
    return [];
  }
}
