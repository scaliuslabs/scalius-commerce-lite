import { useState, useMemo, useCallback } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Tag, Plus, Trash2, AlertTriangle, Loader2 } from "lucide-react";
import { createListSearchValidator, createDataSelector } from "~/lib/list-helpers";
import { RouteErrorComponent } from "~/lib/route-error";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";
import { categoriesQueryOptions } from "~/lib/api-query-options/categories";
import { warmRouteQuery } from "~/lib/route-query-warming";
import {
  useDeleteCategory,
  usePermanentDeleteCategory,
  useRestoreCategory,
  useBulkDeleteCategories,
} from "~/lib/api-mutations/categories";
import {
  DataTable,
  DataTableToolbar,
  useServerTable,
} from "~/components/admin/data-table";
import {
  getCategoryColumns,
  type CategoryListItem,
} from "~/components/admin/data-table/columns/category-columns";

const validateCategorySearch = createListSearchValidator(
  ["name", "createdAt", "updatedAt"] as const,
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
  const showTrashed = search.trashed;

  // Mutations
  const deleteMutation = useDeleteCategory();
  const permanentDeleteMutation = usePermanentDeleteCategory();
  const restoreMutation = useRestoreCategory();
  const bulkDeleteMutation = useBulkDeleteCategories();

  // Delete confirmation state
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const isActionLoading =
    deleteMutation.isPending || permanentDeleteMutation.isPending;

  const handleConfirmDelete = useCallback(() => {
    if (!deleteId) return;
    const id = deleteId;
    setDeleteId(null);
    if (showTrashed) {
      permanentDeleteMutation.mutate(id);
    } else {
      deleteMutation.mutate(id);
    }
  }, [deleteId, showTrashed, deleteMutation, permanentDeleteMutation]);

  // Column definitions
  const columns = useMemo(
    () =>
      getCategoryColumns({
        showTrashed,
        getStorefrontPath,
        onEdit: (id) =>
          void navigate({ to: "/admin/categories/$categoryId/edit", params: { categoryId: id } }),
        onDelete: (id) => setDeleteId(id),
        onRestore: (id) => restoreMutation.mutate(id),
        onPermanentDelete: (id) => setDeleteId(id),
      }),
    [showTrashed, getStorefrontPath, navigate, restoreMutation],
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

  const { table, isFetching, isLoading, selectedIds, clearSelection } =
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
          {!showTrashed && (
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
            bulkActions={
              <Button
                variant="outline"
                size="sm"
                className="text-destructive border-destructive hover:bg-destructive/10"
                onClick={() => {
                  bulkDeleteMutation.mutate(
                    {
                      categoryIds: selectedIds,
                      permanent: showTrashed,
                    },
                    { onSuccess: clearSelection },
                  );
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {showTrashed ? "Delete" : "Trash"} ({selectedIds.length})
              </Button>
            }
          />
        }
      />

      {/* Delete confirmation dialog */}
      <AlertDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              {showTrashed ? (
                <>
                  <AlertTriangle className="h-4 w-4 text-red-500" /> Delete
                  Permanently?
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 text-amber-500" /> Move to Trash?
                </>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              {showTrashed
                ? "This action cannot be undone. Are you sure you want to permanently delete this category?"
                : "Are you sure you want to move this category to the trash? It can be restored later."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isActionLoading}
              className="h-8 text-xs"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className={cn(
                "h-8 text-xs",
                showTrashed ? "bg-destructive hover:bg-destructive/90" : "",
              )}
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}
              {showTrashed ? "Delete Permanently" : "Move to Trash"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
