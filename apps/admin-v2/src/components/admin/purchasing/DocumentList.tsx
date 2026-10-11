import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import type { UseQueryOptions } from "@tanstack/react-query";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { useServerTable } from "~/components/admin/data-table/useServerTable";
import { EmptyState, FilteredEmptyState } from "~/components/admin/states";
import { IndexTabs, type IndexTab } from "~/components/admin/resource/IndexTabs";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { useMessages } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import { DEFAULT_PAGE_SIZE, createDataSelector, readSavedPageSize } from "~/lib/list-helpers";
import { useListSearch } from "~/lib/list-search";

export interface DocumentListProps<T extends { id: string }, Tab extends string> {
  title: string;
  /** Header buttons; the primary action last. */
  actions?: ReactNode;
  /** A notice above the list (e.g. "Add a second location first"). */
  notice?: ReactNode;
  /** Hide the notice when the first-run card carries the same guidance. Defaults to false. */
  hideNoticeWhenEmpty?: boolean;
  tabs: ReadonlyArray<IndexTab<Tab>>;
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  /** The list's session search key (the term never goes in the URL). */
  searchKey: string;
  searchPlaceholder: string;
  /** The filter fields, in the toolbar's "Filters" panel (`FilterControl`). */
  filters?: ReactNode;
  /** How many filters (beyond the tab and search) are set. */
  filterCount?: number;
  onClearFilters?: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (term: string, page: number, limit: number) => UseQueryOptions<any, any, any, any>;
  /** Response field holding the rows. */
  dataKey: string;
  columns: ColumnDef<T, unknown>[];
  layoutKey: string;
  itemLabel: string;
  rowHref?: (row: T) => string | undefined;
  /** The first tab, unfiltered, with nothing yet: one card that invites the first record. */
  empty: { icon: ComponentType<{ className?: string }>; title: string; description: string; action?: ReactNode };
}

/**
 * The purchasing lists (Polaris IndexTable): header, view tabs, a server
 * search kept in this tab's session, the table (cards on phones), pages and
 * Shopify's empty states.
 */
export function DocumentList<T extends { id: string }, Tab extends string>(props: DocumentListProps<T, Tab>) {
  const t = useMessages(purchasingMessages);
  const [term, setTerm] = useListSearch(props.searchKey);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(() => readSavedPageSize(props.layoutKey) ?? DEFAULT_PAGE_SIZE);
  const filterCount = props.filterCount ?? 0;
  // Another tab, search or filter starts at the first page.
  const filterKey = `${props.tab}|${term}|${filterCount}`;
  useEffect(() => setPage(1), [filterKey]);
  const dataSelector = useMemo(() => createDataSelector<T>(props.dataKey), [props.dataKey]);
  const { table, isFetching, isLoading, error, refetch, pagination } = useServerTable<T>({
    columns: props.columns,
    queryOptions: props.query(term, page, limit),
    dataSelector,
    currentPage: page,
    currentLimit: limit,
    onPaginationChange: (nextPage, nextLimit) => {
      setPage(nextPage);
      setLimit(nextLimit);
    },
    onSortingChange: () => undefined,
    enableRowSelection: false,
    enableSorting: false,
  });

  const first = props.tabs[0]?.value;
  const narrowed = Boolean(term) || props.tab !== first || filterCount > 0;
  const nothingYet = !narrowed && !isLoading && !error && pagination.total === 0 && table.getRowModel().rows.length === 0;
  const clear = () => {
    setTerm("");
    props.onClearFilters?.();
    if (first !== undefined && props.tab !== first) props.onTabChange(first);
  };
  const Icon = props.empty.icon;

  return (
    <div className="mx-auto max-w-7xl pb-8">
      {/* Nothing yet: the first-run card alone, with its own create action (E1, C3). */}
      <PageHeader title={props.title} actions={nothingYet ? undefined : props.actions} />
      {props.notice && !(props.hideNoticeWhenEmpty && nothingYet) ? <div className="mb-4">{props.notice}</div> : null}
      {nothingYet ? (
        <EmptyState icon={Icon} title={props.empty.title} description={props.empty.description} action={props.empty.action} />
      ) : (
        <DataTable
          variant="card"
          table={table}
          isFetching={isFetching}
          isLoading={isLoading}
          error={error}
          onRetry={() => void refetch()}
          what={props.itemLabel}
          itemLabel={props.itemLabel}
          layoutKey={props.layoutKey}
          density="compact"
          defaultSortLabel={false}
          getRowHref={props.rowHref}
          emptyState={<FilteredEmptyState onClearFilters={clear} />}
          toolbar={(
            <>
              <IndexTabs label={t("views")} tabs={props.tabs} value={props.tab} onChange={props.onTabChange} />
              <DataTableToolbar
                searchValue={term}
                onSearchChange={setTerm}
                searchPlaceholder={props.searchPlaceholder}
                filters={props.filters}
                filterCount={filterCount}
                onClearFilters={props.onClearFilters}
              />
            </>
          )}
        />
      )}
    </div>
  );
}
