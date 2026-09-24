import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { hashKey, useMutation, useQueryClient, type QueryKey, type UseQueryOptions } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import type { ExtraAction } from "~/components/admin/data-table/DataTableRowActions";
import { useServerTable } from "~/components/admin/data-table/useServerTable";
import { createActionsColumn, createSelectColumn } from "~/components/admin/data-table/columns/column-factories";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { createDataSelector, type ListSearchParams } from "~/lib/list-helpers";
import { listSearchKey, useListSearch } from "~/lib/list-search";
import { getServerFnError } from "~/lib/api-helpers";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { IndexTabs, type IndexTab } from "./IndexTabs";
import { PageHeader } from "./PageHeader";
import { EmptyState } from "./EmptyState";

export type ResourceAction = "trash" | "restore" | "delete";

/** Rows per bulk request: D1 allows 100 bound parameters, so stay at 90. */
export const BULK_CHUNK = 90;
/** "Select all N" gathers at most this many rows; larger lists act per page. */
export const SELECT_ALL_LIMIT = 500;

/** Runs a bulk request over rows in D1-sized chunks, one after another. */
export async function inChunks<T>(rows: T[], run: (chunk: T[]) => Promise<unknown>) {
  for (let start = 0; start < rows.length; start += BULK_CHUNK) {
    await run(rows.slice(start, start + BULK_CHUNK));
  }
}

export interface ResourceLifecycle<T> {
  canTrash: boolean;
  canRestore: boolean;
  canDelete: boolean;
  /** Per-row guard for permanent delete (e.g. records tied to orders). */
  canDeleteRow?: (row: T) => boolean;
  /** Says why `count` selected rows stay in Trash, shown before a bulk permanent delete. */
  deleteBlockedNote?: (count: number) => string;
  /** Runs one action for one or more rows; send revision claims from the rows. */
  run: (action: ResourceAction, rows: T[]) => Promise<unknown>;
}

export interface ResourceListPageProps<T extends { id: string }> {
  title: string;
  /** Header buttons; the create action goes last. */
  actions?: ReactNode;
  /** The route's validated search (page, limit, sort, order, trashed…). */
  search: ListSearchParams & Record<string, unknown>;
  /**
   * The list's name for its search terms, which are kept in the session per
   * tab and never in the URL (`useListSearch(listSearchKey(list, search, views?.param))`);
   * build `query` with the same term.
   */
  list: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: UseQueryOptions<any, any, any, any>;
  /**
   * The same list for any page, used by "Select all N" to gather every row
   * across pages (up to SELECT_ALL_LIMIT); without it selection stays per page.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pageQuery?: (page: number, limit: number) => UseQueryOptions<any, any, any, any>;
  /** Response field holding the rows, e.g. "categories". */
  dataKey: string;
  /** Content columns. The kit adds the checkbox and actions columns. */
  columns: ColumnDef<T, unknown>[];
  /** Query keys refreshed after any trash, restore, delete or bulk action. */
  invalidate: readonly QueryKey[];
  empty: { icon: ComponentType<{ className?: string }>; title: string; description: string; action?: ReactNode };
  /** Extra tabs next to All, stored in `search[views.param]`. */
  views?: { param: string; tabs: ReadonlyArray<IndexTab<string>> };
  /** Says what the search matches, e.g. "Search by title, SKU or barcode". */
  searchPlaceholder?: string;
  /** Names a number of rows ("2 products") in confirmations; a bare number otherwise. */
  countLabel?: (count: number) => string;
  /** URL params set by `filters`; they mark the list filtered and "Clear filters" resets them. */
  filterParams?: readonly string[];
  filters?: ReactNode;
  lifecycle?: ResourceLifecycle<T>;
  /** Extra bulk buttons for the non-trash tabs; call `done` after success. */
  bulkActions?: (rows: T[], done: () => void) => ReactNode;
  rowTo?: (row: T) => string | undefined;
  /** Names the row for its checkbox and menu ("Select Cotton panjabi"). */
  rowLabel?: (row: T) => string;
  viewUrl?: (row: T) => string | undefined;
  rowActions?: (row: T) => ExtraAction[] | undefined;
  canSelectRow?: (row: T) => boolean;
  sortable?: boolean;
  onReorder?: (oldIndex: number, newIndex: number, rows: T[]) => void;
}

/**
 * The one list screen (Polaris IndexTable): header, tabs incl. Trash, search,
 * bulk actions, one confirm dialog, empty state, the sort and columns menu
 * (saved per `list`) and the table's automatic phone card built from
 * `meta.mobile` column flags.
 */
export function ResourceListPage<T extends { id: string }>(props: ResourceListPageProps<T>) {
  const { search, lifecycle } = props;
  const t = useMessages(resourceMessages);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const trashed = search.trashed;
  const [term, setTerm] = useListSearch(listSearchKey(props.list, search, props.views?.param));
  // `kept`: selected rows a permanent delete leaves in Trash (canDeleteRow is false).
  const [confirm, setConfirm] = useState<{ action: "trash" | "delete"; rows: T[]; kept: number } | null>(null);

  const setSearch = useCallback(
    (updates: Record<string, unknown>) =>
      void navigate({ search: ((prev: Record<string, unknown>) => ({ ...prev, ...updates })) as never }),
    [navigate],
  );

  // A `?q=` link was adopted as the session term by the loader; the address drops it
  // so search terms never stay in URLs.
  const urlTerm = search.q;
  useEffect(() => {
    if (typeof urlTerm !== "string") return;
    setTerm(urlTerm);
    void navigate({ search: ((prev: Record<string, unknown>) => ({ ...prev, q: undefined })) as never, replace: true });
  }, [navigate, setTerm, urlTerm]);

  const canBulk = trashed
    ? Boolean(lifecycle?.canRestore || lifecycle?.canDelete)
    : Boolean(lifecycle?.canTrash || props.bulkActions);

  const mutation = useMutation({
    mutationFn: ({ action, rows }: { action: ResourceAction; rows: T[] }) =>
      inChunks(rows, (chunk) => lifecycle!.run(action, chunk)),
    onSuccess: (_data, { action }) => {
      toast.success(t(action === "trash" ? "movedToTrash" : action === "restore" ? "restored" : "deleted"));
      clearAll();
    },
    onError: (error) => toast.error(getServerFnError(error, t("actionFailed"))),
    onSettled: () => {
      setConfirm(null);
      for (const queryKey of props.invalidate) void queryClient.invalidateQueries({ queryKey });
    },
  });

  const { mutate } = mutation;
  const request = useCallback(
    (action: ResourceAction, rows: T[]) => {
      if (action === "restore") {
        mutate({ action, rows });
        return;
      }
      const deletable = action === "delete" && lifecycle?.canDeleteRow ? rows.filter(lifecycle.canDeleteRow) : rows;
      setConfirm({ action, rows: deletable, kept: rows.length - deletable.length });
    },
    [lifecycle, mutate],
  );

  const { rowTo, viewUrl, rowActions, rowLabel, columns: contentColumns } = props;
  const columns = useMemo<ColumnDef<T, unknown>[]>(() => {
    const canTrash = !trashed && lifecycle?.canTrash;
    const canRestore = trashed && lifecycle?.canRestore;
    const canDelete = trashed && lifecycle?.canDelete;
    return [
      ...(canBulk ? [createSelectColumn<T>({ getLabel: (row) => (rowLabel ? rowLabel(row as T) : t("selectRow")) })] : []),
      ...contentColumns,
      createActionsColumn<T>({
        showTrashed: trashed,
        onView: viewUrl && !trashed ? (row) => window.open(viewUrl(row), "_blank", "noopener") : undefined,
        canView: (row) => Boolean(viewUrl?.(row)),
        onEdit: rowTo && !trashed ? (row) => {
          const to = rowTo(row);
          if (to) void navigate({ to });
        } : undefined,
        onDelete: canTrash ? (row) => request("trash", [row]) : undefined,
        onRestore: canRestore ? (row) => request("restore", [row]) : undefined,
        onPermanentDelete: canDelete ? (row) => request("delete", [row]) : undefined,
        canPermanentDelete: lifecycle?.canDeleteRow,
        getExtraActions: trashed ? undefined : rowActions,
        getMenuLabel: rowLabel ? (row) => t("actionsFor", { name: rowLabel(row) }) : undefined,
      }),
    ];
  }, [canBulk, contentColumns, lifecycle, navigate, request, rowActions, rowLabel, rowTo, t, trashed, viewUrl]);

  const dataSelector = useMemo(() => createDataSelector<T>(props.dataKey), [props.dataKey]);
  const { table, error, isFetching, isLoading, refetch, selectedRows, clearSelection, pagination } = useServerTable<T>({
    columns,
    queryOptions: props.query,
    dataSelector,
    currentPage: search.page,
    currentLimit: search.limit,
    currentSort: search.sort,
    currentOrder: search.order,
    onPaginationChange: (page, limit) => setSearch({ page, limit }),
    onSortingChange: (sort, order) => setSearch({ sort, order, page: 1 }),
    enableRowSelection: props.canSelectRow ? (row) => props.canSelectRow!(row.original) : true,
  });

  // "Select all N" across pages (Polaris IndexTable): offered once the whole
  // page is ticked; it loads every row so bulk actions keep their contracts.
  const [allRows, setAllRows] = useState<T[] | null>(null);
  const [loadingAll, setLoadingAll] = useState(false);
  const scope = hashKey(props.query.queryKey);
  const pageAllSelected = table.getIsAllPageRowsSelected();
  useEffect(() => setAllRows(null), [scope]);
  useEffect(() => {
    if (!pageAllSelected) setAllRows(null);
  }, [pageAllSelected]);
  const clearAll = () => {
    setAllRows(null);
    clearSelection();
  };
  const bulkRows = allRows ?? selectedRows;
  const canSelectAll =
    Boolean(props.pageQuery) && pageAllSelected && !allRows && pagination.total > selectedRows.length && pagination.total <= SELECT_ALL_LIMIT;
  const selectAll = async () => {
    if (!props.pageQuery) return;
    setLoadingAll(true);
    try {
      const rows: T[] = [];
      for (let page = 1; ; page += 1) {
        const { data, pagination: pages } = dataSelector(await queryClient.fetchQuery(props.pageQuery(page, 100)));
        rows.push(...data);
        if (page >= pages.totalPages || data.length === 0) break;
      }
      setAllRows(props.canSelectRow ? rows.filter(props.canSelectRow) : rows);
    } catch (error) {
      toast.error(getServerFnError(error, t("actionFailed")));
    } finally {
      setLoadingAll(false);
    }
  };

  const viewParam = props.views?.param;
  const currentView = trashed ? "trash" : viewParam ? String(search[viewParam] ?? "all") : "all";
  const tabs: IndexTab<string>[] = [
    { value: "all", label: t("all") },
    ...(props.views?.tabs ?? []),
    ...(lifecycle ? [{ value: "trash", label: t("trash") }] : []),
  ];
  const onTabChange = (value: string) =>
    setSearch({
      trashed: value === "trash" ? true : undefined,
      ...(viewParam ? { [viewParam]: value === "all" || value === "trash" ? undefined : value } : {}),
      page: 1,
    });

  const filterParams = props.filterParams ?? [];
  const filtered = Boolean(term) || currentView !== "all" || filterParams.some((param) => search[param] !== undefined);
  const Icon = props.empty.icon;
  const emptyState = trashed
    ? { icon: Icon, title: t("trashEmpty"), description: "" }
    : filtered
      ? {
          icon: Icon,
          title: t("noResults"),
          description: t("noResultsHint"),
          action: (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setTerm("");
                setSearch({
                  ...(viewParam ? { [viewParam]: undefined } : {}),
                  ...Object.fromEntries(filterParams.map((param) => [param, undefined])),
                  page: 1,
                });
              }}
            >
              {t("clearFilters")}
            </Button>
          ),
        }
      : props.empty;

  const bulkButtons = selectedRows.length > 0 ? (
    <>
      {allRows ? (
        <span className="flex items-center gap-1 text-body">
          {t("allSelected", { count: allRows.length })}
          <Button variant="link" size="sm" onClick={clearAll}>
            {t("clearSelection")}
          </Button>
        </span>
      ) : (
        <span className="flex items-center gap-1 text-body">
          {t("selected", { count: selectedRows.length })}
          {canSelectAll ? (
            <Button variant="link" size="sm" loading={loadingAll} onClick={() => void selectAll()}>
              {t("selectAllCount", { count: pagination.total })}
            </Button>
          ) : null}
        </span>
      )}
      {trashed && lifecycle?.canRestore ? (
        <Button variant="outline" size="sm" loading={mutation.isPending && mutation.variables?.action === "restore"} onClick={() => request("restore", bulkRows)}>
          {t("restore")}
        </Button>
      ) : null}
      {trashed && lifecycle?.canDelete ? (
        <Button
          variant="destructive"
          size="sm"
          // Offered only when at least one selected row can really be deleted.
          disabled={Boolean(lifecycle.canDeleteRow) && !bulkRows.some((row) => lifecycle.canDeleteRow!(row))}
          onClick={() => request("delete", bulkRows)}
        >
          {t("deletePermanently")}
        </Button>
      ) : null}
      {!trashed ? props.bulkActions?.(bulkRows, clearAll) : null}
      {!trashed && lifecycle?.canTrash ? (
        <Button variant="outline" size="sm" onClick={() => request("trash", bulkRows)}>
          {t("moveToTrash")}
        </Button>
      ) : null}
    </>
  ) : undefined;

  const count = confirm?.rows.length ?? 0;
  const rowCount = table.getRowModel().rows.length;
  // Nothing created yet: one card with the empty state instead of an empty table.
  const nothingYet = !filtered && !trashed && !isLoading && !error && pagination.total === 0 && rowCount === 0;
  const tabBar = tabs.length > 1 ? <IndexTabs tabs={tabs} value={currentView} onChange={onTabChange} /> : null;

  return (
    <div className="pb-8">
      <PageHeader title={props.title} actions={trashed || nothingYet ? undefined : props.actions} />
      {nothingYet ? (
        <div className="overflow-clip rounded-xl bg-card shadow-card">
          {tabBar}
          <EmptyState icon={Icon} title={props.empty.title} description={props.empty.description} action={props.empty.action ?? props.actions} />
        </div>
      ) : (
      <DataTable
        variant="card"
        table={table}
        isFetching={isFetching}
        isLoading={isLoading}
        error={error}
        onRetry={() => void refetch()}
        layoutKey={props.list}
        getRowHref={trashed ? undefined : rowTo}
        emptyState={emptyState}
        // Reorder only when the whole list is on screen (at most 90 rows per
        // write): renumbering a partial page would duplicate positions.
        sortable={Boolean(props.sortable) && pagination.page === 1 && rowCount > 1 && pagination.total === rowCount && pagination.total <= 90}
        onReorder={props.onReorder ? (from, to) => props.onReorder!(from, to, table.getRowModel().rows.map((row) => row.original)) : undefined}
        toolbar={
          <>
            {tabBar}
            <div className="px-2 pt-2">
              <DataTableToolbar
                searchValue={term}
                onSearchChange={(value) => {
                  setTerm(value);
                  if (search.page !== 1) setSearch({ page: 1 });
                }}
                searchPlaceholder={props.searchPlaceholder ?? t("search")}
                selectedCount={bulkRows.length}
                filters={props.filters}
                bulkActions={bulkButtons}
              />
            </div>
          </>
        }
      />
      )}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setConfirm(null);
        }}
        title={
          count === 1 && rowLabel
            ? t(confirm?.action === "delete" ? "deleteOneTitle" : "trashOneTitle", { name: rowLabel(confirm!.rows[0]!) })
            : t(confirm?.action === "delete" ? "deleteTitle" : "trashTitle", { count: props.countLabel ? props.countLabel(count) : count })
        }
        description={[
          t(confirm?.action === "delete" ? "deleteBody" : count === 1 ? "trashBodyOne" : "trashBody"),
          confirm?.kept ? lifecycle?.deleteBlockedNote?.(confirm.kept) : undefined,
        ].filter(Boolean).join(" ")}
        confirmLabel={t(confirm?.action === "delete" ? "deletePermanently" : "moveToTrash")}
        loadingLabel={t("working")}
        cancelLabel={t("cancel")}
        variant={confirm?.action === "delete" ? "destructive" : "default"}
        isLoading={mutation.isPending}
        onConfirm={() => confirm && mutation.mutate(confirm)}
      />
    </div>
  );
}

/**
 * One mutation for a screen's extra actions (publish, activate, reorder…):
 * runs `fn`, shows the success toast or the server's error, refreshes `invalidate`.
 */
export function useResourceMutation<V>(fn: (variables: V) => Promise<unknown>, invalidate: readonly QueryKey[]) {
  const t = useMessages(resourceMessages);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ variables }: { variables: V; success?: string }) => fn(variables),
    onSuccess: (_data, { success }) => {
      if (success) toast.success(success);
    },
    onError: (error) => toast.error(getServerFnError(error, t("actionFailed"))),
    onSettled: () => {
      for (const queryKey of invalidate) void queryClient.invalidateQueries({ queryKey });
    },
  });
}

/** Link for the primary cell of a resource row (name/title): at most two lines. */
export function ResourceRowLink({ to, children }: { to?: string; children: ReactNode }) {
  return to ? (
    <Link to={to} className="line-clamp-2 break-words font-medium text-foreground hover:underline">
      {children}
    </Link>
  ) : (
    <span className="line-clamp-2 break-words font-medium">{children}</span>
  );
}
