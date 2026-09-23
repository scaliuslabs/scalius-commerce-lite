import {
  lazy,
  Suspense,
  type CSSProperties,
  type MouseEvent,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  flexRender,
  type Row,
  type Table,
  type TableRowData,
} from "./table-config";
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
import { DataTableBodyRow, rowClickHandler } from "./DataTableBodyRow";
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
}

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
  const visibleColumnCount = table.getVisibleLeafColumns().length;

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
            {headerGroup.headers.map((header) => (
              <TableHead
                key={header.id}
                className={cn(header.getSize() !== 150 && "w-(--column-width)", header.column.columnDef.meta?.numeric && "text-right")}
                style={{ "--column-width": `${header.getSize()}px` } as CSSProperties}
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
        {showError ? (
          <TableRow>
            <TableCell
              colSpan={table.getAllColumns().length + (includeDragColumn ? 1 : 0)}
            >
              {renderErrorState()}
            </TableCell>
          </TableRow>
        ) : hasRows ? (
          rows.map((row) => {
            const cells = row.getVisibleCells();
            return (
              <DataTableBodyRow
                key={row.id}
                cells={cells}
                isSelected={row.getIsSelected()}
                includeDragColumn={includeDragColumn}
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
              colSpan={table.getAllColumns().length + (includeDragColumn ? 1 : 0)}
              className="h-24 text-center"
            >
              <DataTableEmptyState config={emptyState} />
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </UITable>
  );

  return (
    <div className={cn(isCard && "overflow-clip rounded-xl bg-card shadow-card", className)}>
      {toolbar}

      <div
        className={cn("relative", variant === "default" ? "rounded-md border" : "border-t")}
        aria-busy={showInitialLoading || undefined}
        data-data-table-results=""
      >
        <span className="sr-only" role="status" aria-live="polite">
          {showInitialLoading ? itemLabel ?? t("loading") : ""}
        </span>
        <DataTableLoadingOverlay visible={isFetching && !isLoading && !showError} />

        {isMobile && mobileCardRenderer ? (
          // Mobile card view
          <div className="divide-y">
            {showError ? (
              renderErrorState()
            ) : hasRows ? (
              rows.map((row) => {
                const open = openRow(row);
                return (
                  <div key={row.id} onClick={rowClickHandler(open)} className={open ? "cursor-pointer" : undefined}>
                    {mobileCardRenderer(row)}
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

      {!showError && (
        <DataTablePagination
          table={table}
          pageSizeOptions={pageSizeOptions}
        />
      )}
    </div>
  );
}
