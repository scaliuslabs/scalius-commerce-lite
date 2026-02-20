import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle } from "lucide-react";
import type { OrderListItem } from "../../lib/admin";
import type { DateRange } from "react-day-picker";

// Import the refactored components
import { OrderListToolbar } from "./order-list/OrderListToolbar";
import { OrderTable } from "./order-list/OrderTable";
import { OrderListPagination } from "./order-list/OrderListPagination";
import { DeleteOrderDialog } from "./order-list/DeleteOrderDialog";
import { BulkShipDialog } from "./order-list/BulkShipDialog";

type SortField =
  | "customerName"
  | "totalAmount"
  | "status"
  | "createdAt"
  | "updatedAt";
type SortOrder = "asc" | "desc";

interface OrderListProps {
  orders: OrderListItem[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
  initialSearchQuery?: string;
  initialSort?: {
    field: SortField;
    order: SortOrder;
  };
  showTrashed?: boolean;
}

export function OrderList({
  orders,
  pagination,
  initialSearchQuery = "",
  initialSort = { field: "updatedAt", order: "desc" },
  showTrashed = false,
}: OrderListProps) {
  const { toast } = useToast();

  // State Management
  const [displayOrders, setDisplayOrders] =
    React.useState<OrderListItem[]>(orders);
  const [currentPagination, setCurrentPagination] = React.useState(pagination);
  const [searchQuery, setSearchQuery] = React.useState(initialSearchQuery);
  const [sort, setSort] = React.useState(initialSort);
  const [selectedOrders, setSelectedOrders] = React.useState<Set<string>>(
    new Set(),
  );
  const [lastSelectedId, setLastSelectedId] = React.useState<string | null>(
    null,
  );
  const [activeStatus, setActiveStatus] = React.useState<string | null>(null);
  const [paymentStatus, setPaymentStatus] = React.useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = React.useState<string | null>(null);
  const [fulfillmentStatus, setFulfillmentStatus] = React.useState<string | null>(null);
  const [shipmentStatuses, setShipmentStatuses] = React.useState<
    Record<string, any>
  >({});
  const [dateRange, setDateRange] = React.useState<DateRange | undefined>(
    undefined,
  );

  // UI State
  const [updatingStatusIds, setUpdatingStatusIds] = React.useState<Set<string>>(
    new Set(),
  );
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [isShipping, setIsShipping] = React.useState(false);
  const [isLoadingOrders, setIsLoadingOrders] = React.useState(false);

  // Dialog State
  const [orderToDelete, setOrderToDelete] = React.useState<string | null>(null);
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = React.useState(false);
  const [isShippingDialogOpen, setIsShippingDialogOpen] = React.useState(false);

  // Effects
  React.useEffect(() => {
    setDisplayOrders(orders);
  }, [orders]);

  React.useEffect(() => {
    setCurrentPagination(pagination);
  }, [pagination]);

  React.useEffect(() => {
    const url = new URL(window.location.href);
    setActiveStatus(url.searchParams.get("status"));
    setPaymentStatus(url.searchParams.get("paymentStatus"));
    setPaymentMethod(url.searchParams.get("paymentMethod"));
    setFulfillmentStatus(url.searchParams.get("fulfillmentStatus"));

    // Update sort state from URL params
    const sortField = url.searchParams.get("sort") as SortField | null;
    const sortOrder = url.searchParams.get("order") as SortOrder | null;
    if (sortField && sortOrder) {
      setSort({ field: sortField, order: sortOrder });
    }
  }, []);

  // Reset selection when orders change (e.g., after filter/search/pagination)
  React.useEffect(() => {
    const currentOrderIds = new Set(displayOrders.map((o) => o.id));
    setSelectedOrders((prev) => {
      const newSelection = new Set<string>();
      prev.forEach((id) => {
        if (currentOrderIds.has(id)) {
          newSelection.add(id);
        }
      });
      return newSelection;
    });
  }, [displayOrders]);

  // Initialize shipment statuses from orders prop
  React.useEffect(() => {
    const initialShipmentStatuses: Record<string, any> = {};
    orders.forEach((order) => {
      if (order.latestShipment) {
        initialShipmentStatuses[order.id] = order.latestShipment;
      }
    });
    setShipmentStatuses(initialShipmentStatuses);
  }, [orders]);

  // Fetch orders from API
  const fetchOrders = React.useCallback(
    async (params: {
      page?: number;
      limit?: number;
      search?: string;
      status?: string | null;
      sort?: string;
      order?: string;
      trashed?: boolean;
      startDate?: Date;
      endDate?: Date;
    }) => {
      setIsLoadingOrders(true);

      try {
        const url = new URL("/api/orders", window.location.origin);
        if (params.page) url.searchParams.set("page", params.page.toString());
        if (params.limit)
          url.searchParams.set("limit", params.limit.toString());
        if (params.search) url.searchParams.set("search", params.search);
        if (params.status) url.searchParams.set("status", params.status);
        if (params.sort) url.searchParams.set("sort", params.sort);
        if (params.order) url.searchParams.set("order", params.order);
        if (params.trashed) url.searchParams.set("trashed", "true");
        // new filters
        if (paymentStatus) url.searchParams.set("paymentStatus", paymentStatus);
        if (paymentMethod) url.searchParams.set("paymentMethod", paymentMethod);
        if (fulfillmentStatus) url.searchParams.set("fulfillmentStatus", fulfillmentStatus);
        if (params.startDate)
          url.searchParams.set("startDate", params.startDate.toISOString());
        if (params.endDate)
          url.searchParams.set("endDate", params.endDate.toISOString());

        const response = await fetch(url.toString());
        if (!response.ok) throw new Error("Failed to fetch orders");

        const data = await response.json();

        // Parse dates from ISO strings
        const parsedOrders = data.orders.map((order: any) => ({
          ...order,
          createdAt: new Date(order.createdAt),
          updatedAt: new Date(order.updatedAt),
          latestShipment: order.latestShipment
            ? {
              ...order.latestShipment,
              lastChecked: order.latestShipment.lastChecked
                ? new Date(order.latestShipment.lastChecked)
                : null,
            }
            : null,
        }));

        setDisplayOrders(parsedOrders);
        setCurrentPagination(data.pagination);

        // Update shipment statuses
        const newShipmentStatuses: Record<string, any> = {};
        parsedOrders.forEach((order: any) => {
          if (order.latestShipment) {
            newShipmentStatuses[order.id] = order.latestShipment;
          }
        });
        setShipmentStatuses(newShipmentStatuses);

        // Update URL without reload
        const urlToUpdate = new URL(window.location.href);
        if (params.page)
          urlToUpdate.searchParams.set("page", params.page.toString());
        if (params.limit)
          urlToUpdate.searchParams.set("limit", params.limit.toString());
        if (params.search) {
          urlToUpdate.searchParams.set("search", params.search);
        } else {
          urlToUpdate.searchParams.delete("search");
        }
        if (params.status) {
          urlToUpdate.searchParams.set("status", params.status);
        } else {
          urlToUpdate.searchParams.delete("status");
        }

        // Sync advance filters
        if (paymentStatus) urlToUpdate.searchParams.set("paymentStatus", paymentStatus);
        else urlToUpdate.searchParams.delete("paymentStatus");

        if (paymentMethod) urlToUpdate.searchParams.set("paymentMethod", paymentMethod);
        else urlToUpdate.searchParams.delete("paymentMethod");

        if (fulfillmentStatus) urlToUpdate.searchParams.set("fulfillmentStatus", fulfillmentStatus);
        else urlToUpdate.searchParams.delete("fulfillmentStatus");

        if (params.sort) urlToUpdate.searchParams.set("sort", params.sort);
        if (params.order) urlToUpdate.searchParams.set("order", params.order);
        if (params.trashed) {
          urlToUpdate.searchParams.set("trashed", "true");
        } else {
          urlToUpdate.searchParams.delete("trashed");
        }

        window.history.pushState({}, "", urlToUpdate.toString());
      } catch (error) {
        console.error("Error fetching orders:", error);
        console.error("Error fetching orders:", error);
        // setFetchError(error instanceof Error ? error.message : "Failed to fetch orders");
        toast({
          title: "Error",
          description: "Failed to fetch orders. Please try again.",
          variant: "destructive",
        });
      } finally {
        setIsLoadingOrders(false);
      }
    },
    [toast],
  );

  const handleDateRangeChange = (range: DateRange | undefined) => {
    setDateRange(range);
    if (range?.from) {
      fetchOrders({
        page: 1,
        limit: currentPagination.limit,
        search: searchQuery,
        status: activeStatus,
        sort: sort.field,
        order: sort.order,
        trashed: showTrashed,
        startDate: range.from,
        endDate: range.to,
      });
    } else if (range === undefined) {
      fetchOrders({
        page: 1,
        limit: currentPagination.limit,
        search: searchQuery,
        status: activeStatus,
        sort: sort.field,
        order: sort.order,
        trashed: showTrashed,
        startDate: undefined,
        endDate: undefined,
      });
    }
  };

  const handleSearch = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    fetchOrders({
      page: 1, // Reset to first page on search
      limit: currentPagination.limit,
      search: searchQuery,
      status: activeStatus,
      sort: sort.field,
      order: sort.order,
      trashed: showTrashed,
      startDate: dateRange?.from,
      endDate: dateRange?.to,
    });
  };



  // React to additional filter changes
  React.useEffect(() => {
    // Only fetch if it's not the initial mount
    const url = new URL(window.location.href);
    const urlPaymentStatus = url.searchParams.get("paymentStatus");
    const urlPaymentMethod = url.searchParams.get("paymentMethod");
    const urlFulfillmentStatus = url.searchParams.get("fulfillmentStatus");

    // We compare with the state explicitly. If they differ significantly, fetch.
    if (paymentStatus !== urlPaymentStatus || paymentMethod !== urlPaymentMethod || fulfillmentStatus !== urlFulfillmentStatus) {
      fetchOrders({
        page: 1,
        limit: currentPagination.limit,
        search: searchQuery,
        status: activeStatus,
        sort: sort.field,
        order: sort.order,
        trashed: showTrashed,
        startDate: dateRange?.from,
        endDate: dateRange?.to,
      });
    }
  }, [paymentStatus, paymentMethod, fulfillmentStatus]);

  // Auto-trigger search when searchQuery changes from toolbar
  const prevSearchQuery = React.useRef(initialSearchQuery);
  React.useEffect(() => {
    // Only trigger if searchQuery actually changed and it's not the initial render
    if (searchQuery !== prevSearchQuery.current) {
      prevSearchQuery.current = searchQuery;
      handleSearch();
    }
  }, [searchQuery]);

  const handleSort = (field: SortField) => {
    const newOrder =
      sort.field === field && sort.order === "asc" ? "desc" : "asc";
    setSort({ field, order: newOrder });
    fetchOrders({
      page: currentPagination.page,
      limit: currentPagination.limit,
      search: searchQuery,
      status: activeStatus,
      sort: field,
      order: newOrder,
      trashed: showTrashed,
      startDate: dateRange?.from,
      endDate: dateRange?.to,
    });
  };

  const handlePageChange = (newPage: number) => {
    fetchOrders({
      page: newPage,
      limit: currentPagination.limit,
      search: searchQuery,
      status: activeStatus,
      sort: sort.field,
      order: sort.order,
      trashed: showTrashed,
      startDate: dateRange?.from,
      endDate: dateRange?.to,
    });
  };

  const handleLimitChange = (newLimit: number) => {
    fetchOrders({
      page: 1, // Reset to first page when changing limit
      limit: newLimit,
      search: searchQuery,
      status: activeStatus,
      sort: sort.field,
      order: sort.order,
      trashed: showTrashed,
      startDate: dateRange?.from,
      endDate: dateRange?.to,
    });
  };

  const handleStatusFilter = (status: string | null) => {
    setActiveStatus(status);
    fetchOrders({
      page: 1, // Reset to first page on filter change
      limit: currentPagination.limit,
      search: searchQuery,
      status,
      sort: sort.field,
      order: sort.order,
      trashed: showTrashed,
      startDate: dateRange?.from,
      endDate: dateRange?.to,
    });
  };

  const handleToggleTrash = () => {
    window.location.href = showTrashed
      ? "/admin/orders"
      : "/admin/orders?trashed=true";
  };

  // Selection Handlers
  const handleToggleSelection = (
    orderId: string,
    shiftKey: boolean = false,
  ) => {
    // Prevent text selection when shift-clicking
    if (shiftKey) {
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
      }
    }

    if (shiftKey && lastSelectedId && lastSelectedId !== orderId) {
      // Range selection
      const orderIds = displayOrders.map((o) => o.id);
      const startIndex = orderIds.indexOf(lastSelectedId);
      const endIndex = orderIds.indexOf(orderId);
      const [start, end] =
        startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];

      const newSelection = new Set(selectedOrders);
      for (let i = start; i <= end; i++) {
        newSelection.add(orderIds[i]);
      }
      setSelectedOrders(newSelection);
    } else {
      // Single selection
      const newSelection = new Set(selectedOrders);
      if (newSelection.has(orderId)) {
        newSelection.delete(orderId);
      } else {
        newSelection.add(orderId);
      }
      setSelectedOrders(newSelection);
    }
    setLastSelectedId(orderId);
  };

  const handleToggleAll = () => {
    if (selectedOrders.size === displayOrders.length) {
      setSelectedOrders(new Set());
    } else {
      setSelectedOrders(new Set(displayOrders.map((o) => o.id)));
    }
  };

  // Data Mutation Handlers
  const handleStatusUpdate = async (orderId: string, newStatus: string) => {
    setUpdatingStatusIds((prev) => new Set(prev).add(orderId));
    const originalOrders = [...displayOrders];

    setDisplayOrders((prev) =>
      prev.map((order) =>
        order.id === orderId ? { ...order, status: newStatus } : order,
      ),
    );

    try {
      const response = await fetch(`/api/orders/${orderId}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus.toLowerCase() }),
      });
      if (!response.ok) throw new Error("Failed to update status");
      toast({
        title: "Status Updated",
        description: (
          <span className="flex items-center">
            <CheckCircle className="mr-1.5 h-4 w-4 text-emerald-500" /> Order
            status changed to {newStatus}
          </span>
        ),
      });
    } catch (error) {
      console.error("Error updating status:", error);
      setDisplayOrders(originalOrders);
      toast({
        title: "Error",
        description: "Failed to update order status. Please try again.",
        variant: "destructive",
      });
    } finally {
      setUpdatingStatusIds((prev) => {
        const newSet = new Set(prev);
        newSet.delete(orderId);
        return newSet;
      });
    }
  };

  const performDelete = async (ids: string[], permanent: boolean) => {
    setIsDeleting(true);
    const originalOrders = [...displayOrders];

    setDisplayOrders((prev) => prev.filter((order) => !ids.includes(order.id)));

    try {
      const response = await fetch("/api/orders/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds: ids, permanent }),
      });
      if (!response.ok) throw new Error("Failed to delete orders");

      toast({
        title: "Success",
        description: `${ids.length} order(s) have been ${permanent ? "permanently deleted" : "moved to trash"}.`,
      });

      setSelectedOrders(new Set());

      // Smart refresh: Update pagination count
      setCurrentPagination((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - ids.length),
        totalPages: Math.max(
          1,
          Math.ceil((prev.total - ids.length) / prev.limit),
        ),
      }));
    } catch (error) {
      console.error("Error deleting orders:", error);
      setDisplayOrders(originalOrders);
      toast({
        title: "Error",
        description: "Failed to delete orders. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
      setOrderToDelete(null);
      setIsBulkDeleteOpen(false);
    }
  };

  const handleSingleDelete = () => {
    if (orderToDelete) {
      performDelete([orderToDelete], showTrashed);
    }
  };

  const handleBulkDelete = () => {
    performDelete(Array.from(selectedOrders), showTrashed);
  };

  const handleRestore = async (id: string) => {
    setDisplayOrders((prev) => prev.filter((order) => order.id !== id));
    try {
      const response = await fetch(`/api/orders/${id}/restore`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("Failed to restore order");
      toast({ title: "Order restored" });

      // Smart refresh: Update pagination count
      setCurrentPagination((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - 1),
        totalPages: Math.max(1, Math.ceil((prev.total - 1) / prev.limit)),
      }));
    } catch (error) {
      console.error("Error restoring order:", error);
      toast({ title: "Error restoring order", variant: "destructive" });
      setDisplayOrders(orders); // Revert optimistic update
    }
  };

  const handleBulkShipmentSubmit = async (providerId: string) => {
    setIsShipping(true);
    const orderIds = Array.from(selectedOrders);
    let successCount = 0;
    let completedCount = 0;

    // Process shipments with progress tracking
    for (const orderId of orderIds) {
      try {
        const response = await fetch(`/api/orders/${orderId}/shipments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerId, options: {} }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || result.message);

        successCount++;
        setShipmentStatuses((prev) => ({ ...prev, [orderId]: result }));
        setDisplayOrders((prev) =>
          prev.map((order) =>
            order.id === orderId ? { ...order, status: "Shipped" } : order,
          ),
        );
      } catch (error) {
        console.error(`Error for order ${orderId}:`, error);
      } finally {
        completedCount++;
        // Optional: you could emit progress here if needed
      }
    }

    toast({
      title: successCount > 0 ? "Shipments Created" : "Shipment Failed",
      description: `${successCount} of ${orderIds.length} shipments created successfully.`,
      variant: successCount > 0 ? "default" : "destructive",
    });

    setIsShipping(false);
    setIsShippingDialogOpen(false);
    if (successCount === orderIds.length) setSelectedOrders(new Set());
  };

  const handleExportCSV = () => {
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
    const csvRows = displayOrders.map((order) => [
      order.id,
      order.customerName,
      order.customerPhone,
      order.customerEmail || "",
      order.cityName || order.city,
      order.zoneName || order.zone,
      order.areaName || order.area || "",
      order.status,
      order.totalAmount,
      order.discountAmount || 0,
      order.itemCount,
      order.createdAt.toLocaleDateString(),
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

    toast({
      title: "CSV Exported",
      description: `${displayOrders.length} orders exported successfully.`,
    });
  };

  const handleRefresh = () => {
    fetchOrders({
      page: currentPagination.page,
      limit: currentPagination.limit,
      search: searchQuery,
      status: activeStatus,
      sort: sort.field,
      order: sort.order,
      trashed: showTrashed,
      startDate: dateRange?.from,
      endDate: dateRange?.to,
    });
  };

  const handleRefreshAllShipments = async () => {
    const ordersWithShipments = displayOrders.filter(
      (order) => shipmentStatuses[order.id],
    );

    if (ordersWithShipments.length === 0) {
      toast({
        title: "No shipments to refresh",
        description: "None of the orders on this page have shipments.",
      });
      return;
    }

    let successCount = 0;
    const results = await Promise.all(
      ordersWithShipments.map(async (order) => {
        const shipment = shipmentStatuses[order.id];
        if (!shipment) return null;

        try {
          const response = await fetch(
            `/api/orders/${order.id}/shipments/${shipment.id}/refresh`,
            { method: "POST" },
          );

          if (!response.ok) throw new Error("Failed to refresh");

          const updatedShipment = await response.json();
          successCount++;
          return { orderId: order.id, shipment: updatedShipment };
        } catch (error) {
          console.error(
            `Error refreshing shipment for order ${order.id}:`,
            error,
          );
          return null;
        }
      }),
    );

    // Update all successful refreshes
    results.forEach((result) => {
      if (result) {
        setShipmentStatuses((prev) => ({
          ...prev,
          [result.orderId]: result.shipment,
        }));
      }
    });

    toast({
      title: "Shipments Refreshed",
      description: `${successCount} of ${ordersWithShipments.length} shipments refreshed successfully.`,
    });
  };

  return (
    <>
      <Card className="overflow-hidden border border-border bg-card shadow-sm backdrop-blur-xl transition-all duration-300 hover:border-border hover:shadow-md">
        <CardHeader className="space-y-1.5 pb-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pb-2">
            <div className="flex items-center gap-3">
              <CardTitle className="text-2xl font-bold tracking-tight text-foreground">
                {showTrashed ? "Trash" : "Orders"}
              </CardTitle>
              {!showTrashed && (
                <div className="flex items-center justify-center rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary ring-1 ring-inset ring-primary/20">
                  {currentPagination.total}{" "}
                  {currentPagination.total === 1 ? "order" : "orders"}
                </div>
              )}
            </div>
          </div>

          <OrderListToolbar
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onSearchSubmit={handleSearch}
            selectedOrdersCount={selectedOrders.size}
            onBulkDeleteClick={() => setIsBulkDeleteOpen(true)}
            onBulkShipClick={() => setIsShippingDialogOpen(true)}
            showTrashed={showTrashed}
            onToggleTrash={handleToggleTrash}
            activeStatus={activeStatus}
            onStatusFilterChange={handleStatusFilter}
            onExportCSV={handleExportCSV}
            onRefresh={handleRefresh}
            dateRange={dateRange}
            onDateRangeChange={handleDateRangeChange}
            paymentStatus={paymentStatus}
            onPaymentStatusChange={setPaymentStatus}
            paymentMethod={paymentMethod}
            onPaymentMethodChange={setPaymentMethod}
            fulfillmentStatus={fulfillmentStatus}
            onFulfillmentStatusChange={setFulfillmentStatus}
          />
        </CardHeader>

        <CardContent className="p-0 relative">
          {isLoadingOrders && (
            <div className="absolute inset-0 bg-(--background)/80 backdrop-blur-sm z-10 flex items-center justify-center">
              <div className="flex flex-col items-center gap-2">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
                <p className="text-sm text-muted-foreground">
                  Loading orders...
                </p>
              </div>
            </div>
          )}
          <OrderTable
            orders={displayOrders}
            shipmentStatuses={shipmentStatuses}
            selectedOrders={selectedOrders}
            updatingStatusIds={updatingStatusIds}
            sort={sort}
            showTrashed={showTrashed}
            searchQuery={searchQuery}
            onSort={handleSort}
            onToggleAll={handleToggleAll}
            onToggleSelection={handleToggleSelection}
            onEdit={(id) => (window.location.href = `/admin/orders/${id}/edit`)}
            onDelete={(id) => setOrderToDelete(id)}
            onPermanentDelete={(id) => setOrderToDelete(id)}
            onRestore={handleRestore}
            onStatusUpdate={handleStatusUpdate}
            onShipmentStatusUpdated={(updatedShipment) => {
              setShipmentStatuses((prev) => ({
                ...prev,
                [updatedShipment.orderId]: updatedShipment,
              }));
            }}
            onRefreshAllShipments={handleRefreshAllShipments}
          />
          <OrderListPagination
            pagination={currentPagination}
            onPageChange={handlePageChange}
            onLimitChange={handleLimitChange}
          />
        </CardContent>
      </Card>

      <DeleteOrderDialog
        isOpen={!!orderToDelete || isBulkDeleteOpen}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setOrderToDelete(null);
            setIsBulkDeleteOpen(false);
          }
        }}
        isDeleting={isDeleting}
        onConfirm={isBulkDeleteOpen ? handleBulkDelete : handleSingleDelete}
        showTrashed={showTrashed}
        isBulk={isBulkDeleteOpen}
        itemCount={selectedOrders.size}
      />

      <BulkShipDialog
        isOpen={isShippingDialogOpen}
        onOpenChange={setIsShippingDialogOpen}
        isShipping={isShipping}
        onConfirm={handleBulkShipmentSubmit}
        itemCount={selectedOrders.size}
      />
    </>
  );
}
