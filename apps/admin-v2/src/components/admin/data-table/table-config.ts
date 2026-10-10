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
  type Header as TanStackHeader,
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
  /** Money, counts and quantities: right-aligned with tabular figures. */
  numeric?: boolean;
  /**
   * A money column (the order total, a balance, a price): numeric, and never
   * stepped aside to fit the width, like the title column.
   */
  money?: boolean;
  /** The column's name in the column menu (needed when the header is not plain text). */
  label?: string;
  /**
   * The title column: always shown, never hidden by width, pinned left when
   * the table scrolls sideways. One per list.
   */
  primary?: boolean;
  /** Higher stays longer when the table runs out of width (default 50). */
  priority?: number;
  /**
   * Never stepped aside to fit the width (the orders list's Date): the
   * merchant can still hide it in the column menu.
   */
  keep?: boolean;
  /**
   * A stand-in for these columns (ids), shown in their place when the table
   * is too narrow for them side by side but has room for this one (Shopify
   * folds Payment and Fulfillment into one cell). It is not in the column
   * menu: it follows the columns it stands for.
   */
  combines?: readonly string[];
  /** Narrowest width (px) the column still reads well at (default 120). */
  minWidth?: number;
  /**
   * Widest the column grows (px). Free text (a customer's name) is cut with
   * an ellipsis there, with the whole value on hover, so one long value
   * never pushes the money and status columns out of the table.
   */
  maxWidth?: number;
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
export type Header<TData extends RowData, TValue = unknown> = TanStackHeader<
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
