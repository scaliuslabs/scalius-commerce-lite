import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import type { AnalyticsColumn } from "@scalius/shared/analytics-reports";
import type { AnalyticsGranularity } from "@scalius/shared/analytics-period";
import { Button } from "~/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { useMessages } from "~/i18n";
import { analyticsMessages, type AnalyticsMessageKey } from "~/i18n/analytics";
import { formatReportCell, isNumericColumn } from "./analytics-format";

type Cell = number | string | null;

/** API cells are numbers, strings or null; anything else shows as empty. */
function toCell(value: unknown): Cell {
  return typeof value === "number" || typeof value === "string" ? value : null;
}

export interface ReportTableData {
  report: { id: string; columns: AnalyticsColumn[]; rowLink?: "product" | "variant" };
  sort: { key: string; direction: "asc" | "desc" };
  page: number;
  totalPages: number;
  totalRows: number;
  rows: Array<{ id: string; productId?: string | null; values: Record<string, unknown> }>;
  totals: Record<string, unknown>;
  granularity: AnalyticsGranularity | null;
}

/**
 * A report as an IndexTable: the first column is the row's name (pinned
 * while the table scrolls sideways on phones), numbers right-aligned and
 * tabular, headings sort on click (the server sorts every row, not the page),
 * a totals row for the columns that add up, and pages below.
 */
export function ReportTable({
  data,
  money,
  onSort,
  onPage,
}: {
  data: ReportTableData;
  money: (value: number) => string;
  onSort: (key: string, direction: "asc" | "desc") => void;
  onPage: (page: number) => void;
}) {
  const t = useMessages(analyticsMessages);
  const columns = data.report.columns;
  const context = { t, money, granularity: data.granularity };
  const label = (column: AnalyticsColumn) => t(`column.${column.key}` as AnalyticsMessageKey);
  // Totals exist for columns that add up (and rates computed from those sums).
  const hasTotals = columns.some((column, index) => index > 0 && isNumericColumn(column) && data.totals[column.key] != null);

  return (
    <div className="space-y-3">
      <div className="overflow-clip rounded-xl bg-card shadow-card">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((column, index) => {
                const active = data.sort.key === column.key;
                const next = active && data.sort.direction === "desc" ? "asc" : active ? "desc" : isNumericColumn(column) ? "desc" : "asc";
                return (
                  <TableHead
                    key={column.key}
                    data-numeric={isNumericColumn(column) || undefined}
                    data-pin={index === 0 ? "primary" : undefined}
                    aria-sort={active ? (data.sort.direction === "asc" ? "ascending" : "descending") : "none"}
                  >
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onSort(column.key, next)}
                      aria-label={t("sortBy", { column: label(column) })}
                    >
                      {label(column)}
                      {active ? (
                        data.sort.direction === "asc" ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />
                      ) : null}
                    </button>
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length}>
                  <p className="py-6 text-center text-muted-foreground">{t("noRows")}</p>
                </TableCell>
              </TableRow>
            ) : (
              data.rows.map((row) => (
                <TableRow key={row.id}>
                  {columns.map((column, index) => {
                    const text = formatReportCell(column, toCell(row.values[column.key]), row.values, context);
                    const linked = index === 0 && data.report.rowLink && row.productId;
                    return (
                      <TableCell
                        key={column.key}
                        data-numeric={isNumericColumn(column) || undefined}
                        data-pin={index === 0 ? "primary" : undefined}
                      >
                        {column.key === "sku" ? (
                          <span className="font-mono">{text}</span>
                        ) : linked ? (
                          <Link
                            to="/admin/products/$productId/edit"
                            params={{ productId: row.productId! }}
                            className="text-link hover:underline"
                          >
                            {text}
                          </Link>
                        ) : (
                          text
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))
            )}
            {hasTotals && data.rows.length > 0 ? (
              <TableRow>
                {columns.map((column, index) => (
                  <TableCell
                    key={column.key}
                    data-numeric={isNumericColumn(column) || undefined}
                    data-pin={index === 0 ? "primary" : undefined}
                  >
                    <span className="font-semibold">
                      {index === 0
                        ? t("totalRow")
                        : isNumericColumn(column) && data.totals[column.key] != null
                          ? formatReportCell(column, toCell(data.totals[column.key]), data.totals, context)
                          : null}
                    </span>
                  </TableCell>
                ))}
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between gap-3 text-body text-muted-foreground print:hidden">
        <span>{data.totalRows === 1 ? t("rowsCountOne") : t("rowsCount", { count: data.totalRows })}</span>
        {data.totalPages > 1 ? (
          <div className="flex items-center gap-2">
            <span>{t("pageOf", { page: data.page, pages: data.totalPages })}</span>
            <Button variant="outline" size="icon-sm" onClick={() => onPage(data.page - 1)} disabled={data.page <= 1} aria-label={t("previousPage")}>
              <ChevronLeft className="size-4" />
            </Button>
            <Button variant="outline" size="icon-sm" onClick={() => onPage(data.page + 1)} disabled={data.page >= data.totalPages} aria-label={t("nextPage")}>
              <ChevronRight className="size-4" />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
