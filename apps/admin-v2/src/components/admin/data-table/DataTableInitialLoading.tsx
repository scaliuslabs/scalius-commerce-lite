import { cn } from "@scalius/shared/utils";
import { Skeleton } from "../../ui/skeleton";
import { TableCell, TableRow } from "../../ui/table";
import { ACTIONS_COLUMN, SELECT_COLUMN, isPrimaryColumn } from "./column-layout";
import { columnAttributes, isNumericColumn } from "./column-attributes";
import { ROW_HEIGHT, type RowDensity } from "./DataTableBodyRow";
import type { Column, TableRowData } from "./table-config";

/** Skeleton rows are capped where a page of real rows is (X1: at most 100 in the DOM). */
const MAX_SKELETON_ROWS = 100;
/** Phone cards fill about one screen. */
const MAX_SKELETON_CARDS = 8;

/** Placeholder per column kind, so the skeleton reads like the real row it stands for. */
function CellSkeleton<TData extends TableRowData>({ column, density }: { column: Column<TData, unknown>; density: RowDensity }) {
  if (column.id === SELECT_COLUMN) return <Skeleton className="size-4" />;
  if (column.id === ACTIONS_COLUMN) return <Skeleton className="ms-auto size-7" />;
  if (isPrimaryColumn(column)) {
    return density === "default" ? (
      <span className="flex flex-col gap-1.5">
        <Skeleton className="h-3.5 w-40 max-w-full" />
        <Skeleton className="h-3 w-24 max-w-full" />
      </span>
    ) : <Skeleton className="h-3.5 w-40 max-w-full" />;
  }
  return <Skeleton className={cn("h-3.5 max-w-full", isNumericColumn(column) ? "ms-auto w-16" : "w-24")} />;
}

/**
 * The first load (L2): as many rows as the page will hold (its page size),
 * at the real row height and in the real columns, so nothing moves when the
 * rows arrive.
 */
export function DataTableInitialRows<TData extends TableRowData>({
  columns,
  rowCount,
  density,
  hasSelect,
  includeDragColumn,
}: {
  columns: Column<TData, unknown>[];
  rowCount: number;
  density: RowDensity;
  hasSelect: boolean;
  includeDragColumn: boolean;
}) {
  const rows = Math.max(1, Math.min(rowCount, MAX_SKELETON_ROWS));
  return Array.from({ length: rows }, (_, rowIndex) => (
    <TableRow
      key={`initial-loading-row-${rowIndex}`}
      aria-hidden="true"
      data-slot="skeleton"
      className={cn("pointer-events-none hover:bg-transparent", ROW_HEIGHT[density])}
    >
      {includeDragColumn ? <TableCell className="w-[40px] px-2" /> : null}
      {columns.map((column, columnIndex) => (
        <TableCell key={column.id} {...columnAttributes(column, hasSelect, columns[columnIndex - 1])}>
          <CellSkeleton column={column} density={density} />
        </TableCell>
      ))}
    </TableRow>
  ));
}

export function DataTableInitialCards({ count }: { count: number }) {
  return Array.from({ length: Math.max(1, Math.min(count, MAX_SKELETON_CARDS)) }, (_, cardIndex) => (
    <div
      key={`initial-loading-card-${cardIndex}`}
      aria-hidden="true"
      data-slot="skeleton"
      className="pointer-events-none flex items-start gap-3 px-3 py-2.5"
    >
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="h-3.5 w-2/5" />
      </div>
      <Skeleton className="h-5 w-16 shrink-0" />
    </div>
  ));
}
