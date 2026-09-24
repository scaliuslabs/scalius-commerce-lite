import { ACTIONS_COLUMN, SELECT_COLUMN, isPrimaryColumn } from "./column-layout";
import type { Column, TableRowData } from "./table-config";

/**
 * A column's layout, as data attributes the table cells style themselves by
 * (`components/ui/table.tsx`): numbers right aligned and unwrapped, and the
 * columns that pin when the table has to scroll sideways (checkbox and title
 * left, actions right).
 */
export function columnAttributes<TData extends TableRowData>(
  column: Column<TData, unknown>,
  hasSelect: boolean,
): { "data-numeric"?: ""; "data-pin"?: "select" | "primary" | "actions"; "data-after-select"?: "" } {
  const pin =
    column.id === SELECT_COLUMN ? "select" : column.id === ACTIONS_COLUMN ? "actions" : isPrimaryColumn(column) ? "primary" : undefined;
  return {
    ...(column.columnDef.meta?.numeric ? { "data-numeric": "" as const } : {}),
    ...(pin ? { "data-pin": pin } : {}),
    ...(pin === "primary" && hasSelect ? { "data-after-select": "" as const } : {}),
  };
}
