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
import type { PageInfo } from "~/lib/list-helpers";

/**
 * Previous/Next by cursor for a list the API pages with `pageInfo` (orders,
 * products, customers): the range label reads "51–100 of 1,000+" (exact
 * below the API's count cap), and the arrows follow the cursors instead of
 * page numbers.
 */
export interface DataTableCursorPaging {
  total: number;
  /** `total` is a lower bound ("1,000+"). */
  totalIsCapped?: boolean;
  /** Zero-based index of the page's first row; null when deeper than the API counts. */
  offset?: number | null;
  pageInfo: PageInfo | undefined;
  onPrevious: (startCursor: string) => void;
  onNext: (endCursor: string) => void;
}

interface DataTablePaginationProps<TData extends TableRowData> {
  table: Table<TData>;
  pageSizeOptions?: number[];
  cursorPaging?: DataTableCursorPaging;
}

export function DataTablePagination<TData extends TableRowData>({
  table,
  pageSizeOptions = [10, 20, 50, 100],
  cursorPaging,
}: DataTablePaginationProps<TData>) {
  const t = useMessages(resourceMessages);
  const { pageIndex, pageSize } = table.state.pagination;
  const total = cursorPaging ? cursorPaging.total : table.getRowCount();
  if (total === 0) return null;

  const rowsOnPage = table.getRowModel().rows.length;
  const known = cursorPaging ? typeof cursorPaging.offset === "number" : true;
  const start = cursorPaging ? (cursorPaging.offset ?? 0) + 1 : pageIndex * pageSize + 1;
  const end = cursorPaging ? (cursorPaging.offset ?? 0) + rowsOnPage : Math.min((pageIndex + 1) * pageSize, total);
  const label = !known
    ? t("showingBeyond", { count: rowsOnPage, total })
    : cursorPaging?.totalIsCapped
      ? t("showingCapped", { start, end, total })
      : t("showing", { start, end, total });

  const pageInfo = cursorPaging?.pageInfo;
  const canPrevious = cursorPaging ? Boolean(pageInfo?.hasPreviousPage && pageInfo.startCursor) : table.getCanPreviousPage();
  const canNext = cursorPaging ? Boolean(pageInfo?.hasNextPage && pageInfo.endCursor) : table.getCanNextPage();

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-body text-muted-foreground">
      <div className="flex items-center gap-2">
        <span aria-live={cursorPaging ? "polite" : undefined}>{label}</span>
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
      <nav
        aria-label={cursorPaging ? t("pagination") : t("page", { page: pageIndex + 1, pages: Math.max(1, table.getPageCount()) })}
        className="flex items-center gap-1"
      >
        <Button
          variant="outline"
          size="icon"
          onClick={() => {
            if (cursorPaging && pageInfo?.startCursor) cursorPaging.onPrevious(pageInfo.startCursor);
            else table.previousPage();
          }}
          disabled={!canPrevious}
          aria-label={t("previous")}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={() => {
            if (cursorPaging && pageInfo?.endCursor) cursorPaging.onNext(pageInfo.endCursor);
            else table.nextPage();
          }}
          disabled={!canNext}
          aria-label={t("next")}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </nav>
    </div>
  );
}
