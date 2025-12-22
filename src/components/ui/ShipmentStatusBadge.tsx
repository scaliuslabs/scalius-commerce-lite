import { Badge } from "./badge";

export type ShipmentStatusType =
  | "pending"
  | "picked_up"
  | "in_transit"
  | "delivered"
  | "failed"
  | "cancelled"
  | "returned"
  | "unknown";

interface ShipmentStatusBadgeProps {
  status: string;
  className?: string;
}

export function ShipmentStatusBadge({
  status,
  className = "",
}: ShipmentStatusBadgeProps) {
  const baseClasses = "text-xs font-medium";

  switch (status.toLowerCase()) {
    case "pending":
      return (
        <Badge
          variant="secondary"
          className={`bg-amber-50 ${baseClasses} text-amber-700 ${className}`}
        >
          Pending
        </Badge>
      );
    case "picked_up":
      return (
        <Badge
          variant="secondary"
          className={`bg-indigo-50 ${baseClasses} text-indigo-700 ${className}`}
        >
          Picked Up
        </Badge>
      );
    case "in_transit":
      return (
        <Badge
          variant="secondary"
          className={`bg-blue-50 ${baseClasses} text-blue-700 ${className}`}
        >
          In Transit
        </Badge>
      );
    case "delivered":
      return (
        <Badge
          variant="secondary"
          className={`bg-emerald-50 ${baseClasses} text-emerald-700 ${className}`}
        >
          Delivered
        </Badge>
      );
    case "failed":
      return (
        <Badge
          variant="secondary"
          className={`bg-red-50 ${baseClasses} text-red-700 ${className}`}
        >
          Failed
        </Badge>
      );
    case "cancelled":
      return (
        <Badge
          variant="secondary"
          className={`bg-red-50 ${baseClasses} text-red-700 ${className}`}
        >
          Cancelled
        </Badge>
      );
    case "returned":
      return (
        <Badge
          variant="secondary"
          className={`bg-rose-50 ${baseClasses} text-rose-700 ${className}`}
        >
          Returned
        </Badge>
      );
    default:
      return (
        <Badge
          variant="secondary"
          className={`bg-gray-50 ${baseClasses} text-gray-700 ${className}`}
        >
          {status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()}
        </Badge>
      );
  }
}
