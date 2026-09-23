import { useCallback, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate, stripSearchParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Package } from "lucide-react";
import {
  createDataSelector,
  createListSearchValidator,
  normalizeOptionalEnumSearchParam,
  normalizeSearchString,
  type ListSearchParams,
  type SearchValidatorInput,
} from "~/lib/list-helpers";
import { RouteErrorComponent } from "~/lib/route-error";
import { productsQueryOptions, type ProductsQuery } from "~/lib/api-query-options/products";
import { categoryFormOptionsQueryOptions } from "~/lib/api-query-options/categories";
import { warmRouteQuery } from "~/lib/route-query-warming";
import {
  useBulkDeleteProducts,
  useDeleteProduct,
  usePermanentDeleteProduct,
  useRestoreProduct,
} from "~/lib/api-mutations/products";
import { useCurrency } from "~/hooks/use-currency";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { useServerTable } from "~/components/admin/data-table/useServerTable";
import type { Row } from "~/components/admin/data-table/table-config";
import { getProductColumns, type ProductListItem } from "~/components/admin/product-list/product-columns";
import { ProductToolbar } from "~/components/admin/product-list/ProductToolbar";
import { ProductMobileRow } from "~/components/admin/product-list/ProductMobileRow";
import { SelectionSheet } from "~/components/admin/shared/SelectionSheet";
import { useIsMobile } from "~/hooks/use-mobile";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { IndexTabs } from "~/components/admin/resource/IndexTabs";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { Button } from "~/components/ui/button";
import { translate, useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { resourceMessages } from "~/i18n/resource";

const PRODUCT_STATUSES = ["active", "draft"] as const;
type ProductStatus = (typeof PRODUCT_STATUSES)[number];
type ProductTab = "all" | ProductStatus | "trash";

const baseSearchValidator = createListSearchValidator(
  ["updatedAt", "createdAt", "name", "price"] as const,
  { sort: "updatedAt" },
);

type SearchParams = ListSearchParams<"updatedAt" | "createdAt" | "name" | "price"> & {
  category: string;
  status?: ProductStatus;
};

function validateProductSearch(search: SearchValidatorInput<SearchParams>): SearchParams {
  return {
    ...baseSearchValidator(search),
    category: normalizeSearchString(search.category, "all"),
    status: normalizeOptionalEnumSearchParam(search.status, PRODUCT_STATUSES),
  };
}

function mapParams(search: SearchParams): ProductsQuery {
  return {
    page: search.page,
    limit: search.limit,
    search: search.search || undefined,
    category: search.category !== "all" ? search.category : undefined,
    sort: search.sort,
    order: search.order,
    trashed: search.trashed ? "true" : undefined,
    status: search.trashed ? undefined : search.status,
  };
}

export const Route = createFileRoute("/admin/products/")({
  validateSearch: validateProductSearch,
  search: {
    middlewares: [stripSearchParams({
      page: 1, limit: 10, search: "", sort: "updatedAt", order: "desc", trashed: false, category: "all",
    })],
  },
  loaderDeps: ({ search }) => search,
  staleTime: 1000 * 60 * 2,
  loader: async ({ context: { queryClient }, deps }) => {
    await warmRouteQuery(queryClient, productsQueryOptions(mapParams(deps)));
    if (typeof window !== "undefined") {
      void queryClient.prefetchQuery(categoryFormOptionsQueryOptions());
    }
  },
  head: () => ({ meta: [{ title: `${translate(productMessages, "products")} | Scalius Admin` }] }),
  component: ProductsPage,
  errorComponent: RouteErrorComponent,
});

type DeleteTarget = { kind: "single"; product: ProductListItem } | { kind: "bulk" };

function ProductsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
  const { fmt } = useCurrency();
  const { products: can } = useCatalogActionPermissions();
  const showTrashed = search.trashed;
  const tab: ProductTab = showTrashed ? "trash" : search.status ?? "all";
  const isFiltered = Boolean(search.search) || search.category !== "all";
  const isMobile = useIsMobile();

  const { data: categoryData } = useQuery(categoryFormOptionsQueryOptions());
  const categories = categoryData?.categories ?? [];

  const deleteMut = useDeleteProduct();
  const permanentDeleteMut = usePermanentDeleteProduct();
  const restoreMut = useRestoreProduct();
  const bulkDeleteMut = useBulkDeleteProducts();
  // The target outlives `deleteOpen` so the dialog text stays put while it closes.
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const askToDelete = useCallback((target: DeleteTarget) => {
    setDeleteTarget(target);
    setDeleteOpen(true);
  }, []);

  const updateSearch = useCallback(
    (updates: Partial<SearchParams>) => {
      void navigate({
        to: "/admin/products",
        search: ((prev: Record<string, unknown>) => ({ ...prev, ...updates })) as never,
      });
    },
    [navigate],
  );

  const openProduct = useCallback(
    (product: ProductListItem) => {
      void navigate({ to: "/admin/products/$productId/edit", params: { productId: product.id } });
    },
    [navigate],
  );

  const restoreProduct = useCallback(
    (product: ProductListItem) => {
      if (!can.canRestore) return;
      restoreMut.mutate({ id: product.id, expectedAggregateRevision: product.aggregateRevision });
    },
    [can.canRestore, restoreMut],
  );

  const askDelete = useCallback(
    (product: ProductListItem) => askToDelete({ kind: "single", product }),
    [askToDelete],
  );

  const columns = useMemo(
    () =>
      getProductColumns({
        showTrashed,
        fmt,
        canSelect: can.canBulkDelete,
        canEdit: can.canEdit,
        canDelete: can.canDelete,
        canRestore: can.canRestore,
        canPermanentDelete: can.canPermanentDelete,
        onOpen: openProduct,
        onDelete: askDelete,
        onRestore: restoreProduct,
        onPermanentDelete: askDelete,
      }),
    [showTrashed, fmt, can, openProduct, askDelete, restoreProduct],
  );

  const dataSelector = useMemo(() => createDataSelector<ProductListItem>("products"), []);

  const { table, error, isFetching, isLoading, refetch, selectedRows, clearSelection, deselectIds } =
    useServerTable({
      columns,
      queryOptions: productsQueryOptions(mapParams(search)),
      dataSelector,
      currentPage: search.page,
      currentLimit: search.limit,
      currentSort: search.sort,
      currentOrder: search.order,
      onPaginationChange: (page, limit) => updateSearch({ page, limit }),
      onSortingChange: () => undefined,
    });

  const confirmDelete = () => {
    const target = deleteTarget;
    setDeleteOpen(false);
    if (!target) return;
    if (target.kind === "single") {
      const claim = { id: target.product.id, expectedAggregateRevision: target.product.aggregateRevision };
      if (showTrashed && can.canPermanentDelete) permanentDeleteMut.mutate(claim);
      if (!showTrashed && can.canDelete) deleteMut.mutate(claim);
      return;
    }
    if (!can.canBulkDelete || selectedRows.length === 0) return;
    bulkDeleteMut.mutate(
      {
        products: selectedRows.map((product) => ({
          id: product.id,
          expectedAggregateRevision: product.aggregateRevision,
        })),
        permanent: showTrashed,
      },
      {
        // Products blocked from permanent delete stay selected in Trash.
        onSuccess: (result) => (showTrashed ? deselectIds(result.deletedIds) : clearSelection()),
      },
    );
  };

  const deleteTitle = deleteTarget?.kind === "single"
    ? t(showTrashed ? "deleteOneTitle" : "trashOneTitle", { name: deleteTarget.product.name })
    : t(showTrashed ? "deleteManyTitle" : "trashManyTitle", { count: selectedRows.length });

  const mobileCardRenderer = useCallback(
    (row: Row<ProductListItem>) => (
      <ProductMobileRow
        product={row.original}
        selected={row.getIsSelected()}
        showTrashed={showTrashed}
        canSelect={can.canBulkDelete}
        canEdit={can.canEdit}
        canDelete={can.canDelete}
        canRestore={can.canRestore}
        canPermanentDelete={can.canPermanentDelete}
        fmt={fmt}
        onSelectedChange={(selected) => row.toggleSelected(selected)}
        onOpen={() => openProduct(row.original)}
        onDelete={() => askDelete(row.original)}
        onRestore={() => restoreProduct(row.original)}
        onPermanentDelete={() => askDelete(row.original)}
      />
    ),
    [showTrashed, can, fmt, openProduct, askDelete, restoreProduct],
  );

  const addProductButton = can.canCreate ? (
    <Button asChild>
      <Link to="/admin/products/new">{t("addProduct")}</Link>
    </Button>
  ) : null;

  return (
    <>
      <PageHeader
        title={t("products")}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/admin/inventory/labels">{t("printLabels")}</Link>
            </Button>
            {addProductButton}
          </>
        }
      />

      <div className="overflow-hidden rounded-xl bg-card shadow-card">
        <IndexTabs<ProductTab>
          label={t("products")}
          value={tab}
          onChange={(next) =>
            updateSearch({
              page: 1,
              trashed: next === "trash" ? true : undefined,
              status: next === "active" || next === "draft" ? next : undefined,
            })
          }
          tabs={[
            { value: "all", label: r("all") },
            { value: "active", label: t("statusActive") },
            { value: "draft", label: t("statusDraft") },
            { value: "trash", label: r("trash") },
          ]}
        />
        <DataTable
          variant="bare"
          getRowHref={search.trashed ? undefined : (product) => `/admin/products/${product.id}/edit`}
          table={table}
          isFetching={isFetching}
          isLoading={isLoading}
          error={error}
          onRetry={() => void refetch()}
          itemLabel={t("products")}
          mobileCardRenderer={mobileCardRenderer}
          toolbar={<div className="px-2 pt-2"><ProductToolbar
              searchValue={search.search}
              onSearchChange={(value) => updateSearch({ search: value, page: 1 })}
              categories={categories}
              selectedCategory={search.category}
              onCategoryChange={(value) => updateSearch({ category: value, page: 1 })}
              sortValue={`${search.sort}:${search.order}`}
              onSortChange={(value) => {
                const [sort, order] = value.split(":") as [SearchParams["sort"], SearchParams["order"]];
                updateSearch({ sort, order, page: 1 });
              }}
              // Phones use the bottom selection bar instead of the toolbar's bulk button.
              selectedCount={isMobile ? 0 : selectedRows.length}
              showTrashed={showTrashed}
              onBulkDelete={() => askToDelete({ kind: "bulk" })}
              isBulkDeleting={bulkDeleteMut.isPending}
              canBulkDelete={can.canBulkDelete}
              bulkActionsDisabled={Boolean(error)}
            /></div>}
          emptyState={
            showTrashed
              ? { icon: Package, title: r("trashEmpty"), description: t("trashEmptyHint") }
              : isFiltered || tab !== "all"
                ? {
                    icon: Package,
                    title: r("noResults"),
                    description: r("noResultsHint"),
                    action: (
                      <Button
                        variant="outline"
                        onClick={() => updateSearch({ search: "", category: "all", status: undefined, page: 1 })}
                      >
                        {t("clearFilters")}
                      </Button>
                    ),
                  }
                : { icon: Package, title: t("emptyTitle"), description: t("emptyHint"), action: addProductButton }
          }
        />
      </div>

      <SelectionSheet count={isMobile ? selectedRows.length : 0} clearLabel={t("clearSelection")} onClear={clearSelection}>
        {can.canBulkDelete ? (
          <Button
            type="button"
            variant={showTrashed ? "destructive" : "outline"}
            disabled={bulkDeleteMut.isPending || Boolean(error)}
            onClick={() => askToDelete({ kind: "bulk" })}
          >
            {showTrashed ? r("deletePermanently") : r("moveToTrash")}
          </Button>
        ) : null}
      </SelectionSheet>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={deleteTitle}
        description={showTrashed ? r("deleteBody") : r("trashBody")}
        confirmLabel={showTrashed ? r("deletePermanently") : r("moveToTrash")}
        cancelLabel={r("cancel")}
        loadingLabel={r("working")}
        variant={showTrashed ? "destructive" : "default"}
        onConfirm={confirmDelete}
      />
    </>
  );
}
