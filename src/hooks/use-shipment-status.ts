import { useState } from "react";
import { toast } from "sonner";

/**
 * Clean an orderId to remove any path-like prefixes
 */
function cleanOrderId(orderId: string): string {
  // Remove any URL path segments that might be present in the orderId
  // This might happen if the orderId is extracted from a URL
  if (orderId.includes("/")) {
    const parts = orderId.split("/");
    orderId = parts[parts.length - 1]; // Get the last segment
  }

  // Also explicitly remove "orders/" prefix if present
  orderId = orderId.replace(/^orders\//, "");

  return orderId;
}

/**
 * Custom hook for refreshing shipment status
 */
export function useShipmentStatus() {
  const [isRefreshing, setIsRefreshing] = useState<Record<string, boolean>>({});

  const refreshShipmentStatus = async (orderId: string, shipmentId: string) => {
    if (isRefreshing[shipmentId]) return;

    // Clean the orderId to ensure it doesn't contain path segments
    const cleanedOrderId = cleanOrderId(orderId);

    console.log(`Original orderId: ${orderId}`);
    console.log(`Cleaned orderId: ${cleanedOrderId}`);
    console.log(`shipmentId: ${shipmentId}`);
    console.log(
      `Request URL: /api/orders/${cleanedOrderId}/shipments/${shipmentId}/refresh`,
    );

    setIsRefreshing((prev) => ({ ...prev, [shipmentId]: true }));
    try {
      const response = await fetch(
        `/api/orders/${cleanedOrderId}/shipments/${shipmentId}/refresh`,
        {
          method: "POST",
        },
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to refresh status");
      }

      const updatedShipment = await response.json();
      console.log("Shipment refresh response:", updatedShipment);

      if (updatedShipment.statusChanged) {
        toast.success(`Status updated to: ${updatedShipment.status}`);

        // If the order status might have changed, reload the page
        if (
          ["delivered", "returned", "cancelled", "failed"].includes(
            updatedShipment.status,
          ) ||
          updatedShipment.orderStatusUpdate
        ) {
          setTimeout(() => window.location.reload(), 1500);
        }
      } else {
        toast.info("Shipment status is up to date");
      }

      return updatedShipment;
    } catch (error) {
      console.error("Error refreshing status:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to refresh status",
      );
      return null;
    } finally {
      setIsRefreshing((prev) => ({ ...prev, [shipmentId]: false }));
    }
  };

  return {
    isRefreshing,
    refreshShipmentStatus,
  };
}
