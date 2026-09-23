import { useCallback, useEffect, useMemo, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { Archive, ShoppingBag, Truck } from "lucide-react";
import type { OrderListItem } from "@scalius/core/modules/orders/orders.types";
import { Button } from "~/components/ui/button";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { useServerTable } from "~/components/admin/data-table/useServerTable";
import type { Row } from "~/components/admin/data-table/table-config";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { ordersQueryOptions } from "~/lib/api-query-options/orders";
import { createDataSelector, getCanonicalPageForPagination } from "~/lib/list-helpers";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { orderListMessages } from "~/i18n/order-list";
import { BulkShipDialog } from "./BulkShipDialog";
import { getOrderColumns } from "./order-columns";
import { getOrderRefreshPause } from "./order-bulk-actions";
import {
  CLEARED_ORDER_FILTERS,
  countOrderFilters,
  orderListQuery,
  orderSearchUpdates,
  type OrderListSearch,
} from "./order-list-search";
import { SelectionSheet } from "~/components/admin/shared/SelectionSheet";
import { OrderListToolbar } from "./OrderListToolbar";
import { OrderMobileCard } from "./OrderMobileCard";
import { useOrderActions, type OrderSelection } from "./use-order-actions";
import { useOrderAutoRefresh } from "./use-order-auto-refresh";

const selectOrders = createDataSelector<OrderListItem>("orders");

/** The order table inside the Orders card: toolbar, rows, bulk archive/ship and their dialogs. */
export function OrderList({
  search,
  onChange,
}: {
  search: OrderListSearch;
  onChange: (updates: Partial<OrderListSearch>, options?: { replace?: boolean }) => void;
}) {
  const t = useMessages(orderListMessages);
  const tr = useMessages(resourceMessages);
  const orderActions = useOrderActionPermissions();
  const showArchived = search.archived;
  const selection = useRef<OrderSelection>({ rows: [], clear: () => {}, deselect: () => {} });
  const refetchRef = useRef<() => Promise<unknown>>(async () => undefined);
  const actions = useOrderActions(orderActions, selection);
  const { editOrder, requestArchive, restore, changeStatus, updatingStatusIds } = actions;

  const columns = useMemo(
    () =>
      getOrderColumns({
        showArchived,
        orderActions,
        updatingStatusIds,
        onEdit: editOrder,
        onArchive: requestArchive,
        onRestore: restore,
        onStatusUpdate: changeStatus,
        onShipmentRefreshed: () => void refetchRef.current(),
      }),
    [showArchived, orderActions, updatingStatusIds, editOrder, requestArchive, restore, changeStatus],
  );

  const {
    table, rawData, error, isError, isFetching, isLoading, refetch, pagination,
    selectedRows, clearSelection, deselectIds,
  } = useServerTable({
    columns,
    queryOptions: ordersQueryOptions(orderListQuery(search)),
    dataSelector: selectOrders,
    currentPage: search.page,
    currentLimit: search.limit,
    onPaginationChange: (page, limit) => onChange({ page, limit }),
    onSortingChange: () => undefined,
    enableSorting: false,
    defaultPageSize: 10,
  });

  useEffect(() => {
    selection.current = { rows: selectedRows, clear: clearSelection, deselect: deselectIds };
    refetchRef.current = refetch;
  });

  useEffect(() => {
    if (!rawData) return;
    const canonicalPage = getCanonicalPageForPagination(search.page, pagination);
    if (canonicalPage !== search.page) onChange({ page: canonicalPage }, { replace: true });
  }, [onChange, pagination, rawData, search.page]);

  const refreshPause = getOrderRefreshPause({
    selectedCount: selectedRows.length,
    actionDialogOpen: actions.dialogOpen,
    mutationInFlight: actions.busy,
  });
  const autoRefresh = useOrderAutoRefresh({ refetch, isFetching, paused: refreshPause !== null });

  const selectable = orderActions.canSelectOrdersForBulkActions && !showArchived;
  const mobileCardRenderer = useCallback(
    (row: Row<OrderListItem>) => (
      <OrderMobileCard
        order={row.original}
        selectable={selectable}
        isSelected={row.getIsSelected()}
        onToggleSelection={() => row.toggleSelected()}
      />
    ),
    [selectable],
  );

  const filtered = Boolean(search.search.trim() || search.view) || countOrderFilters(search) > 0;
  const bulkButtons = showArchived ? null : (
    <>
      {orderActions.canBulkShipOrders ? (
        <Button variant="outline" onClick={actions.openBulkShip} disabled={actions.busy}>
          <Truck className="h-4 w-4" />
          {t("ship")}
        </Button>
      ) : null}
      {orderActions.canBulkDeleteOrders ? (
        <Button variant="outline" onClick={actions.requestBulkArchive} disabled={actions.busy}>
          <Archive className="h-4 w-4" />
          {t("archive")}
        </Button>
      ) : null}
    </>
  );
  const archiveCount = actions.archiveRequest?.orders.length ?? 0;

  return (
    <>
      <DataTable
        variant="bare"
        getRowHref={(order) => `/admin/orders/${order.id}`}
        table={table}
        isFetching={isFetching}
        isLoading={isLoading}
        error={isError ? error : null}
        onRetry={() => void refetch()}
        itemLabel={t("itemLabel")}
        pageSizeOptions={[10, 20, 50, 100]}
        mobileCardRenderer={mobileCardRenderer}
        toolbar={<div className="px-2 pt-2"><OrderListToolbar
            search={search}
            onChange={onChange}
            selectedCount={selectedRows.length}
            autoRefresh={{ ...autoRefresh, pause: refreshPause }}
            bulkActions={<div className="hidden gap-2 md:flex">{bulkButtons}</div>}
          /></div>}
        emptyState={{
          icon: ShoppingBag,
          title: showArchived ? t("archivedEmptyTitle") : filtered ? t("noMatchTitle") : t("emptyTitle"),
          description: showArchived
            ? t("archivedEmptyBody")
            : filtered
              ? tr("noResultsHint")
              : t("emptyBody"),
          action: filtered || showArchived ? (
            <Button
              variant="outline"
              onClick={() => onChange({ ...CLEARED_ORDER_FILTERS, ...orderSearchUpdates("", search), view: undefined })}
            >
              {t("clearFilters")}
            </Button>
          ) : orderActions.canCreateOrders ? (
            <Button asChild>
              <Link to="/admin/orders/new">{t("createOrder")}</Link>
            </Button>
          ) : undefined,
        }}
      />

      <SelectionSheet count={selectedRows.length} clearLabel={t("clearSelection")} onClear={clearSelection}>
        {bulkButtons}
      </SelectionSheet>

      <ConfirmDialog
        open={actions.archiveRequest !== null}
        onOpenChange={(open) => {
          if (!open) actions.closeArchive();
        }}
        title={
          actions.archiveRequest?.bulk
            ? t("archiveTitleBulk", { count: archiveCount })
            : t("archiveTitle", { id: actions.archiveRequest?.orders[0]?.id ?? "" })
        }
        description={t("archiveBody")}
        confirmLabel={t("archive")}
        cancelLabel={tr("cancel")}
        variant="default"
        isLoading={actions.isArchiving}
        loadingLabel={tr("working")}
        onConfirm={actions.confirmArchive}
      />

      <ConfirmDialog
        open={actions.cancelOrderId !== null}
        onOpenChange={(open) => {
          if (!open) actions.setCancelOrderId(null);
        }}
        title={t("cancelTitle", { id: actions.cancelOrderId ?? "" })}
        description={t("cancelBody")}
        confirmLabel={t("cancelOrder")}
        cancelLabel={t("keepOrder")}
        onConfirm={() => {
          if (actions.cancelOrderId) actions.changeStatus(actions.cancelOrderId, "cancelled", true);
        }}
      />

      <BulkShipDialog
        isOpen={actions.shipOpen}
        onOpenChange={actions.setShipOpen}
        isShipping={actions.isShipping}
        onConfirm={(providerId) => void actions.submitBulkShip(providerId)}
        itemCount={selectedRows.length}
        resultSummary={actions.shipResult}
      />
    </>
  );
}
