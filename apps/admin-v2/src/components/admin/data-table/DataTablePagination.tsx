import type { Table } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";

interface DataTablePaginationProps<TData> {
  table: Table<TData>;
  itemLabel?: string;
  pageSizeOptions?: number[];
}

export function DataTablePagination<TData>({
  table,
  itemLabel = "items",
  pageSizeOptions = [10, 20, 50, 100],
}: DataTablePaginationProps<TData>) {
  const { pageIndex, pageSize } = table.getState().pagination;
  const rowCount = table.getRowCount();
  const pageCount = table.getPageCount();

  if (rowCount === 0) return null;

  const start = pageIndex * pageSize + 1;
  const end = Math.min((pageIndex + 1) * pageSize, rowCount);
  const selectedCount = table.getFilteredSelectedRowModel().rows.length;

  return (
    <div className="flex flex-col gap-3 border-t px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-sm text-muted-foreground">
          {selectedCount > 0 && (
            <span className="mr-2 font-medium text-foreground">
              {selectedCount} selected
            </span>
          )}
          Showing{" "}
          <span className="font-medium text-foreground">{start}</span> to{" "}
          <span className="font-medium text-foreground">{end}</span> of{" "}
          <span className="font-medium text-foreground">{rowCount}</span>{" "}
          {itemLabel}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2 text-xs text-foreground"
            >
              {pageSize} per page
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {pageSizeOptions.map((size) => (
              <DropdownMenuItem
                key={size}
                onClick={() => table.setPageSize(size)}
                className={pageSize === size ? "bg-muted font-medium" : ""}
              >
                {size} per page
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <nav aria-label="Pagination" className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={() => table.firstPage()}
          disabled={!table.getCanPreviousPage()}
          className="h-8 w-8 p-0"
          aria-label="First page"
        >
          <ChevronsLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => table.previousPage()}
          disabled={!table.getCanPreviousPage()}
          className="h-8 px-2.5 text-xs"
        >
          <ChevronLeft className="mr-1 h-4 w-4" />
          Previous
        </Button>
        <div className="min-w-[90px] text-center text-sm text-muted-foreground">
          Page{" "}
          <span className="font-medium text-foreground">{pageIndex + 1}</span>{" "}
          of{" "}
          <span className="font-medium text-foreground">
            {pageCount > 0 ? pageCount : 1}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => table.nextPage()}
          disabled={!table.getCanNextPage()}
          className="h-8 px-2.5 text-xs"
        >
          Next
          <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => table.lastPage()}
          disabled={!table.getCanNextPage()}
          className="h-8 w-8 p-0"
          aria-label="Last page"
        >
          <ChevronsRight className="h-4 w-4" />
        </Button>
      </nav>
    </div>
  );
}
