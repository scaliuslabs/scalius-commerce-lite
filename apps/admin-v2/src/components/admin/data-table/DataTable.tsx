import {
  lazy,
  Suspense,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  flexRender,
  type Column,
  type Row,
  type Table,
  type TableRowData,
} from "./table-config";
import { ACTIONS_COLUMN, SELECT_COLUMN, isPrimaryColumn, useColumnLayout, useElementWidth } from "./column-layout";
import { ColumnLayoutContext, ColumnMenuContext, DataTableColumnMenu } from "./DataTableColumnMenu";
import { AlertTriangle } from "lucide-react";
import {
  Table as UITable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@scalius/shared/utils";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { DataTablePagination } from "./DataTablePagination";
import { DataTableLoadingOverlay } from "./DataTableLoadingOverlay";
import { DataTableEmptyState, type EmptyStateConfig } from "./DataTableEmptyState";
import { DataTableBodyRow, DataTableHeadCell, rowClickHandler } from "./DataTableBodyRow";
import { useNavigate } from "@tanstack/react-router";
import { withDashboardBasePath } from "~/lib/dashboard-base-path";
import {
  DataTableInitialCards,
  DataTableInitialRows,
} from "./DataTableInitialLoading";
import type { SortableDataTableContentProps } from "./SortableDataTableContent";

const SortableDataTableContent = lazy(async () => {
  const module = await import("./SortableDataTableContent");
  return {
    default: module.SortableDataTableContent as ComponentType<
      SortableDataTableContentProps<TableRowData>
    >,
  };
});

interface DataTableProps<TData extends TableRowData> {
  table: Table<TData>;
  isFetching: boolean;
  isLoading: boolean;
  toolbar?: ReactNode;
  emptyState?: EmptyStateConfig;
  error?: unknown;
  onRetry?: () => void;
  mobileCardRenderer?: (row: Row<TData>) => ReactNode;
  itemLabel?: string;
  pageSizeOptions?: number[];
  className?: string;
  /** Enable drag-and-drop row reordering. Rows must have an `id` field. */
  sortable?: boolean;
  /** Called after a drag-and-drop reorder with old and new index. */
  onReorder?: (oldIndex: number, newIndex: number) => void;
  /**
   * "card": one bordered card holding toolbar, rows and pagination.
   * "bare": no frame of its own, for a table placed inside the caller's card.
   */
  variant?: "default" | "card" | "bare";
  /** Opens a row from a click anywhere on it (not on its checkbox, links or menu). */
  getRowHref?: (row: TData) => string | undefined;
  /**
   * Names the list for the merchant's saved column choice (this browser
   * only), e.g. "orders". Without it the choice lasts for the page.
   */
  layoutKey?: string;
  /** False for a list that shows every row at once (no page footer). */
  paginate?: boolean;
  /** What the list is sorted by when no sort is chosen (the column menu's first choice); false for none. */
  defaultSortLabel?: string | false;
  /**
   * Below this width of the table's own container the rows become phone
   * cards: a 768px tablet with the sidebar open leaves a table too narrow for
   * more than two columns.
   */
  cardLayoutBelow?: number;
}

/** The container width under which rows become cards, unless a list says otherwise. */
export const CARD_LAYOUT_BELOW = 640;

export function DataTable<TData extends TableRowData>({
  table,
  isFetching,
  isLoading,
  toolbar,
  emptyState,
  error,
  onRetry,
  mobileCardRenderer,
  itemLabel,
  pageSizeOptions,
  className,
  sortable = false,
  onReorder,
  variant = "default",
  getRowHref,
  layoutKey,
  paginate = true,
  defaultSortLabel,
  cardLayoutBelow = CARD_LAYOUT_BELOW,
}: DataTableProps<TData>) {
  const t = useMessages(resourceMessages);
  const navigate = useNavigate();
  const openRow = (row: Row<TData>) => {
    const href = getRowHref?.(row.original);
    if (!href) return undefined;
    return (event: MouseEvent) => {
      if (event.metaKey || event.ctrlKey) window.open(withDashboardBasePath(href), "_blank", "noopener");
      else void navigate({ to: href });
    };
  };
  const isMobile = useIsMobile();
  const isCard = variant === "card";
  const rows = table.getRowModel().rows;
  const hasRows = rows.length > 0;
  const showError = Boolean(error) && !isLoading;
  const showInitialLoading = isLoading && !hasRows && !showError;
  // Columns in the merchant's order, minus those hidden by choice or to fit this width.
  const resultsRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(resultsRef);
  // Cards by the space the table really has, not the window; the window only
  // decides before the container is measured, so phones never flash a table.
  const cardLayout = width > 0 ? width < cardLayoutBelow : isMobile;
  // When the rendered cells still overflow the minimums' estimate, step aside
  // one more column at a time; sideways scrolling is the last resort.
  const [extraHidden, setExtraHidden] = useState({ width, count: 0 });
  const extra = extraHidden.width === width ? extraHidden.count : 0;
  const layout = useColumnLayout(table, layoutKey ?? null, width - (sortable ? 40 : 0), extra);
  useLayoutEffect(() => {
    const rendered = resultsRef.current?.querySelector("table");
    const frame = rendered?.parentElement;
    if (!rendered || !frame || !layout.canHideMore || width === 0) return;
    if (rendered.scrollWidth > frame.clientWidth + 1) setExtraHidden({ width, count: extra + 1 });
    // Re-measure when the width, the columns shown or the rows change.
  }, [layout.canHideMore, layout.visible.length, width, extra, rows]);
  const columns = layout.visible;
  const visibleColumnCount = columns.length;
  const hasSelect = columns.some((column) => column.id === SELECT_COLUMN);
  const headers = new Map(table.getFlatHeaders().map((header) => [header.column.id, header]));
  const cellsOf = (row: Row<TData>) => {
    const byColumn = new Map(row.getAllCells().map((cell) => [cell.column.id, cell]));
    return columns.flatMap((column) => {
      const cell = byColumn.get(column.id);
      return cell ? [cell] : [];
    });
  };
  const columnMenu = <DataTableColumnMenu table={table} layout={layout} defaultSortLabel={defaultSortLabel} />;
  const headerLayout = { toggle: layout.toggle, isHiddenByChoice: layout.isHiddenByChoice };

  const renderErrorState = () => (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <AlertTriangle className="mb-3 h-10 w-10 text-destructive/70" />
      <p className="text-body font-medium text-foreground">{t("loadFailed")}</p>
      {onRetry && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={onRetry}
        >
          {t("retry")}
        </Button>
      )}
    </div>
  );

  const renderDesktopTable = (includeDragColumn = false) => (
    <UITable>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {includeDragColumn && <TableHead className="w-[40px]" />}
            {columns.map((column) => (
              <DataTableHeadCell key={column.id} column={column} header={headers.get(column.id)} hasSelect={hasSelect} />
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {showError ? (
          <TableRow>
            <TableCell
              colSpan={visibleColumnCount + (includeDragColumn ? 1 : 0)}
            >
              {renderErrorState()}
            </TableCell>
          </TableRow>
        ) : hasRows ? (
          rows.map((row) => {
            return (
              <DataTableBodyRow
                key={row.id}
                cells={cellsOf(row)}
                isSelected={row.getIsSelected()}
                includeDragColumn={includeDragColumn}
                hasSelect={hasSelect}
                onOpen={openRow(row)}
              />
            );
          })
        ) : showInitialLoading ? (
          <DataTableInitialRows
            columnCount={visibleColumnCount + (includeDragColumn ? 1 : 0)}
            includeDragColumn={includeDragColumn}
          />
        ) : (
          <TableRow>
            <TableCell
              colSpan={visibleColumnCount + (includeDragColumn ? 1 : 0)}
              className="h-24 text-center"
            >
              <DataTableEmptyState config={emptyState} />
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </UITable>
  );

  // Phones without a list-specific card: the title, then the columns flagged
  // for the card (or the first number), with the checkbox and row menu.
  const defaultMobileCard = (row: Row<TData>) => {
    const cells = row.getAllCells();
    const render = (cell: (typeof cells)[number]) => (
      <div key={cell.id} className="min-w-0">{flexRender(cell.column.columnDef.cell, cell.getContext())}</div>
    );
    const slot = (name: "primary" | "secondary" | "status") =>
      cells.filter((cell) => cell.column.columnDef.meta?.mobile === name);
    const primary = cells.filter((cell) => isPrimaryColumn(cell.column));
    const secondary = slot("secondary").length
      ? slot("secondary")
      : cells.filter((cell) => cell.column.columnDef.meta?.numeric).slice(0, 1);
    const select = cells.find((cell) => cell.column.id === SELECT_COLUMN);
    const actions = cells.find((cell) => cell.column.id === ACTIONS_COLUMN);
    return (
      <div className="flex items-start gap-3 px-3 py-2.5">
        {select ? <div className="mt-3 shrink-0">{render(select)}</div> : null}
        <div className="min-w-0 flex-1 space-y-1">
          {primary.map(render)}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-muted-foreground">{secondary.map(render)}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {slot("status").map(render)}
          {actions ? render(actions) : null}
        </div>
      </div>
    );
  };
  const mobileCard = mobileCardRenderer ?? defaultMobileCard;

  return (
    <ColumnLayoutContext.Provider value={headerLayout}>
    <div className={cn(isCard && "overflow-clip rounded-xl bg-card shadow-card", className)}>
      <ColumnMenuContext.Provider value={columnMenu}>{toolbar}</ColumnMenuContext.Provider>

      <div
        ref={resultsRef}
        className={cn("relative", variant === "default" ? "rounded-md border" : "border-t")}
        aria-busy={showInitialLoading || undefined}
        data-data-table-results=""
      >
        <span className="sr-only" role="status" aria-live="polite">
          {showInitialLoading ? itemLabel ?? t("loading") : ""}
        </span>
        <DataTableLoadingOverlay visible={isFetching && !isLoading && !showError} />

        {cardLayout ? (
          // Mobile card view
          <div className="divide-y">
            {showError ? (
              renderErrorState()
            ) : hasRows ? (
              rows.map((row) => {
                const open = openRow(row);
                return (
                  <div key={row.id} onClick={rowClickHandler(open)} className={open ? "cursor-pointer" : undefined}>
                    {mobileCard(row)}
                  </div>
                );
              })
            ) : showInitialLoading ? (
              <DataTableInitialCards />
            ) : (
              <DataTableEmptyState config={emptyState} />
            )}
          </div>
        ) : showError ? (
          renderDesktopTable(sortable)
        ) : showInitialLoading ? (
          renderDesktopTable(sortable)
        ) : sortable ? (
          <Suspense fallback={renderDesktopTable(true)}>
            <SortableDataTableContent
              table={table as unknown as Table<TableRowData>}
              columns={columns as unknown as Column<TableRowData, unknown>[]}
              rows={rows as unknown as Row<TableRowData>[]}
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

      {!showError && paginate && (
        <DataTablePagination
          table={table}
          pageSizeOptions={pageSizeOptions}
        />
      )}
    </div>
    </ColumnLayoutContext.Provider>
  );
}

