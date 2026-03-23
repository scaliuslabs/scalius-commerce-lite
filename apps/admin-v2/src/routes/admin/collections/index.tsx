import { useMemo, useCallback } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Button } from "~/components/ui/button";
import { PlusCircle, Trash2, Layers, Undo } from "lucide-react";
import { collectionsQueryOptions } from "~/lib/api.queries";
import {
  useUpdateCollection,
  useDeleteCollection,
  usePermanentDeleteCollection,
  useRestoreCollection,
  useBulkDeleteCollections,
  useBulkRestoreCollections,
} from "~/lib/api.mutations";
import {
  DataTable,
  DataTableToolbar,
  useServerTable,
  type ServerTablePagination,
} from "~/components/admin/data-table";
import {
  getCollectionColumns,
  type CollectionItem,
} from "~/components/admin/data-table/columns/collection-columns";

const searchSchema = z.object({
  page: z.number().default(1).catch(1),
  limit: z.number().default(20).catch(20),
  search: z.string().default("").catch(""),
  sort: z
    .enum(["name", "type", "isActive", "sortOrder", "updatedAt"])
    .default("sortOrder")
    .catch("sortOrder"),
  order: z.enum(["asc", "desc"]).default("asc").catch("asc"),
  trashed: z.boolean().default(false).catch(false),
});

function mapParams(deps: z.infer<typeof searchSchema>) {
  return {
    page: deps.page,
    limit: deps.limit,
    search: deps.search || undefined,
    sort: deps.sort,
    order: deps.order,
    showTrashed: deps.trashed,
  };
}

export const Route = createFileRoute("/admin/collections/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => {
    void queryClient.prefetchQuery(collectionsQueryOptions(mapParams(deps)));
  },
  head: ({ match }) => ({
    meta: [
      {
        title: `${match.search.trashed ? "Collections Trash" : "Collections"} | Scalius Admin`,
      },
    ],
  }),
  component: CollectionsPage,
});

function CollectionsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const showTrashed = search.trashed;

  // Mutations
  const updateMutation = useUpdateCollection();
  const deleteMutation = useDeleteCollection();
  const permanentDeleteMutation = usePermanentDeleteCollection();
  const restoreMutation = useRestoreCollection();
  const bulkDeleteMutation = useBulkDeleteCollections();
  const bulkRestoreMutation = useBulkRestoreCollections();

  // Track which IDs are currently being saved (for inline edit spinner)
  const savingIds = useMemo(() => {
    const ids = new Set<string>();
    if (updateMutation.isPending && updateMutation.variables) {
      ids.add(updateMutation.variables.id);
    }
    return ids;
  }, [updateMutation.isPending, updateMutation.variables]);

  // Column action callbacks
  const handleUpdateName = useCallback(
    (id: string, name: string) => {
      updateMutation.mutate({ id, name });
    },
    [updateMutation],
  );

  const handleToggleActive = useCallback(
    (id: string, isActive: boolean) => {
      updateMutation.mutate({ id, isActive });
    },
    [updateMutation],
  );

  const handleEdit = useCallback(
    (id: string) => {
      void navigate({ to: `/admin/collections/${id}/edit` as string });
    },
    [navigate],
  );

  const handleDelete = useCallback(
    (id: string) => {
      deleteMutation.mutate(id);
    },
    [deleteMutation],
  );

  const handleRestore = useCallback(
    (id: string) => {
      restoreMutation.mutate(id);
    },
    [restoreMutation],
  );

  const handlePermanentDelete = useCallback(
    (id: string) => {
      permanentDeleteMutation.mutate(id);
    },
    [permanentDeleteMutation],
  );

  // Columns
  const columns = useMemo(
    () =>
      getCollectionColumns({
        showTrashed,
        savingIds,
        onUpdateName: handleUpdateName,
        onToggleActive: handleToggleActive,
        onEdit: handleEdit,
        onDelete: handleDelete,
        onRestore: handleRestore,
        onPermanentDelete: handlePermanentDelete,
      }),
    [
      showTrashed,
      savingIds,
      handleUpdateName,
      handleToggleActive,
      handleEdit,
      handleDelete,
      handleRestore,
      handlePermanentDelete,
    ],
  );

  // Data selector
  const dataSelector = useCallback(
    (raw: unknown) => {
      const d = raw as {
        collections?: CollectionItem[];
        pagination?: ServerTablePagination;
      };
      return {
        data: (d.collections || []) as CollectionItem[],
        pagination: d.pagination || {
          total: 0,
          page: search.page,
          limit: search.limit,
          totalPages: 0,
        },
      };
    },
    [search.page, search.limit],
  );

  // URL param updaters
  const onPaginationChange = useCallback(
    (page: number, limit: number) => {
      void navigate({
        search: ((prev: Record<string, unknown>) => ({
          ...prev,
          page,
          limit,
        })) as any,
      });
    },
    [navigate],
  );

  const onSortingChange = useCallback(
    (sort: string, order: "asc" | "desc") => {
      void navigate({
        search: ((prev: Record<string, unknown>) => ({
          ...prev,
          sort,
          order,
          page: 1,
        })) as any,
      });
    },
    [navigate],
  );

  const onSearchChange = useCallback(
    (value: string) => {
      void navigate({
        search: ((prev: Record<string, unknown>) => ({
          ...prev,
          search: value || undefined,
          page: 1,
        })) as any,
      });
    },
    [navigate],
  );

  // Server table
  const { table, isFetching, isLoading, selectedIds, clearSelection } =
    useServerTable<CollectionItem>({
      columns,
      queryOptions: collectionsQueryOptions(mapParams(search)) as any,
      dataSelector,
      currentPage: search.page,
      currentLimit: search.limit,
      currentSort: search.sort,
      currentOrder: search.order,
      onPaginationChange,
      onSortingChange,
    });

  // Bulk action handlers
  const handleBulkDelete = useCallback(() => {
    if (selectedIds.length === 0) return;
    bulkDeleteMutation.mutate(
      { ids: selectedIds, permanent: showTrashed },
      { onSuccess: clearSelection },
    );
  }, [selectedIds, showTrashed, bulkDeleteMutation, clearSelection]);

  const handleBulkRestore = useCallback(() => {
    if (selectedIds.length === 0) return;
    bulkRestoreMutation.mutate(
      { ids: selectedIds },
      { onSuccess: clearSelection },
    );
  }, [selectedIds, bulkRestoreMutation, clearSelection]);

  // Toolbar
  const toolbar = (
    <DataTableToolbar
      searchValue={search.search}
      onSearchChange={onSearchChange}
      searchPlaceholder="Search collections..."
      selectedCount={selectedIds.length}
      bulkActions={
        <>
          {showTrashed && (
            <Button variant="outline" size="sm" onClick={handleBulkRestore}>
              <Undo className="h-4 w-4 mr-1.5" />
              Restore ({selectedIds.length})
            </Button>
          )}
          <Button
            variant={showTrashed ? "destructive" : "outline"}
            size="sm"
            onClick={handleBulkDelete}
            className={
              !showTrashed
                ? "text-destructive border-destructive hover:bg-destructive/10"
                : undefined
            }
          >
            <Trash2 className="h-4 w-4 mr-1.5" />
            {showTrashed
              ? `Delete (${selectedIds.length})`
              : `Trash (${selectedIds.length})`}
          </Button>
        </>
      }
      actions={
        <div className="flex items-center gap-2">
          <Link
            to="/admin/collections"
            search={showTrashed ? {} : { trashed: true }}
          >
            <Button variant="outline" size="sm">
              {showTrashed ? (
                <>
                  <Layers className="mr-2 h-4 w-4" />
                  View Active
                </>
              ) : (
                <>
                  <Trash2 className="mr-2 h-4 w-4" />
                  View Trash
                </>
              )}
            </Button>
          </Link>
          {!showTrashed && (
            <Link to="/admin/collections/new">
              <Button>
                <PlusCircle className="mr-2 h-4 w-4" />
                New Collection
              </Button>
            </Link>
          )}
        </div>
      }
    />
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {showTrashed ? "Collections Trash" : "Collections"}
        </h1>
        <p className="text-muted-foreground">
          {showTrashed
            ? "View, restore, or permanently delete trashed collections."
            : "Organize your products into curated collections"}
        </p>
      </div>

      <DataTable
        table={table}
        isFetching={isFetching}
        isLoading={isLoading}
        toolbar={toolbar}
        itemLabel="collections"
        emptyState={{
          icon: Layers,
          title: search.search
            ? "No collections found"
            : showTrashed
              ? "Trash is empty"
              : "No collections yet",
          description: search.search
            ? "Try adjusting your search query."
            : showTrashed
              ? "Deleted collections will appear here."
              : "Create your first collection to get started.",
          action:
            !showTrashed && !search.search ? (
              <Button
                onClick={() =>
                  void navigate({ to: "/admin/collections/new" })
                }
              >
                <PlusCircle className="h-4 w-4 mr-2" />
                New Collection
              </Button>
            ) : undefined,
        }}
      />
    </div>
  );
}
