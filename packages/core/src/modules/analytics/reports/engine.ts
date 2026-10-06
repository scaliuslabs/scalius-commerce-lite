// Runs a catalogued report: validates the sort, pages it and totals it.
//
// SQL reports produce a relation `r` (one row per group); the engine wraps it
// as `select r.*, count(*) over (), sum(col) over () … from r` and pages the
// result with ORDER BY/LIMIT/OFFSET, so the database groups once, sorts once
// and returns one page plus its totals in one statement. Row reports return
// a small complete list (time buckets, a handful of methods or couriers) that
// is sorted and paged here.
import { sql, type SQL } from "drizzle-orm";
import {
  analyticsReport,
  ANALYTICS_REPORT_MAX_PAGE_SIZE,
  ANALYTICS_REPORT_MAX_ROWS,
  type AnalyticsColumn,
  type AnalyticsReportDefinition,
  type AnalyticsReportId,
} from "@scalius/shared/analytics-reports";
import type { AnalyticsGranularity, AnalyticsRange } from "@scalius/shared/analytics-period";
import { num, runAnalyticsQuery, type AnalyticsContext } from "./context";

export type ReportCell = number | string | null;

export interface ReportRow {
  /** Stable row identity (a product id, a bucket key, a method code). */
  id: string;
  values: Record<string, ReportCell>;
  /** The product a row opens, for reports with a `rowLink`. */
  productId?: string | null;
}

export interface ReportParams {
  range: AnalyticsRange | null;
  granularity: AnalyticsGranularity | null;
}

export interface ReportSort {
  key: string;
  direction: "asc" | "desc";
}

export interface ReportPageRequest extends ReportParams {
  sort?: Partial<ReportSort> | null;
  page: number;
  pageSize: number;
}

export interface ReportPage {
  report: AnalyticsReportDefinition;
  range: AnalyticsRange | null;
  granularity: AnalyticsGranularity | null;
  sort: ReportSort;
  page: number;
  pageSize: number;
  totalRows: number;
  rows: ReportRow[];
  /** Column totals across every row (null for columns that don't add up). */
  totals: Record<string, ReportCell>;
  /** Codes the dashboard explains (e.g. `abandoned_retention`). */
  notes: string[];
}

/** A report built from one grouped relation. */
export interface SqlReport {
  kind: "sql";
  build(ctx: AnalyticsContext, params: ReportParams): Promise<{
    /** CTEs without the leading `with`, or null. */
    ctes: SQL | null;
    /** The relation: selects `id` plus every column key. */
    select: SQL;
    notes?: string[];
  }>;
  /** Columns that sort by an expression over `q` instead of `q.<key>`. */
  sortExpressions?: Record<string, string>;
  /** Fills computed cells (average order value, rates) after the read. */
  finishRow?(values: Record<string, ReportCell>, ctx: AnalyticsContext): void;
  /** Fills computed totals from the summed ones. */
  finishTotals?(totals: Record<string, ReportCell>, params: ReportParams): void;
}

/** A report whose complete row list is small and bounded. */
export interface RowsReport {
  kind: "rows";
  rows(ctx: AnalyticsContext, params: ReportParams): Promise<{ rows: ReportRow[]; notes?: string[] }>;
  finishTotals?(totals: Record<string, ReportCell>, params: ReportParams): void;
}

export type ReportImplementation = SqlReport | RowsReport;

export function resolveReportSort(report: AnalyticsReportDefinition, sort?: Partial<ReportSort> | null): ReportSort {
  const key = sort?.key && report.columns.some((column) => column.key === sort.key) ? sort.key : report.defaultSort.key;
  const direction = sort?.direction === "asc" || sort?.direction === "desc"
    ? sort.direction
    : key === report.defaultSort.key ? report.defaultSort.direction : "desc";
  return { key, direction };
}

export function clampReportPage(
  page: number,
  pageSize: number,
  maxPageSize: number = ANALYTICS_REPORT_MAX_PAGE_SIZE,
): { page: number; pageSize: number; offset: number } {
  const size = Math.min(Math.max(Math.trunc(pageSize) || 1, 1), maxPageSize);
  const maxPage = Math.max(1, Math.floor(ANALYTICS_REPORT_MAX_ROWS / size));
  const current = Math.min(Math.max(Math.trunc(page) || 1, 1), maxPage);
  return { page: current, pageSize: size, offset: (current - 1) * size };
}

const isNumericColumn = (column: AnalyticsColumn) => column.type !== "text" && column.type !== "enum" && column.type !== "date";

function emptyTotals(report: AnalyticsReportDefinition): Record<string, ReportCell> {
  return Object.fromEntries(report.columns.map((column) => [column.key, column.summable ? 0 : null]));
}

function compareCells(left: ReportCell, right: ReportCell): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

function sortRows(rows: ReportRow[], sort: ReportSort): ReportRow[] {
  return [...rows].sort((left, right) => {
    const leftValue = left.values[sort.key] ?? null;
    const rightValue = right.values[sort.key] ?? null;
    // Empty cells last in both directions.
    if (leftValue === null && rightValue !== null) return 1;
    if (rightValue === null && leftValue !== null) return -1;
    const order = compareCells(leftValue, rightValue);
    return (sort.direction === "asc" ? order : -order) || left.id.localeCompare(right.id);
  });
}

function sumTotals(report: AnalyticsReportDefinition, rows: readonly ReportRow[]): Record<string, ReportCell> {
  const totals = emptyTotals(report);
  for (const column of report.columns) {
    if (!column.summable) continue;
    totals[column.key] = rows.reduce((sum, row) => sum + num(row.values[column.key]), 0);
  }
  return totals;
}

function cellOf(column: AnalyticsColumn, value: unknown): ReportCell {
  if (value === null || value === undefined) return null;
  return isNumericColumn(column) ? num(value) : String(value);
}

async function runSqlReport(
  ctx: AnalyticsContext,
  report: AnalyticsReportDefinition,
  impl: SqlReport,
  request: ReportPageRequest,
  sort: ReportSort,
  page: { page: number; pageSize: number; offset: number },
): Promise<Omit<ReportPage, "report" | "range" | "granularity" | "sort" | "page" | "pageSize">> {
  const params: ReportParams = { range: request.range, granularity: request.granularity };
  const built = await impl.build(ctx, params);
  const summable = report.columns.filter((column) => column.summable);
  const windowTotals = summable.map((column) => sql.raw(`, coalesce(sum(r.${column.key}) over (), 0) as total__${column.key}`));
  const inner = sql`with ${built.ctes ? sql`${built.ctes},` : sql``}
    r as (${built.select})
    select r.*, count(*) over () as total_rows${sql.join(windowTotals, sql.raw(""))}
    from r`;
  const fieldNames = [
    "id",
    ...(report.rowLink ? ["link_product_id"] : []),
    ...report.columns.map((column) => column.key),
    "total_rows",
    ...summable.map((column) => `total__${column.key}`),
  ];
  const fields = Object.fromEntries(fieldNames.map((name) => [name, sql`q.${sql.raw(name)}`])) as Record<string, SQL<unknown>>;
  const sortColumn = report.columns.find((column) => column.key === sort.key)!;
  const sortExpression = impl.sortExpressions?.[sort.key]
    ?? (sortColumn.type === "text" ? `lower(q.${sort.key})` : `q.${sort.key}`);
  const order = [
    sql.raw(`case when q.${sort.key} is null then 1 else 0 end`),
    sql.raw(`${sortExpression} ${sort.direction}`),
    sql.raw("q.id asc"),
  ];
  const read = (limit: number, offset: number) => ctx.db
    .select(fields)
    .from(sql`(${inner}) as q`)
    .orderBy(...order)
    .limit(limit)
    .offset(offset);

  const rows = await runAnalyticsQuery(`report:${report.id}`, () => read(page.pageSize, page.offset)) as Array<Record<string, unknown>>;
  // A page past the end still reports the totals.
  const totalsSource = rows[0] ?? (page.offset > 0
    ? (await runAnalyticsQuery(`report:${report.id}:totals`, () => read(1, 0)) as Array<Record<string, unknown>>)[0]
    : undefined);

  const totals = emptyTotals(report);
  for (const column of summable) totals[column.key] = num(totalsSource?.[`total__${column.key}`]);
  impl.finishTotals?.(totals, params);

  return {
    totalRows: num(totalsSource?.total_rows),
    totals,
    notes: built.notes ?? [],
    rows: rows.map((row) => {
      const values = Object.fromEntries(report.columns.map((column) => [column.key, cellOf(column, row[column.key])]));
      impl.finishRow?.(values, ctx);
      return report.rowLink
        ? { id: String(row.id ?? ""), values, productId: row.link_product_id == null ? null : String(row.link_product_id) }
        : { id: String(row.id ?? ""), values };
    }),
  };
}

export async function runReportPage(
  ctx: AnalyticsContext,
  reportId: AnalyticsReportId,
  impl: ReportImplementation,
  request: ReportPageRequest,
  /** Internal readers (CSV export) read bigger pages than the dashboard may ask for. */
  maxPageSize: number = ANALYTICS_REPORT_MAX_PAGE_SIZE,
): Promise<ReportPage> {
  const report = analyticsReport(reportId);
  const sort = resolveReportSort(report, request.sort);
  const page = clampReportPage(request.page, request.pageSize, maxPageSize);
  const base = {
    report,
    range: report.period === "range" ? request.range : null,
    granularity: report.granularity ? request.granularity : null,
    sort,
    page: page.page,
    pageSize: page.pageSize,
  };
  if (impl.kind === "sql") {
    return { ...base, ...await runSqlReport(ctx, report, impl, request, sort, page) };
  }
  const params: ReportParams = { range: request.range, granularity: request.granularity };
  const result = await runAnalyticsQuery(`report:${report.id}`, () => impl.rows(ctx, params));
  const totals = sumTotals(report, result.rows);
  impl.finishTotals?.(totals, params);
  const sorted = sortRows(result.rows, sort);
  return {
    ...base,
    totalRows: sorted.length,
    totals,
    notes: result.notes ?? [],
    rows: sorted.slice(page.offset, page.offset + page.pageSize),
  };
}

/**
 * Rows per statement while exporting: the whole 10,000-row cap in one read,
 * so the report groups once (a page re-groups every row before its LIMIT).
 */
export const ANALYTICS_EXPORT_PAGE_SIZE = ANALYTICS_REPORT_MAX_ROWS;

/**
 * Every row of a report up to {@link ANALYTICS_REPORT_MAX_ROWS}, in the
 * requested order, for CSV export: the dashboard's statement in pages of
 * {@link ANALYTICS_EXPORT_PAGE_SIZE}, so an export is one bounded read.
 */
export async function* iterateReportRows(
  ctx: AnalyticsContext,
  reportId: AnalyticsReportId,
  impl: ReportImplementation,
  request: Omit<ReportPageRequest, "page" | "pageSize">,
  maxRows = ANALYTICS_REPORT_MAX_ROWS,
): AsyncGenerator<ReportPage> {
  const pageSize = ANALYTICS_EXPORT_PAGE_SIZE;
  let emitted = 0;
  for (let page = 1; emitted < maxRows; page += 1) {
    const result = await runReportPage(ctx, reportId, impl, { ...request, page, pageSize }, pageSize);
    yield result;
    emitted += result.rows.length;
    if (result.rows.length < pageSize || emitted >= result.totalRows) return;
  }
}
