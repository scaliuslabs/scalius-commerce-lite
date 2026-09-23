import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Table, TableRowData } from "./table-config";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";

interface DataTablePaginationProps<TData extends TableRowData> {
  table: Table<TData>;
  pageSizeOptions?: number[];
}

export function DataTablePagination<TData extends TableRowData>({
  table,
  pageSizeOptions = [10, 20, 50, 100],
}: DataTablePaginationProps<TData>) {
  const t = useMessages(resourceMessages);
  const { pageIndex, pageSize } = table.state.pagination;
  const total = table.getRowCount();
  if (total === 0) return null;

  const start = pageIndex * pageSize + 1;
  const end = Math.min((pageIndex + 1) * pageSize, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-body text-muted-foreground">
      <div className="flex items-center gap-2">
        <span>{t("showing", { start, end, total })}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              {t("perPage", { count: pageSize })}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={String(pageSize)} onValueChange={(value) => table.setPageSize(Number(value))}>
              {pageSizeOptions.map((size) => (
                <DropdownMenuRadioItem key={size} value={String(size)}>
                  {t("perPage", { count: size })}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <nav aria-label={t("page", { page: pageIndex + 1, pages: Math.max(1, table.getPageCount()) })} className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon"
          onClick={() => table.previousPage()}
          disabled={!table.getCanPreviousPage()}
          aria-label={t("previous")}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={() => table.nextPage()}
          disabled={!table.getCanNextPage()}
          aria-label={t("next")}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </nav>
    </div>
  );
}
