import { Suspense, createContext, lazy, useContext, type ReactNode } from "react";
import { Columns3 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { Skeleton } from "~/components/ui/skeleton";
import { useMessages } from "~/i18n";
import { dataTableMessages } from "~/i18n/data-table";
import type { ColumnLayout } from "./column-layout";
import type { ColumnMenuPanelProps } from "./DataTableColumnMenuPanel";
import type { Column, Table, TableRowData } from "./table-config";

/** The column name people see: `meta.label`, a plain-text or `sortHeader` header, else the id. */
export function columnLabel<TData extends TableRowData>(column: Column<TData, unknown>): string {
  const header = column.columnDef.header as unknown;
  const named = typeof header === "function" ? (header as { label?: unknown }).label : undefined;
  return column.columnDef.meta?.label ?? (typeof header === "string" ? header : typeof named === "string" ? named : column.id);
}

/** Set by `DataTable`, read by the toolbar: the sort and columns menus sit right of the search (Shopify). */
export const ColumnMenuContext = createContext<{ sortMenu: ReactNode; columnMenu: ReactNode }>({ sortMenu: null, columnMenu: null });

export function useColumnMenu(): { sortMenu: ReactNode; columnMenu: ReactNode } {
  return useContext(ColumnMenuContext);
}

/** The list's column layout, for the column header menus ("Hide {name}"). */
export const ColumnLayoutContext = createContext<Pick<ColumnLayout<TableRowData>, "toggle" | "isHiddenByChoice"> | null>(null);

/** The columns the list can sort by (shown ones). */
export function sortableColumns<TData extends TableRowData>(table: Table<TData>): Column<TData, unknown>[] {
  return table.getAllLeafColumns().filter((column) => column.getCanSort() && column.getIsVisible());
}

// The menu's controls (and drag and drop) load when it first opens, or on
// hover or focus of its button: never with the list itself.
const loadPanel = () => import("./DataTableColumnMenuPanel");
const ColumnMenuPanel = lazy(() => loadPanel().then((module) => ({ default: module.ColumnMenuPanel }))) as <TData extends TableRowData>(
  props: ColumnMenuPanelProps<TData>,
) => ReactNode;

/**
 * Shopify's columns menu: show or hide with the eye, reorder by drag or with
 * the arrow keys on the handle, plus "Reset to default". The title column is
 * always shown. Sorting has its own menu (`DataTableSortMenu`).
 */
export function DataTableColumnMenu<TData extends TableRowData>({
  table,
  layout,
}: {
  table: Table<TData>;
  layout: ColumnLayout<TData>;
}) {
  const t = useMessages(dataTableMessages);
  const menuName = t("columns");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" aria-label={menuName} title={menuName} onPointerEnter={() => void loadPanel()} onFocus={() => void loadPanel()}>
          <Columns3 aria-hidden />
          <span className="max-sm:sr-only">{menuName}</span>
        </Button>
      </PopoverTrigger>
      {/* As tall as the screen allows (not the popover's 24rem): every column in view. */}
      <PopoverContent align="end" className="flex max-h-(--radix-popover-content-available-height) w-80 flex-col overflow-hidden p-0">
        <Suspense
          fallback={(
            <div aria-busy="true" className="space-y-2 p-3">
              {["a", "b", "c", "d"].map((key) => <Skeleton key={key} className="h-9 w-full" />)}
            </div>
          )}
        >
          <ColumnMenuPanel table={table} layout={layout} />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}
