import React from "react";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";
import { formatDateShort } from "@scalius/shared/timestamps";
import type { OrderListItem } from "@scalius/core/modules/orders";
import type { UseOrderListStateReturn, OrderListPagination } from "./useOrderListState";
import { getOrders, createOrderShipment, refreshShipmentStatus } from "~/lib/api.functions";
import {
  useUpdateOrderStatus,
  useBulkDeleteOrders,
  useRestoreOrder,
} from "~/lib/api.mutations";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";

interface ShipmentStatus {
  id: string;
  orderId: string;
  [key: string]: unknown;
}

interface FetchOrdersParams {
  page?: number;
  limit?: number;
  search?: string;
  status?: string | null;
  sort?: string;
  order?: string;
  trashed?: boolean;
  startDate?: Date;
  endDate?: Date;
}

export function useOrderListApi(
  state: UseOrderListStateReturn,
  _showTrashed: boolean,
  _initialOrders: OrderListItem[],
) {
  const statusMutation = useUpdateOrderStatus();
  const bulkDeleteMutation = useBulkDeleteOrders();
  const restoreMutation = useRestoreOrder();

  const {
    displayOrders,
    setDisplayOrders,
    setCurrentPagination,
    setShipmentStatuses,
    setIsLoadingOrders,
    setUpdatingStatusIds,
    setIsDeleting,
    setIsShipping,
    setIsShippingDialogOpen,
    setSelectedOrders,
    setOrderToDelete,
    setIsBulkDeleteOpen,
    paymentStatus,
    paymentMethod,
    fulfillmentStatus,
    shipmentStatuses,
  } = state;

  const navigate = useNavigate();

  const fetchOrders = React.useCallback(
    async (params: FetchOrdersParams) => {
      setIsLoadingOrders(true);

      try {
        const data = await getOrders({
          data: {
            page: params.page,
            limit: params.limit,
            search: params.search,
            status: params.status ?? undefined,
            sort: params.sort,
            order: params.order,
            showTrashed: params.trashed,
            paymentStatus: paymentStatus || undefined,
            paymentMethod: paymentMethod || undefined,
            fulfillmentStatus: fulfillmentStatus || undefined,
          },
        }) as Record<string, unknown>;
        const parsedOrders = ((data.orders || []) as Record<string, unknown>[]).map((order: Record<string, unknown>) => ({
          ...order,
          createdAt: new Date(order.createdAt as string),
          updatedAt: new Date(order.updatedAt as string),
          latestShipment: order.latestShipment
            ? {
              ...(order.latestShipment as Record<string, unknown>),
              lastChecked: (order.latestShipment as Record<string, unknown>).lastChecked
                ? new Date((order.latestShipment as Record<string, unknown>).lastChecked as string)
                : null,
            }
            : null,
        }));

        setDisplayOrders(parsedOrders as OrderListItem[]);
        setCurrentPagination(data.pagination as OrderListPagination);
        const newShipmentStatuses: Record<string, ShipmentStatus> = {};
        (parsedOrders as OrderListItem[]).forEach((order: OrderListItem) => {
          if (order.latestShipment) {
            newShipmentStatuses[order.id] = order.latestShipment as unknown as ShipmentStatus;
          }
        });
        setShipmentStatuses(newShipmentStatuses);
        void navigate({
          search: ((prev: any) => {
            const next: Record<string, unknown> = { ...prev };
            if (params.page) next.page = params.page;
            else delete next.page;
            if (params.limit) next.limit = params.limit;
            else delete next.limit;
            if (params.search) next.search = params.search;
            else delete next.search;
            if (params.status) next.status = params.status;
            else delete next.status;
            if (paymentStatus) next.paymentStatus = paymentStatus;
            else delete next.paymentStatus;
            if (paymentMethod) next.paymentMethod = paymentMethod;
            else delete next.paymentMethod;
            if (fulfillmentStatus) next.fulfillmentStatus = fulfillmentStatus;
            else delete next.fulfillmentStatus;
            if (params.sort) next.sort = params.sort;
            if (params.order) next.order = params.order;
            if (params.trashed) next.trashed = "true";
            else delete next.trashed;
            return next;
          }) as any,
          replace: true,
        });
      } catch (error) {
        console.error("Error fetching orders:", error);
        toast.error("Failed to fetch orders. Please try again.");
      } finally {
        setIsLoadingOrders(false);
      }
    },
    [paymentStatus, paymentMethod, fulfillmentStatus, setDisplayOrders, setCurrentPagination, setShipmentStatuses, setIsLoadingOrders, navigate],
  );

  const handleStatusUpdate = React.useCallback((orderId: string, newStatus: string) => {
    setUpdatingStatusIds((prev) => new Set(prev).add(orderId));
    const originalOrders = [...displayOrders];

    // Optimistic update
    setDisplayOrders((prev) =>
      prev.map((order) =>
        order.id === orderId ? { ...order, status: newStatus } : order,
      ),
    );

    statusMutation.mutate(
      { orderId, status: newStatus.toLowerCase() },
      {
        onError: () => {
          setDisplayOrders(originalOrders);
        },
        onSettled: () => {
          setUpdatingStatusIds((prev) => {
            const newSet = new Set(prev);
            newSet.delete(orderId);
            return newSet;
          });
        },
      },
    );
  }, [displayOrders, setDisplayOrders, setUpdatingStatusIds, statusMutation]);

  const performDelete = React.useCallback((ids: string[], permanent: boolean) => {
    setIsDeleting(true);
    const originalOrders = [...displayOrders];

    // Optimistic removal
    setDisplayOrders((prev) => prev.filter((order) => !ids.includes(order.id)));

    bulkDeleteMutation.mutate(
      { orderIds: ids, permanent },
      {
        onSuccess: () => {
          setSelectedOrders(new Set());
          setCurrentPagination((prev) => ({
            ...prev,
            total: Math.max(0, prev.total - ids.length),
            totalPages: Math.max(
              1,
              Math.ceil((prev.total - ids.length) / prev.limit),
            ),
          }));
        },
        onError: () => {
          setDisplayOrders(originalOrders);
        },
        onSettled: () => {
          setIsDeleting(false);
          setOrderToDelete(null);
          setIsBulkDeleteOpen(false);
        },
      },
    );
  }, [displayOrders, setDisplayOrders, setIsDeleting, setSelectedOrders, setCurrentPagination, setOrderToDelete, setIsBulkDeleteOpen, bulkDeleteMutation]);

  const handleRestore = React.useCallback((id: string) => {
    const snapshot = [...displayOrders];
    setDisplayOrders((prev) => prev.filter((order) => order.id !== id));

    restoreMutation.mutate(id, {
      onSuccess: () => {
        setCurrentPagination((prev) => ({
          ...prev,
          total: Math.max(0, prev.total - 1),
          totalPages: Math.max(1, Math.ceil((prev.total - 1) / prev.limit)),
        }));
      },
      onError: () => {
        setDisplayOrders(snapshot);
      },
    });
  }, [displayOrders, setDisplayOrders, setCurrentPagination, restoreMutation]);

  const handleBulkShipmentSubmit = React.useCallback(async (providerId: string) => {
    setIsShipping(true);
    const orderIds = Array.from(state.selectedOrders);
    let successCount = 0;

    for (const orderId of orderIds) {
      try {
        const result = await createOrderShipment({ data: { orderId, shipment: { providerId, options: {} } } });
        successCount++;
        setShipmentStatuses((prev) => ({ ...prev, [orderId]: result as unknown as ShipmentStatus }));
        setDisplayOrders((prev) =>
          prev.map((order) =>
            order.id === orderId ? { ...order, status: "shipped" } : order,
          ),
        );
      } catch (error) {
        console.error(`Error for order ${orderId}:`, error);
      }
    }

    if (successCount > 0) {
      toast.success(`${successCount} of ${orderIds.length} shipments created successfully.`);
    } else {
      toast.error("Shipment failed");
    }

    setIsShipping(false);
    setIsShippingDialogOpen(false);
    if (successCount === orderIds.length) setSelectedOrders(new Set());
  }, [state.selectedOrders, setIsShipping, setShipmentStatuses, setDisplayOrders, setIsShippingDialogOpen, setSelectedOrders]);

  const handleExportCSV = React.useCallback(() => {
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

    toast.success(`${displayOrders.length} orders exported successfully.`);
  }, [displayOrders]);

  const handleRefreshAllShipments = React.useCallback(async () => {
    const ordersWithShipments = displayOrders.filter(
      (order) => shipmentStatuses[order.id],
    );

    if (ordersWithShipments.length === 0) {
      toast("No shipments to refresh", {
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
          const updatedShipment = await refreshShipmentStatus({ data: { orderId: order.id, shipmentId: shipment.id } });
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

    results.forEach((result) => {
      if (result) {
        setShipmentStatuses((prev) => ({
          ...prev,
          [result.orderId]: result.shipment as unknown as ShipmentStatus,
        }));
      }
    });

    toast.success(`${successCount} of ${ordersWithShipments.length} shipments refreshed successfully.`);
  }, [displayOrders, shipmentStatuses, setShipmentStatuses]);

  return {
    fetchOrders,
    handleStatusUpdate,
    performDelete,
    handleRestore,
    handleBulkShipmentSubmit,
    handleExportCSV,
    handleRefreshAllShipments,
  };
}
