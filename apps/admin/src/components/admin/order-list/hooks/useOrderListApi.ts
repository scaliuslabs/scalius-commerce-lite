import React from "react";
import { toast } from "sonner";
import type { OrderListItem } from "@scalius/core/modules/orders";
import type { UseOrderListStateReturn } from "./useOrderListState";
import { unwrapEnvelope, extractApiError } from "@/lib/api-helpers";
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
  initialOrders: OrderListItem[],
) {
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

  const fetchOrders = React.useCallback(
    async (params: FetchOrdersParams) => {
      setIsLoadingOrders(true);

      try {
        const url = new URL("/api/v1/admin/orders", window.location.origin);
        if (params.page) url.searchParams.set("page", params.page.toString());
        if (params.limit)
          url.searchParams.set("limit", params.limit.toString());
        if (params.search) url.searchParams.set("search", params.search);
        if (params.status) url.searchParams.set("status", params.status);
        if (params.sort) url.searchParams.set("sort", params.sort);
        if (params.order) url.searchParams.set("order", params.order);
        if (params.trashed) url.searchParams.set("trashed", "true");
        if (paymentStatus) url.searchParams.set("paymentStatus", paymentStatus);
        if (paymentMethod) url.searchParams.set("paymentMethod", paymentMethod);
        if (fulfillmentStatus) url.searchParams.set("fulfillmentStatus", fulfillmentStatus);
        if (params.startDate)
          url.searchParams.set("startDate", params.startDate.toISOString());
        if (params.endDate)
          url.searchParams.set("endDate", params.endDate.toISOString());

        const response = await fetch(url.toString());
        if (!response.ok) throw new Error("Failed to fetch orders");

        const json = await response.json();
        const data = unwrapEnvelope(json);
        const parsedOrders = data.orders.map((order: Record<string, unknown>) => ({
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

        setDisplayOrders(parsedOrders);
        setCurrentPagination(data.pagination);
        const newShipmentStatuses: Record<string, ShipmentStatus> = {};
        parsedOrders.forEach((order: OrderListItem) => {
          if (order.latestShipment) {
            newShipmentStatuses[order.id] = order.latestShipment as unknown as ShipmentStatus;
          }
        });
        setShipmentStatuses(newShipmentStatuses);
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
        toast.error("Failed to fetch orders. Please try again.");
      } finally {
        setIsLoadingOrders(false);
      }
    },
    [paymentStatus, paymentMethod, fulfillmentStatus, setDisplayOrders, setCurrentPagination, setShipmentStatuses, setIsLoadingOrders],
  );

  const handleStatusUpdate = React.useCallback(async (orderId: string, newStatus: string) => {
    setUpdatingStatusIds((prev) => new Set(prev).add(orderId));
    const originalOrders = [...displayOrders];

    setDisplayOrders((prev) =>
      prev.map((order) =>
        order.id === orderId ? { ...order, status: newStatus } : order,
      ),
    );

    try {
      const response = await fetch(`/api/v1/admin/orders/${orderId}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus.toLowerCase() }),
      });
      if (!response.ok) {
        let errorMessage = "Failed to update order status. Please try again.";
        try {
          const errorData = await response.json();
          errorMessage = extractApiError(errorData, errorMessage);
        } catch {
          errorMessage = `Server error (${response.status}). Please try again.`;
        }
        throw new Error(errorMessage);
      }
      toast.success(`Order status changed to ${newStatus}`);
    } catch (error) {
      console.error("Error updating status:", error);
      setDisplayOrders(originalOrders);
      toast.error(error instanceof Error ? error.message : "Failed to update order status. Please try again.");
    } finally {
      setUpdatingStatusIds((prev) => {
        const newSet = new Set(prev);
        newSet.delete(orderId);
        return newSet;
      });
    }
  }, [displayOrders, setDisplayOrders, setUpdatingStatusIds]);

  const performDelete = React.useCallback(async (ids: string[], permanent: boolean) => {
    setIsDeleting(true);
    const originalOrders = [...displayOrders];

    setDisplayOrders((prev) => prev.filter((order) => !ids.includes(order.id)));

    try {
      const response = await fetch("/api/v1/admin/orders/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds: ids, permanent }),
      });
      if (!response.ok) {
        let errorMessage = "Failed to delete orders. Please try again.";
        try {
          const errorData = await response.json();
          errorMessage = extractApiError(errorData, errorMessage);
        } catch {
          errorMessage = `Server error (${response.status}). Please try again.`;
        }
        throw new Error(errorMessage);
      }

      toast.success(`${ids.length} order(s) have been ${permanent ? "permanently deleted" : "moved to trash"}.`);

      setSelectedOrders(new Set());
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
      toast.error(error instanceof Error ? error.message : "Failed to delete orders. Please try again.");
    } finally {
      setIsDeleting(false);
      setOrderToDelete(null);
      setIsBulkDeleteOpen(false);
    }
  }, [displayOrders, setDisplayOrders, setIsDeleting, setSelectedOrders, setCurrentPagination, setOrderToDelete, setIsBulkDeleteOpen]);

  const handleRestore = React.useCallback(async (id: string) => {
    setDisplayOrders((prev) => prev.filter((order) => order.id !== id));
    try {
      const response = await fetch(`/api/v1/admin/orders/${id}/restore`, {
        method: "POST",
      });
      if (!response.ok) {
        const errorJson = await response.json().catch(() => ({}));
        throw new Error(extractApiError(errorJson, "Failed to restore order"));
      }
      toast.success("Order restored");

      setCurrentPagination((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - 1),
        totalPages: Math.max(1, Math.ceil((prev.total - 1) / prev.limit)),
      }));
    } catch (error) {
      console.error("Error restoring order:", error);
      toast.error(error instanceof Error ? error.message : "Error restoring order");
      setDisplayOrders(initialOrders);
    }
  }, [initialOrders, setDisplayOrders, setCurrentPagination]);

  const handleBulkShipmentSubmit = React.useCallback(async (providerId: string) => {
    setIsShipping(true);
    const orderIds = Array.from(state.selectedOrders);
    let successCount = 0;

    for (const orderId of orderIds) {
      try {
        const response = await fetch(`/api/v1/admin/orders/${orderId}/shipments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerId, options: {} }),
        });
        const rawResult = await response.json();
        if (!response.ok) throw new Error(rawResult.error || rawResult.message);
        const result = unwrapEnvelope(rawResult);

        successCount++;
        setShipmentStatuses((prev) => ({ ...prev, [orderId]: result }));
        setDisplayOrders((prev) =>
          prev.map((order) =>
            order.id === orderId ? { ...order, status: "Shipped" } : order,
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
      order.createdAt.toLocaleDateString("en-US"),
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
          const response = await fetch(
            `/api/v1/admin/orders/${order.id}/shipments/${shipment.id}/refresh`,
            { method: "POST" },
          );

          if (!response.ok) throw new Error("Failed to refresh");

          const updatedShipment = unwrapEnvelope(await response.json());
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
          [result.orderId]: result.shipment,
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
