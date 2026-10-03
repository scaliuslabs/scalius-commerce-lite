import type { CSSProperties } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useMessages } from "~/i18n";
import { analyticsMessages } from "~/i18n/analytics";
import { formatPercent } from "./analytics-format";

export interface BreakdownRow {
  /** Unique within its card: one key (a channel) can have several rows (one per source). */
  key: string;
  name: string;
  /** A second line (a channel's source). */
  detail?: string | null;
  value: number;
  orders: number;
}

/**
 * One breakdown as ranked rows: the name, its value and share, and a thin
 * bar (one series, so no legend) whose length is the share of the largest
 * row. Values are text, never coloured; the bar only reinforces them.
 */
export function BreakdownCard({
  title,
  rows,
  format,
  reportId,
  search,
}: {
  title: string;
  rows: BreakdownRow[];
  format: (value: number) => string;
  reportId: string;
  search: Record<string, string | undefined>;
}) {
  const t = useMessages(analyticsMessages);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  const max = Math.max(0, ...rows.map((row) => row.value));
  return (
    <Card className="min-w-0">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>{title}</CardTitle>
        <Button variant="ghost" size="sm" asChild className="print:hidden">
          <Link to="/admin/analytics/reports/$reportId" params={{ reportId }} search={search as never}>
            {t("viewReport")}
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {rows.length === 0 || total === 0 ? (
          <p className="text-body text-muted-foreground">{t("breakdownEmpty")}</p>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
              <li key={row.key} className="space-y-1">
                <div className="flex items-baseline justify-between gap-3 text-body">
                  <span className="min-w-0 truncate">
                    {row.name}
                    {row.detail ? <span className="text-muted-foreground"> · {row.detail}</span> : null}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {format(row.value)}
                    <span className="ml-2 text-muted-foreground">{formatPercent((row.value / total) * 100, 0)}</span>
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-muted" aria-hidden>
                  <div
                    className="h-full w-(--share) rounded-full bg-chart-1"
                    style={{ "--share": `${max > 0 ? Math.max(1, (row.value / max) * 100) : 0}%` } as CSSProperties}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
