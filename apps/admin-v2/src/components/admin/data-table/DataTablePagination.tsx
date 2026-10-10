import { Suspense, lazy } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Table, TableRowData } from "./table-config";
import { Button } from "@/components/ui/button";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { PAGE_SIZE_OPTIONS, writeSavedPageSize, type PageInfo } from "~/lib/list-helpers";

const PageSizeMenu = lazy(() => import("./DataTablePageSizeMenu"));

/**
 * Previous/Next by cursor for a list the API pages with `pageInfo` (orders,
 * products, customers): the range label reads "51–100 of 1,000+" (exact
 * below the API's count cap), and the arrows follow the cursors instead of
 * page numbers.
 */
export interface DataTableCursorPaging {
  /** Matching rows; null for a list the API does not count (a history log): the label then shows the range alone. */
  total: number | null;
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
  pageSizeOptions?: readonly number[];
  cursorPaging?: DataTableCursorPaging;
  /** Names the list whose page size this browser keeps (`createListSearchValidator`'s `list`). */
  layoutKey?: string;
  /** A page is loading: the arrows wait instead of stacking requests. */
  busy?: boolean;
}

/**
 * The one pager (T12): "51–100 of 1,000+", the page size (kept per list in
 * this browser), then Previous and Next, which are left out when everything
 * fits on one page. It pages by number or by the API's cursors, whichever
 * the API does.
 */
export function DataTablePagination<TData extends TableRowData>({
  table,
  pageSizeOptions = PAGE_SIZE_OPTIONS,
  cursorPaging,
  layoutKey,
  busy = false,
}: DataTablePaginationProps<TData>) {
  const t = useMessages(resourceMessages);
  const { pageIndex, pageSize } = table.state.pagination;
  const rowsOnPage = table.getRowModel().rows.length;
  const total = cursorPaging ? cursorPaging.total ?? (rowsOnPage > 0 ? null : 0) : table.getRowCount();
  if (total === 0) return null;

  const known = cursorPaging ? typeof cursorPaging.offset === "number" : true;
  const start = cursorPaging ? (cursorPaging.offset ?? 0) + 1 : pageIndex * pageSize + 1;
  const end = cursorPaging ? (cursorPaging.offset ?? 0) + rowsOnPage : Math.min((pageIndex + 1) * pageSize, total ?? Number.POSITIVE_INFINITY);
  const label = total === null
    ? t("showingRange", { start, end })
    : !known
      ? t("showingBeyond", { count: rowsOnPage, total })
      : cursorPaging?.totalIsCapped
        ? t("showingCapped", { start, end, total })
        : t("showing", { start, end, total });

  const pageInfo = cursorPaging?.pageInfo;
  const canPrevious = cursorPaging ? Boolean(pageInfo?.hasPreviousPage && pageInfo.startCursor) : table.getCanPreviousPage();
  const canNext = cursorPaging ? Boolean(pageInfo?.hasNextPage && pageInfo.endCursor) : table.getCanNextPage();
  const sizes = pageSizeOptions.includes(pageSize) ? pageSizeOptions : [...pageSizeOptions, pageSize].sort((a, b) => a - b);

  return (
    <IndexPager
      label={label}
      navLabel={cursorPaging ? t("pagination") : t("page", { page: pageIndex + 1, pages: Math.max(1, table.getPageCount()) })}
      // Choosing a size only matters when the list is longer than the smallest page.
      pageSize={total === null || total > Math.min(...sizes) || (pageInfo?.hasNextPage ?? false) ? {
        value: pageSize,
        options: sizes,
        onChange: (size) => {
          if (layoutKey) writeSavedPageSize(layoutKey, size);
          table.setPageSize(size);
        },
      } : undefined}
      canPrevious={canPrevious}
      canNext={canNext}
      onPrevious={() => {
        if (busy) return;
        if (cursorPaging && pageInfo?.startCursor) cursorPaging.onPrevious(pageInfo.startCursor);
        else table.previousPage();
      }}
      onNext={() => {
        if (busy) return;
        if (cursorPaging && pageInfo?.endCursor) cursorPaging.onNext(pageInfo.endCursor);
        else table.nextPage();
      }}
    />
  );
}

/**
 * The pager's look, for a paged list that is not a `DataTable` (a dialog's
 * list of values): the range label, the page size when offered, then
 * Previous and Next, left out when there is one page.
 */
export function IndexPager({
  label,
  navLabel,
  pageSize,
  canPrevious,
  canNext,
  onPrevious,
  onNext,
}: {
  label: string;
  navLabel: string;
  pageSize?: { value: number; options: readonly number[]; onChange: (size: number) => void };
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const t = useMessages(resourceMessages);
  return (
    <div data-slot="pagination" className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-body text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className="tabular-nums" aria-live="polite">{label}</span>
        {pageSize ? (
          <Suspense fallback={<Button variant="ghost" size="sm">{t("perPage", { count: pageSize.value })}</Button>}>
            <PageSizeMenu value={pageSize.value} options={pageSize.options} onChange={pageSize.onChange} />
          </Suspense>
        ) : null}
      </div>
      {!canPrevious && !canNext ? null : (
        <nav aria-label={navLabel} className="flex items-center gap-1">
          <Button variant="outline" size="icon" onClick={onPrevious} disabled={!canPrevious} aria-label={t("previous")} title={t("previous")}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" onClick={onNext} disabled={!canNext} aria-label={t("next")} title={t("next")}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </nav>
      )}
    </div>
  );
}
