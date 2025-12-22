import { type FC } from "react";
import { useShipmentStatus } from "@/hooks/use-shipment-status";
import { History, RefreshCw } from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

interface ShipmentStatusIndicatorProps {
  shipment: {
    id: string;
    status: string;
    lastChecked?: string;
    orderId: string;
  };
  onStatusUpdated?: (updatedShipment: any) => void;
}

export const ShipmentStatusIndicator: FC<ShipmentStatusIndicatorProps> = ({
  shipment,
  onStatusUpdated,
}) => {
  const { isRefreshing, refreshShipmentStatus } = useShipmentStatus();

  // Calculate relative time for last checked
  const getRelativeTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffInSeconds < 60) {
      return `${diffInSeconds} sec${diffInSeconds !== 1 ? "s" : ""} ago`;
    }

    const diffInMinutes = Math.floor(diffInSeconds / 60);
    if (diffInMinutes < 60) {
      return `${diffInMinutes} min${diffInMinutes !== 1 ? "s" : ""} ago`;
    }

    const diffInHours = Math.floor(diffInMinutes / 60);
    if (diffInHours < 24) {
      return `${diffInHours} hour${diffInHours !== 1 ? "s" : ""} ago`;
    }

    const diffInDays = Math.floor(diffInHours / 24);
    return `${diffInDays} day${diffInDays !== 1 ? "s" : ""} ago`;
  };

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

    console.log(
      `Attempting to refresh shipment status with orderId: ${shipment.orderId}, shipmentId: ${shipment.id}`,
    );

    const updatedShipment = await refreshShipmentStatus(
      shipment.orderId,
      shipment.id,
    );

    if (updatedShipment && onStatusUpdated) {
      onStatusUpdated(updatedShipment);
    }
  };

  // Format the status for display
  const formatStatus = (status: string) => {
    return status
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  };

  // Format the full date for tooltip
  const getFullDateForTooltip = (dateStr?: string) => {
    if (!dateStr) return "Never checked";

    try {
      const date = new Date(dateStr);
      return date.toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZoneName: "short",
      });
    } catch (error) {
      return "Invalid date";
    }
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

      <div className="flex items-center justify-between text-xs">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-help">
              <History className="h-3 w-3 mr-1" />
              {shipment.lastChecked
                ? getRelativeTime(shipment.lastChecked)
                : "Never checked"}
            </div>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            className="text-xs p-2 bg-[var(--popover)] text-[var(--popover-foreground)] border border-[var(--border)]"
          >
            {getFullDateForTooltip(shipment.lastChecked)}
          </TooltipContent>
        </Tooltip>

        <Button
          onClick={handleRefresh}
          disabled={isRefreshing[shipment.id]}
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 hover:bg-[var(--muted)]"
          title="Refresh shipment status"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${isRefreshing[shipment.id] ? "animate-spin" : ""}`}
          />
        </Button>
      </div>
    </div>
  );
};

export default ShipmentStatusIndicator;
