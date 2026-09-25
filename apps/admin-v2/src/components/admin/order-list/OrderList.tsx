import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Archive, CircleCheck, Download, MoreHorizontal, Printer, Send, ShoppingBag, Truck } from "lucide-react";
import { getApiV1AdminOrders } from "@scalius/api-client/sdk";
import type { OrderListItem } from "@scalius/core/modules/orders/browser";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { useServerTable } from "~/components/admin/data-table/useServerTable";
import type { Row } from "~/components/admin/data-table/table-config";
import { SelectionSheet } from "~/components/admin/shared/SelectionSheet";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { apiData } from "~/lib/api";
import { getServerFnError } from "~/lib/api-helpers";
import { ordersQueryOptions } from "~/lib/api-query-options/orders";
import { withDashboardBasePath } from "~/lib/dashboard-base-path";
import { createDataSelector, getCanonicalPageForPagination } from "~/lib/list-helpers";
import { useListSearch } from "~/lib/list-search";
import { translate, useLocale, useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { orderListMessages } from "~/i18n/order-list";
import { BulkOrdersDialog } from "./BulkOrdersDialog";
import { OrderRowCancelDialog } from "./CancelOrderDialog";
import { ExportOrdersDialog } from "./ExportOrdersDialog";
import { getOrderColumns } from "./order-columns";
import { getOrderRefreshPause, planOrderBulkAction, type OrderBulkAction } from "./order-bulk-actions";
import { useOrderExportDialog } from "./order-export";
import {
  CLEARED_ORDER_FILTERS,
  countOrderFilters,
  ORDER_SEARCH_LIST,
  orderFilterQuery,
  orderListQuery,
  orderSearchSortUpdates,
  type OrderListSearch,
} from "./order-list-search";
import { OrderListToolbar } from "./OrderListToolbar";
import { OrderMobileCard } from "./OrderMobileCard";
import { useOrderActions, type OrderSelection } from "./use-order-actions";
import { useOrderAutoRefresh } from "./use-order-auto-refresh";

const selectOrders = createDataSelector<OrderListItem>("orders");
/** "Archive all matching orders" loads at most this many orders to act on. */
const ALL_MATCHING_LIMIT = 1000;
/** The invoice print page takes at most 90 orders. */
const PRINT_LIMIT = 90;

async function loadAllMatchingOrders(filters: ReturnType<typeof orderFilterQuery>): Promise<OrderListItem[]> {
  const orders: OrderListItem[] = [];
  for (let page = 1; orders.length < ALL_MATCHING_LIMIT; page += 1) {
    const result = selectOrders(await apiData(getApiV1AdminOrders({ query: { ...filters, page, limit: 100 } })));
    orders.push(...result.data);
    if (result.data.length === 0 || page >= result.pagination.totalPages) break;
  }
  return orders.slice(0, ALL_MATCHING_LIMIT);
}

/** The order table inside the Orders card: toolbar, rows, bulk actions and their dialogs. */
export function OrderList({
  search,
  onChange,
}: {
  search: OrderListSearch;
  onChange: (updates: Partial<OrderListSearch>, options?: { replace?: boolean }) => void;
}) {
  const t = useMessages(orderListMessages);
  const locale = useLocale();
  const tr = useMessages(resourceMessages);
  const orderActions = useOrderActionPermissions();
  const [term, setTerm] = useListSearch(ORDER_SEARCH_LIST);
  const exportDialog = useOrderExportDialog();
  const showArchived = search.archived;
  const dateField = search.sort === "updatedAt" ? "updatedAt" : "createdAt";
  const filters = useMemo(() => orderFilterQuery(search, term), [search, term]);
  const filtersKey = JSON.stringify(filters);
  const [allMatchingKey, setAllMatchingKey] = useState<string | null>(null);
  const selection = useRef<OrderSelection>({ rows: [], clear: () => {}, deselect: () => {} });
  const refetchRef = useRef<() => Promise<unknown>>(async () => undefined);
  const actions = useOrderActions(orderActions, selection);
  const { archive, restore, changeStatus, updatingStatusIds } = actions;

  const columns = useMemo(
    () =>
      getOrderColumns({
        showArchived,
        dateField,
        selectable: true,
        orderActions,
        updatingStatusIds,
        onArchive: (order) => archive([order]),
        onRestore: restore,
        onStatusUpdate: changeStatus,
        onShipmentRefreshed: () => void refetchRef.current(),
        label: (key) => translate(orderListMessages, key),
      }),
    // The locale re-labels the columns for the column menu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showArchived, dateField, orderActions, updatingStatusIds, archive, restore, changeStatus, locale],
  );

  const {
    table, rawData, error, isError, isFetching, isLoading, refetch, pagination,
    selectedRows, selectedIds, clearSelection, deselectIds,
  } = useServerTable({
    columns,
    queryOptions: ordersQueryOptions(orderListQuery(search, term)),
    dataSelector: selectOrders,
    currentPage: search.page,
    currentLimit: search.limit,
    onPaginationChange: (page, limit) => onChange({ page, limit }),
    onSortingChange: () => undefined,
    enableSorting: false,
    defaultPageSize: 10,
  });

  const pageRows = table.getRowModel().rows;
  const pageFullySelected = pageRows.length > 0 && selectedRows.length === pageRows.length;
  const allSelected = pageFullySelected && allMatchingKey === filtersKey && pagination.total > pageRows.length;
  const selectedCount = allSelected ? pagination.total : selectedRows.length;
  const clearAll = useCallback(() => {
    setAllMatchingKey(null);
    clearSelection();
  }, [clearSelection]);

  useEffect(() => {
    selection.current = { rows: selectedRows, clear: clearAll, deselect: deselectIds };
    refetchRef.current = refetch;
  });

  useEffect(() => {
    if (!rawData) return;
    const canonicalPage = getCanonicalPageForPagination(search.page, pagination);
    if (canonicalPage !== search.page) onChange({ page: canonicalPage }, { replace: true });
  }, [onChange, pagination, rawData, search.page]);

  const refreshPause = getOrderRefreshPause({
    selectedCount: selectedRows.length,
    actionDialogOpen: actions.dialogOpen || exportDialog.open,
    mutationInFlight: actions.busy,
  });
  const autoRefresh = useOrderAutoRefresh({ refetch, isFetching, paused: refreshPause !== null });

  const mobileCardRenderer = useCallback(
    (row: Row<OrderListItem>) => (
      <OrderMobileCard
        order={row.original}
        dateField={dateField}
        selectable
        isSelected={row.getIsSelected()}
        onToggleSelection={() => row.toggleSelected()}
      />
    ),
    [dateField],
  );

  const openBulk = (action: OrderBulkAction) => {
    if (!allSelected) {
      actions.openBulk(action, selectedRows);
      return;
    }
    actions.openBulk(action, null);
    loadAllMatchingOrders(filters).then(actions.setDialogOrders, (loadError: unknown) => {
      actions.closeBulk();
      toast.error(getServerFnError(loadError, t("loadOrdersFailed")));
    });
  };

  const archiveSelection = () => {
    if (allSelected) openBulk("archive");
    else archive(selectedRows, clearAll);
  };

  const printInvoices = () => {
    const ids = selectedIds.slice(0, PRINT_LIMIT).join(",");
    window.open(withDashboardBasePath(`/invoices?ids=${ids}`), "_blank", "noopener");
  };

  const canArchiveSelection =
    orderActions.canBulkDeleteOrders
    && (allSelected || planOrderBulkAction(selectedRows, "archive").eligible.length > 0);
  const moreActions = [
    !allSelected && orderActions.canPrintInvoices
      ? { key: "print", icon: Printer, label: t("printInvoices"), disabled: selectedIds.length > PRINT_LIMIT, hint: undefined, onSelect: printInvoices }
      : null,
    { key: "export", icon: Download, label: t("export"), disabled: false, hint: undefined, onSelect: () => exportDialog.setOpen(true) },
    !showArchived && orderActions.canBulkDeleteOrders
      ? {
          key: "archive",
          icon: Archive,
          label: t("archive"),
          disabled: !canArchiveSelection || actions.busy,
          // A greyed-out Archive says why, as Shopify does.
          hint: canArchiveSelection ? undefined : t("archiveOnlyFinished"),
          onSelect: archiveSelection,
        }
      : null,
  ].filter((action) => action !== null);

  const bulkButtons = (
    <>
      {pageFullySelected && !allSelected && pagination.total > pageRows.length ? (
        <Button variant="link" onClick={() => setAllMatchingKey(filtersKey)}>
          {t("selectAllMatching", { count: pagination.total })}
        </Button>
      ) : null}
      {!showArchived && !allSelected && orderActions.canChangeOrderStatus ? (
        <Button variant="outline" onClick={() => openBulk("confirm")} disabled={actions.busy}>
          <CircleCheck className="h-4 w-4" />
          {t("confirm")}
        </Button>
      ) : null}
      {!showArchived && !allSelected && orderActions.canManageOrderShipments ? (
        <Button variant="outline" onClick={() => openBulk("send")} disabled={actions.busy}>
          <Send className="h-4 w-4" />
          {t("markAsSent")}
        </Button>
      ) : null}
      {!showArchived && !allSelected && orderActions.canBulkShipOrders ? (
        <Button variant="outline" onClick={() => openBulk("ship")} disabled={actions.busy}>
          <Truck className="h-4 w-4" />
          {t("bookCourier")}
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label={tr("moreActions")} title={tr("moreActions")}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {moreActions.map((action) => (
            <DropdownMenuItem key={action.key} disabled={action.disabled} onSelect={action.onSelect}>
              <span className="flex h-lh items-center"><action.icon className="h-4 w-4" /></span>
              {action.hint ? (
                <span className="flex max-w-64 flex-col">
                  <span>{action.label}</span>
                  <span className="text-muted-foreground">{action.hint}</span>
                </span>
              ) : action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  const filtered = Boolean(term.trim() || search.view) || countOrderFilters(search) > 0;
  const clearFilters = () => {
    setTerm("");
    onChange({ ...CLEARED_ORDER_FILTERS, ...orderSearchSortUpdates("", term, search.sort), view: undefined });
  };
  const cancelOrder = actions.cancelOrder;

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
        layoutKey="orders"
        toolbar={<div className="px-2 pt-2"><OrderListToolbar
            search={search}
            term={term}
            onSearch={(value) => {
              const sortUpdates = orderSearchSortUpdates(value, term, search.sort);
              setTerm(value);
              onChange(sortUpdates, { replace: true });
            }}
            onChange={onChange}
            selectedCount={selectedRows.length}
            autoRefresh={{ ...autoRefresh, pause: refreshPause }}
            bulkActions={
              <div className="hidden flex-wrap items-center gap-2 md:flex">
                <span className="text-body font-medium">
                  {allSelected ? t("allSelected", { count: selectedCount }) : tr("selected", { count: selectedCount })}
                </span>
                {bulkButtons}
              </div>
            }
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
            <Button variant="outline" onClick={clearFilters}>
              {t("clearFilters")}
            </Button>
          ) : orderActions.canCreateOrders ? (
            <Button asChild>
              <Link to="/admin/orders/new">{t("createOrder")}</Link>
            </Button>
          ) : undefined,
        }}
      />

      <SelectionSheet count={selectedCount} clearLabel={t("clearSelection")} onClear={clearAll}>
        {bulkButtons}
      </SelectionSheet>

      <OrderRowCancelDialog
        order={cancelOrder}
        pending={cancelOrder !== null && actions.updatingStatusIds.has(cancelOrder.id)}
        onOpenChange={(open) => {
          if (!open) actions.setCancelOrder(null);
        }}
        onConfirm={(order, reason) => actions.changeStatus(order, "cancelled", { confirmed: true, reason })}
      />

      <BulkOrdersDialog
        action={actions.dialog?.action ?? null}
        orders={actions.dialog?.orders ?? null}
        selectedCount={actions.dialog?.orders && !allSelected ? actions.dialog.orders.length : selectedCount}
        note={allSelected && pagination.total > ALL_MATCHING_LIMIT
          ? t("allMatchingCapped", { count: ALL_MATCHING_LIMIT })
          : undefined}
        running={actions.running}
        outcome={actions.outcome}
        onOpenChange={(open) => {
          if (!open) actions.closeBulk();
        }}
        onRun={actions.runBulk}
      />

      <ExportOrdersDialog
        open={exportDialog.open}
        onOpenChange={exportDialog.setOpen}
        filters={filters}
        pageIds={pageRows.map((row) => row.original.id)}
        selectedIds={selectedIds}
        allSelected={allSelected}
        total={pagination.total}
      />
    </>
  );
}

