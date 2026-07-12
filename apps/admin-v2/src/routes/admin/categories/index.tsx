import { lazy, Suspense, useState, useMemo, useCallback } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Tag, Plus, Trash2 } from "lucide-react";
import { createListSearchValidator, createDataSelector } from "~/lib/list-helpers";
import { RouteErrorComponent } from "~/lib/route-error";
import { Button } from "~/components/ui/button";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { categoriesQueryOptions } from "~/lib/api-query-options/categories";
import { warmRouteQuery } from "~/lib/route-query-warming";
import {
  useDeleteCategory,
  usePermanentDeleteCategory,
  useRestoreCategory,
  useBulkDeleteCategories,
  useBulkRestoreCategories,
} from "~/lib/api-mutations/categories";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { useServerTable } from "~/components/admin/data-table/useServerTable";
import {
  getCategoryColumns,
  type CategoryListItem,
} from "~/components/admin/data-table/columns/category-columns";
import type { CategoryRevisionClaim } from "~/lib/api-functions/categories";

const CategoryDeleteDialog = lazy(() =>
  import("./-CategoryDeleteDialog").then((module) => ({
    default: module.CategoryDeleteDialog,
  })),
);

const validateCategorySearch = createListSearchValidator(
  ["name", "status", "createdAt", "updatedAt"] as const,
  { sort: "updatedAt" },
);

function mapParams(deps: ReturnType<typeof validateCategorySearch>) {
  return {
    page: deps.page,
    limit: deps.limit,
    search: deps.search || undefined,
    sort: deps.sort,
    order: deps.order,
    showTrashed: deps.trashed,
  };
}

export const Route = createFileRoute("/admin/categories/")({
  validateSearch: validateCategorySearch,
  loaderDeps: ({ search }) => search,
  staleTime: 1000 * 60 * 2,
  loader: async ({ context: { queryClient }, deps }) => {
    await warmRouteQuery(queryClient, categoriesQueryOptions(mapParams(deps)));
  },
  head: ({ match }) => ({
    meta: [
      {
        title: `${match.search.trashed ? "Trash" : "Categories"} | Scalius Admin`,
      },
    ],
  }),
  component: CategoriesPage,
  errorComponent: RouteErrorComponent,
});

function CategoriesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { getStorefrontPath } = useStorefrontUrl();
  const { categories: categoryActions } = useCatalogActionPermissions();
  const showTrashed = search.trashed;

  // Mutations
  const deleteMutation = useDeleteCategory();
  const permanentDeleteMutation = usePermanentDeleteCategory();
  const restoreMutation = useRestoreCategory();
  const bulkDeleteMutation = useBulkDeleteCategories();
  const bulkRestoreMutation = useBulkRestoreCategories();

  const [deleteIntent, setDeleteIntent] = useState<{
    categories: CategoryRevisionClaim[];
    permanent: boolean;
    bulk: boolean;
  } | null>(null);

  const isActionLoading =
    deleteMutation.isPending ||
    permanentDeleteMutation.isPending ||
    bulkDeleteMutation.isPending;

  const isCategoryDeleteDialogOpen = deleteIntent !== null;

  // Column definitions
  const columns = useMemo(
    () =>
      getCategoryColumns({
        showTrashed,
        getStorefrontPath,
        canSelect: showTrashed
          ? categoryActions.canRestore || categoryActions.canPermanentDelete
          : categoryActions.canBulkDelete,
        canEdit: categoryActions.canEdit,
        canDelete: categoryActions.canDelete,
        canRestore: categoryActions.canRestore,
        canPermanentDelete: categoryActions.canPermanentDelete,
        onEdit: (id) =>
          categoryActions.canEdit
            ? void navigate({
                to: "/admin/categories/$categoryId/edit",
                params: { categoryId: id },
              })
            : undefined,
        onDelete: (category) => {
          if (categoryActions.canDelete) {
            setDeleteIntent({
              categories: [{ id: category.id, expectedRevision: category.revision }],
              permanent: false,
              bulk: false,
            });
          }
        },
        onRestore: (category) => {
          if (categoryActions.canRestore) {
            restoreMutation.mutate({
              id: category.id,
              expectedRevision: category.revision,
            });
          }
        },
        onPermanentDelete: (category) => {
          if (categoryActions.canPermanentDelete) {
            setDeleteIntent({
              categories: [{ id: category.id, expectedRevision: category.revision }],
              permanent: true,
              bulk: false,
            });
          }
        },
      }),
    [
      showTrashed,
      getStorefrontPath,
      categoryActions,
      navigate,
      restoreMutation,
    ],
  );

  // Data selector
  const dataSelector = useMemo(() => createDataSelector<CategoryListItem>("categories"), []);

  const onPaginationChange = useCallback(
    (page: number, limit: number) => {
      void navigate({
        search: ((prev: Record<string, unknown>) => ({ ...prev, page, limit })) as never,
      });
    },
    [navigate],
  );

  const onSortingChange = useCallback(
    (sort: string, order: "asc" | "desc") => {
      void navigate({
        search: ((prev: Record<string, unknown>) => ({ ...prev, sort, order, page: 1 })) as never,
      });
    },
    [navigate],
  );

  const { table, error, isFetching, isLoading, refetch, selectedIds, clearSelection } =
    useServerTable({
      columns,
      queryOptions: categoriesQueryOptions(mapParams(search)),
      dataSelector,
      currentPage: search.page,
      currentLimit: search.limit,
      currentSort: search.sort,
      currentOrder: search.order,
      onPaginationChange,
      onSortingChange,
    });

  const selectedCategories = table
    .getSelectedRowModel()
    .rows.map(({ original }) => ({
      id: original.id,
      expectedRevision: original.revision,
    }));

  const handleConfirmDelete = useCallback(() => {
    if (!deleteIntent) return;
    const intent = deleteIntent;
    if (intent.permanent) {
      if (!categoryActions.canPermanentDelete) return;
      if (intent.bulk) {
        bulkDeleteMutation.mutate(
          { categories: intent.categories, permanent: true },
          { onSuccess: clearSelection },
        );
      } else {
        permanentDeleteMutation.mutate(intent.categories[0]!);
      }
    } else {
      if (!categoryActions.canDelete) return;
      if (intent.bulk) {
        bulkDeleteMutation.mutate(
          { categories: intent.categories, permanent: false },
          { onSuccess: clearSelection },
        );
      } else {
        deleteMutation.mutate(intent.categories[0]!);
      }
    }
    setDeleteIntent(null);
  }, [
    deleteIntent,
    categoryActions.canDelete,
    categoryActions.canPermanentDelete,
    deleteMutation,
    permanentDeleteMutation,
    bulkDeleteMutation,
    clearSelection,
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {showTrashed ? "Category Trash" : "Categories"}
          </h1>
          <p className="text-muted-foreground">
            {showTrashed
              ? "View, restore, or permanently delete trashed categories."
              : "Organize your products into categories."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/admin/categories"
            search={((prev: Record<string, unknown>) => ({ ...prev, trashed: !showTrashed })) as never}
          >
            <Button variant="outline" size="sm">
              {showTrashed ? (
                <Tag className="mr-2 h-4 w-4" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {showTrashed ? "View Active" : "View Trash"}
            </Button>
          </Link>
          {!showTrashed && categoryActions.canCreate && (
            <Link to="/admin/categories/new">
              <Button size="sm">
                <Plus className="mr-2 h-4 w-4" />
                New Category
              </Button>
            </Link>
          )}
        </div>
      </div>

      <DataTable
        table={table}
        isFetching={isFetching}
        isLoading={isLoading}
        error={error}
        onRetry={() => void refetch()}
        itemLabel="categories"
        emptyState={{
          icon: Tag,
          title: showTrashed ? "Trash is empty" : "No categories found",
          description: showTrashed
            ? "Categories moved to trash will appear here."
            : "Create your first category to organize products.",
        }}
        toolbar={
          <DataTableToolbar
            searchValue={search.search}
            onSearchChange={(value) =>
              void navigate({
                search: ((prev: Record<string, unknown>) => ({ ...prev, search: value, page: 1 })) as never,
              })
            }
            searchPlaceholder="Search categories..."
            selectedCount={selectedIds.length}
            bulkActions={selectedIds.length > 0 ? (
              <div className="flex items-center gap-2">
                {showTrashed && categoryActions.canRestore ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => bulkRestoreMutation.mutate(selectedCategories, { onSuccess: clearSelection })}
                    disabled={Boolean(error) || bulkRestoreMutation.isPending}
                  >
                    Restore ({selectedIds.length})
                  </Button>
                ) : null}
                {(!showTrashed && categoryActions.canBulkDelete) ||
                (showTrashed && categoryActions.canPermanentDelete) ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive border-destructive hover:bg-destructive/10"
                    onClick={() => setDeleteIntent({
                      categories: selectedCategories,
                      permanent: showTrashed,
                      bulk: true,
                    })}
                    disabled={Boolean(error) || bulkDeleteMutation.isPending}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {showTrashed ? "Delete permanently" : "Move to trash"} ({selectedIds.length})
                  </Button>
                ) : null}
              </div>
            ) : undefined}
          />
        }
      />

      {isCategoryDeleteDialogOpen &&
        (showTrashed
          ? categoryActions.canPermanentDelete
          : categoryActions.canDelete) && (
        <Suspense fallback={null}>
          <CategoryDeleteDialog
            showTrashed={showTrashed}
            isOpen={isCategoryDeleteDialogOpen}
            isActionLoading={isActionLoading}
            itemCount={deleteIntent?.categories.length ?? 1}
            onOpenChange={(open) => !open && setDeleteIntent(null)}
            onConfirm={handleConfirmDelete}
          />
        </Suspense>
      )}
    </div>
  );
}
