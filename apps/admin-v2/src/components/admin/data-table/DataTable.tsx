import type { ReactNode } from "react";
import { flexRender, type Table, type Row } from "@tanstack/react-table";
import {
  Table as UITable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useIsMobile } from "~/hooks/use-mobile";
import { DataTablePagination } from "./DataTablePagination";
import { DataTableLoadingOverlay } from "./DataTableLoadingOverlay";
import { DataTableEmptyState, type EmptyStateConfig } from "./DataTableEmptyState";

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
}: DataTableProps<TData>) {
  const isMobile = useIsMobile();
  const rows = table.getRowModel().rows;
  const hasRows = rows.length > 0;

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
            ) : (
              <DataTableEmptyState config={emptyState} />
            )}
          </div>
        ) : (
          // Desktop table view
          <UITable>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
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
                    colSpan={table.getAllColumns().length}
                    className="h-24 text-center"
                  >
                    <DataTableEmptyState config={emptyState} />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </UITable>
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
