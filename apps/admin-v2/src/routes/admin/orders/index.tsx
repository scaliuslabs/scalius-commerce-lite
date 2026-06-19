import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  createDataSelector,
  createListSearchValidator,
  getCanonicalPageForPagination,
  normalizeDateSearchParam,
  normalizeOptionalSearchString,
  type ListSearchParams,
  type SearchValidatorInput,
} from "~/lib/list-helpers";
import { RouteErrorComponent } from "~/lib/route-error";
import type { Row } from "@tanstack/react-table";
import type { OrderListItem } from "@scalius/core/modules/orders";
import type { DateRange } from "react-day-picker";
import { formatDateShort } from "@scalius/shared/timestamps";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import { useQueryClient } from "@tanstack/react-query";
import { ordersQueryOptions } from "~/lib/api-query-options/orders";
import { queryKeys } from "~/lib/query-keys";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { formatDateOnly, parseDateOnly } from "~/lib/date-only";
import {
  useUpdateOrderStatus,
  useBulkDeleteOrders,
  useRestoreOrder,
} from "~/lib/api-mutations/orders";
import { createOrderShipment } from "~/lib/api-functions/orders";
import { useCurrency } from "~/hooks/use-currency";
import { useServerTable, DataTable } from "~/components/admin/data-table";
import { getOrderColumns } from "~/components/admin/data-table/columns/order-columns";
import { OrderToolbar } from "~/components/admin/data-table/toolbars/OrderToolbar";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { ShoppingBag } from "lucide-react";
import { OrderMobileCard } from "~/components/admin/order-list/OrderMobileCard";

const DeleteOrderDialog = lazy(() =>
  import("~/components/admin/order-list/DeleteOrderDialog").then((module) => ({
    default: module.DeleteOrderDialog,
  })),
);

const BulkShipDialog = lazy(() =>
  import("~/components/admin/order-list/BulkShipDialog").then((module) => ({
    default: module.BulkShipDialog,
  })),
);

// ── Search schema ─────────────────────────────────────────────────

const baseSearchValidator = createListSearchValidator(
  [
    "relevance",
    "customerName",
    "totalAmount",
    "status",
    "createdAt",
    "updatedAt",
  ] as const,
  { limit: 10, sort: "updatedAt" },
);

type OrderSort =
  | "relevance"
  | "customerName"
  | "totalAmount"
  | "status"
  | "createdAt"
  | "updatedAt";

type SearchParams = ListSearchParams<OrderSort> & {
  status?: string;
  startDate?: string;
  endDate?: string;
};

function validateOrderSearch(search: SearchValidatorInput<SearchParams>): SearchParams {
  return {
    ...baseSearchValidator(search),
    status: normalizeOptionalSearchString(search.status),
    startDate: normalizeDateSearchParam(search.startDate),
    endDate: normalizeDateSearchParam(search.endDate),
  };
}

// ── Map search params to API params ───────────────────────────────

function mapParams(deps: SearchParams) {
  return {
    page: deps.page,
    limit: deps.limit,
    search: deps.search || undefined,
    status: deps.status,
    sort: deps.sort,
    order: deps.order,
    showTrashed: deps.trashed,
    startDate: deps.startDate,
    endDate: deps.endDate,
  };
}

// ── Shipment types ────────────────────────────────────────────────

interface ShipmentStatus {
  id: string;
  orderId: string;
  [key: string]: unknown;
}

const ORDER_AUTO_REFRESH_SECONDS = 60;
const ORDER_AUTO_REFRESH_DEBOUNCE_MS = 5_000;

function isDocumentHidden() {
  return typeof document !== "undefined" && document.hidden;
}

// ── Route definition ──────────────────────────────────────────────

export const Route = createFileRoute("/admin/orders/")({
  validateSearch: validateOrderSearch,
  loaderDeps: ({ search }) => search,
  staleTime: 1000 * 30,
  loader: async ({ context: { queryClient }, deps }) => {
    await warmRouteQuery(queryClient, ordersQueryOptions(mapParams(deps)));
  },
  head: ({ match }) => ({
    meta: [
      {
        title: `${match.search.trashed ? "Trash" : "Orders"} | Scalius Admin`,
      },
    ],
  }),
  component: OrdersPage,
  errorComponent: RouteErrorComponent,
});

// ── Page component ────────────────────────────────────────────────

function OrdersPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { symbol } = useCurrency();
  const showTrashed = search.trashed;

  // ── Local state ───────────────────────────────────────────────
  const [shipmentStatuses, setShipmentStatuses] = useState<
    Record<string, ShipmentStatus>
  >({});
  const [updatingStatusIds, setUpdatingStatusIds] = useState<Set<string>>(
    new Set(),
  );
  const [orderToDelete, setOrderToDelete] = useState<string | null>(null);
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false);
  const [isShippingDialogOpen, setIsShippingDialogOpen] = useState(false);
  const [isShipping, setIsShipping] = useState(false);
  // Derive filter values directly from URL search params (reactive to back/forward)
  const activeStatus = search.status ?? null;
  const isDeleteDialogOpen = !!orderToDelete || isBulkDeleteOpen;

  // Date range — derive from URL params
  const dateRange: DateRange | undefined =
    search.startDate || search.endDate
      ? {
          from: parseDateOnly(search.startDate),
          to: parseDateOnly(search.endDate),
        }
      : undefined;

  // Auto-refresh state
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("orderlist-auto-refresh") === "true";
    }
    return false;
  });
  const [countdown, setCountdown] = useState(ORDER_AUTO_REFRESH_SECONDS);
  const countdownIntervalRef = useRef<number | undefined>(undefined);
  const activeOrderListRefreshRef = useRef<(() => Promise<unknown>) | null>(
    null,
  );
  const orderListFetchingRef = useRef(false);
  const orderListRefreshInFlightRef = useRef(false);
  const lastOrderListRefreshAtRef = useRef(0);

  // ── Mutations ─────────────────────────────────────────────────
  const statusMutation = useUpdateOrderStatus();
  const bulkDeleteMut = useBulkDeleteOrders();
  const restoreMut = useRestoreOrder();

  // ── Navigation helpers ────────────────────────────────────────

  const handleNavigate = useCallback(
    (updates: Partial<SearchParams>) => {
      void navigate({
        to: "/admin/orders",
        search: ((prev: Record<string, unknown>) => ({ ...prev, ...updates })) as never,
      });
    },
    [navigate],
  );

  const onSearchChange = useCallback(
    (value: string) => {
      const hasNextSearch = value.trim().length > 0;
      const hasCurrentSearch = search.search.trim().length > 0;

      if (hasNextSearch && !hasCurrentSearch) {
        handleNavigate({
          search: value,
          page: 1,
          sort: "relevance",
          order: "desc",
        });
        return;
      }

      if (!hasNextSearch && search.sort === "relevance") {
        handleNavigate({
          search: value,
          page: 1,
          sort: "updatedAt",
          order: "desc",
        });
        return;
      }

      handleNavigate({ search: value, page: 1 });
    },
    [handleNavigate, search.search, search.sort],
  );

  const onPaginationChange = useCallback(
    (page: number, limit: number) => handleNavigate({ page, limit }),
    [handleNavigate],
  );

  const onSortingChange = useCallback(
    (sort: string, order: "asc" | "desc") =>
      handleNavigate({ sort: sort as SearchParams["sort"], order }),
    [handleNavigate],
  );

  // ── Filter handlers ───────────────────────────────────────────

  const onStatusFilterChange = useCallback(
    (status: string | null) => {
      handleNavigate({ status: status ?? undefined, page: 1 });
    },
    [handleNavigate],
  );

  const onDateRangeChange = useCallback(
    (range: DateRange | undefined) => {
      handleNavigate({
        startDate: formatDateOnly(range?.from),
        endDate: formatDateOnly(range?.to),
        page: 1,
      });
    },
    [handleNavigate],
  );

  // ── Action handlers ───────────────────────────────────────────

  const handleEdit = useCallback(
    (id: string) => {
      void navigate({ to: `/admin/orders/${id}/edit` as string });
    },
    [navigate],
  );

  const handleDelete = useCallback(
    (id: string) => setOrderToDelete(id),
    [],
  );

  const handlePermanentDelete = useCallback(
    (id: string) => setOrderToDelete(id),
    [],
  );

  const handleRestore = useCallback(
    (id: string) => restoreMut.mutate(id),
    [restoreMut],
  );

  const handleStatusUpdate = useCallback(
    (orderId: string, newStatus: string) => {
      setUpdatingStatusIds((prev) => new Set(prev).add(orderId));
      statusMutation.mutate(
        { orderId, status: newStatus.toLowerCase() },
        {
          onSettled: () => {
            setUpdatingStatusIds((prev) => {
              const newSet = new Set(prev);
              newSet.delete(orderId);
              return newSet;
            });
          },
        },
      );
    },
    [statusMutation],
  );

  const handleShipmentStatusUpdated = useCallback(
    (updatedShipment: { id: string; orderId: string; [key: string]: unknown }) => {
      setShipmentStatuses((prev) => ({
        ...prev,
        [updatedShipment.orderId]: updatedShipment as ShipmentStatus,
      }));
    },
    [],
  );

  // ── Delete handlers ───────────────────────────────────────────

  const handleSingleDelete = useCallback(() => {
    if (!orderToDelete) return;
    bulkDeleteMut.mutate(
      { orderIds: [orderToDelete], permanent: showTrashed },
      {
        onSettled: () => {
          setOrderToDelete(null);
        },
      },
    );
  }, [orderToDelete, showTrashed, bulkDeleteMut]);

  const handleBulkDeleteClick = useCallback(() => {
    setIsBulkDeleteOpen(true);
  }, []);

  // NOTE: handleBulkDeleteConfirm and handleBulkShipmentSubmit are defined
  // after useServerTable to avoid using selectedIds/clearSelection before declaration.

  // ── Initialize shipment statuses from query data ──────────────

  const dataSelector = useMemo(() => createDataSelector<OrderListItem>("orders"), []);

  // ── Columns ───────────────────────────────────────────────────

  const columns = useMemo(
    () =>
      getOrderColumns({
        showTrashed,
        symbol,
        shipmentStatuses,
        updatingStatusIds,
        onEdit: handleEdit,
        onDelete: handleDelete,
        onRestore: handleRestore,
        onPermanentDelete: handlePermanentDelete,
        onStatusUpdate: handleStatusUpdate,
        onShipmentStatusUpdated: handleShipmentStatusUpdated,
      }),
    [
      showTrashed,
      symbol,
      shipmentStatuses,
      updatingStatusIds,
      handleEdit,
      handleDelete,
      handleRestore,
      handlePermanentDelete,
      handleStatusUpdate,
      handleShipmentStatusUpdated,
    ],
  );

  // ── Server table ──────────────────────────────────────────────

  const {
    table,
    rawData: ordersRawData,
    error: rawOrdersError,
    isError: isOrdersError,
    isFetching,
    isLoading,
    refetch: refetchOrders,
    pagination,
    selectedIds,
    clearSelection,
    deselectIds,
  } = useServerTable({
    columns,
    queryOptions: ordersQueryOptions(mapParams(search)),
    dataSelector,
    currentPage: search.page,
    currentLimit: search.limit,
    currentSort: search.sort === "relevance" ? undefined : search.sort,
    currentOrder: search.order,
    onPaginationChange,
    onSortingChange,
    defaultPageSize: 10,
  });
  const ordersError = isOrdersError ? rawOrdersError : null;

  // ── Active-query refresh ──────────────────────────────────────

  useEffect(() => {
    activeOrderListRefreshRef.current = refetchOrders;
  }, [refetchOrders]);

  useEffect(() => {
    orderListFetchingRef.current = isFetching;
  }, [isFetching]);

  const refreshActiveOrderList = useCallback(() => {
    const refetchActiveOrders = activeOrderListRefreshRef.current;
    if (!refetchActiveOrders || isDocumentHidden()) return false;
    if (orderListFetchingRef.current || orderListRefreshInFlightRef.current) {
      return false;
    }

    const now = Date.now();
    if (now - lastOrderListRefreshAtRef.current < ORDER_AUTO_REFRESH_DEBOUNCE_MS) {
      return false;
    }

    lastOrderListRefreshAtRef.current = now;
    orderListRefreshInFlightRef.current = true;
    try {
      void Promise.resolve(refetchActiveOrders()).finally(() => {
        orderListRefreshInFlightRef.current = false;
      });
    } catch (error) {
      orderListRefreshInFlightRef.current = false;
      console.warn("Failed to start active order list refresh", error);
      return false;
    }
    return true;
  }, []);

  // ── Auto-refresh ──────────────────────────────────────────────

  const toggleAutoRefresh = useCallback(() => {
    const newValue = !autoRefreshEnabled;
    setAutoRefreshEnabled(newValue);
    if (typeof window !== "undefined") {
      localStorage.setItem("orderlist-auto-refresh", String(newValue));
    }
    if (newValue) {
      refreshActiveOrderList();
      setCountdown(ORDER_AUTO_REFRESH_SECONDS);
    }
  }, [autoRefreshEnabled, refreshActiveOrderList]);

  useEffect(() => {
    if (autoRefreshEnabled) {
      setCountdown(ORDER_AUTO_REFRESH_SECONDS);
      countdownIntervalRef.current = window.setInterval(() => {
        if (isDocumentHidden()) return;
        setCountdown((prev) => {
          if (prev <= 1) {
            refreshActiveOrderList();
            return ORDER_AUTO_REFRESH_SECONDS;
          }
          return prev - 1;
        });
      }, 1000);

      const handleVisibilityChange = () => {
        if (isDocumentHidden()) return;
        refreshActiveOrderList();
        setCountdown(ORDER_AUTO_REFRESH_SECONDS);
      };
      document.addEventListener("visibilitychange", handleVisibilityChange);

      return () => {
        if (countdownIntervalRef.current)
          window.clearInterval(countdownIntervalRef.current);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      };
    } else {
      if (countdownIntervalRef.current)
        window.clearInterval(countdownIntervalRef.current);
    }
  }, [autoRefreshEnabled, refreshActiveOrderList]);

  useEffect(() => {
    if (!ordersRawData) return;
    const canonicalPage = getCanonicalPageForPagination(search.page, pagination);
    if (canonicalPage === search.page) return;
    handleNavigate({ page: canonicalPage });
  }, [handleNavigate, ordersRawData, pagination, search.page]);

  // ── Export CSV ─────────────────────────────────────────────────

  const handleExportCSV = useCallback(() => {
    const rows = table.getRowModel().rows.map((r) => r.original);
    const csvHeaders = [
      "Order ID",
      "Customer Name",
      "Phone",
      "Email",
      "City",
      "Zone",
      "Area",
      "Status",
      "Total Amount",
      "Discount",
      "Items",
      "Created At",
    ];
    const csvRows = rows.map((order) => [
      order.id,
      order.customerName,
      formatPhoneForDisplay(order.customerPhone),
      order.customerEmail || "",
      order.cityName || order.city,
      order.zoneName || order.zone,
      order.areaName || order.area || "",
      order.status,
      order.totalAmount,
      order.discountAmount || 0,
      order.itemCount,
      formatDateShort(order.createdAt),
    ]);
    const csvContent = [
      csvHeaders.join(","),
      ...csvRows.map((row) => row.map((cell) => `"${cell}"`).join(",")),
    ].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute(
      "download",
      `orders-${new Date().toISOString().split("T")[0]}.csv`,
    );
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success(`${rows.length} orders exported successfully.`);
  }, [table]);

  // ── Bulk delete handler (after useServerTable for selectedIds/clearSelection) ──
  const handleBulkDeleteConfirm = useCallback(() => {
    bulkDeleteMut.mutate(
      { orderIds: selectedIds, permanent: showTrashed },
      {
        onSuccess: () => {
          clearSelection();
          setIsBulkDeleteOpen(false);
        },
        onSettled: () => {
          setIsBulkDeleteOpen(false);
        },
      },
    );
  }, [showTrashed, bulkDeleteMut, selectedIds, clearSelection]);

  // ── Bulk shipment handler (after useServerTable for selectedIds/clearSelection) ──
  const handleBulkShipmentSubmit = useCallback(
    async (providerId: string) => {
      if (isShipping || selectedIds.length === 0) return;
      setIsShipping(true);
      let successCount = 0;
      const shippedOrderIds: string[] = [];
      const failedOrderIds: string[] = [];
      for (const orderId of selectedIds) {
        try {
          const result = await createOrderShipment({
            data: { orderId, shipment: { providerId, options: {} } },
          });
          successCount++;
          shippedOrderIds.push(orderId);
          setShipmentStatuses((prev) => ({
            ...prev,
            [orderId]: result,
          }));
        } catch (error) {
          failedOrderIds.push(orderId);
          console.error(`Error for order ${orderId}:`, error);
        }
      }
      if (successCount > 0) {
        toast.success(
          `${successCount} of ${selectedIds.length} shipments created successfully.`,
        );
      } else {
        toast.error("Shipment failed");
      }
      if (shippedOrderIds.length > 0) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
        void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
        for (const orderId of shippedOrderIds) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.orders.detail(orderId),
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.orders.shipments(orderId),
          });
        }
      }
      setIsShipping(false);
      setIsShippingDialogOpen(false);
      if (successCount === selectedIds.length) {
        clearSelection();
      } else if (successCount > 0) {
        deselectIds(shippedOrderIds);
        toast.warning(`${failedOrderIds.length} selected order(s) still need shipment.`);
      }
    },
    [queryClient, selectedIds, clearSelection, deselectIds, isShipping],
  );

  // ── Sync shipment statuses when data changes ──────────────────
  useEffect(() => {
    if (!ordersRawData) return;
    const r = ordersRawData as Record<string, unknown>;
    const orders = (r.orders ?? []) as OrderListItem[];
    const newStatuses: Record<string, ShipmentStatus> = {};
    orders.forEach((order) => {
      if (order.latestShipment) {
        newStatuses[order.id] =
          order.latestShipment as unknown as ShipmentStatus;
      }
    });
    setShipmentStatuses(newStatuses);
  }, [ordersRawData]);

  // ── Mobile card renderer ──────────────────────────────────────

  const mobileCardRenderer = useCallback(
    (row: Row<OrderListItem>) => {
      const order = row.original;
      const shipment = shipmentStatuses[order.id];
      return (
        <OrderMobileCard
          order={order}
          shipment={shipment}
          isSelected={row.getIsSelected()}
          isUpdatingStatus={updatingStatusIds.has(order.id)}
          showTrashed={showTrashed}
          onToggleSelection={(id) => {
            const r = table.getRowModel().rows.find((r) => r.original.id === id);
            if (r) r.toggleSelected(!r.getIsSelected());
          }}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onPermanentDelete={handlePermanentDelete}
          onRestore={handleRestore}
          onStatusUpdate={handleStatusUpdate}
          onShipmentStatusUpdated={handleShipmentStatusUpdated}
        />
      );
    },
    [
      shipmentStatuses,
      updatingStatusIds,
      showTrashed,
      table,
      handleEdit,
      handleDelete,
      handlePermanentDelete,
      handleRestore,
      handleStatusUpdate,
      handleShipmentStatusUpdated,
    ],
  );

  // ── Toolbar ───────────────────────────────────────────────────

  const toolbar = (
    <OrderToolbar
      searchValue={search.search}
      onSearchChange={onSearchChange}
      selectedCount={selectedIds.length}
      showTrashed={showTrashed}
      activeStatus={activeStatus}
      onStatusFilterChange={onStatusFilterChange}
      dateRange={dateRange}
      onDateRangeChange={onDateRangeChange}
      onBulkDelete={handleBulkDeleteClick}
      onBulkShip={() => {
        if (isShipping || selectedIds.length === 0) return;
        setIsShippingDialogOpen(true);
      }}
      isBulkActionBusy={isShipping || bulkDeleteMut.isPending}
      onExportCSV={handleExportCSV}
      autoRefreshEnabled={autoRefreshEnabled}
      onToggleAutoRefresh={toggleAutoRefresh}
      countdown={countdown}
    />
  );

  // ── Render ────────────────────────────────────────────────────

  return (
    <>
      <Card className="overflow-hidden border border-border bg-card shadow-sm backdrop-blur-xl">
        <CardHeader className="space-y-1 pb-3">
          <div className="flex items-center gap-3">
            <CardTitle className="text-xl font-bold tracking-tight text-foreground">
              {showTrashed ? "Trash" : "Orders"}
            </CardTitle>
            {!showTrashed && (
              <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary ring-1 ring-inset ring-primary/20">
                {pagination.total}{" "}
                {pagination.total === 1 ? "order" : "orders"}
              </span>
            )}
          </div>
        </CardHeader>

        <CardContent className="p-0 px-4 sm:px-6 pb-4">
          <DataTable
            table={table}
            isFetching={isFetching}
            isLoading={isLoading}
            error={ordersError}
            onRetry={() => {
              void refetchOrders();
            }}
            toolbar={toolbar}
            itemLabel="orders"
            pageSizeOptions={[10, 20, 50, 100]}
            mobileCardRenderer={mobileCardRenderer}
            emptyState={{
              icon: ShoppingBag,
              title: showTrashed
                ? "No orders in trash"
                : search.search
                  ? "No orders found"
                  : "No orders found",
              description: showTrashed
                ? "Deleted orders will appear here"
                : search.search
                  ? "Try adjusting your search"
                  : "New orders will appear here",
            }}
          />
        </CardContent>
      </Card>

      {/* Delete confirmation */}
      {isDeleteDialogOpen && (
        <Suspense fallback={null}>
          <DeleteOrderDialog
            isOpen={isDeleteDialogOpen}
            onOpenChange={(isOpen) => {
              if (!isOpen) {
                setOrderToDelete(null);
                setIsBulkDeleteOpen(false);
              }
            }}
            isDeleting={bulkDeleteMut.isPending}
            onConfirm={isBulkDeleteOpen ? handleBulkDeleteConfirm : handleSingleDelete}
            showTrashed={showTrashed}
            isBulk={isBulkDeleteOpen}
            itemCount={selectedIds.length}
          />
        </Suspense>
      )}

      {/* Bulk ship dialog */}
      {(isShippingDialogOpen || isShipping) && (
        <Suspense fallback={null}>
          <BulkShipDialog
            isOpen={isShippingDialogOpen}
            onOpenChange={(isOpen) => {
              if (isShipping && !isOpen) return;
              setIsShippingDialogOpen(isOpen);
            }}
            isShipping={isShipping}
            onConfirm={handleBulkShipmentSubmit}
            itemCount={selectedIds.length}
          />
        </Suspense>
      )}
    </>
  );
}
