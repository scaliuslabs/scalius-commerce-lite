import { useState } from "react";
import { serverTableFeatures, useTable, type ColumnDef, type RowSelectionState, type Table, type TableRowData } from "./table-config";

/**
 * A table over a short list the API returns whole (saved segments, price
 * lists, content types: a store keeps tens of them, the API caps them under
 * 100): the same `DataTable` rows, columns and states as a server list, one
 * page, no pager (`paginate={false}`).
 */
export function useStaticTable<TData extends TableRowData & { id: string }>(
  rows: TData[],
  columns: ColumnDef<TData, unknown>[],
  options: { selectable?: boolean } = {},
): { table: Table<TData>; selection: RowSelectionState; clearSelection: () => void } {
  const [selection, setSelection] = useState<RowSelectionState>({});
  const table = useTable({
    features: serverTableFeatures,
    data: rows,
    columns,
    getRowId: (row) => row.id,
    manualPagination: true,
    manualSorting: true,
    rowCount: rows.length,
    state: { pagination: { pageIndex: 0, pageSize: Math.max(1, rows.length) }, sorting: [], rowSelection: selection },
    enableRowSelection: options.selectable ?? false,
    onRowSelectionChange: (updater) => setSelection((current) => (typeof updater === "function" ? updater(current) : updater)),
  });
  return { table, selection, clearSelection: () => setSelection({}) };
}
