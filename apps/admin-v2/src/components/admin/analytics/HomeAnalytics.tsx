import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "@scalius/shared/utils";
import {
  analyticsPresetRange,
  analyticsToday,
  defaultAnalyticsGranularity,
  type AnalyticsPreset,
} from "@scalius/shared/analytics-period";
import { getStoreTimeZone } from "~/lib/store-time-zone";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { useCurrency } from "~/hooks/use-currency";
import { formatNumber, useMessages } from "~/i18n";
import { analyticsMessages } from "~/i18n/analytics";
import { analyticsOverviewQueryOptions } from "~/lib/api-query-options/analytics";
import { MetricTile } from "./MetricTile";
import { SalesTrendChart } from "./SalesTrendChart";
import { formatBucketLabel, formatPercent, formatRangeLabel } from "./analytics-format";

const HOME_PRESETS: AnalyticsPreset[] = ["today", "last_7_days", "last_30_days"];

/** Home's overview read for a preset: the same numbers the Analytics page shows. */
export function homeOverviewQuery(preset: AnalyticsPreset, today: string = analyticsToday(getStoreTimeZone())) {
  const range = analyticsPresetRange(preset, today);
  return analyticsOverviewQueryOptions({
    ...range,
    comparison: "previous_period",
    granularity: defaultAnalyticsGranularity(range),
  });
}

/**
 * Home's sales strip (Shopify's Home): total sales, orders, average order
 * value and the COD return-to-sender rate for today, 7 or 30 days against
 * the period before, the total-sales trend, and the way into Analytics.
 */
export function HomeAnalytics() {
  const t = useMessages(analyticsMessages);
  const { fmt } = useCurrency();
  const today = useMemo(() => analyticsToday(getStoreTimeZone()), []);
  const [preset, setPreset] = useState<AnalyticsPreset>("last_30_days");
  const overview = useQuery(homeOverviewQuery(preset, today));
  const data = overview.data;
  const compared = "previous_period" as const;

  return (
    <section className="space-y-3" aria-label={t("analytics")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label={t("dateRange")}>
          {HOME_PRESETS.map((key) => (
            <Button key={key} size="sm" variant={preset === key ? "secondary" : "ghost"} aria-pressed={preset === key} onClick={() => setPreset(key)}>
              {t(`preset.${key}`)}
            </Button>
          ))}
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/admin/analytics">{t("viewAnalytics")}</Link>
        </Button>
      </div>
      {!data ? (
        overview.isError ? (
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
              <p className="text-body">{t("loadFailed")}</p>
              <Button variant="outline" size="sm" onClick={() => void overview.refetch()}>{t("retry")}</Button>
            </CardHeader>
          </Card>
        ) : (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {["a", "b", "c", "d"].map((key) => <Skeleton key={key} className="h-28" />)}
          </div>
        )
      ) : (
        <div className={cn("space-y-3", overview.isFetching && "opacity-70")} aria-busy={overview.isFetching}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricTile
              label={t("kpi.totalSales")}
              value={fmt(data.current.totals.totalSales)}
              help={t("help.totalSales")}
              current={data.current.totals.totalSales}
              previous={data.previous?.totals.totalSales ?? null}
              comparedTo={compared}
            />
            <MetricTile
              label={t("kpi.orders")}
              value={formatNumber(data.current.totals.orders)}
              help={t("help.orders")}
              current={data.current.totals.orders}
              previous={data.previous?.totals.orders ?? null}
              comparedTo={compared}
            />
            <MetricTile
              label={t("kpi.averageOrderValue")}
              value={fmt(data.current.totals.averageOrderValue)}
              help={t("help.averageOrderValue")}
              current={data.current.totals.averageOrderValue}
              previous={data.previous?.totals.averageOrderValue ?? null}
              comparedTo={compared}
            />
            <MetricTile
              label={t("kpi.rtsRate")}
              value={formatPercent(data.current.payments.rtsRate)}
              help={t("help.rtsRate")}
              current={data.current.payments.rtsRate}
              previous={data.previous?.payments.rtsRate ?? null}
              comparedTo={compared}
              change="points"
              upIsGood={false}
            />
          </div>
          {data.series.length > 1 ? (
            <Card>
              <CardHeader className="space-y-1">
                <CardTitle>{t("salesOverTime")}</CardTitle>
                <p className="text-body text-muted-foreground">{t("help.totalSales")}</p>
              </CardHeader>
              <CardContent>
                {data.series.some((point) => point.current.orders > 0) ? (
                  <SalesTrendChart
                    points={data.series.map((point) => ({
                      key: point.key,
                      label: formatBucketLabel(point.key, data.granularity),
                      current: point.current.totalSales,
                      previous: point.previous?.totalSales ?? null,
                      previousLabel: point.previousKey ? formatBucketLabel(point.previousKey, data.granularity, true) : null,
                    }))}
                    format={fmt}
                    label={`${t("kpi.totalSales")}, ${formatRangeLabel(data.current.range)}`}
                    currentName={formatRangeLabel(data.current.range)}
                    previousName={data.previous ? formatRangeLabel(data.previous.range) : null}
                  />
                ) : (
                  <p className="py-8 text-center text-body text-muted-foreground">{t("chartEmpty")}</p>
                )}
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}
    </section>
  );
}
