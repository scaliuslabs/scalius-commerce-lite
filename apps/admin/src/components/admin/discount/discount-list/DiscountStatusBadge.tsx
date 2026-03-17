import React from "react";
import { Badge } from "../../../ui/badge";
import { Button } from "../../../ui/button";
import { Clock } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import type { DiscountItem } from "./hooks/useDiscountListFilters";

interface DiscountStatusBadgeProps {
  discount: DiscountItem;
  showTrashed: boolean;
  onToggleStatus: (id: string, currentStatus: boolean) => void;
}

export const DiscountStatusBadge = React.memo(function DiscountStatusBadge({
  discount,
  showTrashed,
  onToggleStatus,
}: DiscountStatusBadgeProps) {
  if (showTrashed) {
    return (
      <Badge
        variant="outline"
        className="text-muted-foreground text-xs font-medium px-2 py-0.5 rounded-full"
      >
        Deleted
      </Badge>
    );
  }

  const now = new Date();
  const startDate = discount.startDate ? new Date(discount.startDate) : null;
  const endDate = discount.endDate ? new Date(discount.endDate) : null;
  const isExpired = endDate ? endDate < now : false;
  const isScheduled = startDate ? startDate > now : false;

  if (isExpired) {
    return (
      <Badge
        variant="outline"
        className="text-xs font-medium px-2 py-0.5 rounded-full bg-gray-50 text-gray-500 border-gray-200 dark:bg-gray-900/30 dark:text-gray-400"
      >
        Expired
      </Badge>
    );
  }

  if (isScheduled && discount.isActive) {
    return (
      <Badge
        variant="outline"
        className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400"
      >
        <Clock className="h-3 w-3 mr-1" />
        Scheduled
      </Badge>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="p-0 h-auto hover:bg-transparent"
      onClick={() => onToggleStatus(discount.id, discount.isActive)}
    >
      <Badge
        variant={discount.isActive ? "default" : "outline"}
        className={cn(
          discount.isActive
            ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-700"
            : "text-muted-foreground",
          "text-xs font-medium px-2 py-0.5 rounded-full",
        )}
      >
        {discount.isActive ? "Active" : "Inactive"}
      </Badge>
    </Button>
  );
});
