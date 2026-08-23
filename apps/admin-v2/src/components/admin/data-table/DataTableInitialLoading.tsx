import { Skeleton } from "../../ui/skeleton";
import { TableCell, TableRow } from "../../ui/table";

const DESKTOP_SKELETON_ROWS = 5;
const MOBILE_SKELETON_CARDS = 4;

const CELL_WIDTHS = [
  "w-5",
  "w-40 max-w-full",
  "w-28 max-w-full",
  "w-20 max-w-full",
  "w-32 max-w-full",
] as const;

function cellSkeletonClass(columnIndex: number, columnCount: number): string {
  if (columnIndex === 0) return "h-4 w-4 rounded-sm";
  if (columnIndex === columnCount - 1) return "ml-auto h-8 w-8";
  return `h-4 ${CELL_WIDTHS[columnIndex % CELL_WIDTHS.length]}`;
}

export function DataTableInitialRows({
  columnCount,
  includeDragColumn,
}: {
  columnCount: number;
  includeDragColumn: boolean;
}) {
  const safeColumnCount = Math.max(1, columnCount);

  return Array.from({ length: DESKTOP_SKELETON_ROWS }, (_, rowIndex) => (
    <TableRow
      key={`initial-loading-row-${rowIndex}`}
      aria-hidden="true"
      data-data-table-loading-row=""
      className="pointer-events-none"
    >
      {Array.from({ length: safeColumnCount }, (_, columnIndex) => (
        <TableCell
          key={`initial-loading-cell-${rowIndex}-${columnIndex}`}
          className={includeDragColumn && columnIndex === 0 ? "w-[40px] px-2" : undefined}
        >
          <Skeleton className={cellSkeletonClass(columnIndex, safeColumnCount)} />
        </TableCell>
      ))}
    </TableRow>
  ));
}

export function DataTableInitialCards() {
  return Array.from({ length: MOBILE_SKELETON_CARDS }, (_, cardIndex) => (
    <div
      key={`initial-loading-card-${cardIndex}`}
      aria-hidden="true"
      data-data-table-loading-card=""
      className="pointer-events-none space-y-3 p-4"
    >
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-8 w-8 shrink-0" />
      </div>
      <Skeleton className="h-4 w-4/5" />
      <div className="flex items-center gap-2">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-24" />
      </div>
    </div>
  ));
}
