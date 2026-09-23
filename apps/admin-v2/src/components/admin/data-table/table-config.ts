import {
  columnSizingFeature,
  columnVisibilityFeature,
  flexRender,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type Cell as TanStackCell,
  type Column as TanStackColumn,
  type ColumnDef as TanStackColumnDef,
  type ColumnVisibilityState,
  type PaginationState,
  type ReactTable,
  type Row as TanStackRow,
  type RowData,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";

/**
 * Per-column hints. `mobile` places the cell in the automatic phone card:
 * "primary" (title line), "secondary" (muted second line) or "status" (right).
 * Columns without it are left out of the card.
 */
export interface ServerColumnMeta {
  mobile?: "primary" | "secondary" | "status";
}

/**
 * The dashboard tables page, sort, and filter on the server. Register only the
 * client capabilities the shared renderer actually invokes so Table v9 can
 * tree-shake the unused client row-model and interaction machinery.
 */
export const serverTableFeatures = tableFeatures({
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  columnVisibilityFeature,
  columnSizingFeature,
  columnMeta: {} as ServerColumnMeta,
});

export type ServerTableFeatures = typeof serverTableFeatures;
export type TableRowData = RowData;
export type Table<TData extends RowData> = ReactTable<ServerTableFeatures, TData>;
export type Row<TData extends RowData> = TanStackRow<ServerTableFeatures, TData>;
export type Cell<TData extends RowData, TValue = unknown> = TanStackCell<
  ServerTableFeatures,
  TData,
  TValue
>;
export type Column<TData extends RowData, TValue = unknown> = TanStackColumn<
  ServerTableFeatures,
  TData,
  TValue
>;
export type ColumnDef<TData extends RowData, TValue = unknown> = TanStackColumnDef<
  ServerTableFeatures,
  TData,
  TValue
>;

export type VisibilityState = ColumnVisibilityState;
export type {
  PaginationState,
  RowSelectionState,
  SortingState,
};
export { flexRender, useTable };
