import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Inbox,
} from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";

import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

import { EmptyState } from "./EmptyState";

export type IndexTableSortDirection = "asc" | "desc";

export interface IndexTableSort {
  columnId: string;
  direction: IndexTableSortDirection;
}

export interface IndexTableColumn<T> {
  /** Stable column id; also the value passed to `onSortChange`. */
  id: string;
  header: ReactNode;
  cell: (item: T) => ReactNode;
  /** Adds a sort button to the header. Sorting itself stays server-side. */
  sortable?: boolean;
  /** Default: "start". */
  align?: "start" | "end";
  /** Label shown beside the value when rows stack below `sm`. */
  mobileLabel?: string;
  /** Drop the column entirely from the stacked mobile layout. */
  hideOnMobile?: boolean;
  className?: string;
  headerClassName?: string;
}

export interface IndexTablePagination {
  /** 1-based page number. */
  page: number;
  pageSize: number;
  /** Total matching rows, not the rows on this page. */
  total: number;
  onPageChange: (page: number) => void;
  /** Locks the pager while the next page is in flight. */
  disabled?: boolean;
  /** Noun for the range line. Default: "items". */
  itemLabel?: string;
}

export interface IndexTableProps<T> {
  items: readonly T[];
  columns: ReadonlyArray<IndexTableColumn<T>>;
  getRowId: (item: T) => string;
  /** Accessible name for the table. Default: "Results". */
  label?: string;
  /** Shows skeleton rows instead of content while the first page loads. */
  loading?: boolean;
  /** Skeleton rows drawn while loading. Default: 5. */
  loadingRowCount?: number;
  /** Rendered instead of the table when there is nothing to show. */
  empty?: ReactNode;
  /** Adds the leading selection column. */
  selectable?: boolean;
  selectedIds?: readonly string[];
  onSelectionChange?: (selectedIds: string[]) => void;
  /** Makes rows clickable and keyboard reachable (Enter / Space). */
  onRowClick?: (item: T) => void;
  /** Trailing per-row overflow menu. Clicks inside it do not open the row. */
  rowActions?: (item: T) => ReactNode;
  sort?: IndexTableSort;
  onSortChange?: (columnId: string, direction: IndexTableSortDirection) => void;
  /** Keeps the header visible while the list scrolls. Default: true. */
  stickyHeader?: boolean;
  /** Bulk action bar, shown only while something is selected. */
  bulkActions?: ReactNode;
  /** Rendered under the rows, above the pager when both are present. */
  footer?: ReactNode;
  /** Compact pager in the table footer. Paging itself stays with the caller. */
  pagination?: IndexTablePagination;
  className?: string;
}

/** Total pages for a pager; always at least one so "Page 1 of 1" is honest. */
export function indexTablePageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
}

/**
 * Compact pager: the range it is showing on the left, previous/next on the
 * right. It never renders page-number buttons — a list that needs them needs a
 * filter instead.
 */
function IndexTablePager({
  page,
  pageSize,
  total,
  onPageChange,
  disabled = false,
  itemLabel = "items",
}: IndexTablePagination) {
  const pageCount = indexTablePageCount(total, pageSize);
  const current = Math.min(Math.max(1, page), pageCount);
  const first = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const last = Math.min(total, current * pageSize);

  return (
    <nav
      aria-label="Pagination"
      data-testid="index-table-pagination"
      className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"
    >
      <span data-testid="index-table-pagination-range">
        {total === 0
          ? `No ${itemLabel}`
          : `${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()} ${itemLabel}`}
      </span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Previous page"
          data-testid="index-table-pagination-previous"
          className="h-11 w-11 sm:h-8 sm:w-8"
          disabled={disabled || current <= 1}
          onClick={() => onPageChange(current - 1)}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </Button>
        <span aria-live="polite">Page {current} of {pageCount}</span>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Next page"
          data-testid="index-table-pagination-next"
          className="h-11 w-11 sm:h-8 sm:w-8"
          disabled={disabled || current >= pageCount}
          onClick={() => onPageChange(current + 1)}
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </nav>
  );
}

function ariaSortFor(
  columnId: string,
  sortable: boolean | undefined,
  sort: IndexTableSort | undefined,
): "ascending" | "descending" | "none" | undefined {
  if (!sortable) return undefined;
  if (sort?.columnId !== columnId) return "none";
  return sort.direction === "asc" ? "ascending" : "descending";
}

/**
 * The dashboard's resource list: one density (44px rows), optional sorting,
 * optional bulk selection, a sticky header, and rows that stack into cards
 * below `sm`. It is a presentation wrapper — paging, filtering, and sorting
 * stay with the caller.
 */
export function IndexTable<T>({
  items,
  columns,
  getRowId,
  label = "Results",
  loading = false,
  loadingRowCount = 5,
  empty,
  selectable = false,
  selectedIds,
  onSelectionChange,
  onRowClick,
  rowActions,
  sort,
  onSortChange,
  stickyHeader = true,
  bulkActions,
  footer,
  pagination,
  className,
}: IndexTableProps<T>) {
  const selected = new Set(selectedIds ?? []);
  const rowIds = items.map((item) => getRowId(item));
  const selectedOnPage = rowIds.filter((id) => selected.has(id));
  const allSelected = rowIds.length > 0 && selectedOnPage.length === rowIds.length;
  const someSelected = selectedOnPage.length > 0 && !allSelected;
  const columnCount = columns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0);
  // The first column that survives the mobile layout is the card's title: it
  // reads top-left without a label, the way a Shopify resource card does.
  const primaryColumnId = columns.find((column) => !column.hideOnMobile)?.id;

  function toggleAll(next: boolean) {
    if (!onSelectionChange) return;
    if (next) {
      const merged = new Set(selected);
      for (const id of rowIds) merged.add(id);
      onSelectionChange([...merged]);
      return;
    }
    onSelectionChange([...selected].filter((id) => !rowIds.includes(id)));
  }

  function toggleRow(id: string, next: boolean) {
    if (!onSelectionChange) return;
    const merged = new Set(selected);
    if (next) merged.add(id);
    else merged.delete(id);
    onSelectionChange([...merged]);
  }

  function onRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, item: T) {
    if (!onRowClick) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    // Let controls inside the row keep their own keyboard behaviour.
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    onRowClick(item);
  }

  const showEmpty = !loading && items.length === 0;

  return (
    <div data-testid="index-table" className={cn("space-y-3", className)}>
      {selectable && selectedOnPage.length > 0 && bulkActions ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="index-table-bulk-actions"
          className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
        >
          <span className="text-xs font-medium">
            {selectedOnPage.length} selected
          </span>
          <div className="flex flex-wrap items-center gap-2">{bulkActions}</div>
        </div>
      ) : null}

      {showEmpty ? (
        empty ?? (
          <EmptyState
            icon={Inbox}
            heading="Nothing here yet"
            body="Items appear here once they are created."
          />
        )
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <Table aria-label={label} aria-busy={loading || undefined} className="max-sm:block">
            <TableHeader
              className={cn(
                "max-sm:hidden",
                stickyHeader ? "sticky top-0 z-10 bg-card" : undefined,
              )}
            >
              <TableRow className="hover:bg-transparent">
                {selectable ? (
                  <TableHead className="w-10 px-3">
                    <Checkbox
                      aria-label={allSelected ? "Clear selection" : "Select all rows"}
                      checked={allSelected ? true : someSelected ? "indeterminate" : false}
                      disabled={rowIds.length === 0 || !onSelectionChange}
                      onCheckedChange={(value) => toggleAll(value === true)}
                    />
                  </TableHead>
                ) : null}
                {columns.map((column) => {
                  const active = sort?.columnId === column.id;
                  const nextDirection: IndexTableSortDirection =
                    active && sort?.direction === "asc" ? "desc" : "asc";
                  return (
                    <TableHead
                      key={column.id}
                      scope="col"
                      aria-sort={ariaSortFor(column.id, column.sortable, sort)}
                      className={cn(
                        "px-3 text-xs",
                        column.align === "end" ? "text-right" : undefined,
                        column.headerClassName,
                      )}
                    >
                      {column.sortable && onSortChange ? (
                        <button
                          type="button"
                          data-testid={`index-table-sort-${column.id}`}
                          className={cn(
                            "-mx-1 inline-flex items-center gap-1 rounded-sm px-1 py-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            active ? "text-foreground" : undefined,
                          )}
                          onClick={() => onSortChange(column.id, nextDirection)}
                        >
                          {column.header}
                          {active ? (
                            sort?.direction === "asc" ? (
                              <ArrowUp className="h-3 w-3" aria-hidden />
                            ) : (
                              <ArrowDown className="h-3 w-3" aria-hidden />
                            )
                          ) : (
                            <ChevronsUpDown className="h-3 w-3 opacity-50" aria-hidden />
                          )}
                        </button>
                      ) : (
                        column.header
                      )}
                    </TableHead>
                  );
                })}
                {rowActions ? (
                  <TableHead className="w-12 px-3">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>

            <TableBody className="max-sm:block max-sm:divide-y max-sm:divide-border">
              {loading && items.length === 0
                ? Array.from({ length: Math.max(1, loadingRowCount) }, (_, index) => (
                    <TableRow
                      key={`skeleton-${index}`}
                      data-testid="index-table-loading-row"
                      className="max-sm:block sm:h-11"
                    >
                      {Array.from({ length: Math.max(1, columnCount) }, (_, cell) => (
                        <TableCell key={cell} className="px-3 max-sm:block">
                          <Skeleton className="h-4 w-full max-w-40" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                : items.map((item) => {
                    const id = getRowId(item);
                    const isSelected = selected.has(id);
                    return (
                      <TableRow
                        key={id}
                        data-testid="index-table-row"
                        data-row-id={id}
                        data-state={isSelected ? "selected" : undefined}
                        tabIndex={onRowClick ? 0 : undefined}
                        aria-selected={selectable ? isSelected : undefined}
                        onClick={onRowClick ? () => onRowClick(item) : undefined}
                        onKeyDown={(event) => onRowKeyDown(event, item)}
                        className={cn(
                          "sm:h-11",
                          "max-sm:relative max-sm:block max-sm:space-y-1 max-sm:border-0 max-sm:px-3 max-sm:py-3",
                          onRowClick
                            ? "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                            : undefined,
                        )}
                      >
                        {selectable ? (
                          <TableCell
                            className="w-10 px-3 max-sm:block max-sm:px-0 max-sm:pb-1 max-sm:pt-0"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <Checkbox
                              aria-label={`Select row ${id}`}
                              checked={isSelected}
                              disabled={!onSelectionChange}
                              onCheckedChange={(value) => toggleRow(id, value === true)}
                            />
                          </TableCell>
                        ) : null}
                        {columns.map((column) => {
                          const isPrimary = column.id === primaryColumnId;
                          return (
                            <TableCell
                              key={column.id}
                              data-primary-cell={isPrimary ? "true" : undefined}
                              className={cn(
                                "px-3 text-sm",
                                column.align === "end" ? "text-right" : undefined,
                                column.hideOnMobile
                                  ? "max-sm:hidden"
                                  : isPrimary
                                    // The card title: left-aligned, no label,
                                    // and clear of the actions button pinned
                                    // to the top-right corner.
                                    ? cn(
                                        "max-sm:block max-sm:pb-1 max-sm:pl-0 max-sm:pt-0 max-sm:text-left max-sm:font-medium",
                                        rowActions ? "max-sm:pr-11" : "max-sm:pr-0",
                                      )
                                    : "max-sm:flex max-sm:items-center max-sm:justify-between max-sm:gap-3 max-sm:px-0 max-sm:py-1",
                                column.className,
                              )}
                            >
                              {column.hideOnMobile || isPrimary ? null : (
                                <span
                                  aria-hidden
                                  className="hidden text-xs text-muted-foreground max-sm:block"
                                >
                                  {column.mobileLabel ??
                                    (typeof column.header === "string" ? column.header : "")}
                                </span>
                              )}
                              <span className="min-w-0 max-sm:block">{column.cell(item)}</span>
                            </TableCell>
                          );
                        })}
                        {rowActions ? (
                          <TableCell
                            data-testid="index-table-row-actions"
                            className="w-12 px-3 text-right max-sm:absolute max-sm:right-2 max-sm:top-2 max-sm:z-10 max-sm:block max-sm:w-auto max-sm:p-0"
                            onClick={(event) => event.stopPropagation()}
                          >
                            {rowActions(item)}
                          </TableCell>
                        ) : null}
                      </TableRow>
                    );
                  })}
            </TableBody>
          </Table>
          {footer || pagination ? (
            <div className="space-y-2 border-t border-border px-3 py-2">
              {footer}
              {pagination ? <IndexTablePager {...pagination} /> : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default IndexTable;
