import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { z } from "zod";
import { toast } from "sonner";
import { createListSearchSchema, createDataSelector, RouteErrorComponent } from "~/lib/list-helpers";
import type { Row } from "@tanstack/react-table";
import type { OrderListItem } from "@scalius/core/modules/orders";
import type { DateRange } from "react-day-picker";
import { formatDateShort } from "@scalius/shared/timestamps";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import { ordersQueryOptions } from "~/lib/api.queries";
import {
  useUpdateOrderStatus,
  useBulkDeleteOrders,
  useRestoreOrder,
} from "~/lib/api.mutations";
import { createOrderShipment, refreshShipmentStatus } from "~/lib/api.functions";
import { useCurrency } from "~/hooks/use-currency";
import { useServerTable, DataTable } from "~/components/admin/data-table";
import { getOrderColumns } from "~/components/admin/data-table/columns/order-columns";
import { OrderToolbar } from "~/components/admin/data-table/toolbars/OrderToolbar";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { ShoppingBag } from "lucide-react";
import { DeleteOrderDialog } from "~/components/admin/order-list/DeleteOrderDialog";
import { BulkShipDialog } from "~/components/admin/order-list/BulkShipDialog";
import { OrderMobileCard } from "~/components/admin/order-list/OrderMobileCard";

// ── Search schema ─────────────────────────────────────────────────

const searchSchema = createListSearchSchema(
  ["customerName", "totalAmount", "status", "createdAt", "updatedAt"] as const,
  { limit: 10, sort: "updatedAt" },
).extend({
  status: z.string().optional().catch(undefined),
  paymentStatus: z.string().optional().catch(undefined),
  paymentMethod: z.string().optional().catch(undefined),
  fulfillmentStatus: z.string().optional().catch(undefined),
});

type SearchParams = z.infer<typeof searchSchema>;

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
    paymentStatus: deps.paymentStatus,
    paymentMethod: deps.paymentMethod,
    fulfillmentStatus: deps.fulfillmentStatus,
  };
}

// ── Shipment types ────────────────────────────────────────────────

interface ShipmentStatus {
  id: string;
  orderId: string;
  [key: string]: unknown;
}

// ── Route definition ──────────────────────────────────────────────

export const Route = createFileRoute("/admin/orders/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => {
    void queryClient.prefetchQuery(ordersQueryOptions(mapParams(deps)));
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
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);
  const [activeStatus, setActiveStatus] = useState<string | null>(
    search.status ?? null,
  );
  const [paymentStatus, setPaymentStatus] = useState<string | null>(
    search.paymentStatus ?? null,
  );
  const [paymentMethod, setPaymentMethod] = useState<string | null>(
    search.paymentMethod ?? null,
  );
  const [fulfillmentStatus, setFulfillmentStatus] = useState<string | null>(
    search.fulfillmentStatus ?? null,
  );

  // Auto-refresh state
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("orderlist-auto-refresh") === "true";
    }
    return false;
  });
  const [countdown, setCountdown] = useState(60);
  const refreshIntervalRef = useRef<number | undefined>(undefined);
  const countdownIntervalRef = useRef<number | undefined>(undefined);

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
    (value: string) => handleNavigate({ search: value, page: 1 }),
    [handleNavigate],
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
      setActiveStatus(status);
      handleNavigate({ status: status ?? undefined, page: 1 });
    },
    [handleNavigate],
  );

  const onPaymentStatusChange = useCallback(
    (status: string | null) => {
      setPaymentStatus(status);
      handleNavigate({ paymentStatus: status ?? undefined, page: 1 });
    },
    [handleNavigate],
  );

  const onPaymentMethodChange = useCallback(
    (method: string | null) => {
      setPaymentMethod(method);
      handleNavigate({ paymentMethod: method ?? undefined, page: 1 });
    },
    [handleNavigate],
  );

  const onFulfillmentStatusChange = useCallback(
    (status: string | null) => {
      setFulfillmentStatus(status);
      handleNavigate({ fulfillmentStatus: status ?? undefined, page: 1 });
    },
    [handleNavigate],
  );

  const onDateRangeChange = useCallback(
    (range: DateRange | undefined) => {
      setDateRange(range);
      // Date range filtering triggers a re-fetch via URL params
      // For now just update local state; the query will re-run
    },
    [],
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
  }, []);

  // ── Refresh ───────────────────────────────────────────────────

  const handleRefresh = useCallback(() => {
    // Force re-fetch by navigating with the same params
    handleNavigate({});
  }, [handleNavigate]);

  // ── Auto-refresh ──────────────────────────────────────────────

  const toggleAutoRefresh = useCallback(() => {
    const newValue = !autoRefreshEnabled;
    setAutoRefreshEnabled(newValue);
    if (typeof window !== "undefined") {
      localStorage.setItem("orderlist-auto-refresh", String(newValue));
    }
    if (newValue) {
      handleRefresh();
      setCountdown(60);
    }
  }, [autoRefreshEnabled, handleRefresh]);

  useEffect(() => {
    if (autoRefreshEnabled) {
      setCountdown(60);
      countdownIntervalRef.current = window.setInterval(() => {
        setCountdown((prev) => (prev <= 1 ? 60 : prev - 1));
      }, 1000);
      refreshIntervalRef.current = window.setInterval(() => {
        handleRefresh();
      }, 60000);
      return () => {
        if (countdownIntervalRef.current)
          window.clearInterval(countdownIntervalRef.current);
        if (refreshIntervalRef.current)
          window.clearInterval(refreshIntervalRef.current);
      };
    } else {
      if (countdownIntervalRef.current)
        window.clearInterval(countdownIntervalRef.current);
      if (refreshIntervalRef.current)
        window.clearInterval(refreshIntervalRef.current);
    }
  }, [autoRefreshEnabled, handleRefresh]);

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
    isFetching,
    isLoading,
    pagination,
    selectedIds,
    clearSelection,
  } = useServerTable({
    columns,
    queryOptions: ordersQueryOptions(mapParams(search)),
    dataSelector,
    currentPage: search.page,
    currentLimit: search.limit,
    currentSort: search.sort,
    currentOrder: search.order,
    onPaginationChange,
    onSortingChange,
    defaultPageSize: 10,
  });

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
      setIsShipping(true);
      let successCount = 0;
      for (const orderId of selectedIds) {
        try {
          const result = await createOrderShipment({
            data: { orderId, shipment: { providerId, options: {} } },
          });
          successCount++;
          setShipmentStatuses((prev) => ({
            ...prev,
            [orderId]: result as unknown as ShipmentStatus,
          }));
        } catch (error) {
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
      setIsShipping(false);
      setIsShippingDialogOpen(false);
      if (successCount === selectedIds.length) clearSelection();
    },
    [selectedIds, clearSelection],
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
      paymentStatus={paymentStatus}
      onPaymentStatusChange={onPaymentStatusChange}
      paymentMethod={paymentMethod}
      onPaymentMethodChange={onPaymentMethodChange}
      fulfillmentStatus={fulfillmentStatus}
      onFulfillmentStatusChange={onFulfillmentStatusChange}
      dateRange={dateRange}
      onDateRangeChange={onDateRangeChange}
      onBulkDelete={handleBulkDeleteClick}
      onBulkShip={() => setIsShippingDialogOpen(true)}
      onExportCSV={handleExportCSV}
      onRefresh={handleRefresh}
      autoRefreshEnabled={autoRefreshEnabled}
      onToggleAutoRefresh={toggleAutoRefresh}
      countdown={countdown}
    />
  );

  // ── Render ────────────────────────────────────────────────────

  return (
    <>
      <Card className="overflow-hidden border border-border bg-card shadow-sm backdrop-blur-xl">
        <CardHeader className="space-y-1.5 pb-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pb-2">
            <div className="flex items-center gap-3">
              <CardTitle className="text-2xl font-bold tracking-tight text-foreground">
                {showTrashed ? "Trash" : "Orders"}
              </CardTitle>
              {!showTrashed && (
                <div className="flex items-center justify-center rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary ring-1 ring-inset ring-primary/20">
                  {pagination.total}{" "}
                  {pagination.total === 1 ? "order" : "orders"}
                </div>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0 px-4 sm:px-6 pb-4">
          <DataTable
            table={table}
            isFetching={isFetching}
            isLoading={isLoading}
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
      <DeleteOrderDialog
        isOpen={!!orderToDelete || isBulkDeleteOpen}
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

      {/* Bulk ship dialog */}
      <BulkShipDialog
        isOpen={isShippingDialogOpen}
        onOpenChange={setIsShippingDialogOpen}
        isShipping={isShipping}
        onConfirm={handleBulkShipmentSubmit}
        itemCount={selectedIds.length}
      />
    </>
  );
}
