import { extractApiError, unwrapEnvelope } from "@/lib/api-helpers";

type ShipmentResult = {
  success: boolean;
  data?: Record<string, unknown>;
  message?: string;
};

type ShipmentActions = {
  createShipment(
    orderId: string,
    providerId: string,
    options?: Record<string, unknown>
  ): Promise<ShipmentResult>;
  checkShipmentStatus(shipmentId: string): Promise<ShipmentResult>;
  deleteShipment(shipmentId: string): Promise<boolean>;
};

type ShipmentWindow = Window & {
  shipmentActions?: ShipmentActions;
};

function cleanOrderId(orderId: string): string {
  // Remove any URL path segments that might be present
  if (orderId.includes("/")) {
    const parts = orderId.split("/");
    orderId = parts[parts.length - 1]; // Get the last segment
  }

  // Also explicitly remove "orders/" prefix if present
  return orderId.replace(/^orders[\\/]/, "");
}

export function initShipmentActions(): void {
  const win = window as ShipmentWindow;

  win.shipmentActions = {
    async createShipment(orderId, providerId, options = {}) {
      // Ensure clean orderId
      orderId = cleanOrderId(orderId);

      try {
        const response = await fetch(`/api/v1/admin/orders/${orderId}/shipments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerId, options }),
        });

        const result = await response.json();

        if (!response.ok) {
          throw new Error(
            extractApiError(result, "Failed to create shipment")
          );
        }

        return { success: true, data: unwrapEnvelope(result) };
      } catch (error: unknown) {
        console.error("Error creating shipment:", error);
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async checkShipmentStatus(shipmentId) {
      try {
        // Get the current path and extract orderId more robustly
        const pathParts = window.location.pathname.split("/");
        const ordersIndex = pathParts.indexOf("orders");
        let orderId = "";

        // Get the part after "orders/" in the path
        if (ordersIndex !== -1 && ordersIndex + 1 < pathParts.length) {
          orderId = pathParts[ordersIndex + 1];
        } else {
          // Fallback: try to get from the last non-empty segment
          for (let i = pathParts.length - 1; i >= 0; i--) {
            if (pathParts[i].trim() !== "") {
              orderId = pathParts[i];
              break;
            }
          }
        }

        // Clean the orderId to be safe
        orderId = cleanOrderId(orderId);

        const response = await fetch(
          `/api/v1/admin/orders/${orderId}/shipments/${shipmentId}/refresh`,
          {
            method: "POST",
          }
        );

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(
            extractApiError(errorData, "Failed to check shipment status")
          );
        }

        const json = await response.json();
        const result = unwrapEnvelope<Record<string, unknown>>(json);

        return {
          success: true,
          data: {
            status: result.status,
            rawStatus: result.rawStatus,
            lastChecked: result.lastChecked,
            statusChanged: result.statusChanged,
            orderStatusUpdate: result.orderStatusUpdate,
            metadata: result.metadata ? JSON.parse(result.metadata as string) : {},
          },
        };
      } catch (error: unknown) {
        console.error("Error checking shipment status:", error);
        return {
          success: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async deleteShipment(shipmentId) {
      try {
        const response = await fetch(`/api/v1/admin/shipments/${shipmentId}`, {
          method: "DELETE",
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(extractApiError(errorData, "Failed to delete shipment"));
        }

        return true;
      } catch (error: unknown) {
        console.error("Error deleting shipment:", error);
        throw error;
      }
    },
  };
}
