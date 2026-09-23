import { useState } from "react";
import { toast } from "sonner";
import { useRouter } from "@tanstack/react-router";
import { postApiV1AdminOrdersByIdShipmentsByShipmentIdRefresh } from "@scalius/api-client/sdk";
import { apiData } from "~/lib/api";
import { useMessages } from "~/i18n";
import { orderListMessages, shipmentStatusLabel } from "~/i18n/order-list";

/** Asks the courier for the latest delivery status of one shipment. */
export function useShipmentStatus() {
  const t = useMessages(orderListMessages);
  const router = useRouter();
  const [isRefreshing, setIsRefreshing] = useState<Record<string, boolean>>({});

  const refreshShipmentStatus = async (orderId: string, shipmentId: string) => {
    if (isRefreshing[shipmentId]) return;
    setIsRefreshing((prev) => ({ ...prev, [shipmentId]: true }));
    try {
      const updated = await apiData(postApiV1AdminOrdersByIdShipmentsByShipmentIdRefresh({
        path: { id: orderId, shipmentId },
      }));
      if (updated.statusChanged) {
        toast.success(t("shipmentUpdated", { status: shipmentStatusLabel(t, String(updated.status)) }));
        if (
          ["delivered", "returned", "cancelled", "failed"].includes(String(updated.status))
          || updated.orderStatusUpdate
        ) {
          void router.invalidate();
        }
      } else {
        toast.info(t("shipmentUpToDate"));
      }
      return updated;
    } catch (error: unknown) {
      toast.error(t("shipmentRefreshFailed"), {
        description: error instanceof Error && error.message ? error.message : undefined,
      });
      return null;
    } finally {
      setIsRefreshing((prev) => ({ ...prev, [shipmentId]: false }));
    }
  };

  return { isRefreshing, refreshShipmentStatus };
}
