import {
  lazy,
  Suspense,
  useCallback,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import type { Table } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import type { DataTablePaginationPageSizeMenuProps } from "./DataTablePaginationPageSizeMenu";

interface DataTablePaginationProps<TData> {
  table: Table<TData>;
  itemLabel?: string;
  pageSizeOptions?: number[];
}

const LazyDataTablePaginationPageSizeMenu = lazy(async () => {
  const module = await import("./DataTablePaginationPageSizeMenu");
  return {
    default: module.DataTablePaginationPageSizeMenu as ComponentType<
      DataTablePaginationPageSizeMenuProps
    >,
  };
});

function isMenuOpenKey(key: string) {
  return key === "Enter" || key === " " || key === "ArrowDown";
}

export function DataTablePagination<TData>({
  table,
  itemLabel = "items",
  pageSizeOptions = [10, 20, 50, 100],
}: DataTablePaginationProps<TData>) {
  const { pageIndex, pageSize } = table.getState().pagination;
  const rowCount = table.getRowCount();
  const pageCount = table.getPageCount();
  const [isPageSizeMenuRequested, setIsPageSizeMenuRequested] = useState(false);
  const [isPageSizeMenuOpen, setIsPageSizeMenuOpen] = useState(false);

  const requestPageSizeMenuOpen = useCallback(() => {
    setIsPageSizeMenuRequested(true);
    setIsPageSizeMenuOpen(true);
  }, []);

  const handlePageSizeMenuOpenChange = useCallback((open: boolean) => {
    if (open) {
      setIsPageSizeMenuRequested(true);
    }
    setIsPageSizeMenuOpen(open);
  }, []);

  const handlePageSizeTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (!isMenuOpenKey(event.key)) {
        return;
      }

      event.preventDefault();
      requestPageSizeMenuOpen();
    },
    [requestPageSizeMenuOpen],
  );

  if (rowCount === 0) return null;

  const start = pageIndex * pageSize + 1;
  const end = Math.min((pageIndex + 1) * pageSize, rowCount);
  const selectedCount = table.getFilteredSelectedRowModel().rows.length;
  const pageSizeTrigger = (
    <Button
      variant="outline"
      size="sm"
      className="h-8 px-2 text-xs text-foreground"
      data-state={isPageSizeMenuOpen ? "open" : undefined}
      aria-haspopup="menu"
      aria-expanded={isPageSizeMenuOpen}
      onClick={
        isPageSizeMenuRequested ? undefined : requestPageSizeMenuOpen
      }
      onKeyDown={
        isPageSizeMenuRequested ? undefined : handlePageSizeTriggerKeyDown
      }
    >
      {pageSize} per page
    </Button>
  );

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
        {isPageSizeMenuRequested ? (
          <Suspense fallback={pageSizeTrigger}>
            <LazyDataTablePaginationPageSizeMenu
              open={isPageSizeMenuOpen}
              onOpenChange={handlePageSizeMenuOpenChange}
              trigger={pageSizeTrigger}
              pageSize={pageSize}
              pageSizeOptions={pageSizeOptions}
              onPageSizeChange={table.setPageSize}
            />
          </Suspense>
        ) : (
          pageSizeTrigger
        )}
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
