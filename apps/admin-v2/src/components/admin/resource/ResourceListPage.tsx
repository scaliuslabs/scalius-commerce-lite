import { useCallback, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient, type QueryKey, type UseQueryOptions } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import type { ExtraAction } from "~/components/admin/data-table/DataTableRowActions";
import { useServerTable } from "~/components/admin/data-table/useServerTable";
import { createActionsColumn, createSelectColumn } from "~/components/admin/data-table/columns/column-factories";
import { flexRender, type ColumnDef, type Row } from "~/components/admin/data-table/table-config";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { createDataSelector, type ListSearchParams } from "~/lib/list-helpers";
import { getServerFnError } from "~/lib/api-helpers";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { IndexTabs, type IndexTab } from "./IndexTabs";
import { PageHeader } from "./PageHeader";
import { EmptyState } from "./EmptyState";

export type ResourceAction = "trash" | "restore" | "delete";

export interface ResourceLifecycle<T> {
  canTrash: boolean;
  canRestore: boolean;
  canDelete: boolean;
  /** Per-row guard for permanent delete (e.g. records tied to orders). */
  canDeleteRow?: (row: T) => boolean;
  /** Runs one action for one or more rows; send revision claims from the rows. */
  run: (action: ResourceAction, rows: T[]) => Promise<unknown>;
}

export interface ResourceListPageProps<T extends { id: string }> {
  title: string;
  /** Header buttons; the create action goes last. */
  actions?: ReactNode;
  /** The route's validated search (page, limit, search, sort, order, trashed…). */
  search: ListSearchParams & Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: UseQueryOptions<any, any, any, any>;
  /** Response field holding the rows, e.g. "categories". */
  dataKey: string;
  /** Content columns. The kit adds the checkbox and actions columns. */
  columns: ColumnDef<T, unknown>[];
  /** Query keys refreshed after any trash, restore, delete or bulk action. */
  invalidate: readonly QueryKey[];
  empty: { icon: ComponentType<{ className?: string }>; title: string; description: string; action?: ReactNode };
  /** Extra tabs next to All, stored in `search[views.param]`. */
  views?: { param: string; tabs: ReadonlyArray<IndexTab<string>> };
  filters?: ReactNode;
  lifecycle?: ResourceLifecycle<T>;
  /** Extra bulk buttons for the non-trash tabs; call `done` after success. */
  bulkActions?: (rows: T[], done: () => void) => ReactNode;
  rowTo?: (row: T) => string | undefined;
  viewUrl?: (row: T) => string | undefined;
  rowActions?: (row: T) => ExtraAction[] | undefined;
  canSelectRow?: (row: T) => boolean;
  sortable?: boolean;
  onReorder?: (oldIndex: number, newIndex: number, rows: T[]) => void;
}

/**
 * The one list screen (Polaris IndexTable): header, tabs incl. Trash, search,
 * bulk actions, one confirm dialog, empty state and an automatic phone card
 * built from `meta.mobile` column flags.
 */
export function ResourceListPage<T extends { id: string }>(props: ResourceListPageProps<T>) {
  const { search, lifecycle } = props;
  const t = useMessages(resourceMessages);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const trashed = search.trashed;
  const [confirm, setConfirm] = useState<{ action: "trash" | "delete"; rows: T[] } | null>(null);

  const setSearch = useCallback(
    (updates: Record<string, unknown>) =>
      void navigate({ search: ((prev: Record<string, unknown>) => ({ ...prev, ...updates })) as never }),
    [navigate],
  );

  const canBulk = trashed
    ? Boolean(lifecycle?.canRestore || lifecycle?.canDelete)
    : Boolean(lifecycle?.canTrash || props.bulkActions);

  const mutation = useMutation({
    mutationFn: ({ action, rows }: { action: ResourceAction; rows: T[] }) => lifecycle!.run(action, rows),
    onSuccess: (_data, { action }) => {
      toast.success(t(action === "trash" ? "movedToTrash" : action === "restore" ? "restored" : "deleted"));
      clearSelection();
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
      if (action === "restore") mutate({ action, rows });
      else setConfirm({ action, rows });
    },
    [mutate],
  );

  const { rowTo, viewUrl, rowActions, columns: contentColumns } = props;
  const columns = useMemo<ColumnDef<T, unknown>[]>(() => {
    const canTrash = !trashed && lifecycle?.canTrash;
    const canRestore = trashed && lifecycle?.canRestore;
    const canDelete = trashed && lifecycle?.canDelete;
    return [
      ...(canBulk ? [createSelectColumn<T>()] : []),
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
      }),
    ];
  }, [canBulk, contentColumns, lifecycle, navigate, request, rowActions, rowTo, trashed, viewUrl]);

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

  const filtered = Boolean(search.search) || currentView !== "all";
  const Icon = props.empty.icon;
  const emptyState = trashed
    ? { icon: Icon, title: t("trashEmpty"), description: "" }
    : filtered
      ? { icon: Icon, title: t("noResults"), description: t("noResultsHint") }
      : props.empty;

  const bulkButtons = selectedRows.length > 0 ? (
    <>
      {trashed && lifecycle?.canRestore ? (
        <Button variant="outline" size="sm" disabled={mutation.isPending} onClick={() => request("restore", selectedRows)}>
          {t("restore")}
        </Button>
      ) : null}
      {trashed && lifecycle?.canDelete ? (
        <Button variant="destructive" size="sm" onClick={() => request("delete", selectedRows)}>
          {t("deletePermanently")}
        </Button>
      ) : null}
      {!trashed ? props.bulkActions?.(selectedRows, clearSelection) : null}
      {!trashed && lifecycle?.canTrash ? (
        <Button variant="outline" size="sm" onClick={() => request("trash", selectedRows)}>
          {t("moveToTrash")}
        </Button>
      ) : null}
    </>
  ) : undefined;

  const mobileCard = (row: Row<T>) => {
    const cells = row.getVisibleCells();
    const slot = (name: "primary" | "secondary" | "status") =>
      cells
        .filter((cell) => cell.column.columnDef.meta?.mobile === name)
        .map((cell) => <div key={cell.id} className="min-w-0">{flexRender(cell.column.columnDef.cell, cell.getContext())}</div>);
    const actionsCell = cells.find((cell) => cell.column.id === "actions");
    return (
      <div className="flex items-start gap-3 px-3 py-2.5">
        {canBulk ? (
          <Checkbox
            checked={row.getIsSelected()}
            disabled={!row.getCanSelect()}
            onCheckedChange={(value) => row.toggleSelected(Boolean(value))}
            aria-label={t("selectRow")}
            className="mt-3"
          />
        ) : null}
        <div className="min-w-0 flex-1 space-y-1">
          {slot("primary")}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">{slot("secondary")}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {slot("status")}
          {actionsCell ? flexRender(actionsCell.column.columnDef.cell, actionsCell.getContext()) : null}
        </div>
      </div>
    );
  };

  const count = confirm?.rows.length ?? 0;
  const rowCount = table.getRowModel().rows.length;
  // Nothing created yet: one card with the empty state instead of an empty table.
  const nothingYet = !filtered && !trashed && !isLoading && !error && pagination.total === 0 && rowCount === 0;
  const tabBar = tabs.length > 1 ? <IndexTabs tabs={tabs} value={currentView} onChange={onTabChange} /> : null;

  return (
    <div className="pb-8">
      <PageHeader title={props.title} actions={trashed || nothingYet ? undefined : props.actions} />
      {nothingYet ? (
        <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
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
        mobileCardRenderer={mobileCard}
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
                searchValue={search.search}
                onSearchChange={(value) => setSearch({ search: value || undefined, page: 1 })}
                searchPlaceholder={t("search")}
                selectedCount={selectedRows.length}
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
        title={t(confirm?.action === "delete" ? "deleteTitle" : "trashTitle", { count })}
        description={t(confirm?.action === "delete" ? "deleteBody" : "trashBody")}
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

/** Link for the primary cell of a resource row (name/title). */
export function ResourceRowLink({ to, children }: { to?: string; children: ReactNode }) {
  return to ? (
    <Link to={to} className="block truncate font-medium text-foreground hover:underline">
      {children}
    </Link>
  ) : (
    <span className="block truncate font-medium">{children}</span>
  );
}
