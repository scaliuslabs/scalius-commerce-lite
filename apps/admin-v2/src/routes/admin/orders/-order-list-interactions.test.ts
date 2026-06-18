import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ORDERS_ROUTE_SOURCE = fileURLToPath(
  new URL("./index.tsx", import.meta.url),
);
const ORDER_TOOLBAR_SOURCE = fileURLToPath(
  new URL(
    "../../../components/admin/data-table/toolbars/OrderToolbar.tsx",
    import.meta.url,
  ),
);
const BULK_SHIP_DIALOG_SOURCE = fileURLToPath(
  new URL(
    "../../../components/admin/order-list/BulkShipDialog.tsx",
    import.meta.url,
  ),
);
const ORDER_MOBILE_CARD_SOURCE = fileURLToPath(
  new URL(
    "../../../components/admin/order-list/OrderMobileCard.tsx",
    import.meta.url,
  ),
);

describe("order list interactions", () => {
  it("guards bulk shipping against re-entry and partial-success reselection", () => {
    const routeSource = readFileSync(ORDERS_ROUTE_SOURCE, "utf8");
    const toolbarSource = readFileSync(ORDER_TOOLBAR_SOURCE, "utf8");
    const dialogSource = readFileSync(BULK_SHIP_DIALOG_SOURCE, "utf8");

    expect(routeSource).toContain("deselectIds");
    expect(routeSource).toContain(
      "if (isShipping || selectedIds.length === 0) return",
    );
    expect(routeSource).toContain("const failedOrderIds: string[] = []");
    expect(routeSource).toContain("deselectIds(shippedOrderIds)");
    expect(routeSource).toContain("isBulkActionBusy={isShipping || bulkDeleteMut.isPending}");
    expect(routeSource).toContain("if (isShipping && !isOpen) return");

    expect(toolbarSource).toContain("isBulkActionBusy?: boolean");
    expect(toolbarSource).toContain("disabled={isBulkActionBusy}");
    expect(toolbarSource).toContain(
      '{isBulkActionBusy ? "Shipping..." : `Ship Orders (${selectedCount})`}',
    );

    expect(dialogSource).toContain("if (isShipping) return");
    expect(dialogSource).toContain("if (isShipping && !nextOpen) return");
    expect(dialogSource).toContain(
      "<Dialog open={isOpen} onOpenChange={handleOpenChange}>",
    );
  });

  it("surfaces list errors and canonicalizes out-of-range pages", () => {
    const routeSource = readFileSync(ORDERS_ROUTE_SOURCE, "utf8");

    expect(routeSource).toContain("getCanonicalPageForPagination");
    expect(routeSource).toContain("const canonicalPage = getCanonicalPageForPagination(search.page, pagination)");
    expect(routeSource).toContain("handleNavigate({ page: canonicalPage })");
    expect(routeSource).toContain("error: rawOrdersError");
    expect(routeSource).toContain("isError: isOrdersError");
    expect(routeSource).toContain("refetch: refetchOrders");
    expect(routeSource).toContain("error={ordersError}");
    expect(routeSource).toContain("void refetchOrders()");
  });

  it("serializes order date filters as date-only values", () => {
    const routeSource = readFileSync(ORDERS_ROUTE_SOURCE, "utf8");

    expect(routeSource).toContain("formatDateOnly");
    expect(routeSource).toContain("parseDateOnly");
    expect(routeSource).toContain("startDate: formatDateOnly(range?.from)");
    expect(routeSource).toContain("endDate: formatDateOnly(range?.to)");
    expect(routeSource).not.toContain("range.from.toISOString()");
    expect(routeSource).not.toContain("range.to.toISOString()");
  });

  it("does not advertise mobile range selection that is not implemented", () => {
    const source = readFileSync(ORDER_MOBILE_CARD_SOURCE, "utf8");

    expect(source).not.toContain("Hold Shift");
    expect(source).not.toContain("shiftKey");
    expect(source).toContain("onToggleSelection: (id: string) => void");
  });
});
