import { type FC } from "react";
import { useShipmentStatus } from "@/hooks/use-shipment-status";
import { History, RefreshCw } from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
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

export const ShipmentStatusIndicator: FC<ShipmentStatusIndicatorProps> = ({
  shipment,
  onStatusUpdated,
  canRefresh = true,
  refreshDisabledReason,
  showLastChecked = true,
}) => {
  const { isRefreshing, refreshShipmentStatus } = useShipmentStatus();
  const showRefreshControl = canRefresh || Boolean(refreshDisabledReason);
  const refreshTitle = refreshDisabledReason ?? "Refresh shipment status";

  // Get status color based on status
  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case "delivered":
        return "bg-emerald-500";
      case "in_transit":
      case "picked_up":
        return "bg-blue-500";
      case "pending":
      case "in_review":
        return "bg-amber-500";
      case "cancelled":
      case "failed":
      case "returned":
        return "bg-red-500";
      default:
        return "bg-gray-500";
    }
  };

  // Handle refresh status
  const handleRefresh = async () => {
    if (isRefreshing[shipment.id]) return;

    const updatedShipment = await refreshShipmentStatus(
      shipment.orderId, shipment.id,
    );

    if (updatedShipment && onStatusUpdated) {
      onStatusUpdated(updatedShipment as { id: string; orderId: string; status: string; lastChecked: string | null; [key: string]: unknown });
    }
  };

  // Format the status for display
  const formatStatus = (status: string) => {
    return status
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  };

  const getLastCheckedLabel = (dateStr?: string) => {
    if (!dateStr) return "Never checked";
    return formatOrderTimestamp(dateStr) ?? "Never checked";
  };

  return (
    <div className="flex flex-col space-y-1.5">
      <div className="flex items-center space-x-2">
        <span
          className={`w-3 h-3 rounded-full ${getStatusColor(shipment.status)}`}
        ></span>
        <span className="font-medium text-[var(--foreground)]">
          {formatStatus(shipment.status)}
        </span>
      </div>

      {(showLastChecked || showRefreshControl) && (
        <div className="flex items-center justify-between text-xs">
          {showLastChecked ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex cursor-help items-center text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                  <History className="mr-1 h-3 w-3" />
                  {getLastCheckedLabel(shipment.lastChecked)}
                </div>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                className="border border-[var(--border)] bg-[var(--popover)] p-2 text-xs text-[var(--popover-foreground)]"
              >
                {getLastCheckedLabel(shipment.lastChecked)}
              </TooltipContent>
            </Tooltip>
          ) : <span />}

          {showRefreshControl && (
            <span title={refreshTitle}>
              <Button
                aria-label={refreshTitle}
                onClick={handleRefresh}
                disabled={!canRefresh || isRefreshing[shipment.id]}
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 hover:bg-[var(--muted)]"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${isRefreshing[shipment.id] ? "animate-spin" : ""}`}
                />
              </Button>
            </span>
          )}
        </div>
      )}
    </div>
  );
};

export default ShipmentStatusIndicator;
