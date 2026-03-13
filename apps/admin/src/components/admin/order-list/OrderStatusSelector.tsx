import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { LoaderCircle, ChevronDown } from "lucide-react";

interface OrderStatusSelectorProps {
  status: string;
  orderId: string;
  isLoading: boolean;
  showTrashed: boolean;
  onStatusUpdate: (orderId: string, newStatus: string) => void;
}

const orderStatuses = [
  "Pending",
  "Processing",
  "Confirmed",
  "Shipped",
  "Delivered",
  "Cancelled",
  "Returned",
];

export function OrderStatusSelector({
  status,
  orderId,
  isLoading,
  showTrashed,
  onStatusUpdate,
}: OrderStatusSelectorProps) {
  const baseClasses =
    "text-xs font-medium transition-all border px-2.5 py-1 shadow-sm rounded-full";
  const hoverClasses = "hover:shadow-md hover:-translate-y-px";
  let variantClasses = "";
  let iconColor = "";
  let dotColor = "";

  switch (status.toLowerCase()) {
    case "pending":
      variantClasses =
        "bg-amber-50 text-amber-700 border-amber-200/50 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800/50 hover:bg-amber-100";
      iconColor = "text-amber-500 dark:text-amber-400";
      dotColor = "bg-amber-500 dark:bg-amber-400";
      break;
    case "processing":
      variantClasses =
        "bg-blue-50 text-blue-700 border-blue-200/50 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800/50 hover:bg-blue-100";
      iconColor = "text-blue-500 dark:text-blue-400";
      dotColor = "bg-blue-500 dark:bg-blue-400";
      break;
    case "confirmed":
      variantClasses =
        "bg-indigo-50 text-indigo-700 border-indigo-200/50 dark:bg-indigo-900/30 dark:text-indigo-400 dark:border-indigo-800/50 hover:bg-indigo-100";
      iconColor = "text-indigo-500 dark:text-indigo-400";
      dotColor = "bg-indigo-500 dark:bg-indigo-400";
      break;
    case "shipped":
      variantClasses =
        "bg-violet-50 text-violet-700 border-violet-200/50 dark:bg-violet-900/30 dark:text-violet-400 dark:border-violet-800/50 hover:bg-violet-100";
      iconColor = "text-violet-500 dark:text-violet-400";
      dotColor = "bg-violet-500 dark:bg-violet-400";
      break;
    case "delivered":
      variantClasses =
        "bg-emerald-50 text-emerald-700 border-emerald-200/50 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800/50 hover:bg-emerald-100";
      iconColor = "text-emerald-500 dark:text-emerald-400";
      dotColor = "bg-emerald-500 dark:bg-emerald-400";
      break;
    case "cancelled":
      variantClasses =
        "bg-red-50 text-red-700 border-red-200/50 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800/50 hover:bg-red-100";
      iconColor = "text-red-500 dark:text-red-400";
      dotColor = "bg-red-500 dark:bg-red-400";
      break;
    case "returned":
      variantClasses =
        "bg-rose-50 text-rose-700 border-rose-200/50 dark:bg-rose-900/30 dark:text-rose-400 dark:border-rose-800/50 hover:bg-rose-100";
      iconColor = "text-rose-500 dark:text-rose-400";
      dotColor = "bg-rose-500 dark:bg-rose-400";
      break;
    default:
      variantClasses =
        "bg-gray-50 text-gray-700 border-gray-200/50 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700/50 hover:bg-gray-100";
      iconColor = "text-gray-500 dark:text-gray-400";
      dotColor = "bg-gray-500 dark:bg-gray-400";
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={isLoading || showTrashed}>
        <button
          type="button"
          className={`inline-flex items-center ${baseClasses} ${variantClasses} ${!showTrashed ? hoverClasses + " cursor-pointer group" : "cursor-default"} ${isLoading ? "opacity-75 animate-pulse" : ""}`}
          aria-label={`Current status: ${status}. Click to change status.`}
        >
          {isLoading ? (
            <LoaderCircle
              className={`animate-spin mr-1.5 h-3 w-3 ${iconColor}`}
            />
          ) : (
            <span
              className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${dotColor}`}
            ></span>
          )}
          {status}
          {!showTrashed && !isLoading && (
            <ChevronDown className="ml-1 h-3 w-3 opacity-70 group-hover:opacity-100 transition-opacity" />
          )}
        </button>
      </DropdownMenuTrigger>
      {!showTrashed && (
        <DropdownMenuContent align="start" className="w-40">
          <DropdownMenuRadioGroup
            value={status}
            onValueChange={(newStatus) => onStatusUpdate(orderId, newStatus)}
          >
            {orderStatuses.map((s) => (
              <DropdownMenuRadioItem
                key={s}
                value={s}
                className="text-xs cursor-pointer hover:bg-[var(--muted)]"
              >
                {s}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}