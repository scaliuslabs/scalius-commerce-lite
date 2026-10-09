import { ErrorState } from "~/components/admin/states/ErrorState";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileBarChart, Info, Printer } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { analyticsChange, type AnalyticsGranularity } from "@scalius/shared/analytics-period";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { EmptyState } from "~/components/admin/resource/EmptyState";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { useCurrency } from "~/hooks/use-currency";
import { formatNumber, useMessages } from "~/i18n";
import { analyticsMessages, type AnalyticsMessageKey } from "~/i18n/analytics";
import { analyticsOverviewQueryOptions, type AnalyticsOverview as OverviewData } from "~/lib/api-query-options/analytics";
import { appPaymentMethodFallbackName } from "~/lib/app-payment-method";
import { AnalyticsToolbar } from "./AnalyticsToolbar";
import { BreakdownCard, type BreakdownRow } from "./BreakdownCard";
import { MetricTile } from "./MetricTile";
import { SalesTrendChart, type TrendPoint } from "./SalesTrendChart";
import { formatBucketLabel, formatPercent, formatRangeLabel, formatSignedPercent } from "./analytics-format";
import type { AnalyticsSearch, AnalyticsSelection } from "./analytics-selection";

type Period = OverviewData["current"];
type SeriesMeasures = OverviewData["series"][number]["current"];
type ChartMetric = "totalSales" | "netSales" | "orders" | "averageOrderValue";
const CHART_METRICS: ChartMetric[] = ["totalSales", "netSales", "orders", "averageOrderValue"];

function metricOf(measures: SeriesMeasures, metric: ChartMetric): number {
  if (metric === "averageOrderValue") return measures.orders > 0 ? (measures.grossSales - measures.discounts) / measures.orders : 0;
  return measures[metric];
}

export function AnalyticsOverview({
  selection,
  today,
  granularity,
  onChange,
}: {
  selection: AnalyticsSelection;
  today: string;
  granularity: AnalyticsGranularity;
  onChange: (patch: Partial<AnalyticsSelection>) => void;
}) {
  const t = useMessages(analyticsMessages);
  const { fmt } = useCurrency();
  const [metric, setMetric] = useState<ChartMetric>("totalSales");
  const overview = useQuery(analyticsOverviewQueryOptions({
    from: selection.from,
    to: selection.to,
    comparison: selection.comparison,
    granularity,
  }));
  const reportSearch: AnalyticsSearch = { from: selection.from, to: selection.to };

  const header = (
    <PageHeader
      title={t("analytics")}
      actions={(
        <>
          <Button variant="outline" size="sm" onClick={() => window.print()} className="print:hidden">
            <Printer className="size-4" aria-hidden />
            {t("print")}
          </Button>
          <Button size="sm" asChild className="print:hidden">
            <Link to="/admin/analytics/reports">
              <FileBarChart className="size-4" aria-hidden />
              {t("reports")}
            </Link>
          </Button>
        </>
      )}
    />
  );
  const toolbar = (
    <>
      <AnalyticsToolbar
        selection={selection}
        today={today}
        granularity={granularity}
        showGranularity
        onChange={onChange}
      />
      {/* The toolbar doesn't print: the printed page still says which days it covers. */}
      <p className="hidden text-body text-muted-foreground print:block">
        {formatRangeLabel(selection)}
        {selection.comparison !== "none" ? ` · ${t(`comparison.${selection.comparison}`)}` : null}
      </p>
    </>
  );

  if (overview.isError && !overview.data) {
    return (
      <div className="space-y-4 pb-8">
        {header}
        {toolbar}
        <Card>
          <CardContent className="pt-4">
<ErrorState layout="inline" title={t("loadFailed")} error={overview.error} onRetry={() => void overview.refetch()} />
</CardContent>
        </Card>
      </div>
    );
  }

  const data = overview.data;
  if (!data) {
    return (
      <div className="space-y-4 pb-8">
        {header}
        {toolbar}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {["a", "b", "c", "d"].map((key) => <Skeleton key={key} className="h-28" />)}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  const { current, previous } = data;
  const compared = previous && data.comparison !== "none" ? data.comparison : null;
  const tile = (key: Extract<keyof Period["totals"], string>, upIsGood = true) => ({
    current: current.totals[key],
    previous: previous?.totals[key] ?? null,
    comparedTo: compared,
    upIsGood,
  });
  const points: TrendPoint[] = data.series.map((point) => ({
    key: point.key,
    label: formatBucketLabel(point.key, data.granularity),
    current: metricOf(point.current, metric),
    previous: point.previous ? metricOf(point.previous, metric) : null,
    previousLabel: point.previousKey ? formatBucketLabel(point.previousKey, data.granularity, true) : null,
  }));
  const formatMetric = (value: number) => (metric === "orders" ? formatNumber(value, { maximumFractionDigits: 0 }) : fmt(value));
  const hasSales = data.series.some((point) => point.current.orders > 0);

  return (
    <div className={cn("space-y-4 pb-8", overview.isFetching && "opacity-70")} aria-busy={overview.isFetching}>
      {header}
      {toolbar}
      {current.otherCurrencyOrders > 0 ? (
        <Alert variant="info">
          <Info className="size-4" aria-hidden />
          <AlertDescription>{t("otherCurrency", { count: current.otherCurrencyOrders })}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricTile label={t("kpi.totalSales")} value={fmt(current.totals.totalSales)} help={t("help.totalSales")} {...tile("totalSales")} />
        <MetricTile label={t("kpi.netSales")} value={fmt(current.totals.netSales)} help={t("help.netSales")} {...tile("netSales")} />
        <MetricTile label={t("kpi.orders")} value={formatNumber(current.totals.orders)} help={t("help.orders")} {...tile("orders")} />
        <MetricTile label={t("kpi.averageOrderValue")} value={fmt(current.totals.averageOrderValue)} help={t("help.averageOrderValue")} {...tile("averageOrderValue")} />
      </div>

      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
          <div className="space-y-1">
            <CardTitle>{t("salesOverTime")}</CardTitle>
            <p className="text-body text-muted-foreground">{t("attribution")}</p>
          </div>
          <div className="flex flex-wrap gap-1 print:hidden" role="group" aria-label={t("salesOverTime")}>
            {CHART_METRICS.map((key) => (
              <Button key={key} variant={metric === key ? "secondary" : "ghost"} size="sm" aria-pressed={metric === key} onClick={() => setMetric(key)}>
                {t(`metric.${key}`)}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {hasSales ? (
            <SalesTrendChart
              points={points}
              format={formatMetric}
              label={`${t(`metric.${metric}`)}, ${formatRangeLabel(current.range)}`}
              currentName={formatRangeLabel(current.range)}
              previousName={previous ? formatRangeLabel(previous.range) : null}
            />
          ) : (
            <EmptyState icon={FileBarChart} title={t("chartEmpty")} description={t("chartEmptyBody")} />
          )}
          <Button variant="link" size="sm" asChild className="print:hidden">
            <Link
              to="/admin/analytics/reports/$reportId"
              params={{ reportId: "sales_over_time" }}
              search={{ ...reportSearch, granularity: data.granularity } as never}
            >
              {t("viewAsTable")}
            </Link>
          </Button>
        </CardContent>
      </Card>

      <div className="grid items-start gap-4 lg:grid-cols-3">
        <SalesBreakdownCard current={current} previous={previous} compared={compared} money={fmt} />
        <CustomersCard current={current} previous={previous} compared={compared} />
        <CodCard current={current} money={fmt} />
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <BreakdownCard
          title={t("breakdown.channel")}
          rows={data.breakdowns.channel.map((row) => breakdownRow(row, t, "channel"))}
          format={fmt}
          reportId="sales_by_channel"
          search={reportSearch as Record<string, string | undefined>}
        />
        <BreakdownCard
          title={t("breakdown.paymentMethod")}
          rows={data.breakdowns.paymentMethod.map((row) => breakdownRow(row, t, "paymentMethod"))}
          format={fmt}
          reportId="sales_by_payment_method"
          search={reportSearch as Record<string, string | undefined>}
        />
        <BreakdownCard
          title={t("breakdown.city")}
          rows={data.breakdowns.city.map((row) => breakdownRow(row, t, "city"))}
          format={fmt}
          reportId="sales_by_city"
          search={reportSearch as Record<string, string | undefined>}
        />
        <BreakdownCard
          title={t("breakdown.deliveryZone")}
          rows={data.breakdowns.deliveryZone.map((row) => breakdownRow(row, t, "zone"))}
          format={fmt}
          reportId="sales_by_delivery_zone"
          search={reportSearch as Record<string, string | undefined>}
        />
        <BreakdownCard
          title={t("breakdown.location")}
          rows={data.breakdowns.location.map((row) => breakdownRow(row, t, "location"))}
          format={fmt}
          reportId="sales_by_location"
          search={reportSearch as Record<string, string | undefined>}
        />
      </div>
    </div>
  );
}

type Translate = (key: AnalyticsMessageKey, vars?: Record<string, string | number>) => string;
type OverviewBreakdown = OverviewData["breakdowns"]["channel"][number];

function hasKey(key: string): key is AnalyticsMessageKey {
  return Object.hasOwn(analyticsMessages.en, key);
}

/** A breakdown row's words: enum words for channels and methods, placeholders for unnamed rows. */
export function breakdownRow(
  row: OverviewBreakdown,
  t: Translate,
  kind: "channel" | "paymentMethod" | "city" | "zone" | "location",
): BreakdownRow {
  const word = (key: string, fallback: string) => (hasKey(key) ? t(key) : fallback);
  let name: string;
  let detail: string | null = null;
  if (row.key === "__other") name = t("token.other");
  else if (kind === "channel") {
    name = word(`enum.channel.${row.key}`, row.key);
    detail = row.label || null;
  } else if (kind === "paymentMethod") {
    // An app's method (`<plugin id>:<provider id>`) reads as its provider, never the stored id.
    name = word(`enum.paymentMethod.${row.key}`, appPaymentMethodFallbackName(row.key) ?? row.key);
  }
  else if (kind === "city") name = row.key || t("token.city");
  else if (kind === "zone") name = row.label || word(`token.${row.key}`, row.key);
  else name = row.label || row.key || t("token.none");
  // A row is one (key, label) group in the query: a channel's key repeats per source.
  return { key: JSON.stringify([row.key, row.label]), name, detail, value: row.totalSales, orders: row.orders };
}

function ChangeText({ current, previous, compared, upIsGood = true }: { current: number; previous: number | null | undefined; compared: string | null; upIsGood?: boolean }) {
  if (!compared || previous === null || previous === undefined) return null;
  const change = analyticsChange(current, previous);
  if (change === null) return <span className="text-muted-foreground">—</span>;
  const flat = Math.abs(change) < 0.05;
  const good = (change > 0) === upIsGood;
  return (
    <span className={cn("tabular-nums", flat ? "text-muted-foreground" : good ? "text-success" : "text-critical")}>
      {change > 0 ? "↑" : change < 0 ? "↓" : ""}
      {formatSignedPercent(change)}
    </span>
  );
}

function SalesBreakdownCard({ current, previous, compared, money }: { current: Period; previous: Period | null; compared: string | null; money: (value: number) => string }) {
  const t = useMessages(analyticsMessages);
  const rows: Array<{ key: Extract<keyof Period["totals"], string>; label: AnalyticsMessageKey; sign?: -1; strong?: true; upIsGood?: boolean }> = [
    { key: "grossSales", label: "kpi.grossSales" },
    { key: "discounts", label: "kpi.discounts", sign: -1, upIsGood: false },
    { key: "returns", label: "kpi.returns", sign: -1, upIsGood: false },
    { key: "netSales", label: "kpi.netSales", strong: true },
    { key: "shipping", label: "kpi.shipping" },
    { key: "taxes", label: "kpi.taxes" },
    { key: "totalSales", label: "kpi.totalSales", strong: true },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("salesBreakdown")}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <dl className="divide-y border-t">
          {rows.map((row) => (
            <div key={row.key} className={cn("flex items-baseline justify-between gap-3 px-4 py-2 text-body", row.strong && "font-semibold")}>
              <dt title={row.key === "grossSales" ? t("help.grossSales") : undefined}>{t(row.label)}</dt>
              <dd className="flex items-baseline gap-3">
                <ChangeText current={current.totals[row.key]} previous={previous?.totals[row.key]} compared={compared} upIsGood={row.upIsGood} />
                <span className="tabular-nums">{money((row.sign ?? 1) * current.totals[row.key])}</span>
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function StatRow({ label, value, help, change }: { label: string; value: string; help?: string; change?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 py-2 text-body">
      <dt title={help}>{label}</dt>
      <dd className="flex items-baseline gap-3">
        {change}
        <span className="font-semibold tabular-nums">{value}</span>
      </dd>
    </div>
  );
}

function CustomersCard({ current, previous, compared }: { current: Period; previous: Period | null; compared: string | null }) {
  const t = useMessages(analyticsMessages);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>{t("customersCard")}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <dl className="divide-y border-t">
          <StatRow
            label={t("kpi.newCustomers")}
            value={formatNumber(current.customers.newCustomers)}
            change={<ChangeText current={current.customers.newCustomers} previous={previous?.customers.newCustomers} compared={compared} />}
          />
          <StatRow
            label={t("kpi.returningCustomers")}
            value={formatNumber(current.customers.returningCustomers)}
            change={<ChangeText current={current.customers.returningCustomers} previous={previous?.customers.returningCustomers} compared={compared} />}
          />
          <StatRow
            label={t("kpi.repeatPurchaseRate")}
            help={t("help.repeatPurchaseRate")}
            value={formatPercent(current.customers.repeatPurchaseRate)}
          />
          <StatRow label={t("kpi.netItemsSold")} value={formatNumber(current.totals.netItemsSold)} />
        </dl>
      </CardContent>
    </Card>
  );
}

function CodCard({ current, money }: { current: Period; money: (value: number) => string }) {
  const t = useMessages(analyticsMessages);
  const payments = current.payments;
  const resolved = payments.returnedToSender + payments.codDelivered;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("codCard")}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <dl className="divide-y border-t">
          <StatRow
            label={t("kpi.codShare")}
            value={formatPercent(payments.codShare)}
            change={<span className="text-muted-foreground">{t("ordersCount", { count: payments.codOrders })}</span>}
          />
          <StatRow label={t("kpi.prepaidShare")} value={t("ordersCount", { count: payments.prepaidOrders })} />
          <StatRow
            label={t("kpi.rtsRate")}
            help={t("help.rtsRate")}
            value={formatPercent(payments.rtsRate)}
            change={resolved > 0 ? <span className="text-muted-foreground">{t("rtsCount", { returned: payments.returnedToSender, resolved })}</span> : null}
          />
          <StatRow
            label={t("kpi.cancellationRate")}
            help={t("help.cancellationRate")}
            value={formatPercent(current.cancellations.cancellationRate)}
          />
          <StatRow label={t("kpi.refunded")} value={money(payments.refunded)} />
        </dl>
      </CardContent>
    </Card>
  );
}
