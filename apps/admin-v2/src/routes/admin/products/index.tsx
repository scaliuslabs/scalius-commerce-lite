import { lazy, Suspense, useMemo, useState } from "react";
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
  NO_CURSOR,
  createListSearchValidator,
  normalizeAppFilterSearchParam,
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
import { channelsInUse, salesChannelName, salesChannelsQueryOptions } from "~/lib/api-query-options/sales-channels";
import { salesChannelNamesMessages } from "~/i18n/sales-channel-names";
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
import { Skeleton } from "~/components/ui/skeleton";
import { useAppListColumns } from "~/components/admin/apps/ui/list-columns";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { resourceMessages } from "~/i18n/resource";
import { pageHead } from "~/i18n/page-titles";
import { LazyImportDialog } from "~/components/admin/store-transfer/LazyImportDialog";

const STATUSES = ["active", "draft"] as const;
const CHANNEL_STATES = ["published", "unpublished"] as const;
const validateBase = createListSearchValidator(["updatedAt", "createdAt", "name", "price", "category"] as const, { sort: "updatedAt" });

function validateProductSearch(search: SearchValidatorInput) {
  return {
    ...validateBase(search),
    category: normalizeOptionalSearchString(search.category),
    status: normalizeOptionalEnumSearchParam(search.status, STATUSES),
    // Sales channels (MARKETS-DESIGN D6): on (or not on) one channel.
    channel: normalizeOptionalSearchString(search.channel),
    channelState: normalizeOptionalEnumSearchParam(search.channelState, CHANNEL_STATES),
    // An app column and its exact value: `<app id>/<column id>:<value>`.
    appFilter: normalizeAppFilterSearchParam(search.appFilter),
  };
}

type ProductSearch = ReturnType<typeof validateProductSearch>;

/**
 * `app` is what the active apps ask of the list (their columns and the filter
 * their columns allow); the route's loader runs before they are known and
 * reads the URL's filter as it is.
 */
function listQuery(search: ProductSearch, term: string, app?: { columnsParam?: string; filterParam?: string }) {
  // A numbered page (older links) or a cursor, never both.
  const cursor = search.after ? { after: search.after } : search.before ? { before: search.before } : null;
  return productsQueryOptions({
    ...(cursor ?? { page: search.page }),
    limit: search.limit,
    search: term || undefined,
    category: search.category || undefined,
    sort: search.sort,
    order: search.order,
    trashed: search.trashed ? "true" : undefined,
    status: search.trashed ? undefined : search.status,
    salesChannel: search.channel || undefined,
    salesChannelState: search.channel ? search.channelState : undefined,
    view: "compact",
    appFilter: app ? app.filterParam : search.appFilter,
    appColumns: app?.columnsParam,
  });
}

// Loads only when an active app has a column to filter by.
const AppListFilter = lazy(() => import("~/components/admin/apps/AppListFilter").then((module) => ({ default: module.AppListFilter })));

export const Route = createFileRoute("/admin/products/")({
  validateSearch: validateProductSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => warmRouteQuery(queryClient, listQuery(deps, adoptListSearch(listSearchKey("products", deps, "status"), deps.q))),
  head: () => pageHead("products"),
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
  const [importing, setImporting] = useState(false);
  const { data: categoryData } = useQuery(categoryFormOptionsQueryOptions());
  const { data: channelData } = useQuery(salesChannelsQueryOptions());
  const c = useMessages(salesChannelNamesMessages);
  const rowTo = (row: ProductListItem) => `/admin/products/${row.id}/edit`;
  // The Channels column and filter appear once the store tells channels apart
  // (or a link, such as Settings › Sales channels, filters by one).
  const showChannels = Boolean(channelData && (channelsInUse(channelData) || search.channel));
  const channelNames = useMemo(
    () => (channelData && showChannels ? new Map(channelData.map((channel) => [channel.id, salesChannelName(channel)])) : undefined),
    // Names follow the dashboard language (c changes with it).
    [channelData, showChannels, c],
  );

  const app = useAppListColumns<ProductListItem>("product", search.appFilter);
  const columns = useMemo(
    () => getProductColumns({ trashed: search.trashed, fmt, rowTo, channels: channelNames, extra: app.extra }),
    [search.trashed, fmt, channelNames, app.extra],
  );
  const channelFilter = search.channel ? `${search.channelState ?? "published"}:${search.channel}` : "all";

  return (
    <>
      <ResourceListPage<ProductListItem>
        title={t("products")}
        list="products"
        appActions="product"
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/admin/inventory/labels">{t("printLabels")}</Link>
            </Button>
            {can.canCreate || can.canEdit ? (
              <Button variant="outline" onClick={() => setImporting(true)}>{r("import")}</Button>
            ) : null}
            {can.canCreate ? (
              <Button asChild>
                <Link to="/admin/products/new">{t("addProduct")}</Link>
              </Button>
            ) : null}
          </>
        }
        search={search}
        query={listQuery(search, term, app)}
        pageQuery={(page, limit) => listQuery({ ...search, page, limit, ...NO_CURSOR }, term, { filterParam: app.filterParam })}
        cursorPaging
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
        filterParams={["category", "channel", "channelState", "appFilter"]}
        filters={
          <>
          <SearchableSelect
            value={search.category ?? "all"}
            onValueChange={(value) => void navigate({
              to: "/admin/products",
              search: ((prev: Record<string, unknown>) => ({ ...prev, category: value === "all" ? undefined : value, page: 1, ...NO_CURSOR })) as never,
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
          {showChannels ? (
          <SearchableSelect
            value={channelFilter}
            onValueChange={(value) => {
              const [state, ...rest] = value.split(":");
              const channel = value === "all" ? undefined : rest.join(":");
              void navigate({
                to: "/admin/products",
                search: ((prev: Record<string, unknown>) => ({
                  ...prev,
                  channel,
                  channelState: channel && state === "unpublished" ? "unpublished" : undefined,
                  page: 1,
                  ...NO_CURSOR,
                })) as never,
              });
            }}
            options={[
              { value: "all", label: c("allChannels") },
              ...(channelData ?? []).flatMap((channel) => [
                { value: `published:${channel.id}`, label: c("onChannel", { name: salesChannelName(channel) }) },
                { value: `unpublished:${channel.id}`, label: c("notOnChannel", { name: salesChannelName(channel) }) },
              ]),
            ]}
            placeholder={c("allChannels")}
            searchPlaceholder={c("filterChannel")}
            emptyMessage={r("noResults")}
            ariaLabel={c("filterChannel")}
            triggerClassName="w-full shrink-0 sm:w-auto sm:min-w-44"
          />
          ) : null}
          {app.filterable.length > 0 ? (
            <Suspense fallback={<Skeleton className="h-9 w-full sm:w-80" />}>
              <AppListFilter
                resource="product"
                value={search.appFilter}
                onChange={(appFilter) => void navigate({
                  to: "/admin/products",
                  search: ((prev: Record<string, unknown>) => ({ ...prev, appFilter, page: 1, ...NO_CURSOR })) as never,
                })}
              />
            </Suspense>
          ) : null}
          </>
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
      <LazyImportDialog kind="products" open={importing} onOpenChange={setImporting} />
    </>
  );
}
