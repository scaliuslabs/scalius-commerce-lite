import { memo } from "react";
import { flexRender, type Cell, type TableRowData } from "./table-config";

import { TableCell, TableRow } from "../../ui/table";

interface DataTableBodyRowProps<TData extends TableRowData> {
  cells: Cell<TData, unknown>[];
  isSelected: boolean;
  includeDragColumn: boolean;
}

function DataTableBodyRowInner<TData extends TableRowData>({
  cells,
  isSelected,
  includeDragColumn,
}: DataTableBodyRowProps<TData>) {
  return (
    <TableRow data-state={isSelected ? "selected" : undefined}>
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
