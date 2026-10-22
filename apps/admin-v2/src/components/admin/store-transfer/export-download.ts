// Paged CSV exports (products, inventory): the API returns one page at a time
// with the cursor of the next in X-Export-Next-Cursor; the pages are joined
// into one file in the browser and saved. The request carries only a cursor,
// a page size and a location id: never a search term or contact detail.
import { withDashboardBasePath } from "~/lib/dashboard-base-path";
import { adminCalendarDateKey } from "~/lib/admin-time";

export type PagedExport = "products" | "inventory";

const EXPORT_PATH: Record<PagedExport, string> = {
  products: "/api/v1/admin/export/products",
  inventory: "/api/v1/admin/export/inventory",
};

const PAGE_SIZE: Record<PagedExport, number> = { products: 250, inventory: 500 };
/** Selected products per request (one bound list on the server). */
const SELECTION_CHUNK = 90;

/** Fetches every page and joins them (the first page carries the BOM and header). */
export async function fetchPagedExport(
  kind: PagedExport,
  options: {
    locationId?: string;
    /** Only these products (a list selection): sent 90 per request, the header on the first. */
    ids?: readonly string[];
    onProgress?: (rows: number) => void;
    signal?: AbortSignal;
    fetcher?: typeof fetch;
  } = {},
): Promise<{ csv: string; rows: number }> {
  const fetcher = options.fetcher ?? fetch;
  if (options.ids) {
    const parts: string[] = [];
    let rows = 0;
    for (let start = 0; start < options.ids.length; start += SELECTION_CHUNK) {
      const params = new URLSearchParams({ limit: String(SELECTION_CHUNK), ids: options.ids.slice(start, start + SELECTION_CHUNK).join(",") });
      if (start > 0) params.set("header", "false");
      const response = await fetcher(`${withDashboardBasePath(EXPORT_PATH[kind])}?${params.toString()}`, {
        credentials: "same-origin",
        cache: "no-store",
        signal: options.signal,
      });
      if (!response.ok) throw new Error(`Export failed with ${response.status}`);
      parts.push(await response.text());
      rows += Number(response.headers.get("X-Export-Row-Count") ?? "0") || 0;
      options.onProgress?.(rows);
    }
    return { csv: parts.join(""), rows };
  }
  const parts: string[] = [];
  let cursor: string | null = null;
  let rows = 0;
  do {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE[kind]) });
    if (cursor) {
      params.set("after", cursor);
      params.set("header", "false");
    }
    if (options.locationId) params.set("locationId", options.locationId);
    const response = await fetcher(`${withDashboardBasePath(EXPORT_PATH[kind])}?${params.toString()}`, {
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
    });
    if (!response.ok) throw new Error(`Export failed with ${response.status}`);
    parts.push(await response.text());
    rows += Number(response.headers.get("X-Export-Row-Count") ?? "0") || 0;
    options.onProgress?.(rows);
    cursor = response.headers.get("X-Export-Next-Cursor");
  } while (cursor);
  return { csv: parts.join(""), rows };
}

/** Saves text as a CSV file download. */
export function saveCsv(csv: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function downloadPagedExport(kind: PagedExport, onProgress?: (rows: number) => void, ids?: readonly string[]): Promise<number> {
  const { csv, rows } = await fetchPagedExport(kind, { onProgress, ...(ids ? { ids } : {}) });
  saveCsv(csv, `${kind}-${adminCalendarDateKey()}.csv`);
  return rows;
}
