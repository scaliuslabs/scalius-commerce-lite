import { Badge } from "~/components/ui/badge";

export function CustomerAccountBadge({ hasAccount }: { hasAccount: boolean }) {
  return (
    <Badge
      variant="outline"
      aria-label={`Buyer type: ${hasAccount ? "Account" : "Guest"}`}
      className={hasAccount
        ? "h-5 shrink-0 border-emerald-300 px-1.5 text-[10px] font-medium text-emerald-700 dark:border-emerald-800 dark:text-emerald-400"
        : "h-5 shrink-0 px-1.5 text-[10px] font-medium text-muted-foreground"}
    >
      {hasAccount ? "Account" : "Guest"}
    </Badge>
  );
}
