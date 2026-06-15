import {
  lazy,
  Suspense,
  type ComponentType,
  type ReactNode,
} from "react";
import { flexRender, type Table, type Row } from "@tanstack/react-table";
import {
  Table as UITable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";
import { DataTablePagination } from "./DataTablePagination";
import { DataTableLoadingOverlay } from "./DataTableLoadingOverlay";
import { DataTableEmptyState, type EmptyStateConfig } from "./DataTableEmptyState";
import type { SortableDataTableContentProps } from "./SortableDataTableContent";

const SortableDataTableContent = lazy(async () => {
  const module = await import("./SortableDataTableContent");
  return {
    default: module.SortableDataTableContent as ComponentType<
      SortableDataTableContentProps<unknown>
    >,
  };
});

interface DataTableProps<TData> {
  table: Table<TData>;
  isFetching: boolean;
  isLoading: boolean;
  toolbar?: ReactNode;
  emptyState?: EmptyStateConfig;
  mobileCardRenderer?: (row: Row<TData>) => ReactNode;
  itemLabel?: string;
  pageSizeOptions?: number[];
  className?: string;
  /** Enable drag-and-drop row reordering. Rows must have an `id` field. */
  sortable?: boolean;
  /** Called after a drag-and-drop reorder with old and new index. */
  onReorder?: (oldIndex: number, newIndex: number) => void;
}

export function DataTable<TData>({
  table,
  isFetching,
  isLoading,
  toolbar,
  emptyState,
  mobileCardRenderer,
  itemLabel = "items",
  pageSizeOptions,
  className,
  sortable = false,
  onReorder,
}: DataTableProps<TData>) {
  const isMobile = useIsMobile();
  const rows = table.getRowModel().rows;
  const hasRows = rows.length > 0;
  const showInitialLoading = isLoading && !hasRows;

  const renderDesktopTable = (includeDragColumn = false) => (
    <UITable>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {includeDragColumn && <TableHead className="w-[40px]" />}
            {headerGroup.headers.map((header) => (
              <TableHead
                key={header.id}
                style={{
                  width: header.getSize() !== 150 ? header.getSize() : undefined,
                }}
              >
                {header.isPlaceholder
                  ? null
                  : flexRender(
                      header.column.columnDef.header,
                      header.getContext(),
                    )}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {hasRows ? (
          rows.map((row) => (
            <TableRow
              key={row.id}
              data-state={row.getIsSelected() ? "selected" : undefined}
            >
              {includeDragColumn && <TableCell className="w-[40px] px-2" />}
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {flexRender(
                    cell.column.columnDef.cell,
                    cell.getContext(),
                  )}
                </TableCell>
              ))}
            </TableRow>
          ))
        ) : (
          <TableRow>
            <TableCell
              colSpan={table.getAllColumns().length + (includeDragColumn ? 1 : 0)}
              className="h-24 text-center"
            >
              {showInitialLoading ? (
                <div className="flex items-center justify-center py-10">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
                </div>
              ) : (
                <DataTableEmptyState config={emptyState} />
              )}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </UITable>
  );

  return (
    <div className={className}>
      {toolbar}

      <div className="relative rounded-md border">
        <DataTableLoadingOverlay visible={isFetching && !isLoading} />

        {isMobile && mobileCardRenderer ? (
          // Mobile card view
          <div className="divide-y">
            {hasRows ? (
              rows.map((row) => (
                <div key={row.id}>{mobileCardRenderer(row)}</div>
              ))
            ) : showInitialLoading ? (
              <div className="flex items-center justify-center py-10">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
              </div>
            ) : (
              <DataTableEmptyState config={emptyState} />
            )}
          </div>
        ) : sortable ? (
          <Suspense fallback={renderDesktopTable(true)}>
            <SortableDataTableContent
              table={table as unknown as Table<unknown>}
              rows={rows as unknown as Row<unknown>[]}
              hasRows={hasRows}
              showInitialLoading={showInitialLoading}
              emptyState={emptyState}
              onReorder={onReorder}
            />
          </Suspense>
        ) : (
          renderDesktopTable()
        )}
      </div>

      <DataTablePagination
        table={table}
        itemLabel={itemLabel}
        pageSizeOptions={pageSizeOptions}
      />
    </div>
  );
}
