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
  // This data is now obtained from the order form-data endpoint.
  // For standalone usage, we still provide a helper but typically
  // getOrderEditData covers it.
  const result = await apiGet<{ productsWithVariants: any[] }>("/orders/new/form-data").catch(
    () => ({ productsWithVariants: [] }),
  );
  return result.productsWithVariants;
}

export async function getOrderViewData(id: string) {
  const result = await apiGet<any>("/orders/" + id).catch(() => null);
  if (!result) return null;

  return result;
}

export async function getOrderEditData(id: string) {
  const result = await apiGet<any>("/orders/" + id + "/form-data").catch(() => null);
  if (!result) return null;

  return result;
}
