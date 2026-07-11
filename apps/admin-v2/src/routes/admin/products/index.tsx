import { lazy, Suspense, useState, useMemo, useCallback } from "react";
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
} from "lucide-react";
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
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { useServerTable } from "~/components/admin/data-table/useServerTable";
import {
  getProductColumns,
  type ProductListItem,
} from "~/components/admin/data-table/columns/product-columns";
import { ProductToolbar } from "~/components/admin/data-table/toolbars/ProductToolbar";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { StatCard } from "~/components/admin/shared/StatCard";

const ProductDeleteDialog = lazy(() =>
  import("./-ProductDeleteDialog").then((module) => ({
    default: module.ProductDeleteDialog,
  })),
);

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
  const { products: productActions } = useCatalogActionPermissions();
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
      if (!productActions.canEdit) return;
      void navigate({
        to: "/admin/products/$productId/edit",
        params: { productId: id },
      });
    },
    [navigate, productActions.canEdit],
  );

  const handleDelete = useCallback(
    (id: string) => {
      if (productActions.canDelete) setProductToDelete(id);
    },
    [productActions.canDelete],
  );

  const handleRestore = useCallback(
    (id: string) => {
      if (productActions.canRestore) restoreMut.mutate(id);
    },
    [restoreMut, productActions.canRestore],
  );

  const handlePermanentDelete = useCallback(
    (id: string) => {
      if (productActions.canPermanentDelete) setProductToDelete(id);
    },
    [productActions.canPermanentDelete],
  );

  // ── Columns ───────────────────────────────────────────────────

  const columns = useMemo(
    () =>
      getProductColumns({
        showTrashed,
        symbol,
        canSelect: productActions.canBulkDelete,
        canEdit: productActions.canEdit,
        canDelete: productActions.canDelete,
        canRestore: productActions.canRestore,
        canPermanentDelete: productActions.canPermanentDelete,
        onView: handleView,
        onEdit: handleEdit,
        onDelete: handleDelete,
        onRestore: handleRestore,
        onPermanentDelete: handlePermanentDelete,
      }),
    [
      showTrashed,
      symbol,
      productActions,
      handleView,
      handleEdit,
      handleDelete,
      handleRestore,
      handlePermanentDelete,
    ],
  );

  // ── Data selector ─────────────────────────────────────────────

  const dataSelector = useMemo(() => createDataSelector<ProductListItem>("products"), []);

  // ── Server table ──────────────────────────────────────────────

  const { table, error, isFetching, isLoading, refetch, selectedIds, clearSelection } =
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
      if (!productActions.canPermanentDelete) return;
      permanentDeleteMut.mutate(id);
    } else {
      if (!productActions.canDelete) return;
      deleteMut.mutate(id);
    }
  }, [
    productToDelete,
    showTrashed,
    productActions.canDelete,
    productActions.canPermanentDelete,
    deleteMut,
    permanentDeleteMut,
  ]);

  const handleBulkDelete = useCallback(() => {
    if (productActions.canBulkDelete && selectedIds.length > 0) {
      setIsConfirmBulkDeleteOpen(true);
    }
  }, [productActions.canBulkDelete, selectedIds]);

  const confirmBulkDelete = useCallback(() => {
    if (!productActions.canBulkDelete || selectedIds.length === 0) return;
    setIsConfirmBulkDeleteOpen(false);
    bulkDeleteMut.mutate(
      { productIds: selectedIds, permanent: showTrashed },
      { onSuccess: () => clearSelection() },
    );
  }, [
    productActions.canBulkDelete,
    selectedIds,
    showTrashed,
    bulkDeleteMut,
    clearSelection,
  ]);

  const isProductDeleteDialogOpen = !!productToDelete || isConfirmBulkDeleteOpen;

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
      canBulkDelete={productActions.canBulkDelete}
      bulkActionsDisabled={Boolean(error)}
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
              {!showTrashed && productActions.canCreate && (
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
            error={error}
            onRetry={() => void refetch()}
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
                !showTrashed &&
                productActions.canCreate &&
                !search.search &&
                search.category === "all" ? (
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

      {isProductDeleteDialogOpen &&
        (showTrashed
          ? productActions.canPermanentDelete || productActions.canBulkDelete
          : productActions.canDelete || productActions.canBulkDelete) && (
        <Suspense fallback={null}>
          <ProductDeleteDialog
            showTrashed={showTrashed}
            productToDelete={productToDelete}
            isBulkDeleteOpen={isConfirmBulkDeleteOpen}
            selectedCount={selectedIds.length}
            isActionLoading={isActionLoading}
            onCloseSingle={() => setProductToDelete(null)}
            onBulkOpenChange={setIsConfirmBulkDeleteOpen}
            onConfirmSingle={handleConfirmSingleDelete}
            onConfirmBulk={confirmBulkDelete}
          />
        </Suspense>
      )}
    </>
  );
}
