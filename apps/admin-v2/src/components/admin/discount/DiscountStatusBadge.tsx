import { Badge } from "~/components/ui/badge";
import { Clock } from "lucide-react";
import { cn } from "@scalius/shared/utils";

import type { DiscountLifecycle } from "./discount-list-model";

const statusLabels: Record<DiscountLifecycle, string> = {
  active: "Active",
  inactive: "Inactive",
  scheduled: "Scheduled",
  exhausted: "Limit reached",
  expired: "Expired",
  deleted: "Deleted",
};

export function DiscountStatusBadge({ status }: { status: DiscountLifecycle }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium",
        status === "active" &&
          "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
        status === "scheduled" &&
          "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
        status === "exhausted" &&
          "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300",
        (status === "inactive" || status === "expired" || status === "deleted") &&
          "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      {status === "scheduled" ? <Clock className="mr-1 h-3 w-3" aria-hidden="true" /> : null}
      {statusLabels[status]}
    </Badge>
  );
}
