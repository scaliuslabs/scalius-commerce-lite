import { Suspense, lazy } from "react";
import { ArrowUpDown } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { Skeleton } from "~/components/ui/skeleton";
import { useMessages } from "~/i18n";
import { dataTableMessages } from "~/i18n/data-table";
import { columnLabel, sortableColumns } from "./DataTableColumnMenu";
import type { Table, TableRowData } from "./table-config";

/** A field the list sorts by on the server. */
export interface SortField {
  id: string;
  label: string;
  /** Names the directions ("Oldest first", "Newest first") instead of Ascending and Descending. */
  ascLabel?: string;
  descLabel?: string;
  /** 1: the field sorts one way only (relevance); `desc` says which. */
  directions?: 1 | 2;
  /** The direction a field starts in when chosen (default ascending). */
  desc?: boolean;
}

export interface SortValue {
  id: string;
  desc: boolean;
}

export interface SortMenuProps {
  fields: readonly SortField[];
  /** null: the list's own order. */
  value: SortValue | null;
  /** The list's own order ("Recently updated"); false when it always sorts by a field. */
  defaultLabel?: string | false;
  onChange: (value: SortValue | null) => void;
}

const loadPanel = () => import("./DataTableSortPanel");
const SortPanel = lazy(() => loadPanel().then((module) => ({ default: module.SortPanel })));

/**
 * The toolbar's sort menu (T2, Polaris IndexFilters' sort button): the field,
 * then the direction. Its controls load when it first opens.
 */
export function DataTableSortMenu(props: SortMenuProps) {
  const t = useMessages(dataTableMessages);
  if (props.fields.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" aria-label={t("sortBy")} title={t("sortBy")} onPointerEnter={() => void loadPanel()} onFocus={() => void loadPanel()}>
          <ArrowUpDown aria-hidden />
          <span className="max-sm:sr-only">{t("sort")}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <Suspense
          fallback={(
            <div aria-busy="true" className="space-y-2 p-3">
              {["a", "b", "c"].map((key) => <Skeleton key={key} className="h-9 w-full" />)}
            </div>
          )}
        >
          <SortPanel {...props} />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}

/** The sort menu of a table that sorts by its own columns (their headers' sort). */
export function TableSortMenu<TData extends TableRowData>({ table, defaultLabel }: { table: Table<TData>; defaultLabel?: string | false }) {
  const sorting = table.state.sorting[0];
  const fields = sortableColumns(table).map((column) => ({ id: column.id, label: columnLabel(column) }));
  // A sort on a field that is not a column here (e.g. the route's "updatedAt") is the list's default order.
  const value = sorting && fields.some((field) => field.id === sorting.id) ? { id: sorting.id, desc: sorting.desc } : null;
  return (
    <DataTableSortMenu
      fields={fields}
      value={value}
      defaultLabel={defaultLabel}
      onChange={(next) => table.setSorting(next ? [{ id: next.id, desc: next.desc }] : [])}
    />
  );
}
