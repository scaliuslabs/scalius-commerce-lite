import { withDashboardBasePath } from "~/lib/dashboard-base-path";
import { adminCalendarDateKey } from "~/lib/admin-time";

export interface OrderExportSearch {
  search: string;
  status?: string;
  statusGroup?: string;
  paymentStatus?: string;
  paymentMethod?: string;
  fulfillmentStatus?: string;
  paymentRecovery?: string;
  archived: boolean;
  sort?: string;
  order?: "asc" | "desc";
  startDate?: string;
  endDate?: string;
}

function appendCommonOrderFilters(
  params: URLSearchParams,
  search: OrderExportSearch,
): void {
  if (search.search.trim()) params.set("search", search.search.trim());
  if (search.status) params.set("status", search.status);
  if (search.statusGroup) params.set("statusGroup", search.statusGroup);
  if (search.paymentStatus) params.set("paymentStatus", search.paymentStatus);
  if (search.paymentMethod) params.set("paymentMethod", search.paymentMethod);
  if (search.fulfillmentStatus) params.set("fulfillmentStatus", search.fulfillmentStatus);
  if (search.archived) params.set("archived", "true");
  if (search.sort) params.set("sort", search.sort);
  if (search.order) params.set("order", search.order);
  if (search.startDate) params.set("startDate", search.startDate);
  if (search.endDate) params.set("endDate", search.endDate);
  params.set("maxRows", "1000");
}

export function buildRecoveryExportSearchParams(
  search: OrderExportSearch,
): URLSearchParams | null {
  if (!search.paymentRecovery) return null;
  const params = new URLSearchParams();
  params.set("state", search.paymentRecovery);
  appendCommonOrderFilters(params, search);
  return params;
}

export function buildOrderExportSearchParams(
  search: OrderExportSearch,
): URLSearchParams {
  const params = new URLSearchParams();
  appendCommonOrderFilters(params, search);
  if (search.paymentRecovery) params.set("paymentRecovery", search.paymentRecovery);
  return params;
}

/** Downloads the filtered orders as CSV; online-payment follow-up filters use the recovery export. */
export async function downloadOrderExport(
  search: OrderExportSearch,
): Promise<{ rowCount: number | null; limited: boolean }> {
  const recoveryParams = buildRecoveryExportSearchParams(search);
  const params = recoveryParams ?? buildOrderExportSearchParams(search);
  const endpoint = recoveryParams
    ? "/api/v1/admin/orders/payment-recovery/export"
    : "/api/v1/admin/orders/export";
  const response = await fetch(`${withDashboardBasePath(endpoint)}?${params.toString()}`);
  if (!response.ok) throw new Error(`Export failed with ${response.status}`);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `${recoveryParams ? "payment-recovery" : "orders"}-${adminCalendarDateKey()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  const rowCount = response.headers.get("X-Export-Row-Count");
  return {
    rowCount: rowCount && Number.isFinite(Number(rowCount)) ? Number(rowCount) : null,
    limited: response.headers.get("X-Export-Limited") === "true",
  };
}
