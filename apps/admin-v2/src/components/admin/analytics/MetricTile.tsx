import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { analyticsChange, type AnalyticsComparison } from "@scalius/shared/analytics-period";
import { cn } from "@scalius/shared/utils";
import { Card, CardHeader } from "~/components/ui/card";
import { formatNumber, useMessages } from "~/i18n";
import { analyticsMessages } from "~/i18n/analytics";
import { formatSignedPercent } from "./analytics-format";

export interface MetricTileProps {
  label: string;
  value: string;
  /** Raw numbers for the change; `previous` null (or no comparison) shows no change line. */
  current?: number | null;
  previous?: number | null;
  /**
   * The period the change is against. Each has its own whole phrase ("vs
   * previous period", "আগের সময়ের তুলনায়"): a period name is never glued
   * into another sentence, which reads wrong in Bangla.
   */
  comparedTo?: Exclude<AnalyticsComparison, "none"> | null;
  /** Rates change in percentage points; amounts and counts in percent. */
  change?: "relative" | "points";
  /** Whether a rise is good news (sales) or bad news (cancellations). */
  upIsGood?: boolean;
  help?: string;
}

/**
 * A stat tile: label, the value (proportional figures at display size), and
 * the signed change against a named period. The direction is an arrow and
 * words, colour only reinforces whether it is good news.
 */
export function MetricTile({ label, value, current, previous, comparedTo, change = "relative", upIsGood = true, help }: MetricTileProps) {
  const t = useMessages(analyticsMessages);
  let delta: number | null = null;
  if (comparedTo && typeof current === "number" && typeof previous === "number") {
    delta = change === "points" ? current - previous : analyticsChange(current, previous);
  }
  const words = delta === null
    ? null
    : change === "points"
      ? t("points", { value: formatNumber(Math.abs(delta), { maximumFractionDigits: 1 }) })
      : formatSignedPercent(delta);
  const flat = delta !== null && Math.abs(delta) < 0.05;
  const good = delta !== null && !flat && (delta > 0) === upIsGood;
  const Icon = flat ? Minus : delta !== null && delta > 0 ? ArrowUpRight : ArrowDownRight;

  return (
    <Card>
      <CardHeader className="space-y-1">
        <p className="text-body text-muted-foreground" title={help}>{label}</p>
        <p className="text-heading-lg font-semibold wrap-anywhere sm:text-heading-xl">{value}</p>
        {comparedTo && words !== null ? (
          <p className="flex flex-wrap items-center gap-x-1 text-body">
            <span
              className={cn(
                "flex shrink-0 items-center gap-0.5",
                flat ? "text-muted-foreground" : good ? "text-success" : "text-critical",
              )}
            >
              <Icon className="size-4" aria-hidden />
              <span className="sr-only">{flat ? t("changeNone") : delta! > 0 ? t("changeUp", { change: words }) : t("changeDown", { change: words })}</span>
              <span aria-hidden>{words}</span>
            </span>
            <span className="text-muted-foreground">{t(`vs.${comparedTo}`)}</span>
          </p>
        ) : comparedTo ? (
          <p className="text-body text-muted-foreground">{t("noBaseline")}</p>
        ) : null}
      </CardHeader>
    </Card>
  );
}
