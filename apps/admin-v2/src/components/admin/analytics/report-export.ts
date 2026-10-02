// A report's CSV export (raw fetch + blob, like the order and customer
// exports). The request carries only the report id, dates and sort: never a
// customer name, phone or e-mail.
import { withDashboardBasePath } from "~/lib/dashboard-base-path";

export interface ReportExportParams {
  from?: string;
  to?: string;
  granularity?: string;
  sort?: string;
  direction?: "asc" | "desc";
}

export function reportExportUrl(reportId: string, params: ReportExportParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const query = search.toString();
  return `${withDashboardBasePath(`/api/v1/admin/reports/${encodeURIComponent(reportId)}/export`)}${query ? `?${query}` : ""}`;
}

/** The server's file name, else a readable one. */
function filenameOf(response: Response, fallback: string): string {
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  return match?.[1] ?? fallback;
}

/** Downloads the CSV; `limited` means the server stopped at its cap. */
export async function downloadReportExport(reportId: string, params: ReportExportParams): Promise<{ rowCount: number | null; limited: boolean }> {
  const response = await fetch(reportExportUrl(reportId, params), { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error(`Export failed with ${response.status}`);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filenameOf(response, `${reportId}.csv`);
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
