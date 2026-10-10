import { lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "~/lib/toast";
import { Archive, Blocks, CircleCheck, Download, MoreHorizontal, Printer, Send, ShoppingBag, Truck } from "lucide-react";
import { postApiV1AdminOrdersArchive } from "@scalius/api-client/sdk";
import type { OrderListItem } from "@scalius/core/modules/orders/browser";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { IndexBulkBar } from "~/components/admin/data-table/DataTableToolbar";
import { EmptyState, FilteredEmptyState } from "~/components/admin/states";
import { useServerTable } from "~/components/admin/data-table/useServerTable";
import type { Row } from "~/components/admin/data-table/table-config";
import { APP_BULK_ACTION_MAX_IDS, appActionKey, useAppActionRunner } from "~/components/admin/apps/ui/AppActions";
import { appActionMessages } from "~/i18n/app-actions";
import { useOpenedOnce } from "~/hooks/use-opened-once";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useAppListColumns } from "~/components/admin/apps/ui/list-columns";
import { apiData } from "~/lib/api";
import { getServerFnError } from "~/lib/api-helpers";
import { ordersQueryOptions } from "~/lib/api-query-options/orders";
import { withDashboardBasePath } from "~/lib/dashboard-base-path";
import { NO_CURSOR, createDataSelector, getCanonicalPageForPagination, isPagingRefusal } from "~/lib/list-helpers";
import { runMatching } from "~/lib/bulk-selection";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useListSearch } from "~/lib/list-search";
import { translate, useLocale, useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { orderListMessages } from "~/i18n/order-list";
import { getOrderColumns } from "./order-columns";
import { getOrderRefreshPause, planOrderBulkAction, type OrderBulkAction } from "./order-bulk-actions";
import { OrdersFirstRunContext, useOrderExportDialog } from "./order-export";
import {
  CLEARED_ORDER_FILTERS,
  countOrderFilters,
  ORDER_SEARCH_LIST,
  orderFilterQuery,
  orderListQuery,
  orderSearchSortUpdates,
  type OrderListSearch,
} from "./order-list-search";
import { OrderListToolbar, OrderSortMenu } from "./OrderListToolbar";
import { OrderMobileCard } from "./OrderMobileCard";
import { useOrderActions, type OrderSelection } from "./use-order-actions";
import { useLiveOrderList } from "./use-live-order-list";

// The dialogs load the first time they open: the cancel confirmation (the
// order page's restock and reason copy) when Cancelled is chosen from a row's
// status menu, the bulk preview from the bulk bar, export from its button.
const OrderRowCancelDialog = lazy(() => import("./CancelOrderDialog").then((module) => ({ default: module.OrderRowCancelDialog })));
const BulkOrdersDialog = lazy(() => import("./BulkOrdersDialog").then((module) => ({ default: module.BulkOrdersDialog })));
const ExportOrdersDialog = lazy(() => import("./ExportOrdersDialog").then((module) => ({ default: module.ExportOrdersDialog })));

const selectOrders = createDataSelector<OrderListItem>("orders");
/** The invoice print page takes at most 90 orders. */
const PRINT_LIMIT = 90;

/** The list's filter as "archive all matching" sends it: the API reads the orders itself, slice by slice. */
function orderMatchingFilter(filters: ReturnType<typeof orderFilterQuery> & { appFilter?: string }) {
  const { sort: _sort, order: _order, archived: _archived, openRequest, ...rest } = filters;
  const defined = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined && value !== ""));
  return { ...defined, ...(openRequest === "true" ? { openRequest: true } : {}) } as Record<string, unknown>;
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
  // Apps' columns and filter: asked for only when an active app has them.
  const appList = useAppListColumns<OrderListItem>("order", search.appFilter);
  const { columnsParam: appColumns, filterParam: appFilter, extra: appExtra } = appList;
  const filters = useMemo(() => ({ ...orderFilterQuery(search, term), appFilter }), [search, term, appFilter]);
  const filtersKey = JSON.stringify(filters);
  const [allMatchingKey, setAllMatchingKey] = useState<string | null>(null);
  const selection = useRef<OrderSelection>({ rows: [], clear: () => {}, deselect: () => {} });
  const refetchRef = useRef<() => Promise<unknown>>(async () => undefined);
  const actions = useOrderActions(orderActions, selection);
  const { archive, restore, changeStatus, updatingStatusIds } = actions;
  const appActions = useAppActionRunner("order", true);
  const appCopy = useMessages(appActionMessages);

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
      }, appExtra),
    // The locale re-labels the columns for the column menu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showArchived, dateField, orderActions, updatingStatusIds, archive, restore, changeStatus, locale, appExtra],
  );

  const cursored = Boolean(search.after || search.before);
  const {
    table, rawData, error, isError, isFetching, isLoading, refetch, pagination, pageInfo,
    selectedRows, selectedIds, clearSelection, deselectIds,
  } = useServerTable({
    columns,
    queryOptions: ordersQueryOptions({ ...orderListQuery(search, term), appFilter, appColumns }),
    dataSelector: selectOrders,
    currentPage: cursored ? 1 : search.page,
    currentLimit: search.limit,
    onPaginationChange: (_page, limit) => onChange({ page: 1, limit }),
    onSortingChange: () => undefined,
    enableSorting: false,
  });

  const pageRows = table.getRowModel().rows;
  const pageFullySelected = pageRows.length > 0 && selectedRows.length === pageRows.length;
  const allSelected = pageFullySelected && allMatchingKey === filtersKey && pagination.total > pageRows.length;
  // Past the API's count cap the label reads "1,000+": the server still walks every match.
  const totalIsCapped = pagination.totalIsCapped === true;
  const selectedCount = allSelected ? pagination.total : selectedRows.length;
  // "Archive all matching": its progress in the bulk bar, and the confirmation before it.
  const [matchingDone, setMatchingDone] = useState<number | null>(null);
  const stopMatching = useRef(false);
  const [confirmArchiveAll, setConfirmArchiveAll] = useState(false);
  const archiveAllMatching = async () => {
    setConfirmArchiveAll(false);
    stopMatching.current = false;
    setMatchingDone(0);
    try {
      const totals = await runMatching(
        async (cursor) => {
          const result = await apiData(postApiV1AdminOrdersArchive({ body: { matching: { filter: orderMatchingFilter(filters) as never, ...(cursor ? { cursor } : {}) } } }));
          return result.matching ?? { processed: 0, skipped: 0, next: null };
        },
        (progress) => setMatchingDone(progress.processed + progress.skipped),
        () => stopMatching.current,
      );
      toast.success(t("ordersArchived"), {
        description: [
          totals.skipped > 0 ? t("archiveSkipped", { count: totals.skipped }) : null,
          totals.stopped ? tr("bulkStopped", { count: totals.processed }) : null,
        ].filter(Boolean).join(" ") || undefined,
      });
      clearAll();
    } catch (archiveError) {
      toast.error(getServerFnError(archiveError, t("loadOrdersFailed")));
    } finally {
      setMatchingDone(null);
      void refetch();
    }
  };
  const clearAll = useCallback(() => {
    setAllMatchingKey(null);
    clearSelection();
  }, [clearSelection]);

  useEffect(() => {
    selection.current = { rows: selectedRows, clear: clearAll, deselect: deselectIds };
    refetchRef.current = refetch;
  });

  useEffect(() => {
    // A cursor page has no page number to correct.
    if (!rawData || cursored) return;
    const canonicalPage = getCanonicalPageForPagination(search.page, pagination);
    if (canonicalPage !== search.page) onChange({ page: canonicalPage }, { replace: true });
  }, [cursored, onChange, pagination, rawData, search.page]);

  // A cursor or page the API refuses (an old bookmark, a changed sort) starts the list again.
  const refused = isPagingRefusal(error);
  useEffect(() => {
    if (refused) onChange({ page: 1, ...NO_CURSOR }, { replace: true });
  }, [onChange, refused]);

  const refreshPause = getOrderRefreshPause({
    selectedCount: selectedRows.length,
    actionDialogOpen: actions.dialogOpen || exportDialog.open,
    mutationInFlight: actions.busy,
  });
  const live = useLiveOrderList({
    refetch,
    paused: refreshPause !== null,
    visibleIds: pageRows.map((row) => row.original.id),
    onShowLatest: cursored || search.page > 1 ? () => onChange({ page: 1, ...NO_CURSOR }) : undefined,
  });

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

  const openBulk = (action: OrderBulkAction) => actions.openBulk(action, selectedRows);

  const archiveSelection = () => {
    if (allSelected) setConfirmArchiveAll(true);
    else archive(selectedRows, clearAll);
  };

  const printInvoices = () => {
    const ids = selectedIds.slice(0, PRINT_LIMIT).join(",");
    window.open(withDashboardBasePath(`/invoices?ids=${ids}`), "_blank", "noopener");
  };

  const canArchiveSelection =
    orderActions.canBulkDeleteOrders
    && (allSelected || planOrderBulkAction(selectedRows, "archive").eligible.length > 0);
  // Apps' bulk actions run on the selected rows of this page (at most 250), never "all matching".
  const tooManyForApps = selectedIds.length > APP_BULK_ACTION_MAX_IDS;
  const appMoreActions = allSelected ? [] : appActions.entries.map((entry) => ({
    key: `app:${appActionKey(entry)}`,
    icon: Blocks,
    label: entry.action.label,
    disabled: tooManyForApps || appActions.pending !== null,
    hint: tooManyForApps ? appCopy("tooManySelected", { max: APP_BULK_ACTION_MAX_IDS }) : undefined,
    onSelect: () => appActions.start(entry, selectedIds, clearAll),
  }));
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
    ...appMoreActions,
  ].filter((action) => action !== null);

  const selectionStatus = (
    <>
      {matchingDone !== null ? (
        <span className="flex items-center gap-2" role="status" aria-live="polite">
          {tr("bulkProgress", { label: t("archiving"), count: matchingDone })}
          <Button variant="link" onClick={() => { stopMatching.current = true; }}>{tr("stop")}</Button>
        </span>
      ) : (
        <span>
          {allSelected
            ? tr(totalIsCapped ? "allMatchingSelectedCapped" : "allMatchingSelected", { count: selectedCount })
            : tr("selected", { count: selectedCount })}
        </span>
      )}
      {matchingDone === null && pageFullySelected && !allSelected && pagination.total > pageRows.length ? (
        <Button variant="link" onClick={() => setAllMatchingKey(filtersKey)}>
          {tr(totalIsCapped ? "selectAllMatchingCapped" : "selectAllMatching", { count: pagination.total })}
        </Button>
      ) : null}
    </>
  );
  const bulkButtons = (
    <>
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
          <Button variant="outline" size="icon" className="shrink-0" aria-label={tr("moreActions")} title={tr("moreActions")}>
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
  // No order has ever been placed: an empty state, not a table of nothing.
  const nothingYet = !isLoading && !isError && !filtered && !showArchived && pagination.total === 0 && pageRows.length === 0;
  const reportFirstRun = useContext(OrdersFirstRunContext);
  useEffect(() => {
    reportFirstRun(nothingYet);
    return () => reportFirstRun(false);
  }, [nothingYet, reportFirstRun]);
  const cancelOrder = actions.cancelOrder;
  const cancelLoaded = useOpenedOnce(cancelOrder !== null);
  const bulkLoaded = useOpenedOnce(actions.dialog !== null);
  const exportLoaded = useOpenedOnce(exportDialog.open);

  return (
    <>
      {nothingYet ? (
        <EmptyState
          card={false}
          icon={ShoppingBag}
          title={t("emptyTitle")}
          description={t("emptyBody")}
          action={orderActions.canCreateOrders ? (
            <Button asChild>
              <Link to="/admin/orders/new">{t("createOrder")}</Link>
            </Button>
          ) : undefined}
        />
      ) : (
      <DataTable
        variant="bare"
        getRowHref={(order) => `/admin/orders/${order.id}`}
        table={table}
        isFetching={isFetching}
        isLoading={isLoading}
        error={isError ? error : null}
        onRetry={() => void refetch()}
        what={t("itemLabel")}
        itemLabel={t("itemLabel")}
        mobileCardRenderer={mobileCardRenderer}
        sortMenu={<OrderSortMenu search={search} term={term} onChange={onChange} />}
        cursorPaging={{
          total: pagination.total,
          totalIsCapped,
          offset: pagination.offset,
          pageInfo,
          onNext: (endCursor) => onChange({ after: endCursor, before: undefined, page: 1 }),
          onPrevious: (startCursor) => onChange({ before: startCursor, after: undefined, page: 1 }),
        }}
        layoutKey="orders"
        toolbar={<OrderListToolbar
            search={search}
            term={term}
            onSearch={(value) => {
              const sortUpdates = orderSearchSortUpdates(value, term, search.sort);
              setTerm(value);
              onChange(sortUpdates, { replace: true });
            }}
            onChange={onChange}
            appFilterable={appList.filterable.length > 0}
            live={live}
            bulkBar={selectedRows.length > 0 || matchingDone !== null ? (
              <IndexBulkBar
                status={selectionStatus}
                actions={matchingDone === null ? bulkButtons : null}
                onClear={() => { stopMatching.current = true; clearAll(); }}
              />
            ) : undefined}
          />}
        emptyState={(
          <FilteredEmptyState
            title={showArchived ? t("archivedEmptyTitle") : filtered ? t("noMatchTitle") : t("emptyTitle")}
            description={showArchived ? t("archivedEmptyBody") : filtered ? undefined : t("emptyBody")}
            onClearFilters={filtered || showArchived ? clearFilters : undefined}
          />
        )}
      />
      )}

      {appActions.dialogs}

      <ConfirmDialog
        open={confirmArchiveAll}
        onOpenChange={setConfirmArchiveAll}
        title={t(totalIsCapped ? "archiveAllCappedTitle" : "archiveAllTitle", { count: pagination.total })}
        description={t("archiveAllBody")}
        confirmLabel={t("archive")}
        cancelLabel={tr("cancel")}
        onConfirm={() => void archiveAllMatching()}
      />

      {cancelLoaded ? (
        <Suspense fallback={null}>
          <OrderRowCancelDialog
            order={cancelOrder}
            pending={cancelOrder !== null && actions.updatingStatusIds.has(cancelOrder.id)}
            onOpenChange={(open) => {
              if (!open) actions.setCancelOrder(null);
            }}
            onConfirm={(order, reason) => actions.changeStatus(order, "cancelled", { confirmed: true, reason })}
          />
        </Suspense>
      ) : null}

      {bulkLoaded ? (
        <Suspense fallback={null}>
          <BulkOrdersDialog
            action={actions.dialog?.action ?? null}
            orders={actions.dialog?.orders ?? null}
            selectedCount={actions.dialog?.orders ? actions.dialog.orders.length : selectedCount}
            running={actions.running}
            outcome={actions.outcome}
            onOpenChange={(open) => {
              if (!open) actions.closeBulk();
            }}
            onRun={actions.runBulk}
          />
        </Suspense>
      ) : null}

      {exportLoaded ? (
        <Suspense fallback={null}>
          <ExportOrdersDialog
            open={exportDialog.open}
            onOpenChange={exportDialog.setOpen}
            filters={filters}
            appFilterActive={appFilter !== undefined}
            pageIds={pageRows.map((row) => row.original.id)}
            selectedIds={selectedIds}
            allSelected={allSelected}
            total={pagination.total}
            totalIsCapped={totalIsCapped}
          />
        </Suspense>
      ) : null}
    </>
  );
}

