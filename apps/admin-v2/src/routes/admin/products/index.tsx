import { useState, useMemo, useCallback } from "react";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Plus,
  Package,
  Trash2,
  Eye,
  Image as ImageIcon,
  Tag,
  ShoppingBag,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import {
  createDataSelector,
  createListSearchValidator,
  normalizeSearchString,
  type ListSearchParams,
  type SearchValidatorInput,
} from "~/lib/list-helpers";
import { RouteErrorComponent } from "~/lib/route-error";
import {
  productsQueryOptions,
  productStatsQueryOptions,
} from "~/lib/api-query-options/products";
import { categoryFormOptionsQueryOptions } from "~/lib/api-query-options/categories";
import { warmRouteQuery } from "~/lib/route-query-warming";
import {
  useDeleteProduct,
  usePermanentDeleteProduct,
  useRestoreProduct,
  useBulkDeleteProducts,
} from "~/lib/api-mutations/products";
import { useCurrency } from "~/hooks/use-currency";
import { useServerTable, DataTable } from "~/components/admin/data-table";
import {
  getProductColumns,
  type ProductListItem,
} from "~/components/admin/data-table/columns/product-columns";
import { ProductToolbar } from "~/components/admin/data-table/toolbars/ProductToolbar";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
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
import { StatCard } from "~/components/admin/shared/StatCard";

// ── Search schema ─────────────────────────────────────────────────

const baseSearchValidator = createListSearchValidator(
  ["name", "price", "category", "createdAt", "updatedAt"] as const,
  { sort: "updatedAt" },
);

type ProductSort = "name" | "price" | "category" | "createdAt" | "updatedAt";

type SearchParams = ListSearchParams<ProductSort> & {
  category: string;
};

function validateProductSearch(search: SearchValidatorInput<SearchParams>): SearchParams {
  return {
    ...baseSearchValidator(search),
    category: normalizeSearchString(search.category, "all"),
  };
}

// ── Map search params to API params ───────────────────────────────

function mapParams(deps: SearchParams) {
  return {
    page: deps.page,
    limit: deps.limit,
    search: deps.search || undefined,
    categoryId: deps.category !== "all" ? deps.category : undefined,
    sort: deps.sort,
    order: deps.order,
    showTrashed: deps.trashed,
  };
}

// ── Route definition ──────────────────────────────────────────────

export const Route = createFileRoute("/admin/products/")({
  validateSearch: validateProductSearch,
  loaderDeps: ({ search }) => search,
  staleTime: 1000 * 60 * 2,
  loader: async ({ context: { queryClient }, deps }) => {
    await warmRouteQuery(queryClient, productsQueryOptions(mapParams(deps)));

    if (typeof window !== "undefined") {
      void queryClient.prefetchQuery(categoryFormOptionsQueryOptions());
      void queryClient.prefetchQuery(productStatsQueryOptions());
    }
  },
  head: ({ match }) => ({
    meta: [
      {
        title: `${match.search.trashed ? "Trash" : "Products"} | Scalius Admin`,
      },
    ],
  }),
  component: ProductsPage,
  errorComponent: RouteErrorComponent,
});

// ── Interfaces ────────────────────────────────────────────────────

interface ProductStats {
  totalProducts: number;
  activeProducts: number;
  productsWithImages: number;
  categoriesCount: number;
}

interface Category {
  id: string;
  name: string;
}

// ── Page component ────────────────────────────────────────────────

function ProductsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { symbol } = useCurrency();
  const showTrashed = search.trashed;

  // ── Queries ───────────────────────────────────────────────────
  const { data: catData } = useQuery(categoryFormOptionsQueryOptions());
  const { data: statsData } = useQuery(productStatsQueryOptions());

  const categories = useMemo(
    () => (catData?.categories ?? []) as Category[],
    [catData],
  );

  const stats = statsData as unknown as ProductStats | null;

  // ── Mutations ─────────────────────────────────────────────────
  const deleteMut = useDeleteProduct();
  const permanentDeleteMut = usePermanentDeleteProduct();
  const restoreMut = useRestoreProduct();
  const bulkDeleteMut = useBulkDeleteProducts();

  // ── Dialogs ───────────────────────────────────────────────────
  const [productToDelete, setProductToDelete] = useState<string | null>(null);
  const [isConfirmBulkDeleteOpen, setIsConfirmBulkDeleteOpen] = useState(false);

  // ── Navigation helpers ────────────────────────────────────────

  const handleNavigate = useCallback(
    (updates: Partial<SearchParams>) => {
      void navigate({
        to: "/admin/products",
        search: ((prev: Record<string, unknown>) => ({ ...prev, ...updates })) as never,
      });
    },
    [navigate],
  );

  const onSearchChange = useCallback(
    (value: string) => handleNavigate({ search: value, page: 1 }),
    [handleNavigate],
  );

  const onCategoryChange = useCallback(
    (value: string) => handleNavigate({ category: value, page: 1 }),
    [handleNavigate],
  );

  const onPaginationChange = useCallback(
    (page: number, limit: number) => handleNavigate({ page, limit }),
    [handleNavigate],
  );

  const onSortingChange = useCallback(
    (sort: string, order: "asc" | "desc") =>
      handleNavigate({ sort: sort as SearchParams["sort"], order }),
    [handleNavigate],
  );

  // ── Action handlers ───────────────────────────────────────────

  const handleView = useCallback(
    (id: string) => {
      void navigate({
        to: "/admin/products/$productId",
        params: { productId: id },
      });
    },
    [navigate],
  );

  const handleEdit = useCallback(
    (id: string) => {
      void navigate({
        to: "/admin/products/$productId/edit",
        params: { productId: id },
      });
    },
    [navigate],
  );

  const handleDelete = useCallback(
    (id: string) => setProductToDelete(id),
    [],
  );

  const handleRestore = useCallback(
    (id: string) => restoreMut.mutate(id),
    [restoreMut],
  );

  const handlePermanentDelete = useCallback(
    (id: string) => setProductToDelete(id),
    [],
  );

  // ── Columns ───────────────────────────────────────────────────

  const columns = useMemo(
    () =>
      getProductColumns({
        showTrashed,
        symbol,
        onView: handleView,
        onEdit: handleEdit,
        onDelete: handleDelete,
        onRestore: handleRestore,
        onPermanentDelete: handlePermanentDelete,
      }),
    [showTrashed, symbol, handleView, handleEdit, handleDelete, handleRestore, handlePermanentDelete],
  );

  // ── Data selector ─────────────────────────────────────────────

  const dataSelector = useMemo(() => createDataSelector<ProductListItem>("products"), []);

  // ── Server table ──────────────────────────────────────────────

  const { table, isFetching, isLoading, selectedIds, clearSelection } =
    useServerTable({
      columns,
      queryOptions: productsQueryOptions(mapParams(search)),
      dataSelector,
      currentPage: search.page,
      currentLimit: search.limit,
      currentSort: search.sort,
      currentOrder: search.order,
      onPaginationChange,
      onSortingChange,
    });

  // ── Bulk actions ──────────────────────────────────────────────

  const isActionLoading =
    deleteMut.isPending ||
    permanentDeleteMut.isPending ||
    restoreMut.isPending ||
    bulkDeleteMut.isPending;

  const handleConfirmSingleDelete = useCallback(() => {
    if (!productToDelete) return;
    const id = productToDelete;
    setProductToDelete(null);
    if (showTrashed) {
      permanentDeleteMut.mutate(id);
    } else {
      deleteMut.mutate(id);
    }
  }, [productToDelete, showTrashed, deleteMut, permanentDeleteMut]);

  const handleBulkDelete = useCallback(() => {
    if (selectedIds.length > 0) {
      setIsConfirmBulkDeleteOpen(true);
    }
  }, [selectedIds]);

  const confirmBulkDelete = useCallback(() => {
    if (selectedIds.length === 0) return;
    setIsConfirmBulkDeleteOpen(false);
    bulkDeleteMut.mutate(
      { productIds: selectedIds, permanent: showTrashed },
      { onSuccess: () => clearSelection() },
    );
  }, [selectedIds, showTrashed, bulkDeleteMut, clearSelection]);

  // ── Stats display ─────────────────────────────────────────────

  const displayStats: ProductStats = useMemo(() => {
    if (stats) return stats;
    return {
      totalProducts: 0,
      activeProducts: 0,
      productsWithImages: 0,
      categoriesCount: categories.length,
    };
  }, [stats, categories.length]);

  // ── Toolbar ───────────────────────────────────────────────────

  const toolbar = (
    <ProductToolbar
      searchValue={search.search}
      onSearchChange={onSearchChange}
      categories={categories}
      selectedCategory={search.category}
      onCategoryChange={onCategoryChange}
      selectedCount={selectedIds.length}
      showTrashed={showTrashed}
      onBulkDelete={handleBulkDelete}
      isBulkDeleting={bulkDeleteMut.isPending}
    />
  );

  // ── Render ────────────────────────────────────────────────────

  return (
    <>
      <Card className="border-none shadow-none">
        {/* Header */}
        <CardHeader className="px-2 pt-2 pb-1.5 sm:px-3 sm:pt-3 sm:pb-2 border-b">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base font-semibold tracking-tight">
                {showTrashed ? "Trash" : "Products"}
              </CardTitle>
              <CardDescription className="mt-0 text-xs text-muted-foreground">
                {showTrashed
                  ? "View and manage deleted products."
                  : `Manage your product catalog. ${table.getRowCount()} total products.`}
              </CardDescription>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                asChild
                className="h-7 text-xs text-muted-foreground hover:text-foreground"
              >
                <Link
                  to="/admin/products"
                  search={showTrashed ? undefined : { trashed: true }}
                >
                  {showTrashed ? (
                    <>
                      <Package className="h-3.5 w-3.5 mr-1" /> View Active
                      Products
                    </>
                  ) : (
                    <>
                      <Trash2 className="h-3.5 w-3.5 mr-1" /> View Trash
                    </>
                  )}
                </Link>
              </Button>
              {!showTrashed && (
                <Button size="sm" className="h-7 text-xs" asChild>
                  <Link to="/admin/products/new">
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    Add Product
                  </Link>
                </Button>
              )}
            </div>
          </div>

          {stats && !showTrashed && (
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
              <StatCard
                title="Total Products"
                value={displayStats.totalProducts}
                icon={ShoppingBag}
                iconBgColor="bg-blue-100 dark:bg-blue-900/30"
                iconTextColor="text-blue-600 dark:text-blue-400"
              />
              <StatCard
                title="Active Products"
                value={displayStats.activeProducts}
                icon={Eye}
                iconBgColor="bg-green-100 dark:bg-green-900/30"
                iconTextColor="text-green-600 dark:text-green-400"
              />
              <StatCard
                title="With Images"
                value={displayStats.productsWithImages}
                icon={ImageIcon}
                iconBgColor="bg-orange-100 dark:bg-orange-900/30"
                iconTextColor="text-orange-600 dark:text-orange-400"
              />
              <StatCard
                title="Categories"
                value={displayStats.categoriesCount}
                icon={Tag}
                iconBgColor="bg-purple-100 dark:bg-purple-900/30"
                iconTextColor="text-purple-600 dark:text-purple-400"
              />
            </div>
          )}
        </CardHeader>

        {/* Table */}
        <CardContent className="p-0 px-2 sm:px-3 pt-3">
          <DataTable
            table={table}
            isFetching={isFetching}
            isLoading={isLoading}
            toolbar={toolbar}
            itemLabel="products"
            emptyState={{
              icon: Package,
              title: showTrashed
                ? "Trash is empty."
                : search.search || search.category !== "all"
                  ? "No products match your criteria."
                  : "No products created yet.",
              description: showTrashed
                ? "Products moved to trash will appear here."
                : undefined,
              action:
                !showTrashed && !search.search && search.category === "all" ? (
                  <Button size="sm" asChild className="h-7 text-xs">
                    <Link to="/admin/products/new">
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      Add First Product
                    </Link>
                  </Button>
                ) : undefined,
            }}
          />
        </CardContent>
      </Card>

      {/* Single delete confirmation */}
      <AlertDialog
        open={!!productToDelete && !isConfirmBulkDeleteOpen}
        onOpenChange={(open) => !open && setProductToDelete(null)}
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
                ? "This action cannot be undone. Are you sure you want to permanently delete this product?"
                : "Are you sure you want to move this product to the trash? It can be restored later."}
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
              onClick={handleConfirmSingleDelete}
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

      {/* Bulk delete confirmation */}
      <AlertDialog
        open={isConfirmBulkDeleteOpen}
        onOpenChange={setIsConfirmBulkDeleteOpen}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              {showTrashed ? (
                <>
                  <AlertTriangle className="h-4 w-4 text-red-500" /> Delete
                  Selected Permanently?
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 text-amber-500" /> Move Selected
                  to Trash?
                </>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              You are about to{" "}
              {showTrashed ? "permanently delete" : "move to trash"}{" "}
              {selectedIds.length} product(s).
              {showTrashed ? (
                <span className="font-medium text-destructive block mt-1 text-xs">
                  This action cannot be undone.
                </span>
              ) : (
                <span className="block mt-1 text-xs">
                  They can be restored later from the trash view.
                </span>
              )}
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
              onClick={confirmBulkDelete}
              className={cn(
                "h-8 text-xs",
                showTrashed ? "bg-destructive hover:bg-destructive/90" : "",
              )}
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}
              {showTrashed
                ? `Delete ${selectedIds.length}`
                : `Move ${selectedIds.length} to Trash`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
