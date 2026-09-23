import { type FC } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { useShipmentStatus } from "@/hooks/use-shipment-status";
import { useMessages } from "~/i18n";
import { orderListMessages, shipmentStatusLabel } from "~/i18n/order-list";
import { Button } from "../ui/button";
import { formatOrderTimestamp } from "./orderview/formatters";

interface ShipmentStatusIndicatorProps {
  shipment: {
    id: string;
    status: string;
    lastChecked?: string;
    orderId: string;
  };
  onStatusUpdated?: (updatedShipment: { id: string; orderId: string; status: string; lastChecked: string | null; [key: string]: unknown }) => void;
  canRefresh?: boolean;
  refreshDisabledReason?: string;
  showLastChecked?: boolean;
}

/** Courier delivery status with a refresh button and when it was last checked. */
export const ShipmentStatusIndicator: FC<ShipmentStatusIndicatorProps> = ({
  shipment,
  onStatusUpdated,
  canRefresh = true,
  refreshDisabledReason,
  showLastChecked = true,
}) => {
  const t = useMessages(orderListMessages);
  const { isRefreshing, refreshShipmentStatus } = useShipmentStatus();
  const refreshing = isRefreshing[shipment.id] === true;
  const showRefresh = canRefresh || Boolean(refreshDisabledReason);
  const refreshTitle = refreshDisabledReason ?? t("refreshShipment");
  const checkedAt = formatOrderTimestamp(shipment.lastChecked);

  const handleRefresh = async () => {
    if (refreshing) return;
    const updated = await refreshShipmentStatus(shipment.orderId, shipment.id);
    if (updated && onStatusUpdated) onStatusUpdated(updated);
  };

  return (
    <div className="flex items-start gap-1 text-body">
      <div className="min-w-0">
        <p className="truncate">{shipmentStatusLabel(t, shipment.status)}</p>
        {showLastChecked ? (
          <p className="text-body text-muted-foreground">
            {checkedAt ? t("lastChecked", { time: checkedAt }) : t("neverChecked")}
          </p>
        ) : null}
      </div>
      {showRefresh ? (
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          aria-label={refreshTitle}
          title={refreshTitle}
          onClick={handleRefresh}
          disabled={!canRefresh || refreshing}
        >
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
        </Button>
      ) : null}
    </div>
  );
};

export default ShipmentStatusIndicator;
