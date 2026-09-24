import { createContext, useContext } from "react";
import { withDashboardBasePath } from "~/lib/dashboard-base-path";
import { adminCalendarDateKey } from "~/lib/admin-time";
import type { OrdersQuery } from "~/lib/api-query-options/orders";

export type OrderExportScope = "page" | "all" | "selected";
export type OrderExportFormat = "summary" | "items";

/** The server's hard cap for one export of all matching orders. */
export const ORDER_EXPORT_MAX_ROWS = 5000;

/**
 * Export request: exact orders (the page or a selection, by id) or every order
 * matching the list's filters and search.
 */
export function buildOrderExportParams(input: {
  filters: Omit<OrdersQuery, "page" | "limit">;
  ids: readonly string[] | null;
  format: OrderExportFormat;
}): URLSearchParams {
  const params = new URLSearchParams();
  params.set("format", input.format);
  if (input.ids) {
    params.set("ids", input.ids.join(","));
    params.set("maxRows", String(input.ids.length));
    return params;
  }
  for (const [key, value] of Object.entries(input.filters)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  params.set("maxRows", String(ORDER_EXPORT_MAX_ROWS));
  return params;
}

/** Downloads the orders CSV; `limited` means the server stopped at its cap. */
export async function downloadOrderExport(
  params: URLSearchParams,
): Promise<{ rowCount: number | null; limited: boolean }> {
  const response = await fetch(`${withDashboardBasePath("/api/v1/admin/orders/export")}?${params.toString()}`);
  if (!response.ok) throw new Error(`Export failed with ${response.status}`);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `orders-${adminCalendarDateKey()}.csv`;
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

/** Lets the Orders page header's Export button open the list's export dialog. */
export const OrderExportContext = createContext<{ open: boolean; setOpen: (open: boolean) => void }>({
  open: false,
  setOpen: () => undefined,
});

export const useOrderExportDialog = () => useContext(OrderExportContext);
