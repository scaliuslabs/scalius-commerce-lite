import { Badge } from "~/components/ui/badge";
import type { PromotionAggregate } from "~/lib/api-functions/promotions";

export function getPromotionOperationalStatus(
  promotion: PromotionAggregate,
  nowEpochSeconds = Math.floor(Date.now() / 1_000),
): { label: string; tone: "neutral" | "success" | "warning" } {
  if (promotion.status === "archived") return { label: "Archived", tone: "neutral" };
  if (promotion.status === "paused") return { label: "Paused", tone: "warning" };
  if (promotion.status === "draft") return { label: "Draft", tone: "neutral" };
  if (
    promotion.startsAtEpochSeconds !== null
    && promotion.startsAtEpochSeconds > nowEpochSeconds
  ) {
    return { label: "Scheduled", tone: "warning" };
  }
  if (
    promotion.endsAtEpochSeconds !== null
    && promotion.endsAtEpochSeconds <= nowEpochSeconds
  ) {
    return { label: "Ended", tone: "neutral" };
  }
  return { label: "Active", tone: "success" };
}

export function PromotionStatusBadge({ promotion }: { promotion: PromotionAggregate }) {
  const status = getPromotionOperationalStatus(promotion);
  return (
    <Badge
      variant="outline"
      className={
        status.tone === "success"
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : status.tone === "warning"
            ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
            : "bg-muted/70 text-muted-foreground"
      }
    >
      <span
        aria-hidden="true"
        className={
          status.tone === "success"
            ? "mr-1.5 size-1.5 rounded-full bg-emerald-500"
            : status.tone === "warning"
              ? "mr-1.5 size-1.5 rounded-full bg-amber-500"
              : "mr-1.5 size-1.5 rounded-full bg-muted-foreground/60"
        }
      />
      {status.label}
    </Badge>
  );
}
