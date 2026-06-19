import { useMemo, useCallback } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import { PlusCircle, Trash2, Layers } from "lucide-react";
import { createListSearchValidator, createDataSelector } from "~/lib/list-helpers";
import { RouteErrorComponent } from "~/lib/route-error";
import { collectionsQueryOptions } from "~/lib/api-query-options/collections";
import { warmRouteQuery } from "~/lib/route-query-warming";
import {
  useUpdateCollection,
  useDeleteCollection,
  usePermanentDeleteCollection,
  useRestoreCollection,
  useBulkDeleteCollections,
  useReorderCollections,
} from "~/lib/api-mutations/collections";
import {
  DataTable,
  DataTableToolbar,
  useServerTable,
} from "~/components/admin/data-table";
import {
  getCollectionColumns,
  type CollectionItem,
} from "~/components/admin/data-table/columns/collection-columns";

const validateCollectionSearch = createListSearchValidator(
  ["name", "type", "isActive", "sortOrder", "updatedAt"] as const,
  { sort: "sortOrder", order: "asc" },
);

function mapParams(deps: ReturnType<typeof validateCollectionSearch>) {
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
  validateSearch: validateCollectionSearch,
  loaderDeps: ({ search }) => search,
  staleTime: 1000 * 60 * 2,
  loader: async ({ context: { queryClient }, deps }) => {
    await warmRouteQuery(queryClient, collectionsQueryOptions(mapParams(deps)));
  },
  head: ({ match }) => ({
    meta: [
      {
        title: `${match.search.trashed ? "Collections Trash" : "Collections"} | Scalius Admin`,
      },
    ],
  }),
  component: CollectionsPage,
  errorComponent: RouteErrorComponent,
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
  const reorderMutation = useReorderCollections();

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
      void navigate({ to: "/admin/collections/$collectionId/edit", params: { collectionId: id } });
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
  const dataSelector = useMemo(() => createDataSelector<CollectionItem>("collections"), []);

  // URL param updaters
  const onPaginationChange = useCallback(
    (page: number, limit: number) => {
      void navigate({
        search: ((prev: Record<string, unknown>) => ({
          ...prev,
          page,
          limit,
        })) as never,
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
        })) as never,
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
        })) as never,
      });
    },
    [navigate],
  );

  // Server table
  const { table, isFetching, isLoading, selectedIds, clearSelection } =
    useServerTable<CollectionItem>({
      columns,
      queryOptions: collectionsQueryOptions(mapParams(search)),
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

  // Drag-and-drop reorder: only enabled when sorted by sortOrder asc and not trashed
  const isDragEnabled =
    !showTrashed && search.sort === "sortOrder" && search.order === "asc" && !search.search;

  const handleReorder = useCallback(
    (oldIndex: number, newIndex: number) => {
      const rows = table.getRowModel().rows;
      // Build the new sort order based on the reordered positions
      const items = rows.map((r) => r.original);
      const [movedItem] = items.splice(oldIndex, 1);
      items.splice(newIndex, 0, movedItem);
      const reorderData = items.map((item, idx) => ({
        id: item.id,
        sortOrder: idx,
      }));
      reorderMutation.mutate({ items: reorderData });
    },
    [table, reorderMutation],
  );

  // Toolbar
  const toolbar = (
    <DataTableToolbar
      searchValue={search.search}
      onSearchChange={onSearchChange}
      searchPlaceholder="Search collections..."
      selectedCount={selectedIds.length}
      bulkActions={
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
            : isDragEnabled
              ? "Drag collections to change their display order on your store."
              : "Organize your products into curated collections."}
        </p>
      </div>

      <DataTable
        table={table}
        isFetching={isFetching}
        isLoading={isLoading}
        toolbar={toolbar}
        itemLabel="collections"
        sortable={isDragEnabled}
        onReorder={handleReorder}
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
