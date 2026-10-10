import { memo, type CSSProperties, type MouseEvent } from "react";
import { cn } from "@scalius/shared/utils";
import { flexRender, type Cell, type Column, type Header, type TableRowData } from "./table-config";
import { columnAttributes } from "./column-attributes";
import { layoutColumnOf } from "./column-layout";

import { TableCell, TableHead, TableRow, type RowDensity } from "../../ui/table";

export type { RowDensity } from "../../ui/table";

interface DataTableBodyRowProps<TData extends TableRowData> {
  cells: Cell<TData, unknown>[];
  density: RowDensity;
  isSelected: boolean;
  includeDragColumn: boolean;
  /** The row has a checkbox column (pinned columns are offset by it). */
  hasSelect: boolean;
  onOpen?: (event: MouseEvent) => void;
}

/**
 * Clicks that belong to a control, not the row. Menus, selects and dialogs
 * opened from a row are portaled, but React still bubbles their clicks to the
 * row, so anything inside an overlay counts too.
 */
const INTERACTIVE = [
  "a", "button", "input", "select", "textarea", "label",
  "[role=checkbox]", "[role=menu]", "[role=menuitem]", "[role=menuitemradio]", "[role=menuitemcheckbox]",
  "[role=listbox]", "[role=option]", "[role=dialog]", "[role=alertdialog]",
  "[data-radix-popper-content-wrapper]", "[data-row-click-ignore]",
].join(",");

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
  density,
  isSelected,
  includeDragColumn,
  hasSelect,
  onOpen,
}: DataTableBodyRowProps<TData>) {
  return (
    <TableRow
      data-state={isSelected ? "selected" : undefined}
      onClick={rowClickHandler(onOpen)}
      density={density}
      clickable={Boolean(onOpen)}
    >
      {includeDragColumn && <TableCell className="w-[40px] px-2" />}
      {cells.map((cell, index) => (
        <TableCell key={cell.id} {...columnAttributes(cell.column, hasSelect, cells[index - 1]?.column)}>
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
    previous.density === next.density &&
    previous.includeDragColumn === next.includeDragColumn &&
    previous.hasSelect === next.hasSelect &&
    Boolean(previous.onOpen) === Boolean(next.onOpen) &&
    previous.cells.length === next.cells.length &&
    previous.cells.every((cell, index) => cell === next.cells[index]),
) as typeof DataTableBodyRowInner;

/**
 * One header cell: the column's header, its width and pinning. With no rows
 * to size the columns (an empty search), `holdWidth` gives each the narrowest
 * width its rows would need, so the headings stay where they were.
 */
export function DataTableHeadCell<TData extends TableRowData>({
  column,
  previous,
  header,
  hasSelect,
  holdWidth = false,
}: {
  column: Column<TData, unknown>;
  /** The column shown just before this one. */
  previous?: Column<TData, unknown>;
  header: Header<TData, unknown> | undefined;
  hasSelect: boolean;
  holdWidth?: boolean;
}) {
  const size = column.getSize();
  const { style: _cap, className: _padding, ...attributes } = columnAttributes(column, hasSelect, previous);
  const maxWidth = column.columnDef.meta?.maxWidth;
  return (
    <TableHead
      {...attributes}
      // INDEX_CELL's padding, written out for the class checker.
      className={cn("px-1.5 first:ps-3 last:pe-3", size !== 150 && "w-(--column-width)", holdWidth && "min-w-(--column-min)")}
      style={{
        "--column-width": `${size}px`,
        "--column-max": maxWidth ? `${maxWidth}px` : undefined,
        "--column-min": holdWidth ? `${layoutColumnOf(column).minWidth}px` : undefined,
      } as CSSProperties}
    >
      {header && !header.isPlaceholder ? flexRender(column.columnDef.header, header.getContext()) : null}
    </TableHead>
  );
}
