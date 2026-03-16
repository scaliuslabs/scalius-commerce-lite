import { apiGet } from "@/lib/api-fetch";

export async function getCustomersIndexData(options: {
  page: number;
  limit: number;
  search: string;
  showTrashed: boolean;
  sort:
    | "name"
    | "totalOrders"
    | "totalSpent"
    | "lastOrderAt"
    | "createdAt"
    | "updatedAt";
  order: "asc" | "desc";
}) {
  const params: Record<string, string> = {
    page: String(options.page),
    limit: String(options.limit),
    sort: options.sort,
    order: options.order,
  };
  if (options.search) params.search = options.search;
  if (options.showTrashed) params.trashed = "true";

  const result = await apiGet<{ customers: any[]; pagination: any }>("/customers", params);

  // Convert timestamps to Date objects for admin pages
  const formattedCustomers = result.customers.map((customer: any) => ({
    ...customer,
    lastOrderAt: customer.lastOrderAt ? new Date(customer.lastOrderAt) : null,
    createdAt: new Date(customer.createdAt),
    updatedAt: new Date(customer.updatedAt),
  }));

  return {
    customers: formattedCustomers,
    pagination: result.pagination,
  };
}

export async function getCustomerEditData(id: string) {
  const customer = await apiGet<any>("/customers/" + id).catch(() => null);
  if (!customer) return null;

  return {
    ...customer,
    cityName: customer.cityName || "",
    zoneName: customer.zoneName || "",
    areaName: customer.areaName || "",
  };
}

export async function getCustomerHistoryData(id: string) {
  const result = await apiGet<any>("/customers/" + id + "/history").catch(() => null);
  if (!result) return null;

  // The API already enriches with location names and converts timestamps
  // to Date objects via JSON serialization (they come as ISO strings).
  // Convert ISO strings back to Date objects for admin pages.
  const customer = {
    ...result.customer,
    lastOrderAt: result.customer.lastOrderAt ? new Date(result.customer.lastOrderAt) : null,
    createdAt: new Date(result.customer.createdAt),
    updatedAt: new Date(result.customer.updatedAt),
  };

  const history = (result.history || []).map((record: any) => ({
    ...record,
    createdAt: new Date(record.createdAt),
  }));

  const orders = (result.orders || []).map((order: any) => ({
    ...order,
    createdAt: new Date(order.createdAt),
  }));

  return {
    customer,
    history,
    orders,
  };
}
