import { Badge } from "@/components/ui/badge";
import { cn } from "@scalius/shared/utils";

// ──── Status color configs ────────────────────────────────────────

interface StatusConfig {
  label: string;
  className: string;
}

// ──── Order Status ────────────────────────────────────────────────
// Note: OrderStatusSelector (the dropdown in the order table) has its own
// rich styling with dots, borders, and hover states. This badge is for
// simpler read-only display contexts.

const ORDER_STATUS: Record<string, StatusConfig> = {
  PENDING: {
    label: "Pending",
    className:
      "bg-amber-50 text-amber-700 border-amber-200/50 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800/50",
  },
  CONFIRMED: {
    label: "Confirmed",
    className:
      "bg-indigo-50 text-indigo-700 border-indigo-200/50 dark:bg-indigo-900/30 dark:text-indigo-400 dark:border-indigo-800/50",
  },
  PROCESSING: {
    label: "Processing",
    className:
      "bg-blue-50 text-blue-700 border-blue-200/50 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800/50",
  },
  SHIPPED: {
    label: "Shipped",
    className:
      "bg-violet-50 text-violet-700 border-violet-200/50 dark:bg-violet-900/30 dark:text-violet-400 dark:border-violet-800/50",
  },
  DELIVERED: {
    label: "Delivered",
    className:
      "bg-emerald-50 text-emerald-700 border-emerald-200/50 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800/50",
  },
  COMPLETED: {
    label: "Completed",
    className:
      "bg-teal-50 text-teal-700 border-teal-200/50 dark:bg-teal-900/30 dark:text-teal-400 dark:border-teal-800/50",
  },
  CANCELLED: {
    label: "Cancelled",
    className:
      "bg-red-50 text-red-700 border-red-200/50 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800/50",
  },
  RETURNED: {
    label: "Returned",
    className:
      "bg-rose-50 text-rose-700 border-rose-200/50 dark:bg-rose-900/30 dark:text-rose-400 dark:border-rose-800/50",
  },
  REFUNDED: {
    label: "Refunded",
    className:
      "bg-orange-50 text-orange-700 border-orange-200/50 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800/50",
  },
  PARTIALLY_REFUNDED: {
    label: "Partially Refunded",
    className:
      "bg-amber-50 text-amber-700 border-amber-200/50 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800/50",
  },
  INCOMPLETE: {
    label: "Incomplete",
    className:
      "bg-slate-50 text-slate-700 border-slate-200/50 dark:bg-slate-900/30 dark:text-slate-400 dark:border-slate-800/50",
  },
  ON_HOLD: {
    label: "On Hold",
    className:
      "bg-gray-50 text-gray-700 border-gray-200/50 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700/50",
  },
};

// ──── Payment Status ──────────────────────────────────────────────

const PAYMENT_STATUS: Record<string, StatusConfig> = {
  paid: {
    label: "Paid",
    className:
      "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  },
  partial: {
    label: "Partial",
    className:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  },
  unpaid: {
    label: "Unpaid",
    className:
      "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  },
  refunded: {
    label: "Refunded",
    className:
      "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  },
  failed: {
    label: "Failed",
    className:
      "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  },
};

// ──── Shipment Status ─────────────────────────────────────────────

const SHIPMENT_STATUS: Record<string, StatusConfig> = {
  PENDING: {
    label: "Pending",
    className: "bg-amber-100 text-amber-800",
  },
  ON_HOLD: {
    label: "On Hold",
    className: "bg-amber-100 text-amber-800",
  },
  PICKED_UP: {
    label: "Picked Up",
    className: "bg-blue-100 text-blue-800",
  },
  IN_TRANSIT: {
    label: "In Transit",
    className: "bg-blue-100 text-blue-800",
  },
  IN_REVIEW: {
    label: "In Review",
    className: "bg-blue-100 text-blue-800",
  },
  PROCESSING: {
    label: "Processing",
    className: "bg-blue-100 text-blue-800",
  },
  DELIVERED: {
    label: "Delivered",
    className: "bg-green-100 text-green-800",
  },
  COMPLETED: {
    label: "Completed",
    className: "bg-green-100 text-green-800",
  },
  FAILED: {
    label: "Failed",
    className: "bg-red-100 text-red-800",
  },
  ERROR: {
    label: "Error",
    className: "bg-red-100 text-red-800",
  },
  CANCELLED: {
    label: "Cancelled",
    className: "bg-gray-100 text-gray-800",
  },
  RETURNED: {
    label: "Returned",
    className: "bg-purple-100 text-purple-800",
  },
  RETURNED_APPROVAL_PENDING: {
    label: "Returned",
    className: "bg-purple-100 text-purple-800",
  },
  PARTIAL_DELIVERED_APPROVAL_PENDING: {
    label: "Partially Delivered",
    className: "bg-purple-100 text-purple-800",
  },
  UNKNOWN: {
    label: "Unknown",
    className: "bg-gray-100 text-gray-800",
  },
};

// ──── Helpers ─────────────────────────────────────────────────────

/** Format a raw status string into a human-readable label */
function formatStatusLabel(status: string): string {
  return status
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

// ──── Components ──────────────────────────────────────────────────

export function OrderStatusBadge({ status }: { status: string }) {
  const key = status.toUpperCase();
  const config = ORDER_STATUS[key];
  const label = config?.label ?? formatStatusLabel(status);
  const className =
    config?.className ??
    "bg-gray-50 text-gray-700 border-gray-200/50 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700/50";

  return (
    <Badge
      variant="outline"
      className={cn("text-[10px] px-1.5 py-0 font-medium", className)}
    >
      {label}
    </Badge>
  );
}

export function PaymentStatusBadge({ status }: { status: string }) {
  const config = PAYMENT_STATUS[status];
  if (!config) return null;

  return (
    <Badge
      variant="secondary"
      className={cn("text-[10px] px-1.5 py-0", config.className)}
    >
      {config.label}
    </Badge>
  );
}

export function ShipmentStatusBadge({ status }: { status: string }) {
  const key = status.toUpperCase();
  const config = SHIPMENT_STATUS[key];
  const label = config?.label ?? (formatStatusLabel(status) || "Unknown");
  const className = config?.className ?? "bg-gray-100 text-gray-800";

  return (
    <span
      className={cn(
        "px-2 py-1 text-xs font-medium rounded-full",
        className,
      )}
    >
      {label}
    </span>
  );
}
