import { useMemo, useCallback, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import { Tags, Trash2, Plus } from "lucide-react";
import { createListSearchValidator, createDataSelector } from "~/lib/list-helpers";
import { RouteErrorComponent } from "~/lib/route-error";
import { attributesQueryOptions } from "~/lib/api-query-options/attributes";
import { warmRouteQuery } from "~/lib/route-query-warming";
import {
  useUpdateAttribute,
  useCreateAttribute,
  useDeleteAttribute,
  usePermanentDeleteAttribute,
  useRestoreAttribute,
  useBulkDeleteAttributes,
} from "~/lib/api-mutations/attributes";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { useServerTable } from "~/components/admin/data-table/useServerTable";
import {
  getAttributeColumns,
  type AttributeItem,
} from "~/components/admin/data-table/columns/attribute-columns";
import {
  AttributeCreateDialog,
  AttributeDeleteDialog,
  AttributeValuesViewer,
  AttributeValueEditor,
} from "~/components/admin/attributes-manager/components";
import type { NewAttribute } from "~/components/admin/attributes-manager/types";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";

const validateAttributeSearch = createListSearchValidator(
  ["name", "slug", "filterable", "updatedAt"] as const,
  { sort: "name", order: "asc" },
);

function mapParams(deps: ReturnType<typeof validateAttributeSearch>) {
  return {
    page: deps.page,
    limit: deps.limit,
    search: deps.search || undefined,
    sort: deps.sort,
    order: deps.order,
    trashed: deps.trashed,
  };
}

export const Route = createFileRoute("/admin/attributes")({
  validateSearch: validateAttributeSearch,
  loaderDeps: ({ search }) => search,
  staleTime: 1000 * 60 * 2,
  loader: async ({ context: { queryClient }, deps }) => {
    await warmRouteQuery(queryClient, attributesQueryOptions(mapParams(deps)));
  },
  head: ({ match }) => ({
    meta: [
      {
        title: `${match.search.trashed ? "Attribute Trash" : "Product Attributes"} | Scalius Admin`,
      },
    ],
  }),
  component: AttributesPage,
  errorComponent: RouteErrorComponent,
});

function AttributesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const showTrashed = search.trashed;
  const { attributes: attributeActions } = useCatalogActionPermissions();

  // Mutations
  const updateMutation = useUpdateAttribute();
  const createMutation = useCreateAttribute();
  const deleteMutation = useDeleteAttribute();
  const permanentDeleteMutation = usePermanentDeleteAttribute();
  const restoreMutation = useRestoreAttribute();
  const bulkDeleteMutation = useBulkDeleteAttributes();

  // Dialog states for attribute-specific features
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newAttribute, setNewAttribute] = useState<NewAttribute>({
    name: "",
    slug: "",
    filterable: true,
    options: [],
  });
  const [viewValuesFor, setViewValuesFor] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [editValuesFor, setEditValuesFor] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<{
    ids: string[];
    permanent: boolean;
  } | null>(null);

  // Track which IDs are currently being saved
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
      if (!attributeActions.canEdit) return;
      updateMutation.mutate({ id, name });
    },
    [attributeActions.canEdit, updateMutation],
  );

  const handleUpdateSlug = useCallback(
    (id: string, slug: string) => {
      if (!attributeActions.canEdit) return;
      updateMutation.mutate({ id, slug });
    },
    [attributeActions.canEdit, updateMutation],
  );

  const handleToggleFilterable = useCallback(
    (id: string, filterable: boolean) => {
      if (!attributeActions.canEdit) return;
      updateMutation.mutate({ id, filterable });
    },
    [attributeActions.canEdit, updateMutation],
  );

  const handleViewValues = useCallback(
    (id: string, name: string) => {
      setViewValuesFor({ id, name });
    },
    [],
  );

  const handleEditValues = useCallback(
    (id: string, name: string) => {
      if (attributeActions.canEdit) setEditValuesFor({ id, name });
    },
    [attributeActions.canEdit],
  );

  const handleDelete = useCallback(
    (id: string) => {
      if (!attributeActions.canDelete) return;
      setDeleteRequest({ ids: [id], permanent: false });
    },
    [attributeActions.canDelete],
  );

  const handleRestore = useCallback(
    (id: string) => {
      if (!attributeActions.canRestore) return;
      restoreMutation.mutate(id);
    },
    [attributeActions.canRestore, restoreMutation],
  );

  const handlePermanentDelete = useCallback(
    (id: string) => {
      if (!attributeActions.canPermanentDelete) return;
      setDeleteRequest({ ids: [id], permanent: true });
    },
    [attributeActions.canPermanentDelete],
  );

  // Create attribute handlers
  const handleNewAttributeNameChange = (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const name = e.target.value;
    const slug = name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
    setNewAttribute((prev) => ({ ...prev, name, slug }));
  };

  const handleCreateAttribute = () => {
    if (!attributeActions.canCreate) return;
    createMutation.mutate(newAttribute, {
      onSuccess: () => {
        setNewAttribute({ name: "", slug: "", filterable: true, options: [] });
        setShowCreateDialog(false);
      },
    });
  };

  // Columns
  const columns = useMemo(
    () =>
      getAttributeColumns({
        showTrashed,
        savingIds,
        canSelect: attributeActions.canBulkDelete,
        canEdit: attributeActions.canEdit,
        canDelete: attributeActions.canDelete,
        canRestore: attributeActions.canRestore,
        canPermanentDelete: attributeActions.canPermanentDelete,
        onUpdateName: handleUpdateName,
        onUpdateSlug: handleUpdateSlug,
        onToggleFilterable: handleToggleFilterable,
        onViewValues: handleViewValues,
        onEditValues: handleEditValues,
        onDelete: handleDelete,
        onRestore: handleRestore,
        onPermanentDelete: handlePermanentDelete,
      }),
    [
      showTrashed,
      savingIds,
      attributeActions,
      handleUpdateName,
      handleUpdateSlug,
      handleToggleFilterable,
      handleViewValues,
      handleEditValues,
      handleDelete,
      handleRestore,
      handlePermanentDelete,
    ],
  );

  // Data selector
  const dataSelector = useMemo(() => createDataSelector<AttributeItem>("attributes"), []);

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
  const { table, error, isFetching, isLoading, refetch, selectedIds, clearSelection } =
    useServerTable<AttributeItem>({
      columns,
      queryOptions: attributesQueryOptions(mapParams(search)),
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
    if (!attributeActions.canBulkDelete || selectedIds.length === 0) return;
    setDeleteRequest({ ids: [...selectedIds], permanent: showTrashed });
  }, [
    attributeActions.canBulkDelete,
    selectedIds,
    showTrashed,
  ]);

  const handleConfirmDelete = useCallback(() => {
    if (!deleteRequest) return;
    const onSuccess = () => {
      if (deleteRequest.ids.length > 1) clearSelection();
      setDeleteRequest(null);
    };

    if (deleteRequest.ids.length > 1) {
      bulkDeleteMutation.mutate(deleteRequest, { onSuccess });
    } else if (deleteRequest.permanent) {
      permanentDeleteMutation.mutate(deleteRequest.ids[0]!, { onSuccess });
    } else {
      deleteMutation.mutate(deleteRequest.ids[0]!, { onSuccess });
    }
  }, [
    bulkDeleteMutation,
    clearSelection,
    deleteMutation,
    deleteRequest,
    permanentDeleteMutation,
  ]);

  const deletePending =
    deleteMutation.isPending ||
    permanentDeleteMutation.isPending ||
    bulkDeleteMutation.isPending;

  // Toolbar
  const toolbar = (
    <DataTableToolbar
      searchValue={search.search}
      onSearchChange={onSearchChange}
      searchPlaceholder="Search attributes..."
      selectedCount={selectedIds.length}
      bulkActions={attributeActions.canBulkDelete ? (
        <Button
          variant={showTrashed ? "destructive" : "outline"}
          size="sm"
          onClick={handleBulkDelete}
          disabled={Boolean(error)}
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
      ) : undefined}
      actions={
        <div className="flex items-center gap-2">
          <Link
            to="/admin/attributes"
            search={{ trashed: !showTrashed }}
          >
            <Button variant="outline" size="sm">
              {showTrashed ? (
                <>
                  <Tags className="mr-2 h-4 w-4" />
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
          {!showTrashed && attributeActions.canCreate && (
            <Button onClick={() => setShowCreateDialog(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add Attribute
            </Button>
          )}
        </div>
      }
    />
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {showTrashed ? "Attribute Trash" : "Product Attributes"}
        </h1>
        <p className="text-muted-foreground">
          {showTrashed
            ? "View, restore, or permanently delete trashed attributes."
            : "Manage attributes like brand, color, or warranty to organize and filter products."}
        </p>
      </div>

      <DataTable
        table={table}
        isFetching={isFetching}
        isLoading={isLoading}
        error={error}
        onRetry={() => void refetch()}
        toolbar={toolbar}
        itemLabel="attributes"
        emptyState={{
          icon: Tags,
          title: search.search
            ? "No attributes found"
            : showTrashed
              ? "Trash is empty"
              : "No attributes yet",
          description: search.search
            ? "Try adjusting your search query."
            : showTrashed
              ? "Deleted attributes will appear here."
              : "Create your first attribute to get started.",
          action:
            !showTrashed && attributeActions.canCreate && !search.search ? (
              <Button onClick={() => setShowCreateDialog(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add Attribute
              </Button>
            ) : undefined,
        }}
      />

      {/* Create Attribute Dialog */}
      {attributeActions.canCreate && (
        <AttributeCreateDialog
          open={showCreateDialog}
          newAttribute={newAttribute}
          isCreating={createMutation.isPending}
          onOpenChange={setShowCreateDialog}
          onNameChange={handleNewAttributeNameChange}
          onSlugChange={(slug) =>
            setNewAttribute((prev) => ({ ...prev, slug }))
          }
          onFilterableChange={(checked) =>
            setNewAttribute((prev) => ({ ...prev, filterable: checked }))
          }
          onOptionsChange={(options) =>
            setNewAttribute((prev) => ({ ...prev, options }))
          }
          onCreate={handleCreateAttribute}
        />
      )}

      <AttributeDeleteDialog
        count={deleteRequest?.ids.length ?? 0}
        permanent={deleteRequest?.permanent ?? false}
        open={deleteRequest !== null}
        pending={deletePending}
        onOpenChange={(open) => {
          if (!open && !deletePending) setDeleteRequest(null);
        }}
        onConfirm={handleConfirmDelete}
      />

      {/* Attribute Values Viewer */}
      <AttributeValuesViewer
        attributeId={viewValuesFor?.id || null}
        attributeName={viewValuesFor?.name || null}
        onClose={() => setViewValuesFor(null)}
      />

      {/* Attribute Value Editor */}
      {attributeActions.canEdit && (
        <AttributeValueEditor
          attributeId={editValuesFor?.id || null}
          attributeName={editValuesFor?.name || null}
          onClose={() => setEditValuesFor(null)}
        />
      )}
    </div>
  );
}
