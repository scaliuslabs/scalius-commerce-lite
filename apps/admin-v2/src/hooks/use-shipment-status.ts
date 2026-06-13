import { useState } from "react";
import { toast } from "sonner";
import { useRouter } from "@tanstack/react-router";
import { refreshShipmentStatus } from "~/lib/api-functions/orders";

/**
 * Clean an orderId to remove any path-like prefixes
 */
function cleanOrderId(orderId: string): string {
  // Remove any URL path segments that might be present in the orderId
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
  const router = useRouter();
  const [isRefreshing, setIsRefreshing] = useState<Record<string, boolean>>({});

  const refreshStatus = async (orderId: string, shipmentId: string) => {
    if (isRefreshing[shipmentId]) return;

    // Clean the orderId to ensure it doesn't contain path segments
    const cleanedOrderId = cleanOrderId(orderId);

    setIsRefreshing((prev) => ({ ...prev, [shipmentId]: true }));
    try {
      const updatedShipment = await refreshShipmentStatus({
        data: { orderId: cleanedOrderId, shipmentId },
      });

      if (updatedShipment.statusChanged) {
        toast.success(`Status updated to: ${updatedShipment.status}`);

        // If the order status might have changed, reload the page
        if (
          ["delivered", "returned", "cancelled", "failed"].includes(
            updatedShipment.status as string,
          ) ||
          updatedShipment.orderStatusUpdate
        ) {
          router.invalidate();
        }
      } else {
        toast.info("Shipment status is up to date");
      }

      return updatedShipment;
    } catch (error: unknown) {
      if (import.meta.env.DEV) console.error("Error refreshing status:", error);
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
    refreshShipmentStatus: refreshStatus,
  };
}
