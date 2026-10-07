import type { CSSProperties } from "react";
import { ACTIONS_COLUMN, SELECT_COLUMN, isPrimaryColumn } from "./column-layout";
import type { Column, TableRowData } from "./table-config";

type ColumnAttributes = {
  className: string;
  "data-numeric"?: "";
  "data-pin"?: "select" | "primary" | "actions";
  "data-after-select"?: "";
  "data-capped"?: "";
  style?: CSSProperties;
};

/**
 * Polaris IndexTable spacing: 6px each side of a cell, 12px at the table's
 * edges (the checkbox column keeps its own width).
 */
export const INDEX_CELL = "px-1.5 first:ps-3 last:pe-3";

/**
 * A column's layout, as data attributes the table cells style themselves by
 * (`components/ui/table.tsx`): numbers right aligned and unwrapped, the
 * columns that pin when the table has to scroll sideways (checkbox and title
 * left, actions right), and a capped width (`meta.maxWidth`, as
 * `--column-max`) that long text truncates at.
 */
export function columnAttributes<TData extends TableRowData>(
  column: Column<TData, unknown>,
  hasSelect: boolean,
): ColumnAttributes {
  const pin =
    column.id === SELECT_COLUMN ? "select" : column.id === ACTIONS_COLUMN ? "actions" : isPrimaryColumn(column) ? "primary" : undefined;
  const maxWidth = column.columnDef.meta?.maxWidth;
  return {
    className: INDEX_CELL,
    ...(column.columnDef.meta?.numeric ? { "data-numeric": "" as const } : {}),
    ...(pin ? { "data-pin": pin } : {}),
    ...(pin === "primary" && hasSelect ? { "data-after-select": "" as const } : {}),
    ...(maxWidth ? { "data-capped": "" as const, style: { "--column-max": `${maxWidth}px` } as CSSProperties } : {}),
  };
}
