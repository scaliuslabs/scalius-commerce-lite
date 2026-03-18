import { apiGet } from "@/lib/api-server";
import type {
  Customer,
  PaginationResponse,
  CustomerHistoryData,
  CustomerHistoryRecord,
  CustomerOrderSummary,
} from "@/types/api-responses";

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

  const result = await apiGet<{ customers: Customer[]; pagination: PaginationResponse }>("/customers", params);

  const formattedCustomers = result.customers.map((customer) => ({
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
  const customer = await apiGet<Customer>("/customers/" + id).catch(() => null);
  if (!customer) return null;

  return {
    ...customer,
    cityName: customer.cityName || "",
    zoneName: customer.zoneName || "",
    areaName: customer.areaName || "",
  };
}

export async function getCustomerHistoryData(id: string) {
  const result = await apiGet<CustomerHistoryData>("/customers/" + id + "/history").catch(() => null);
  if (!result) return null;

  const customer = {
    ...result.customer,
    lastOrderAt: result.customer.lastOrderAt ? new Date(result.customer.lastOrderAt) : null,
    createdAt: new Date(result.customer.createdAt),
    updatedAt: new Date(result.customer.updatedAt),
  };

  const history = (result.history || []).map((record: CustomerHistoryRecord) => ({
    ...record,
    createdAt: new Date(record.createdAt),
  }));

  const orders = (result.orders || []).map((order: CustomerOrderSummary) => ({
    ...order,
    createdAt: new Date(order.createdAt),
  }));

  return {
    customer,
    history,
    orders,
  };
}
