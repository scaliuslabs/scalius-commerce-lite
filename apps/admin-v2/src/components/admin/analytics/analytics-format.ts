// Words and numbers for analytics: bucket and range labels in store time,
// percentages, day counts, and report cells by column type (money through
// the store currency formatter, enums and unnamed rows through the catalog).
import type { AnalyticsGranularity, AnalyticsRange } from "@scalius/shared/analytics-period";
import type { AnalyticsColumn } from "@scalius/shared/analytics-reports";
import { formatDateTime, formatNumber } from "~/i18n";
import { analyticsMessages, type AnalyticsMessageKey } from "~/i18n/analytics";

type Translate = (key: AnalyticsMessageKey, vars?: Record<string, string | number>) => string;

/** A merchant day ("2026-08-05") as UTC noon written in UTC: that day in any store zone. */
export function formatDayLabel(dateKey: string, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }): string {
  return formatDateTime(new Date(`${dateKey}T12:00:00Z`), { ...options, timeZone: "UTC" });
}

/** A bucket's label: "5 Aug", "Week of 2 Aug", "Aug 2026". */
export function formatBucketLabel(key: string, granularity: AnalyticsGranularity, withYear = false): string {
  if (granularity === "month") return formatDayLabel(key, { month: "short", year: "numeric" });
  const options: Intl.DateTimeFormatOptions = withYear
    ? { day: "numeric", month: "short", year: "numeric" }
    : { day: "numeric", month: "short" };
  return formatDayLabel(key, options);
}

/** "1–31 Aug 2026" style, as the locale words it. */
export function formatRangeLabel(range: AnalyticsRange): string {
  const sameDay = range.from === range.to;
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  const end = formatDayLabel(range.to, { day: "numeric", month: "short", year: "numeric" });
  if (sameDay) return end;
  const start = formatDayLabel(range.from, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
  return `${start} – ${end}`;
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${formatNumber(value, { maximumFractionDigits: digits })}%`;
}

export function formatSignedPercent(value: number): string {
  return `${formatNumber(Math.abs(value), { maximumFractionDigits: Math.abs(value) < 10 ? 1 : 0 })}%`;
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return formatNumber(value, { maximumFractionDigits: 0 });
}

/** Empty or placeholder text cells of a column, worded. */
function tokenFor(column: string, value: string, t: Translate, row: Record<string, unknown>): string | null {
  if (value.startsWith("__")) {
    const key = `token.${value}`;
    return hasMessage(key) ? t(key) : t("token.other");
  }
  if (value !== "") return null;
  if (column === "discount" && row.method === "manual") return t("token.__manual");
  if (column === "category" || column === "brand" || column === "city" || column === "tax_class" || column === "source") {
    return t(`token.${column}` as AnalyticsMessageKey);
  }
  return t("token.none");
}

function hasMessage(key: string): key is AnalyticsMessageKey {
  return Object.hasOwn(analyticsMessages.en, key);
}

export interface CellFormatContext {
  t: Translate;
  money: (value: number) => string;
  granularity: AnalyticsGranularity | null;
}

/** A report cell as text (the table and the totals row). */
export function formatReportCell(
  column: AnalyticsColumn,
  value: number | string | null | undefined,
  row: Record<string, unknown>,
  context: CellFormatContext,
): string {
  if (value === null || value === undefined) return "—";
  switch (column.type) {
    case "money":
      return context.money(Number(value));
    case "count":
      return formatCount(Number(value));
    case "number":
      return formatNumber(Number(value), { maximumFractionDigits: 2 });
    case "percent":
      return formatPercent(Number(value));
    case "days":
      return context.t("days", { count: formatNumber(Number(value), { maximumFractionDigits: 1 }) });
    case "date":
      return column.key === "period" && context.granularity
        ? formatBucketLabel(String(value), context.granularity, true)
        : formatDayLabel(String(value), { day: "numeric", month: "short", year: "numeric" });
    case "enum": {
      // A method or status an app added has no words here: show its code.
      const key = `enum.${column.enum}.${value}`;
      return hasMessage(key) ? context.t(key) : String(value);
    }
    default:
      return tokenFor(column.key, String(value), context.t, row) ?? String(value);
  }
}

/** Numeric columns align right and use tabular figures. */
export function isNumericColumn(column: AnalyticsColumn): boolean {
  return column.type !== "text" && column.type !== "enum" && column.type !== "date";
}
