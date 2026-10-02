import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Info, Printer } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@scalius/shared/utils";
import { analyticsReport, type AnalyticsColumn, type AnalyticsReportId } from "@scalius/shared/analytics-reports";
import type { AnalyticsGranularity } from "@scalius/shared/analytics-period";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardHeader } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { useCurrency } from "~/hooks/use-currency";
import { useMessages } from "~/i18n";
import { analyticsMessages, type AnalyticsMessageKey } from "~/i18n/analytics";
import { analyticsReportQueryOptions } from "~/lib/api-query-options/analytics";
import { AnalyticsToolbar } from "./AnalyticsToolbar";
import { ReportTable } from "./ReportTable";
import { downloadReportExport } from "./report-export";
import { formatRangeLabel } from "./analytics-format";
import type { AnalyticsSelection } from "./analytics-selection";

export const REPORT_PAGE_SIZE = 50;

export interface ReportView {
  sort?: string;
  direction?: "asc" | "desc";
  page?: number;
}

/**
 * One report: its date range (and grouping for time reports), the table
 * sorted and paged by the server, totals, Export (the whole report as CSV,
 * up to 10,000 rows) and Print.
 */
export function ReportPage({
  reportId,
  selection,
  today,
  granularity,
  view,
  onChange,
  onView,
}: {
  reportId: AnalyticsReportId;
  selection: AnalyticsSelection;
  today: string;
  granularity: AnalyticsGranularity;
  view: ReportView;
  /** A new range or grouping (the page goes back to page 1). */
  onChange: (patch: Partial<AnalyticsSelection>) => void;
  onView: (view: ReportView) => void;
}) {
  const t = useMessages(analyticsMessages);
  const { fmt } = useCurrency();
  const definition = analyticsReport(reportId);
  const ranged = definition.period === "range";
  const [exporting, setExporting] = useState(false);
  const query = {
    ...(ranged ? { from: selection.from, to: selection.to } : {}),
    ...(definition.granularity ? { granularity } : {}),
    ...(view.sort ? { sort: view.sort } : {}),
    ...(view.direction ? { direction: view.direction } : {}),
    page: view.page ?? 1,
    pageSize: REPORT_PAGE_SIZE,
  };
  const report = useQuery(analyticsReportQueryOptions(reportId, query));
  // A different report's last page is never shown in place of this one.
  const data = report.data?.report.id === reportId ? report.data : undefined;
  const title = t(`report.${reportId}` as AnalyticsMessageKey);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const result = await downloadReportExport(reportId, {
        ...(ranged ? { from: selection.from, to: selection.to } : {}),
        ...(definition.granularity ? { granularity } : {}),
        sort: data?.sort.key ?? view.sort,
        direction: data?.sort.direction ?? view.direction,
      });
      if (result.limited && result.rowCount !== null) toast.success(t("exportLimited", { count: result.rowCount }));
      else toast.success(t("exported"));
    } catch {
      toast.error(t("exportFailed"));
    } finally {
      setExporting(false);
    }
  };

  const forbidden = report.error instanceof AdminApiResponseError && report.error.status === 403;

  return (
    <div className="space-y-4 pb-8">
      <PageHeader
        title={title}
        backTo="/admin/analytics/reports"
        actions={(
          <>
            <Button variant="outline" size="sm" onClick={() => window.print()} className="print:hidden">
              <Printer className="size-4" aria-hidden />
              {t("print")}
            </Button>
            <Button size="sm" onClick={() => void exportCsv()} loading={exporting} disabled={!data} className="print:hidden">
              <Download className="size-4" aria-hidden />
              {t("export")}
            </Button>
          </>
        )}
      />
      <p className="-mt-2 text-body text-muted-foreground">
        {t(`report.${reportId}.description` as AnalyticsMessageKey)}
        {" "}
        <span className="hidden print:inline">{ranged ? formatRangeLabel(selection) : t("snapshot")}</span>
      </p>
      {ranged ? (
        <AnalyticsToolbar
          selection={selection}
          today={today}
          granularity={granularity}
          showComparison={false}
          showGranularity={Boolean(definition.granularity)}
          onChange={onChange}
        />
      ) : (
        <p className="text-body text-muted-foreground">{t("snapshot")}</p>
      )}
      {data?.notes.map((note) => (
        <Alert key={note} variant="info">
          <Info className="size-4" aria-hidden />
          <AlertDescription>{t(`note.${note}` as AnalyticsMessageKey)}</AlertDescription>
        </Alert>
      ))}
      {report.isError && !data ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
            <p className="text-body">
              {forbidden ? t("unavailable.customer_access") : t("loadFailed")}
            </p>
            {forbidden ? null : <Button variant="outline" size="sm" onClick={() => void report.refetch()}>{t("retry")}</Button>}
          </CardHeader>
        </Card>
      ) : !data ? (
        <Skeleton className="h-96" />
      ) : (
        <div className={cn(report.isFetching && "opacity-70")} aria-busy={report.isFetching}>
          <ReportTable
            data={{ ...data, report: { ...data.report, columns: data.report.columns as AnalyticsColumn[] } }}
            money={fmt}
            onSort={(sort, direction) => onView({ sort, direction, page: 1 })}
            onPage={(page) => onView({ ...view, page })}
          />
        </div>
      )}
    </div>
  );
}
