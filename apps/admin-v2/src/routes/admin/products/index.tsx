import { useMemo } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Package } from "lucide-react";
import {
  deleteApiV1AdminProductsById,
  deleteApiV1AdminProductsByIdPermanent,
  postApiV1AdminProductsBulkDelete,
  postApiV1AdminProductsByIdRestore,
} from "@scalius/api-client/sdk";
import {
  createListSearchValidator,
  normalizeOptionalEnumSearchParam,
  normalizeOptionalSearchString,
  type SearchValidatorInput,
} from "~/lib/list-helpers";
import { adoptListSearch, listSearchKey, useListSearch } from "~/lib/list-search";
import { RouteErrorComponent } from "~/lib/route-error";
import { apiData } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { productsQueryOptions } from "~/lib/api-query-options/products";
import { categoryFormOptionsQueryOptions } from "~/lib/api-query-options/categories";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { useDuplicateProduct } from "~/lib/api-mutations/products";
import { useCurrency } from "~/hooks/use-currency";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";
import { ResourceListPage } from "~/components/admin/resource/ResourceListPage";
import {
  duplicateProductAction,
  getProductColumns,
  productShortcodeAction,
  type ProductListItem,
} from "~/components/admin/product-list/product-columns";
import { ProductBulkActions } from "~/components/admin/product-list/ProductBulkActions";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Button } from "~/components/ui/button";
import { translate, useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { resourceMessages } from "~/i18n/resource";

const STATUSES = ["active", "draft"] as const;
const validateBase = createListSearchValidator(["updatedAt", "createdAt", "name", "price", "category"] as const, { sort: "updatedAt" });

function validateProductSearch(search: SearchValidatorInput) {
  return {
    ...validateBase(search),
    category: normalizeOptionalSearchString(search.category),
    status: normalizeOptionalEnumSearchParam(search.status, STATUSES),
  };
}

type ProductSearch = ReturnType<typeof validateProductSearch>;

function listQuery(search: ProductSearch, term: string) {
  return productsQueryOptions({
    page: search.page,
    limit: search.limit,
    search: term || undefined,
    category: search.category || undefined,
    sort: search.sort,
    order: search.order,
    trashed: search.trashed ? "true" : undefined,
    status: search.trashed ? undefined : search.status,
    view: "compact",
  });
}

export const Route = createFileRoute("/admin/products/")({
  validateSearch: validateProductSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => warmRouteQuery(queryClient, listQuery(deps, adoptListSearch(listSearchKey("products", deps, "status"), deps.q))),
  head: () => ({ meta: [{ title: `${translate(productMessages, "products")} | Scalius Admin` }] }),
  component: ProductsPage,
  errorComponent: RouteErrorComponent,
});

const claim = (row: ProductListItem) => ({ id: row.id, expectedAggregateRevision: row.aggregateRevision });

function ProductsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
  const [term] = useListSearch(listSearchKey("products", search, "status"));
  const { fmt } = useCurrency();
  const { getStorefrontPath } = useStorefrontUrl();
  const { products: can } = useCatalogActionPermissions();
  const duplicate = useDuplicateProduct();
  const { data: categoryData } = useQuery(categoryFormOptionsQueryOptions());
  const rowTo = (row: ProductListItem) => `/admin/products/${row.id}/edit`;

  const columns = useMemo(
    () => getProductColumns({ trashed: search.trashed, fmt, rowTo }),
    [search.trashed, fmt],
  );

  return (
    <ResourceListPage<ProductListItem>
      title={t("products")}
      list="products"
      actions={
        <>
          <Button variant="outline" asChild>
            <Link to="/admin/inventory/labels">{t("printLabels")}</Link>
          </Button>
          {can.canCreate ? (
            <Button asChild>
              <Link to="/admin/products/new">{t("addProduct")}</Link>
            </Button>
          ) : null}
        </>
      }
      search={search}
      query={listQuery(search, term)}
      pageQuery={(page, limit) => listQuery({ ...search, page, limit }, term)}
      dataKey="products"
      columns={columns}
      invalidate={[queryKeys.products.all, queryKeys.dashboard.all, queryKeys.inventory.list()]}
      empty={{ icon: Package, title: t("emptyTitle"), description: t("emptyHint") }}
      views={{ param: "status", tabs: [
        { value: "active", label: t("statusActive") },
        { value: "draft", label: t("statusDraft") },
      ] }}
      searchPlaceholder={t("searchPlaceholder")}
      countLabel={(count) => t("productsCount", { count })}
      filterParams={["category"]}
      filters={
        <SearchableSelect
          value={search.category ?? "all"}
          onValueChange={(value) => void navigate({
            to: "/admin/products",
            search: ((prev: Record<string, unknown>) => ({ ...prev, category: value === "all" ? undefined : value, page: 1 })) as never,
          })}
          options={[
            { value: "all", label: t("allCategories") },
            ...(categoryData?.categories ?? []).map((category) => ({ value: category.id, label: category.name })),
          ]}
          placeholder={t("allCategories")}
          searchPlaceholder={t("searchCategories")}
          emptyMessage={r("noResults")}
          ariaLabel={t("filterCategory")}
          triggerClassName="w-full shrink-0 sm:w-auto sm:min-w-40"
        />
      }
      rowTo={rowTo}
      rowLabel={(row) => row.name}
      viewUrl={(row) => (row.isActive ? getStorefrontPath(`/products/${row.slug}`) : undefined)}
      rowActions={(row) => [
        ...(can.canCreate ? [duplicateProductAction(() => duplicate.mutate({ id: row.id, name: row.name }))] : []),
        productShortcodeAction(row.slug),
      ]}
      bulkActions={can.canBulkDelete ? (rows, done) => <ProductBulkActions rows={rows} done={done} /> : undefined}
      lifecycle={{
        canTrash: can.canDelete,
        canRestore: can.canRestore,
        canDelete: can.canPermanentDelete,
        // Stock history keeps a product in Trash (AGENTS.md), so never offer a delete that fails.
        canDeleteRow: (row) => !row.hasStockHistory,
        deleteBlockedNote: (count) => t("keptForHistoryNote", { count }),
        run: async (action, rows) => {
          if (action === "trash" && rows.length === 1) {
            const { id, expectedAggregateRevision } = claim(rows[0]!);
            await apiData(deleteApiV1AdminProductsById({ path: { id }, query: { expectedAggregateRevision } }));
            return;
          }
          if (action === "restore") {
            for (const row of rows) {
              await apiData(postApiV1AdminProductsByIdRestore({ path: { id: row.id }, query: { expectedAggregateRevision: row.aggregateRevision } }));
            }
            return;
          }
          if (action === "delete" && rows.length === 1) {
            const { id, expectedAggregateRevision } = claim(rows[0]!);
            await apiData(deleteApiV1AdminProductsByIdPermanent({ path: { id }, query: { expectedAggregateRevision } }));
            return;
          }
          const result = await apiData(postApiV1AdminProductsBulkDelete({
            body: { products: rows.map(claim), permanent: action === "delete" },
          }));
          const kept = result.outcomes.filter((outcome) => outcome.status === "blocked" || outcome.status === "failed").length;
          if (kept > 0) throw new Error(t("bulkDeletePartial", { deleted: result.deletedIds.length, kept }));
        },
      }}
    />
  );
}
