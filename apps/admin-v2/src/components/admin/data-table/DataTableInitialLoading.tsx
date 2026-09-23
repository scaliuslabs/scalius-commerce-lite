import { Skeleton } from "../../ui/skeleton";
import { TableCell, TableRow } from "../../ui/table";

const DESKTOP_SKELETON_ROWS = 5;
const MOBILE_SKELETON_CARDS = 4;

/** Placeholder widths vary by column so the skeleton reads like real rows. */
function CellSkeleton({ columnIndex, columnCount }: { columnIndex: number; columnCount: number }) {
  if (columnIndex === 0) return <Skeleton className="size-4" />;
  if (columnIndex === columnCount - 1) return <Skeleton className="ml-auto size-8" />;
  switch (columnIndex % 5) {
    case 1:
      return <Skeleton className="h-4 w-40 max-w-full" />;
    case 2:
      return <Skeleton className="h-4 w-28 max-w-full" />;
    case 3:
      return <Skeleton className="h-4 w-20 max-w-full" />;
    case 4:
      return <Skeleton className="h-4 w-32 max-w-full" />;
    default:
      return <Skeleton className="h-4 w-5" />;
  }
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
          <CellSkeleton columnIndex={columnIndex} columnCount={safeColumnCount} />
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
