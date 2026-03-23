import React from "react";
import { ErrorBoundary } from "../ErrorBoundary";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card";
import type { OrderListItem } from "@scalius/core/modules/orders";
import type { DateRange } from "react-day-picker";
import { OrderListToolbar } from "./OrderListToolbar";
import { OrderTable } from "./OrderTable";
import { OrderListPagination } from "./OrderListPagination";
import { DeleteOrderDialog } from "./DeleteOrderDialog";
import { BulkShipDialog } from "./BulkShipDialog";
import { useNavigate } from "@tanstack/react-router";
import { useOrderListState } from "./hooks/useOrderListState";
import { useOrderListApi } from "./hooks/useOrderListApi";
import type { SortField } from "./hooks/useOrderListState";

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
    order: "asc" | "desc";
  };
  showTrashed?: boolean;
}

export function OrderListContainer({
  orders,
  pagination,
  initialSearchQuery = "",
  initialSort = { field: "updatedAt", order: "desc" },
  showTrashed = false,
}: OrderListProps) {
  const navigate = useNavigate();
  const state = useOrderListState(orders, pagination, initialSearchQuery, initialSort);
  const api = useOrderListApi(state, showTrashed, orders);

  const {
    displayOrders,
    currentPagination,
    searchQuery,
    setSearchQuery,
    sort,
    setSort,
    selectedOrders,
    setSelectedOrders,
    lastSelectedId,
    setLastSelectedId,
    activeStatus,
    setActiveStatus,
    paymentStatus,
    setPaymentStatus,
    paymentMethod,
    setPaymentMethod,
    fulfillmentStatus,
    setFulfillmentStatus,
    shipmentStatuses,
    setShipmentStatuses,
    dateRange,
    setDateRange,
    updatingStatusIds,
    isDeleting,
    isShipping,
    isLoadingOrders,
    orderToDelete,
    setOrderToDelete,
    isBulkDeleteOpen,
    setIsBulkDeleteOpen,
    isShippingDialogOpen,
    setIsShippingDialogOpen,
  } = state;

  const {
    fetchOrders,
    handleStatusUpdate,
    performDelete,
    handleRestore,
    handleBulkShipmentSubmit,
    handleExportCSV,
    handleRefreshAllShipments,
  } = api;

  const handleDateRangeChange = React.useCallback((range: DateRange | undefined) => {
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
  }, [setDateRange, fetchOrders, currentPagination.limit, searchQuery, activeStatus, sort, showTrashed]);

  const handleSearch = React.useCallback((e?: React.SyntheticEvent) => {
    if (e) e.preventDefault();
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
  }, [fetchOrders, currentPagination.limit, searchQuery, activeStatus, sort, showTrashed, dateRange]);

  // Trigger search when filter dropdowns change
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlPaymentStatus = params.get("paymentStatus");
    const urlPaymentMethod = params.get("paymentMethod");
    const urlFulfillmentStatus = params.get("fulfillmentStatus");

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
  }, [paymentStatus, paymentMethod, fulfillmentStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search
  const prevSearchQuery = React.useRef(initialSearchQuery);
  React.useEffect(() => {
    if (searchQuery !== prevSearchQuery.current) {
      prevSearchQuery.current = searchQuery;
      handleSearch();
    }
  }, [searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSort = React.useCallback((field: SortField) => {
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
  }, [sort, setSort, fetchOrders, currentPagination, searchQuery, activeStatus, showTrashed, dateRange]);

  const handlePageChange = React.useCallback((newPage: number) => {
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
  }, [fetchOrders, currentPagination.limit, searchQuery, activeStatus, sort, showTrashed, dateRange]);

  const handleLimitChange = React.useCallback((newLimit: number) => {
    fetchOrders({
      page: 1,
      limit: newLimit,
      search: searchQuery,
      status: activeStatus,
      sort: sort.field,
      order: sort.order,
      trashed: showTrashed,
      startDate: dateRange?.from,
      endDate: dateRange?.to,
    });
  }, [fetchOrders, searchQuery, activeStatus, sort, showTrashed, dateRange]);

  const handleStatusFilter = React.useCallback((status: string | null) => {
    setActiveStatus(status);
    fetchOrders({
      page: 1,
      limit: currentPagination.limit,
      search: searchQuery,
      status,
      sort: sort.field,
      order: sort.order,
      trashed: showTrashed,
      startDate: dateRange?.from,
      endDate: dateRange?.to,
    });
  }, [setActiveStatus, fetchOrders, currentPagination.limit, searchQuery, sort, showTrashed, dateRange]);

  const handleToggleTrash = React.useCallback(() => {
    void navigate({ to: showTrashed ? "/admin/orders" : "/admin/orders", search: showTrashed ? undefined : { trashed: true } });
  }, [showTrashed]);

  const handleToggleSelection = React.useCallback((
    orderId: string,
    shiftKey: boolean = false,
  ) => {
    if (shiftKey) {
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
      }
    }

    if (shiftKey && lastSelectedId && lastSelectedId !== orderId) {
      const orderIds = displayOrders.map((o) => o.id);
      const startIndex = orderIds.indexOf(lastSelectedId);
      const endIndex = orderIds.indexOf(orderId);
      const [start, end] =
        startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];

      setSelectedOrders((prev) => {
        const newSelection = new Set(prev);
        for (let i = start; i <= end; i++) {
          newSelection.add(orderIds[i]);
        }
        return newSelection;
      });
    } else {
      setSelectedOrders((prev) => {
        const newSelection = new Set(prev);
        if (newSelection.has(orderId)) {
          newSelection.delete(orderId);
        } else {
          newSelection.add(orderId);
        }
        return newSelection;
      });
    }
    setLastSelectedId(orderId);
  }, [lastSelectedId, displayOrders, setSelectedOrders, setLastSelectedId]);

  const handleToggleAll = React.useCallback(() => {
    if (selectedOrders.size === displayOrders.length) {
      setSelectedOrders(new Set());
    } else {
      setSelectedOrders(new Set(displayOrders.map((o) => o.id)));
    }
  }, [selectedOrders.size, displayOrders, setSelectedOrders]);

  const handleSingleDelete = React.useCallback(() => {
    if (orderToDelete) {
      performDelete([orderToDelete], showTrashed);
    }
  }, [orderToDelete, performDelete, showTrashed]);

  const handleBulkDelete = React.useCallback(() => {
    performDelete(Array.from(selectedOrders), showTrashed);
  }, [performDelete, selectedOrders, showTrashed]);

  const handleRefresh = React.useCallback(() => {
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
  }, [fetchOrders, currentPagination, searchQuery, activeStatus, sort, showTrashed, dateRange]);

  return (
    <ErrorBoundary fallback={<div className="p-4 text-center text-muted-foreground">Something went wrong loading orders. <button onClick={() => window.location.reload()} className="underline">Reload</button></div>}>
    <>
      <Card className="overflow-hidden border border-border bg-card shadow-sm backdrop-blur-xl transition-all duration-300 hover:border-border hover:shadow-md">
        <CardHeader className="space-y-1.5 pb-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pb-2">
            <div className="flex items-center gap-3">
              <CardTitle className="text-2xl font-bold tracking-tight text-foreground">
                {showTrashed ? "Trash" : "Orders"}
              </CardTitle>
              {!showTrashed ? (
                <div className="flex items-center justify-center rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary ring-1 ring-inset ring-primary/20">
                  {currentPagination.total}{" "}
                  {currentPagination.total === 1 ? "order" : "orders"}
                </div>
              ) : null}
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
          {isLoadingOrders ? (
            <div className="absolute inset-0 bg-(--background)/80 backdrop-blur-sm z-10 flex items-center justify-center">
              <div className="flex flex-col items-center gap-2">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
                <p className="text-sm text-muted-foreground">
                  Loading orders...
                </p>
              </div>
            </div>
          ) : null}
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
            onEdit={(id) => void navigate({ to: `/admin/orders/${id}/edit` as string })}
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
    </ErrorBoundary>
  );
}
