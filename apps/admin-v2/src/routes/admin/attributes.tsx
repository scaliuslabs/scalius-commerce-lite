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
  useDeleteAttribute,
  usePermanentDeleteAttribute,
  useRestoreAttribute,
  useBulkDeleteAttributes,
} from "~/lib/api-mutations/attributes";
import {
  DataTable,
  DataTableToolbar,
  useServerTable,
} from "~/components/admin/data-table";
import {
  getAttributeColumns,
  type AttributeItem,
} from "~/components/admin/data-table/columns/attribute-columns";
import {
  AttributeCreateDialog,
  AttributeValuesViewer,
  AttributeValueEditor,
} from "~/components/admin/attributes-manager/components";
import { useAttributeActions } from "~/components/admin/attributes-manager/hooks/useAttributeActions";
import type { NewAttribute } from "~/components/admin/attributes-manager/types";

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

  // Mutations
  const updateMutation = useUpdateAttribute();
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

  // We need a dummy setAttributes/fetchAttributes for the create dialog hook
  // (The create action uses the old hook; all other actions use centralized mutations)
  const { isCreating, handleCreate } = useAttributeActions(
    () => {
      /* refresh handled by mutation invalidation */
    },
    () => {
      /* no-op setter */
    },
  );

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
      updateMutation.mutate({ id, name });
    },
    [updateMutation],
  );

  const handleUpdateSlug = useCallback(
    (id: string, slug: string) => {
      updateMutation.mutate({ id, slug });
    },
    [updateMutation],
  );

  const handleToggleFilterable = useCallback(
    (id: string, filterable: boolean) => {
      updateMutation.mutate({ id, filterable });
    },
    [updateMutation],
  );

  const handleViewValues = useCallback(
    (id: string, name: string) => {
      setViewValuesFor({ id, name });
    },
    [],
  );

  const handleEditValues = useCallback(
    (id: string, name: string) => {
      setEditValuesFor({ id, name });
    },
    [],
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
    handleCreate(newAttribute, () => {
      setNewAttribute({ name: "", slug: "", filterable: true, options: [] });
      setShowCreateDialog(false);
    });
  };

  // Columns
  const columns = useMemo(
    () =>
      getAttributeColumns({
        showTrashed,
        savingIds,
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
  const { table, isFetching, isLoading, selectedIds, clearSelection } =
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
    if (selectedIds.length === 0) return;
    bulkDeleteMutation.mutate(
      { ids: selectedIds, permanent: showTrashed },
      { onSuccess: clearSelection },
    );
  }, [selectedIds, showTrashed, bulkDeleteMutation, clearSelection]);

  // Toolbar
  const toolbar = (
    <DataTableToolbar
      searchValue={search.search}
      onSearchChange={onSearchChange}
      searchPlaceholder="Search attributes..."
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
          {!showTrashed && (
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
            !showTrashed && !search.search ? (
              <Button onClick={() => setShowCreateDialog(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add Attribute
              </Button>
            ) : undefined,
        }}
      />

      {/* Create Attribute Dialog */}
      <AttributeCreateDialog
        open={showCreateDialog}
        newAttribute={newAttribute}
        isCreating={isCreating}
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

      {/* Attribute Values Viewer */}
      <AttributeValuesViewer
        attributeId={viewValuesFor?.id || null}
        attributeName={viewValuesFor?.name || null}
        onClose={() => setViewValuesFor(null)}
      />

      {/* Attribute Value Editor */}
      <AttributeValueEditor
        attributeId={editValuesFor?.id || null}
        attributeName={editValuesFor?.name || null}
        onClose={() => setEditValuesFor(null)}
      />
    </div>
  );
}
