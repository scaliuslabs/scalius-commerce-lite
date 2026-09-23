import { memo, type MouseEvent } from "react";
import { flexRender, type Cell, type TableRowData } from "./table-config";

import { TableCell, TableRow } from "../../ui/table";

interface DataTableBodyRowProps<TData extends TableRowData> {
  cells: Cell<TData, unknown>[];
  isSelected: boolean;
  includeDragColumn: boolean;
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
        <TableCell key={cell.id}>
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </TableCell>
      ))}
    </TableRow>
  );
}

export const DataTableBodyRow = memo(
  DataTableBodyRowInner,
) as typeof DataTableBodyRowInner;
