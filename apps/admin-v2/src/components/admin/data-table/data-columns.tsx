import { useCurrency } from "~/hooks/use-currency";
import { formatNumber } from "~/i18n";
import { ListDate } from "./ListDate";
import type { ColumnDef, TableRowData } from "./table-config";

/**
 * A column backed by a value the list already read for each row, not by code
 * per row. Apps' custom fields marked as list columns become these (Wave 7):
 * the list reads the fields in its one bulk read and adds a column for each.
 * The column menu shows, hides and moves them like the list's own columns.
 */
export interface DataColumnSpec<TData> {
  /** Unique in the list, e.g. "app.loyalty.points". */
  id: string;
  /** The column's name, in the dashboard's language. */
  label: string;
  kind: "text" | "number" | "money" | "date";
  /**
   * Higher stays longer when the table runs out of width: default 10, at
   * most `DATA_COLUMN_PRIORITY_MAX`, so an app's column steps aside before
   * any of a list's working columns.
   */
  priority?: number;
  value: (row: TData) => unknown;
}

/** The highest priority an app's column gets: below every list's working set (40 and up). */
export const DATA_COLUMN_PRIORITY_MAX = 35;

/** Widest each kind's content gets (px); longer text is cut, whole on hover. */
export const DATA_COLUMN_WIDTH = { text: 160, number: 80, money: 120, date: 168 } as const;

function MoneyValue({ value }: { value: number }) {
  const { fmt } = useCurrency();
  return <span className="block whitespace-nowrap">{fmt(value)}</span>;
}

function DataValue({ kind, value }: { kind: DataColumnSpec<unknown>["kind"]; value: unknown }) {
  if (value === null || value === undefined || value === "") {
    return <span className="block whitespace-nowrap text-muted-foreground" aria-hidden="true">—</span>;
  }
  if (kind === "date") return <ListDate value={value as string | number | Date} className="block truncate" />;
  if (kind === "money" && typeof value === "number") return <MoneyValue value={value} />;
  const text = kind === "number" && typeof value === "number" ? formatNumber(value) : String(value);
  return <span className="block truncate" title={text}>{text}</span>;
}

/** List columns for `specs`, after the list's own. */
export function dataColumns<TData extends TableRowData>(specs: readonly DataColumnSpec<TData>[]): ColumnDef<TData, unknown>[] {
  return specs.map((spec) => ({
    id: spec.id,
    // A long name is cut at the column's width like its values.
    header: () => <span className="block truncate" title={spec.label}>{spec.label}</span>,
    enableSorting: false,
    meta: {
      label: spec.label,
      priority: Math.min(spec.priority ?? 10, DATA_COLUMN_PRIORITY_MAX),
      numeric: spec.kind === "number" || spec.kind === "money",
      maxWidth: DATA_COLUMN_WIDTH[spec.kind],
      // The content's widest plus the cell's 6px each side.
      minWidth: DATA_COLUMN_WIDTH[spec.kind] + 12,
    },
    cell: ({ row }) => <DataValue kind={spec.kind} value={spec.value(row.original)} />,
  }));
}
