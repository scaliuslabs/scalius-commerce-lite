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
const ORDER_COLUMNS_SOURCE = fileURLToPath(
  new URL(
    "../../../components/admin/data-table/columns/order-columns.tsx",
    import.meta.url,
  ),
);
const ORDER_SERVER_FUNCTIONS_SOURCE = fileURLToPath(
  new URL("../../../lib/api-functions/orders.ts", import.meta.url),
);
const ORDER_MUTATIONS_SOURCE = fileURLToPath(
  new URL("../../../lib/api-mutations/orders.ts", import.meta.url),
);
const DATA_TABLE_TOOLBAR_SOURCE = fileURLToPath(
  new URL(
    "../../../components/admin/data-table/DataTableToolbar.tsx",
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
    expect(routeSource).toContain("useBulkShipOrders");
    expect(routeSource).toContain("const bulkShipMut = useBulkShipOrders()");
    expect(routeSource).toContain("await bulkShipMut.mutateAsync");
    expect(routeSource).toContain("orderIds,");
    expect(routeSource).toContain("providerId,");
    expect(routeSource).toContain("options: {},");
    expect(routeSource).not.toContain("createOrderShipment");
    expect(routeSource).not.toContain("for (const orderId of selectedIds)");
    expect(routeSource).not.toContain("data: { orderId, shipment:");
    expect(routeSource).not.toContain("item.shipment");
    expect(routeSource).toContain("deselectIds(shippedOrderIds)");
    expect(routeSource).toContain("isBulkActionBusy={isShipping || archiveMut.isPending}");
    expect(routeSource).toContain("if (isShipping && !isOpen) return");
    expect(routeSource).toContain("selectedActivePaymentSetupOrders.length > 0");
    expect(routeSource).toContain("const selectedActiveRefundOrders = useMemo");
    expect(routeSource).toContain("hasActiveRefundOperation(order)");
    expect(routeSource).toContain("selectedActiveRefundOrders.length > 0");
    expect(routeSource).toContain("Resolve refund recovery first");
    expect(routeSource).toContain("const selectedShipmentLockedOrders = useMemo");
    expect(routeSource).toContain("hasActiveShipmentLock(order)");
    expect(routeSource).toContain("selectedShipmentLockedOrders.length > 0");
    expect(routeSource).toContain("Resolve shipment recovery first");
    expect(routeSource).toContain("result.results");
    expect(routeSource).toContain("filter((item) => item.success)");
    expect(routeSource).toContain("filter((item) => !item.success)");
    expect(routeSource).toContain("if (result.successCount === orderIds.length)");
    expect(routeSource).toContain("setLastBulkShipResult(buildBulkShipResultSummary(result))");
    expect(routeSource).toContain("setLastBulkShipResult(buildFailedBulkShipResultSummary(orderIds))");
    expect(routeSource).toContain("resultSummary={lastBulkShipResult}");
    expect(routeSource).not.toContain(
      "finally {\n        setIsShipping(false);\n        setIsShippingDialogOpen(false);",
    );

    expect(toolbarSource).toContain("isBulkActionBusy?: boolean");
    expect(toolbarSource).toContain("selectedPaymentRecoveryCount?: number");
    expect(toolbarSource).toContain("selectedActivePaymentSetupCount?: number");
    expect(toolbarSource).toContain("selectedActiveRefundCount?: number");
    expect(toolbarSource).toContain("selectedShipmentLockCount?: number");
    expect(toolbarSource).toContain("selectedShipmentLockCount > 0");
    expect(toolbarSource).toContain("disabled={isBulkActionBusy || bulkShipBlockedByRecovery}");
    expect(toolbarSource).toContain("disabled={isBulkActionBusy || bulkArchiveBlocked}");
    expect(toolbarSource).toContain("Resolve active refund recovery before archiving these orders.");
    expect(toolbarSource).toContain("Resolve active shipment recovery before archiving these orders.");
    expect(toolbarSource).toContain("`Resolve refund (${selectedActiveRefundCount})`");
    expect(toolbarSource).toContain("`Resolve shipment (${selectedShipmentLockCount})`");
    expect(toolbarSource).toContain('searchPlaceholder="Search orders…"');
    expect(toolbarSource).toContain("grid w-full grid-cols-6 gap-1 rounded-md");
    expect(toolbarSource).toContain('index >= 3 ? "col-span-3" : "col-span-2"');
    expect(toolbarSource).toContain('aria-label="Order views"');
    expect(toolbarSource).toContain('aria-controls="order-advanced-filters"');
    expect(toolbarSource).toContain('id="order-advanced-filters"');
    expect(toolbarSource).toContain("activeAdvancedFilterCount");
    expect(toolbarSource).toContain("Clear filters");
    expect(toolbarSource).toContain("Auto-refresh");

    expect(dialogSource).toContain("if (isShipping) return");
    expect(dialogSource).toContain("if (isShipping && !nextOpen) return");
    expect(dialogSource).toContain(
      "<Dialog open={isOpen} onOpenChange={handleOpenChange}>",
    );
    expect(dialogSource).toContain("resultSummary: BulkShipResultSummary | null");
    expect(dialogSource).toContain("visibleFailures");
    expect(dialogSource).toContain("resultSummary.successCount");
    expect(dialogSource).toContain("resultSummary.failureCount");
    expect(dialogSource).toContain("failure.orderId");
    expect(dialogSource).toContain("failure.error");
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

  it("keeps order auto-refresh scoped to the active list query", () => {
    const routeSource = readFileSync(ORDERS_ROUTE_SOURCE, "utf8");
    const mutationsSource = readFileSync(ORDER_MUTATIONS_SOURCE, "utf8");
    const refreshBlock = routeSource.slice(
      routeSource.indexOf("// ── Active-query refresh"),
      routeSource.indexOf("// ── Auto-refresh"),
    );

    expect(refreshBlock).toContain("activeOrderListRefreshRef");
    expect(refreshBlock).toContain("orderListFetchingRef");
    expect(refreshBlock).toContain("orderListRefreshInFlightRef");
    expect(refreshBlock).toContain("autoRefreshPausedRef.current");
    expect(refreshBlock).toContain("ORDER_AUTO_REFRESH_DEBOUNCE_MS");
    expect(refreshBlock).toContain("void Promise.resolve(refetchActiveOrders()).finally");
    expect(refreshBlock).not.toContain("invalidateQueries");
    expect(refreshBlock).not.toContain("queryKeys.orders.list()");

    expect(routeSource).toContain("getOrderAutoRefreshPauseReason");
    expect(routeSource).toContain("autoRefreshPauseReason={autoRefreshPauseReason}");
    expect(routeSource).toContain("if (autoRefreshPausedRef.current) return prev");

    // Mutations may still invalidate all order-list variants; idle resume must not.
    expect(mutationsSource).toContain("queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() })");
  });

  it("labels the bounded page export separately from the server recovery export", () => {
    const routeSource = readFileSync(ORDERS_ROUTE_SOURCE, "utf8");
    const toolbarSource = readFileSync(ORDER_TOOLBAR_SOURCE, "utf8");

    expect(toolbarSource).toContain("exportLabel: string");
    expect(toolbarSource).toContain("{exportLabel}");
    expect(toolbarSource).not.toContain("Export CSV");
    expect(routeSource).toContain('"Export recovery CSV"');
    expect(routeSource).toContain('"Export current page"');
    expect(routeSource).toContain("orders from this page exported");
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

  it("keeps payment and fulfillment filters wired from URL to API params", () => {
    const routeSource = readFileSync(ORDERS_ROUTE_SOURCE, "utf8");
    const toolbarSource = readFileSync(ORDER_TOOLBAR_SOURCE, "utf8");
    const serverFunctionsSource = readFileSync(
      ORDER_SERVER_FUNCTIONS_SOURCE,
      "utf8",
    );

    expect(routeSource).toContain("const PAYMENT_STATUS_FILTERS");
    expect(routeSource).toContain("const PAYMENT_METHOD_FILTERS");
    expect(routeSource).toContain("const FULFILLMENT_STATUS_FILTERS");
    expect(routeSource).toContain("const PAYMENT_RECOVERY_FILTERS");
    expect(routeSource).toContain("const ORDER_STATUS_GROUP_FILTERS");
    expect(routeSource).toContain(
      "paymentStatus: normalizeOptionalEnumSearchParam",
    );
    expect(routeSource).toContain(
      "paymentMethod: normalizeOptionalEnumSearchParam",
    );
    expect(routeSource).toContain(
      "fulfillmentStatus: normalizeOptionalEnumSearchParam",
    );
    expect(routeSource).toContain(
      "paymentRecovery: normalizeOptionalEnumSearchParam",
    );
    expect(routeSource).toContain("paymentStatus: deps.paymentStatus");
    expect(routeSource).toContain("paymentMethod: deps.paymentMethod");
    expect(routeSource).toContain(
      "fulfillmentStatus: deps.fulfillmentStatus",
    );
    expect(routeSource).toContain("paymentRecovery: deps.paymentRecovery");
    expect(routeSource).toContain("statusGroup: deps.statusGroup");
    expect(routeSource).toContain("paymentStatus: normalizeOptionalEnumSearchParam(");
    expect(routeSource).toContain("paymentMethod: normalizeOptionalEnumSearchParam(");
    expect(routeSource).toContain("fulfillmentStatus: normalizeOptionalEnumSearchParam(");
    expect(routeSource).toContain("paymentRecovery: normalizeOptionalEnumSearchParam(");
    expect(routeSource).toContain("activePaymentStatus={activePaymentStatus}");
    expect(routeSource).toContain("activeStatusGroup={activeStatusGroup}");
    expect(routeSource).toContain("activePaymentMethod={activePaymentMethod}");
    expect(routeSource).toContain(
      "activeFulfillmentStatus={activeFulfillmentStatus}",
    );
    expect(routeSource).toContain("activePaymentRecovery={activePaymentRecovery}");
    expect(routeSource).toContain("selectedPaymentRecoveryCount={selectedPaymentRecoveryOrders.length}");
    expect(routeSource).toContain("selectedActivePaymentSetupCount={selectedActivePaymentSetupOrders.length}");
    expect(routeSource).toContain("selectedActiveRefundCount={selectedActiveRefundOrders.length}");

    expect(toolbarSource).toContain("OrderFilterSelect");
    expect(toolbarSource).toContain('aria-label="Order views"');
    expect(toolbarSource).toContain('placeholder="Any order status"');
    expect(toolbarSource).toContain('ariaLabel="Filter by exact order status"');
    expect(toolbarSource).not.toContain("Status filter pills");
    expect(toolbarSource).toContain('placeholder="Any payment"');
    expect(toolbarSource).toContain('placeholder="Any method"');
    expect(toolbarSource).toContain('placeholder="Payment recovery"');
    expect(toolbarSource).toContain('placeholder="Any fulfillment"');
    expect(toolbarSource).toContain('ariaLabel="Filter by payment status"');
    expect(toolbarSource).toContain('ariaLabel="Filter by payment method"');
    expect(toolbarSource).toContain('ariaLabel="Filter by payment recovery"');
    expect(toolbarSource).toContain(
      'ariaLabel="Filter by fulfillment status"',
    );

    expect(serverFunctionsSource).toContain(
      "if (data.statusGroup) params.statusGroup = data.statusGroup",
    );
    expect(serverFunctionsSource).toContain(
      "if (data.paymentStatus) params.paymentStatus = data.paymentStatus",
    );
    expect(serverFunctionsSource).toContain(
      "if (data.paymentMethod) params.paymentMethod = data.paymentMethod",
    );
    expect(serverFunctionsSource).toContain(
      "if (data.fulfillmentStatus) params.fulfillmentStatus = data.fulfillmentStatus",
    );
    expect(serverFunctionsSource).toContain(
      "if (data.paymentRecovery) params.paymentRecovery = data.paymentRecovery",
    );
  });

  it("uses a server-backed export for hosted-payment recovery filters", () => {
    const routeSource = readFileSync(ORDERS_ROUTE_SOURCE, "utf8");

    expect(routeSource).toContain("function buildRecoveryExportSearchParams");
    expect(routeSource).toContain("if (!search.paymentRecovery) return null");
    expect(routeSource).toContain('params.set("state", search.paymentRecovery)');
    expect(routeSource).toContain("/api/v1/admin/orders/payment-recovery/export?");
    expect(routeSource).toContain('`payment-recovery-${new Date().toISOString().split("T")[0]}.csv`');
    expect(routeSource).toContain('response.headers.get("X-Export-Row-Count")');
    expect(routeSource).toContain('response.headers.get("X-Export-Limited") === "true"');
    expect(routeSource).toContain('"Payment Recovery"');
    expect(routeSource).toContain('"Recovery Gateway"');
    expect(routeSource).toContain('"Recovery Status"');
    expect(routeSource).toContain("order.paymentRecovery?.attempts ?? 0");
  });

  it("shows fulfillment state in desktop and mobile order rows", () => {
    const columnsSource = readFileSync(ORDER_COLUMNS_SOURCE, "utf8");
    const mobileSource = readFileSync(ORDER_MOBILE_CARD_SOURCE, "utf8");

    expect(columnsSource).toContain("FulfillmentStatusBadge");
    expect(columnsSource).toContain(
      "FulfillmentStatusBadge status={order.fulfillmentStatus}",
    );
    expect(mobileSource).toContain("FulfillmentStatusBadge");
    expect(mobileSource).toContain(
      "FulfillmentStatusBadge status={order.fulfillmentStatus}",
    );
    expect(mobileSource).toContain("function PaymentMethodLabel");
  });

  it("surfaces active refund locks in desktop/mobile rows and archive dialog", () => {
    const routeSource = readFileSync(ORDERS_ROUTE_SOURCE, "utf8");
    const columnsSource = readFileSync(ORDER_COLUMNS_SOURCE, "utf8");
    const mobileSource = readFileSync(ORDER_MOBILE_CARD_SOURCE, "utf8");
    const dialogSource = readFileSync(
      fileURLToPath(
        new URL(
          "../../../components/admin/order-list/ArchiveOrderDialog.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const statusSelectorSource = readFileSync(
      fileURLToPath(
        new URL(
          "../../../components/admin/order-list/OrderStatusSelector.tsx",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    expect(columnsSource).toContain("RefundRecoveryBadge");
    expect(columnsSource).toContain("ShipmentRecoveryBadge");
    expect(columnsSource).toContain("operation={order.activeRefundOperation}");
    expect(columnsSource).toContain("recovery={order.shipmentRecovery}");
    expect(columnsSource).toContain("order.activeRefundOperation?.active !== true");
    expect(columnsSource).toContain("order.shipmentRecovery?.activeLock !== true");
    expect(columnsSource).toContain("Complete or reconcile the refund before changing this order.");
    expect(columnsSource).toContain("Resolve refund recovery before archiving");
    expect(columnsSource).toContain("Resolve shipment recovery before archiving");

    expect(mobileSource).toContain("RefundRecoveryBadge");
    expect(mobileSource).toContain("ShipmentRecoveryBadge");
    expect(mobileSource).toContain("operation={order.activeRefundOperation} compact");
    expect(mobileSource).toContain("recovery={order.shipmentRecovery} compact");
    expect(mobileSource).toContain("orderActions.canChangeOrderStatus &&");
    expect(mobileSource).toContain("!hasActiveRefundOperation &&");
    expect(mobileSource).toContain("!shipmentLocked");
    expect(mobileSource).toContain("Resolve refund recovery before archiving");
    expect(mobileSource).toContain("Resolve shipment recovery before archiving");

    expect(dialogSource).toContain("activeRefundCount?: number");
    expect(dialogSource).toContain("shipmentLockCount?: number");
    expect(dialogSource).toContain("shipmentLockCount > 0");
    expect(dialogSource).toContain("disabled={isArchiving || isBlocked}");
    expect(dialogSource).toContain("active refund recovery. Complete or reconcile");
    expect(dialogSource).toContain("active shipment recovery. Resolve the shipment");
    expect(dialogSource).not.toContain("before deleting");

    expect(routeSource).toContain("const archiveActiveRefundCount = isBulkArchiveOpen");
    expect(routeSource).toContain("const archiveShipmentLockCount = isBulkArchiveOpen");
    expect(routeSource).toContain("activeRefundCount={archiveActiveRefundCount}");
    expect(routeSource).toContain("shipmentLockCount={archiveShipmentLockCount}");
    expect(statusSelectorSource).toContain("disabledReason?: string");
    expect(statusSelectorSource).toContain("disabledReason: disabledReasonOverride");
  });

  it("allows the order toolbar filters and actions to wrap on narrow screens", () => {
    const toolbarSource = readFileSync(ORDER_TOOLBAR_SOURCE, "utf8");
    const dataTableToolbarSource = readFileSync(
      DATA_TABLE_TOOLBAR_SOURCE,
      "utf8",
    );

    expect(toolbarSource).toContain("flex flex-wrap items-center gap-2");
    expect(dataTableToolbarSource).toContain(
      "flex min-w-0 flex-1 flex-wrap items-center gap-2",
    );
    expect(dataTableToolbarSource).toContain(
      "flex min-w-0 flex-wrap items-center gap-2",
    );
    expect(dataTableToolbarSource).toContain(
      "relative min-w-[220px] max-w-sm flex-1",
    );
  });

  it("uses explicit relevance only while starting an order search", () => {
    const routeSource = readFileSync(ORDERS_ROUTE_SOURCE, "utf8");

    expect(routeSource).toContain('"relevance"');
    expect(routeSource).toContain('"customerName"');
    expect(routeSource).toContain("const hasNextSearch = value.trim().length > 0");
    expect(routeSource).toContain("const hasCurrentSearch = search.search.trim().length > 0");
    expect(routeSource).toContain('sort: "relevance"');
    expect(routeSource).toContain('sort: "updatedAt"');
    expect(routeSource).toContain('order: "desc"');
    expect(routeSource).toContain(
      'currentSort: search.sort === "relevance" ? undefined : search.sort',
    );
  });

  it("does not advertise mobile range selection that is not implemented", () => {
    const source = readFileSync(ORDER_MOBILE_CARD_SOURCE, "utf8");

    expect(source).not.toContain("Hold Shift");
    expect(source).not.toContain("shiftKey");
    expect(source).toContain("onToggleSelection: (id: string) => void");
  });

  it("keeps order list actions aligned with granular order permissions", () => {
    const routeSource = readFileSync(ORDERS_ROUTE_SOURCE, "utf8");
    const toolbarSource = readFileSync(ORDER_TOOLBAR_SOURCE, "utf8");
    const columnsSource = readFileSync(ORDER_COLUMNS_SOURCE, "utf8");
    const mobileSource = readFileSync(ORDER_MOBILE_CARD_SOURCE, "utf8");

    expect(routeSource).toContain("useOrderActionPermissions");
    expect(routeSource).toContain("orderActions={orderActions}");
    expect(routeSource).toContain("orderActions.canBulkDeleteOrders");
    expect(routeSource).toContain("orderActions.canBulkShipOrders");
    expect(routeSource).toContain("orderActions.canChangeOrderStatus");

    expect(toolbarSource).toContain("orderActions.canCreateOrders");
    expect(toolbarSource).toContain("orderActions.canBulkDeleteOrders");
    expect(toolbarSource).toContain("orderActions.canBulkShipOrders");

    expect(columnsSource).toContain("opts.orderActions.canEditOrders");
    expect(columnsSource).toContain("opts.orderActions.canDeleteOrders");
    expect(columnsSource).toContain("opts.orderActions.canRestoreOrders");
    expect(columnsSource).toContain("opts.orderActions.canChangeOrderStatus");
    expect(columnsSource).toContain("opts.orderActions.canManageOrderShipments");
    expect(columnsSource).toContain("opts.orderActions.canSelectOrdersForBulkActions");
    expect(columnsSource).toContain("!order.fullEditReadiness.allowed");

    expect(mobileSource).toContain("orderActions.canSelectOrdersForBulkActions");
    expect(mobileSource).toContain("orderActions.canEditOrders");
    expect(mobileSource).toContain("orderActions.canDeleteOrders");
    expect(mobileSource).toContain("orderActions.canRestoreOrders");
    expect(mobileSource).toContain("orderActions.canChangeOrderStatus");
    expect(mobileSource).toContain("orderActions.canManageOrderShipments");
    expect(mobileSource).toContain("!order.fullEditReadiness.allowed");
  });

  it("archives by browser-loaded revision and exposes no permanent-delete action", () => {
    const routeSource = readFileSync(ORDERS_ROUTE_SOURCE, "utf8");
    const toolbarSource = readFileSync(ORDER_TOOLBAR_SOURCE, "utf8");
    const columnsSource = readFileSync(ORDER_COLUMNS_SOURCE, "utf8");
    const mobileSource = readFileSync(ORDER_MOBILE_CARD_SOURCE, "utf8");
    const serverFunctionsSource = readFileSync(ORDER_SERVER_FUNCTIONS_SOURCE, "utf8");

    expect(routeSource).toContain("expectedVersion: order.version");
    expect(routeSource).toContain("archiveMut.mutate");
    expect(routeSource).toContain("restoreMut.mutate({ id, expectedVersion })");
    expect(routeSource).toContain("archived: normalizeBooleanSearchParam(search.archived)");
    expect(routeSource).toContain("showArchived: deps.archived");
    expect(routeSource).not.toContain("search.trashed");
    expect(toolbarSource).toContain("search={showTrashed ? undefined : { archived: true }}");
    expect(columnsSource).toContain("onArchive(order.id, order.version)");
    expect(mobileSource).toContain("onArchive(order.id, order.version)");
    expect(columnsSource).toContain("aria-label={`Archive order ${order.id}`}");
    expect(columnsSource).toContain("aria-label={`Restore order ${order.id}`}");
    expect(mobileSource).toContain("aria-label={`Archive order ${order.id}`}");
    expect(mobileSource).toContain("aria-label={`Restore order ${order.id}`}");
    expect(columnsSource).not.toContain("onPermanentDelete");
    expect(mobileSource).not.toContain("onPermanentDelete");
    expect(serverFunctionsSource).toContain('apiPost<void>("/orders/archive", data)');
    expect(serverFunctionsSource).not.toContain("/orders/bulk-delete");
    expect(serverFunctionsSource).not.toContain("/permanent");
  });
});
