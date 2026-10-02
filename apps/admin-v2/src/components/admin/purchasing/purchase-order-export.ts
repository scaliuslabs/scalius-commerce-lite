// The purchase order CSV (raw fetch + blob, like the orders and customers
// exports): the API names the file; the PO number is the fallback.
import { withDashboardBasePath } from "~/lib/dashboard-base-path";

function filenameFrom(disposition: string | null, fallback: string): string {
  const match = disposition ? /filename="?([^";]+)"?/i.exec(disposition) : null;
  const name = match?.[1]?.trim();
  return name && /^[\w.-]+$/.test(name) ? name : fallback;
}

export async function downloadPurchaseOrderCsv(order: { id: string; displayNumber: string }): Promise<void> {
  const response = await fetch(
    withDashboardBasePath(`/api/v1/admin/inventory/purchase-orders/${encodeURIComponent(order.id)}/export`),
    { credentials: "same-origin", cache: "no-store" },
  );
  if (!response.ok) throw new Error(`Export failed with ${response.status}`);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filenameFrom(response.headers.get("Content-Disposition"), `${order.displayNumber}.csv`);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
