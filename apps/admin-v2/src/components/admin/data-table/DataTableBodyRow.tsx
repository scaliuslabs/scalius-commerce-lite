import { memo, type CSSProperties, type MouseEvent } from "react";
import { cn } from "@scalius/shared/utils";
import { flexRender, type Cell, type Column, type Header, type TableRowData } from "./table-config";
import { columnAttributes } from "./column-attributes";

import { TableCell, TableHead, TableRow } from "../../ui/table";

interface DataTableBodyRowProps<TData extends TableRowData> {
  cells: Cell<TData, unknown>[];
  isSelected: boolean;
  includeDragColumn: boolean;
  /** The row has a checkbox column (pinned columns are offset by it). */
  hasSelect: boolean;
  onOpen?: (event: MouseEvent) => void;
}

// Clicks on these keep their own meaning instead of opening the row.
const INTERACTIVE = "a,button,input,select,textarea,label,[role=checkbox],[role=menuitem],[role=dialog],[data-row-click-ignore]";

/** Opens a row from a click anywhere on it, except on its own controls (Polaris IndexTable). */
export function rowClickHandler(open: ((event: MouseEvent) => void) | undefined) {
  if (!open) return undefined;
  return (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest(INTERACTIVE)) return;
    if (window.getSelection()?.toString()) return;
    open(event);
  };
}

function DataTableBodyRowInner<TData extends TableRowData>({
  cells,
  isSelected,
  includeDragColumn,
  hasSelect,
  onOpen,
}: DataTableBodyRowProps<TData>) {
  return (
    <TableRow
      data-state={isSelected ? "selected" : undefined}
      onClick={rowClickHandler(onOpen)}
      className={onOpen ? "cursor-pointer" : undefined}
    >
      {includeDragColumn && <TableCell className="w-[40px] px-2" />}
      {cells.map((cell) => (
        <TableCell key={cell.id} {...columnAttributes(cell.column, hasSelect)}>
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </TableCell>
      ))}
    </TableRow>
  );
}

/**
 * Rows re-render only when their cells (TanStack keeps cell objects while the
 * row data holds), selection or layout change: the cell list is rebuilt for
 * each render by the column layout, and the open handler is a fresh closure.
 */
export const DataTableBodyRow = memo(
  DataTableBodyRowInner,
  (previous, next) =>
    previous.isSelected === next.isSelected &&
    previous.includeDragColumn === next.includeDragColumn &&
    previous.hasSelect === next.hasSelect &&
    Boolean(previous.onOpen) === Boolean(next.onOpen) &&
    previous.cells.length === next.cells.length &&
    previous.cells.every((cell, index) => cell === next.cells[index]),
) as typeof DataTableBodyRowInner;

/** One header cell: the column's header, its width and pinning. */
export function DataTableHeadCell<TData extends TableRowData>({
  column,
  header,
  hasSelect,
}: {
  column: Column<TData, unknown>;
  header: Header<TData, unknown> | undefined;
  hasSelect: boolean;
}) {
  const size = column.getSize();
  return (
    <TableHead
      {...columnAttributes(column, hasSelect)}
      className={cn(size !== 150 && "w-(--column-width)")}
      style={{ "--column-width": `${size}px` } as CSSProperties}
    >
      {header && !header.isPlaceholder ? flexRender(column.columnDef.header, header.getContext()) : null}
    </TableHead>
  );
}
