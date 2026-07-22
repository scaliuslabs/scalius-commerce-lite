import { Badge } from "~/components/ui/badge";

export function CustomerOrderRetentionBadge() {
  return (
    <Badge
      variant="outline"
      aria-label="Order-linked customer; permanent deletion is unavailable"
      title="Order history must be retained"
      className="h-5 shrink-0 border-amber-300 px-1.5 text-[10px] font-medium text-amber-700 dark:border-amber-800 dark:text-amber-400"
    >
      Order-linked
    </Badge>
  );
}
