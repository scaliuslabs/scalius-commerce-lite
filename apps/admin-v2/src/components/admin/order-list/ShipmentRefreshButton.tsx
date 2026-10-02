import { RefreshCw } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import { useShipmentStatus } from "~/hooks/use-shipment-status";
import { useMessages } from "~/i18n";
import { orderListMessages } from "~/i18n/order-list";

/**
 * The Delivery status cell's refresh: asks the courier for the parcel's latest
 * status. Disabled with its reason while the order is locked.
 */
export function ShipmentRefreshButton({ orderId, shipmentId, disabledReason, onUpdated }: {
  orderId: string;
  shipmentId: string;
  disabledReason?: string;
  onUpdated: () => void;
}) {
  const t = useMessages(orderListMessages);
  const { isRefreshing, refreshShipmentStatus } = useShipmentStatus();
  const refreshing = isRefreshing[shipmentId] === true;
  const label = disabledReason ?? t("refreshShipment");
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      disabled={Boolean(disabledReason) || refreshing}
      onClick={async () => {
        if (refreshing) return;
        const updated = await refreshShipmentStatus(orderId, shipmentId);
        if (updated) onUpdated();
      }}
    >
      <RefreshCw className={cn(refreshing && "animate-spin")} />
    </Button>
  );
}
