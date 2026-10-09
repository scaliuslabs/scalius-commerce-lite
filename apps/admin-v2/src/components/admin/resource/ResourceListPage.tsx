import { Suspense, createContext, lazy, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { hashKey, useMutation, useQueryClient, type QueryKey, type UseQueryOptions } from "@tanstack/react-query";
import { cn } from "@scalius/shared/utils";
import { toast } from "~/lib/toast";
import { Button } from "~/components/ui/button";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { DataTableToolbar, IndexBulkBar } from "~/components/admin/data-table/DataTableToolbar";
import type { RowDensity } from "~/components/admin/data-table/DataTableBodyRow";
import type { ExtraAction } from "~/components/admin/data-table/DataTableRowActions";
import { useServerTable } from "~/components/admin/data-table/useServerTable";
import { createActionsColumn, createSelectColumn } from "~/components/admin/data-table/columns/column-factories";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { useAppActions, type AppTarget } from "~/components/admin/apps/ui/surfaces";
import {
  NO_CURSOR,
  createDataSelector,
  isPagingRefusal,
  resetCursorUnlessPaging,
  type ListSearchParams,
} from "~/lib/list-helpers";
import { runMatching, type BulkTarget, type MatchingSlice, type MatchingTotals } from "~/lib/bulk-selection";
import { listSearchKey, useListSearch } from "~/lib/list-search";
import { useOpenedOnce } from "~/hooks/use-opened-once";
import { getServerFnError } from "~/lib/api-helpers";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { dataTableMessages } from "~/i18n/data-table";
import { IndexTabs, type IndexTab } from "./IndexTabs";
import { PageHeader } from "./PageHeader";

// The trash and delete confirmation loads the first time it is asked for;
// apps' bulk menu as soon as an app offers this list a bulk action.
// The first-run card loads only for a list with nothing in it.
const EmptyState = lazy(() => import("./EmptyState").then((module) => ({ default: module.EmptyState })));
const ConfirmDialog = lazy(() => import("~/components/admin/shared/ConfirmDialog").then((module) => ({ default: module.ConfirmDialog })));
const loadAppActions = () => import("~/components/admin/apps/ui/AppActions");
const AppBulkActionsMenu = lazy(() => loadAppActions().then((module) => ({ default: module.AppBulkActionsMenu })));

export type ResourceAction = "trash" | "restore" | "delete";

/** Rows per bulk request: D1 allows 100 bound parameters, so stay at 90. */
export const BULK_CHUNK = 90;

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
  /**
   * Runs one action on one slice of every row that matches the list's filter
   * (the API reads the rows itself; `cursor` is where the slice starts). With
   * it the list offers "Select all N matching" (T11).
   */
  runMatching?: (action: ResourceAction, cursor: string | undefined) => Promise<MatchingSlice>;
  /**
   * The "Moved to trash" toast offers Undo (a restore of the same rows). Only
   * for resources whose restore needs nothing from the trashed rows (no revision claim).
   */
  undoTrash?: boolean;
}

/** What a list's bulk buttons get besides the target: a runner that shows progress in the bulk bar. */
export interface BulkRun {
  /** Runs a matching action slice by slice with its progress in the bulk bar; resolves with the totals. */
  matching: (label: string, slice: (cursor: string | undefined) => Promise<MatchingSlice>) => Promise<MatchingTotals>;
}

const BulkRunContext = createContext<BulkRun | null>(null);

/** The bulk runner of the list a bulk action sits in. */
export function useBulkRun(): BulkRun {
  const run = useContext(BulkRunContext);
  if (!run) throw new Error("useBulkRun needs a ResourceListPage");
  return run;
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
   * build `query` with the same term. It also names the saved columns and page size.
   */
  list: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: UseQueryOptions<any, any, any, any>;
  /** Response field holding the rows, e.g. "categories". */
  dataKey: string;
  /** Content columns. The kit adds the checkbox and actions columns. */
  columns: ColumnDef<T, unknown>[];
  /** Row height: "default" for a two-line title or a thumbnail, "compact" for one line. */
  density?: RowDensity;
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
  /** The filter fields, shown in the toolbar's "Filters" panel. */
  filters?: ReactNode;
  lifecycle?: ResourceLifecycle<T>;
  /**
   * Bulk buttons for the non-trash tabs; call `done` after success. A
   * `matching` target is every row matching the list's filter: run it with
   * `run.matching` (or `useBulkRun`), never by gathering rows.
   */
  bulkActions?: (target: BulkTarget<T>, done: () => void, run: BulkRun) => ReactNode;
  /** The resource apps' bulk actions run on (`bulk: true` manifest actions, apps.use). */
  appActions?: AppTarget;
  rowTo?: (row: T) => string | undefined;
  /** Names the row for its checkbox and menu ("Select Cotton panjabi"). */
  rowLabel?: (row: T) => string;
  viewUrl?: (row: T) => string | undefined;
  rowActions?: (row: T) => ExtraAction[] | undefined;
  canSelectRow?: (row: T) => boolean;
  sortable?: boolean;
  onReorder?: (oldIndex: number, newIndex: number, rows: T[]) => void;
  /** The list's order when no sort is chosen (the API's default); "Recently updated" unless given. */
  defaultSortLabel?: string;
  /**
   * The API pages this list by cursor (`pageInfo`, a total capped at 1,000):
   * Previous/Next follow the cursors with an approximate count, and any change
   * of filter, sort, tab or search starts again from the first page. `query`
   * must send `search.after` / `search.before` (and no `page` beside them).
   */
  cursorPaging?: boolean;
}

/**
 * The one list screen (Polaris IndexTable and IndexFilters): header, view
 * tabs incl. Trash, the toolbar (search, Filters, sort, columns), the rows,
 * the pager; a sticky bulk bar with "Select all N matching" run on the
 * server; one confirm dialog; the first-run empty state alone in its card.
 */
export function ResourceListPage<T extends { id: string }>(props: ResourceListPageProps<T>) {
  const { search, lifecycle } = props;
  const t = useMessages(resourceMessages);
  const tableCopy = useMessages(dataTableMessages);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const trashed = search.trashed;
  const [term, setTerm] = useListSearch(listSearchKey(props.list, search, props.views?.param));
  // `kept`: selected rows a permanent delete leaves in Trash (canDeleteRow is false).
  const [confirm, setConfirm] = useState<{ action: "trash" | "delete"; target: BulkTarget<T>; kept: number } | null>(null);

  const cursorPaging = props.cursorPaging === true;
  const setSearch = useCallback(
    (updates: Record<string, unknown>) =>
      void navigate({
        search: ((prev: Record<string, unknown>) => ({
          ...prev,
          ...(cursorPaging ? resetCursorUnlessPaging(updates) : updates),
        })) as never,
      }),
    [cursorPaging, navigate],
  );

  // A `?q=` link was adopted as the session term by the loader; the address drops it
  // so search terms never stay in URLs.
  const urlTerm = search.q;
  useEffect(() => {
    if (typeof urlTerm !== "string") return;
    setTerm(urlTerm);
    void navigate({ search: ((prev: Record<string, unknown>) => ({ ...prev, q: undefined })) as never, replace: true });
  }, [navigate, setTerm, urlTerm]);

  const appBulkActions = useAppActions(props.appActions ?? "product", true);
  const hasAppBulkActions = Boolean(props.appActions) && appBulkActions.length > 0;
  useEffect(() => {
    if (hasAppBulkActions) void loadAppActions();
  }, [hasAppBulkActions]);
  const canBulk = trashed
    ? Boolean(lifecycle?.canRestore || lifecycle?.canDelete)
    : Boolean(lifecycle?.canTrash || props.bulkActions || hasAppBulkActions);

  // A matching action's progress, shown in the bulk bar while it runs.
  const [progress, setProgress] = useState<{ label: string; done: number } | null>(null);
  const stopRef = useRef(false);
  const invalidateAll = useCallback(() => {
    for (const queryKey of props.invalidate) void queryClient.invalidateQueries({ queryKey });
  }, [props.invalidate, queryClient]);
  const bulkRun = useMemo<BulkRun>(() => ({
    matching: async (label, slice) => {
      stopRef.current = false;
      setProgress({ label, done: 0 });
      try {
        return await runMatching(slice, (totals) => setProgress({ label, done: totals.processed + totals.skipped }), () => stopRef.current);
      } finally {
        setProgress(null);
        invalidateAll();
      }
    },
  }), [invalidateAll]);

  const mutation = useMutation({
    mutationFn: async ({ action, target }: { action: ResourceAction; target: BulkTarget<T> }) => {
      if (target.kind === "rows") {
        await inChunks(target.rows, (chunk) => lifecycle!.run(action, chunk));
        return null;
      }
      const label = t(action === "trash" ? "movingToTrash" : action === "restore" ? "restoring" : "deleting");
      return bulkRun.matching(label, (cursor) => lifecycle!.runMatching!(action, cursor));
    },
    onSuccess: (totals, { action, target }) => {
      const description = totals?.stopped ? t("bulkStopped", { count: totals.processed }) : undefined;
      if (action === "trash" && target.kind === "rows" && lifecycle?.undoTrash && lifecycle.canRestore) {
        toast.success(t("movedToTrash"), {
          duration: 10_000,
          action: { label: t("undo"), onClick: () => { mutation.mutate({ action: "restore", target }); } },
        });
      } else {
        toast.success(t(action === "trash" ? "movedToTrash" : action === "restore" ? "restored" : "deleted"), { description });
      }
      clearAll();
    },
    onError: (error) => toast.error(getServerFnError(error, t("actionFailed"))),
    onSettled: () => {
      setConfirm(null);
      invalidateAll();
    },
  });

  const { mutate } = mutation;
  const request = useCallback(
    (action: ResourceAction, target: BulkTarget<T>) => {
      if (action === "restore") {
        mutate({ action, target });
        return;
      }
      if (target.kind === "matching") {
        setConfirm({ action, target, kept: 0 });
        return;
      }
      const deletable = action === "delete" && lifecycle?.canDeleteRow ? target.rows.filter(lifecycle.canDeleteRow) : target.rows;
      setConfirm({ action, target: { kind: "rows", rows: deletable }, kept: target.rows.length - deletable.length });
    },
    [lifecycle, mutate],
  );

  const { rowTo, viewUrl, rowActions, rowLabel, columns: contentColumns } = props;
  const columns = useMemo<ColumnDef<T, unknown>[]>(() => {
    const canTrash = !trashed && lifecycle?.canTrash;
    const canRestore = trashed && lifecycle?.canRestore;
    const canDelete = trashed && lifecycle?.canDelete;
    const one = (row: T): BulkTarget<T> => ({ kind: "rows", rows: [row] });
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
        onDelete: canTrash ? (row) => request("trash", one(row)) : undefined,
        onRestore: canRestore ? (row) => request("restore", one(row)) : undefined,
        onPermanentDelete: canDelete ? (row) => request("delete", one(row)) : undefined,
        canPermanentDelete: lifecycle?.canDeleteRow,
        getExtraActions: trashed ? undefined : rowActions,
        getMenuLabel: rowLabel ? (row) => t("actionsFor", { name: rowLabel(row) }) : undefined,
      }),
    ];
  }, [canBulk, contentColumns, lifecycle, navigate, request, rowActions, rowLabel, rowTo, t, trashed, viewUrl]);

  const dataSelector = useMemo(() => createDataSelector<T>(props.dataKey), [props.dataKey]);
  const { table, error, isFetching, isLoading, refetch, selectedRows, clearSelection, pagination, pageInfo } = useServerTable<T>({
    columns,
    queryOptions: props.query,
    dataSelector,
    currentPage: cursorPaging ? 1 : search.page,
    currentLimit: search.limit,
    currentSort: search.sort,
    currentOrder: search.order,
    onPaginationChange: (page, limit) => setSearch({ page: cursorPaging ? 1 : page, limit }),
    onSortingChange: (sort, order) => setSearch({ sort, order, page: 1 }),
    enableRowSelection: props.canSelectRow ? (row) => props.canSelectRow!(row.original) : true,
  });

  // A cursor or page the API refuses (an old bookmark, a hand-edited URL, a
  // list whose sort changed) starts the list again from its first page.
  const refused = isPagingRefusal(error);
  useEffect(() => {
    if (refused) setSearch({ page: 1, ...NO_CURSOR });
  }, [refused, setSearch]);

  // "Select all N matching" (Polaris IndexTable): offered once the whole page
  // is ticked; the action then sends the list's filter, never the rows.
  const [allMatching, setAllMatching] = useState(false);
  const scope = hashKey(props.query.queryKey);
  const pageAllSelected = table.getIsAllPageRowsSelected();
  useEffect(() => setAllMatching(false), [scope]);
  useEffect(() => {
    if (!pageAllSelected) setAllMatching(false);
  }, [pageAllSelected]);
  const clearAll = () => {
    setAllMatching(false);
    clearSelection();
  };
  const capped = pagination.totalIsCapped === true;
  const supportsMatching = trashed ? Boolean(lifecycle?.runMatching) : Boolean(lifecycle?.runMatching || props.bulkActions);
  const canSelectAll = supportsMatching && pageAllSelected && !allMatching && pagination.total > selectedRows.length;
  const target: BulkTarget<T> = allMatching
    ? { kind: "matching", count: pagination.total, capped }
    : { kind: "rows", rows: selectedRows };

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
  const filterCount = filterParams.filter((param) => search[param] !== undefined).length;
  const clearFilters = () =>
    setSearch({ ...Object.fromEntries(filterParams.map((param) => [param, undefined])), page: 1 });
  const filtered = Boolean(term) || currentView !== "all" || filterCount > 0;
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

  const running = progress !== null;
  const someDeletable = target.kind === "matching" || !lifecycle?.canDeleteRow || target.rows.some((row) => lifecycle.canDeleteRow!(row));
  const selectionStatus = running ? (
    <span className="flex items-center gap-2" role="status" aria-live="polite">
      {t("bulkProgress", { label: progress.label, count: progress.done })}
      <Button variant="link" onClick={() => { stopRef.current = true; }}>{t("stop")}</Button>
    </span>
  ) : allMatching ? (
    <span>{t(capped ? "allMatchingSelectedCapped" : "allMatchingSelected", { count: pagination.total })}</span>
  ) : (
    <>
      <span>{t("selected", { count: selectedRows.length })}</span>
      {canSelectAll ? (
        <Button variant="link" onClick={() => setAllMatching(true)}>
          {t(capped ? "selectAllMatchingCapped" : "selectAllMatching", { count: pagination.total })}
        </Button>
      ) : null}
    </>
  );
  const bulkButtons = (
    <>
      {trashed && lifecycle?.canRestore ? (
        <Button variant="outline" disabled={running} loading={mutation.isPending && mutation.variables?.action === "restore"} onClick={() => request("restore", target)}>
          {t("restore")}
        </Button>
      ) : null}
      {trashed && lifecycle?.canDelete ? (
        // Offered only when at least one selected row can really be deleted.
        <Button variant="destructive" disabled={running || !someDeletable} onClick={() => request("delete", target)}>
          {t("deletePermanently")}
        </Button>
      ) : null}
      {!trashed ? props.bulkActions?.(target, clearAll, bulkRun) : null}
      {!trashed && props.appActions && hasAppBulkActions && target.kind === "rows" ? (
        <Suspense fallback={null}>
          <AppBulkActionsMenu target={props.appActions} ids={target.rows.map((row) => row.id)} onDone={clearAll} />
        </Suspense>
      ) : null}
      {!trashed && lifecycle?.canTrash && (target.kind === "rows" || lifecycle.runMatching) ? (
        <Button variant="outline" disabled={running} onClick={() => request("trash", target)}>
          {t("moveToTrash")}
        </Button>
      ) : null}
    </>
  );
  const bulkBar = selectedRows.length > 0 || running ? (
    <IndexBulkBar status={selectionStatus} actions={running ? null : bulkButtons} onClear={() => { stopRef.current = true; clearAll(); }} />
  ) : undefined;

  const confirmTarget = confirm?.target;
  const count = confirmTarget ? (confirmTarget.kind === "rows" ? confirmTarget.rows.length : confirmTarget.count) : 0;
  const countText = props.countLabel ? props.countLabel(count) : count;
  const confirmTitle = !confirm || !confirmTarget
    ? ""
    : confirmTarget.kind === "matching"
      ? t(confirm.action === "delete"
        ? (confirmTarget.capped ? "deleteMatchingCappedTitle" : "deleteMatchingTitle")
        : (confirmTarget.capped ? "trashMatchingCappedTitle" : "trashMatchingTitle"), { count })
      : count === 1 && rowLabel
        ? t(confirm.action === "delete" ? "deleteOneTitle" : "trashOneTitle", { name: rowLabel(confirmTarget.rows[0]!) })
        : t(confirm.action === "delete" ? "deleteTitle" : "trashTitle", { count: countText });
  const confirmLoaded = useOpenedOnce(confirm !== null);
  const rowCount = table.getRowModel().rows.length;
  // Nothing created yet: the first-run card alone, no tabs, search or headings (E1).
  const nothingYet = !filtered && !trashed && !isLoading && !error && pagination.total === 0 && rowCount === 0;

  return (
    <BulkRunContext.Provider value={bulkRun}>
    <div className="pb-8">
      <PageHeader title={props.title} actions={trashed || nothingYet ? undefined : props.actions} />
      {nothingYet ? (
        <div className="overflow-clip rounded-xl bg-card shadow-card">
          <Suspense fallback={null}>
            <EmptyState icon={Icon} title={props.empty.title} description={props.empty.description} action={props.empty.action ?? props.actions} help />
          </Suspense>
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
        density={props.density}
        defaultSortLabel={props.defaultSortLabel ?? tableCopy("recentlyUpdated")}
        getRowHref={trashed ? undefined : rowTo}
        emptyState={emptyState}
        // Reorder only when the whole list is on screen (at most 90 rows per
        // write): renumbering a partial page would duplicate positions.
        sortable={Boolean(props.sortable) && pagination.page === 1 && rowCount > 1 && pagination.total === rowCount && pagination.total <= 90}
        onReorder={props.onReorder ? (from, to) => props.onReorder!(from, to, table.getRowModel().rows.map((row) => row.original)) : undefined}
        getRowLabel={rowLabel}
        cursorPaging={cursorPaging ? {
          total: pagination.total,
          totalIsCapped: pagination.totalIsCapped,
          offset: pagination.offset,
          pageInfo,
          onNext: (endCursor) => setSearch({ after: endCursor, before: undefined, page: 1 }),
          onPrevious: (startCursor) => setSearch({ before: startCursor, after: undefined, page: 1 }),
        } : undefined}
        toolbar={
          <>
            {tabs.length > 1 ? <IndexTabs tabs={tabs} value={currentView} onChange={onTabChange} /> : null}
            <DataTableToolbar
              searchValue={term}
              onSearchChange={(value) => {
                setTerm(value);
                if (search.page !== 1 || search.after || search.before) setSearch({ page: 1 });
              }}
              searchPlaceholder={props.searchPlaceholder ?? t("search")}
              bulkBar={bulkBar}
              filters={props.filters}
              filterCount={filterCount}
              onClearFilters={clearFilters}
            />
          </>
        }
      />
      )}
      {confirmLoaded ? (
        <Suspense fallback={null}>
          <ConfirmDialog
            open={confirm !== null}
            onOpenChange={(open) => {
              if (!open && !mutation.isPending) setConfirm(null);
            }}
            title={confirmTitle}
            description={[
              t(confirm?.action === "delete" ? "deleteBody" : count === 1 ? "trashBodyOne" : "trashBody"),
              confirm?.kept ? lifecycle?.deleteBlockedNote?.(confirm.kept) : undefined,
            ].filter(Boolean).join(" ")}
            confirmLabel={t(confirm?.action === "delete" ? "deletePermanently" : "moveToTrash")}
            loadingLabel={t("working")}
            cancelLabel={t("cancel")}
            variant={confirm?.action === "delete" ? "destructive" : "default"}
            isLoading={mutation.isPending}
            onConfirm={() => {
              if (!confirm) return;
              // A matching action shows its progress in the bulk bar, not behind a dialog.
              if (confirm.target.kind === "matching") setConfirm(null);
              mutation.mutate({ action: confirm.action, target: confirm.target });
            }}
          />
        </Suspense>
      ) : null}
    </div>
    </BulkRunContext.Provider>
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

/**
 * Link for the primary cell of a resource row (name/title): at most two
 * lines (one above a note), with the whole name on hover where it may be cut (T7).
 */
export function ResourceRowLink({ to, lines = 2, title, children }: {
  to?: string;
  lines?: 1 | 2;
  /** The whole name on hover; a plain-text name is its own title. */
  title?: string;
  children: ReactNode;
}) {
  const clamp = lines === 1 ? "line-clamp-1" : "line-clamp-2";
  const whole = title ?? (typeof children === "string" ? children : undefined);
  return to ? (
    <Link to={to} title={whole} className={cn("break-words font-medium text-foreground hover:underline", clamp)}>
      {children}
    </Link>
  ) : (
    <span title={whole} className={cn("break-words font-medium", clamp)}>{children}</span>
  );
}
