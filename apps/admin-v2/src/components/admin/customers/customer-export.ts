// The customers CSV export (raw fetch + blob, like the orders export). The
// request carries only a tag, a segment id, a channel or customer ids: never
// a search term, phone or e-mail.
import { withDashboardBasePath } from "~/lib/dashboard-base-path";
import { adminCalendarDateKey } from "~/lib/admin-time";
import type { CustomerChannel } from "./customer-list-search";

/** The server's cap for one export of a filter. */
export const CUSTOMER_EXPORT_MAX_ROWS = 10_000;
/** The server takes at most this many chosen ids in one export. */
export const CUSTOMER_EXPORT_MAX_IDS = 100;

export interface CustomerExportFilters {
  tag?: string;
  segmentId?: string;
  subscribed?: CustomerChannel | "any";
}

/** Exact customers (ids, at most 100) or every live customer matching the filters. */
export function buildCustomerExportParams(input: { filters: CustomerExportFilters; ids: readonly string[] | null }): URLSearchParams {
  const params = new URLSearchParams();
  if (input.ids) {
    if (input.ids.length === 0 || input.ids.length > CUSTOMER_EXPORT_MAX_IDS) {
      throw new RangeError(`Export 1 to ${CUSTOMER_EXPORT_MAX_IDS} chosen customers.`);
    }
    params.set("ids", input.ids.join(","));
    params.set("maxRows", String(input.ids.length));
    return params;
  }
  for (const key of ["tag", "segmentId", "subscribed"] as const) {
    const value = input.filters[key];
    if (value) params.set(key, value);
  }
  params.set("maxRows", String(CUSTOMER_EXPORT_MAX_ROWS));
  return params;
}

/** Downloads the CSV; `limited` means the server stopped at its cap. */
export async function downloadCustomerExport(params: URLSearchParams): Promise<{ rowCount: number | null; limited: boolean }> {
  const response = await fetch(`${withDashboardBasePath("/api/v1/admin/customers/export")}?${params.toString()}`, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Export failed with ${response.status}`);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `customers-${adminCalendarDateKey()}.csv`;
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
