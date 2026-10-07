// The analytics service the API calls: resolves a request's range and
// granularity, gates reports by access and capability, and runs pages and
// CSV exports. Validation errors are typed so the API maps them to 400/403/409.
import {
  analyticsPresetRange,
  analyticsToday,
  resolveAnalyticsGranularity,
  validateAnalyticsRange,
  type AnalyticsComparison,
  type AnalyticsGranularity,
  type AnalyticsRange,
} from "@scalius/shared/analytics-period";
import {
  ANALYTICS_REPORTS,
  ANALYTICS_REPORT_MAX_ROWS,
  analyticsReport,
  type AnalyticsReportDefinition,
  type AnalyticsReportId,
} from "@scalius/shared/analytics-reports";
import { ForbiddenError, ValidationError } from "@scalius/core/errors";
import type { AnalyticsContext } from "./context";
import { iterateReportRows, runReportPage, type ReportPage, type ReportSort } from "./engine";
import { REPORT_IMPLEMENTATIONS } from "./definitions";
import { getAnalyticsOverview, type AnalyticsOverview } from "./overview";
import { createReportCsvBuilder } from "./csv";
import type { OrderCsvArtifact } from "../../orders";

/** What the caller may see beyond sales numbers. */
export interface AnalyticsAccess {
  /** "View customers": reports that name customers. */
  customers: boolean;
  /** "View product costs": reports built on unit costs (profit). */
  costs: boolean;
}

export type ReportUnavailableReason = "customer_access" | "cost_access";

export interface ReportCatalogEntry extends AnalyticsReportDefinition {
  available: boolean;
  unavailableReason: ReportUnavailableReason | null;
}

export interface AnalyticsRangeQuery {
  from?: string | null;
  to?: string | null;
  granularity?: string | null;
}

/** A requested range, or the last 30 days of the store calendar. */
export function resolveAnalyticsRange(query: AnalyticsRangeQuery, timeZone: string, now: Date = new Date()): AnalyticsRange {
  if (!query.from && !query.to) return analyticsPresetRange("last_30_days", analyticsToday(timeZone, now));
  try {
    return validateAnalyticsRange({ from: query.from ?? query.to, to: query.to ?? query.from });
  } catch (error: unknown) {
    throw new ValidationError(error instanceof Error ? error.message : "Invalid date range.");
  }
}

async function unavailableReason(
  ctx: AnalyticsContext,
  report: AnalyticsReportDefinition,
  access: AnalyticsAccess,
): Promise<ReportUnavailableReason | null> {
  if (report.requiresCustomerAccess && !access.customers) return "customer_access";
  if (report.requiresCostAccess && !access.costs) return "cost_access";
  return null;
}

export async function listAnalyticsReports(ctx: AnalyticsContext, access: AnalyticsAccess): Promise<ReportCatalogEntry[]> {
  const entries: ReportCatalogEntry[] = [];
  for (const report of ANALYTICS_REPORTS) {
    const reason = await unavailableReason(ctx, report, access);
    entries.push({ ...report, available: reason === null, unavailableReason: reason });
  }
  return entries;
}

async function assertReportAvailable(ctx: AnalyticsContext, report: AnalyticsReportDefinition, access: AnalyticsAccess) {
  const reason = await unavailableReason(ctx, report, access);
  if (reason === "customer_access") {
    throw new ForbiddenError("This report names customers: it needs the View customers permission.");
  }
  if (reason === "cost_access") {
    throw new ForbiddenError("This report shows unit costs: it needs the View product costs permission.");
  }
}

export interface ReportRequest extends AnalyticsRangeQuery {
  sort?: string | null;
  direction?: string | null;
  page?: number;
  pageSize?: number;
}

function resolveReportParams(report: AnalyticsReportDefinition, query: ReportRequest, ctx: AnalyticsContext): {
  range: AnalyticsRange | null;
  granularity: AnalyticsGranularity | null;
  sort: Partial<ReportSort>;
} {
  const range = report.period === "range" ? resolveAnalyticsRange(query, ctx.timeZone, ctx.now) : null;
  return {
    range,
    granularity: report.granularity && range ? resolveAnalyticsGranularity(range, query.granularity) : null,
    sort: {
      key: query.sort ?? undefined,
      direction: query.direction === "asc" || query.direction === "desc" ? query.direction : undefined,
    },
  };
}

export async function getAnalyticsReportPage(
  ctx: AnalyticsContext,
  reportId: AnalyticsReportId,
  query: ReportRequest,
  access: AnalyticsAccess,
): Promise<ReportPage> {
  const report = analyticsReport(reportId);
  await assertReportAvailable(ctx, report, access);
  const params = resolveReportParams(report, query, ctx);
  return runReportPage(ctx, reportId, REPORT_IMPLEMENTATIONS[reportId], {
    ...params,
    page: query.page ?? 1,
    pageSize: query.pageSize ?? 50,
  });
}

export interface ReportCsvExport {
  artifact: OrderCsvArtifact;
  report: AnalyticsReportDefinition;
  range: AnalyticsRange | null;
  /** Rows the report has (the export holds at most {@link ANALYTICS_REPORT_MAX_ROWS}). */
  totalRows: number;
  truncatedBy: "none" | "rows" | "bytes";
  filename: string;
}

/** The whole report (up to 10,000 rows, 16 MB) as CSV with a totals row. */
export async function exportAnalyticsReportCsv(
  ctx: AnalyticsContext,
  reportId: AnalyticsReportId,
  query: ReportRequest,
  access: AnalyticsAccess,
): Promise<ReportCsvExport> {
  const report = analyticsReport(reportId);
  await assertReportAvailable(ctx, report, access);
  const params = resolveReportParams(report, query, ctx);
  const builder = createReportCsvBuilder(report, ctx.currency, undefined, ctx.paymentMethodName);
  let totalRows = 0;
  let exported = 0;
  let totals: ReportPage["totals"] | null = null;
  let truncatedBy: ReportCsvExport["truncatedBy"] = "none";
  pages: for await (const page of iterateReportRows(ctx, reportId, REPORT_IMPLEMENTATIONS[reportId], params)) {
    totalRows = page.totalRows;
    totals = page.totals;
    for (const row of page.rows) {
      if (exported >= ANALYTICS_REPORT_MAX_ROWS) {
        truncatedBy = "rows";
        break pages;
      }
      if (!builder.append(row)) {
        truncatedBy = "bytes";
        break pages;
      }
      exported += 1;
    }
  }
  if (truncatedBy === "none" && totalRows > exported) truncatedBy = "rows";
  if (totals && truncatedBy !== "bytes" && report.columns.some((column) => column.summable)) {
    if (!builder.appendTotals(totals)) truncatedBy = "bytes";
  }
  const suffix = params.range ? `${params.range.from}_${params.range.to}` : analyticsToday(ctx.timeZone, ctx.now);
  return {
    artifact: builder.finish(),
    report,
    range: params.range,
    totalRows,
    truncatedBy,
    filename: `${report.id.replaceAll("_", "-")}-${suffix}.csv`,
  };
}

export interface OverviewRequest extends AnalyticsRangeQuery {
  comparison?: string | null;
}

export async function getAnalyticsOverviewForRequest(
  ctx: AnalyticsContext,
  query: OverviewRequest,
): Promise<AnalyticsOverview> {
  const range = resolveAnalyticsRange(query, ctx.timeZone, ctx.now);
  const comparison: AnalyticsComparison = query.comparison === "previous_year" || query.comparison === "none"
    ? query.comparison
    : "previous_period";
  return getAnalyticsOverview(ctx, {
    range,
    comparison,
    granularity: resolveAnalyticsGranularity(range, query.granularity),
  });
}
