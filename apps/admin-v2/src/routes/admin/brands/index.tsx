import { useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Award } from "lucide-react";
import {
  postApiV1AdminBrandsDeletePermanently,
  postApiV1AdminBrandsRestore,
  postApiV1AdminBrandsTrash,
} from "@scalius/api-client/sdk";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import {
  createListSearchValidator,
  normalizeOptionalEnumSearchParam,
  type SearchValidatorInput,
} from "~/lib/list-helpers";
import { adoptListSearch, listSearchKey, useListSearch } from "~/lib/list-search";
import { RouteErrorComponent } from "~/lib/route-error";
import { apiData } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { brandsQueryOptions, type BrandListItem } from "~/lib/api-query-options/brands";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { ResourceListPage, ResourceRowLink } from "~/components/admin/resource/ResourceListPage";
import { DateText, Thumb, sortHeader } from "~/components/admin/resource/columns";
import { useMessages } from "~/i18n";
import { brandMessages } from "~/i18n/brands";
import { pageHead } from "~/i18n/page-titles";

const STATUSES = ["published", "draft"] as const;
const validateBase = createListSearchValidator(["name", "sortOrder", "createdAt", "updatedAt"] as const, { sort: "updatedAt" });

function validateBrandSearch(search: SearchValidatorInput) {
  return { ...validateBase(search), status: normalizeOptionalEnumSearchParam(search.status, STATUSES) };
}

function listQuery(search: ReturnType<typeof validateBrandSearch>, term: string) {
  return brandsQueryOptions({
    page: search.page,
    limit: search.limit,
    search: term || undefined,
    sort: search.sort,
    order: search.order,
    trashed: search.trashed ? "true" : undefined,
    status: search.trashed ? undefined : search.status,
  });
}

export const Route = createFileRoute("/admin/brands/")({
  validateSearch: validateBrandSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) =>
    warmRouteQuery(queryClient, listQuery(deps, adoptListSearch(listSearchKey("brands", deps, "status"), deps.q))),
  head: () => pageHead("brands"),
  component: BrandsPage,
  errorComponent: RouteErrorComponent,
});

const claims = (rows: BrandListItem[]) => rows.map((row) => ({ id: row.id, expectedRevision: row.revision }));

function BrandsPage() {
  const search = Route.useSearch();
  const [term] = useListSearch(listSearchKey("brands", search, "status"));
  const t = useMessages(brandMessages);
  const { getStorefrontPath } = useStorefrontUrl();
  // Brands share the category permissions (API route permissions).
  const { categories: can } = useCatalogActionPermissions();
  const editTo = (row: BrandListItem) => (can.canEdit ? `/admin/brands/${row.id}/edit` : undefined);

  const columns = useMemo<ColumnDef<BrandListItem, unknown>[]>(() => [
    {
      accessorKey: "name",
      header: sortHeader(t("brand")),
      meta: { mobile: "primary", minWidth: 240 },
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-3">
          <Thumb src={row.original.logo ? mediaImageUrl(row.original.logo.url, 160) : null} icon={Award} />
          <ResourceRowLink to={search.trashed ? undefined : editTo(row.original)}>{row.original.name}</ResourceRowLink>
        </div>
      ),
    },
    {
      accessorKey: "status",
      header: t("status"),
      meta: { mobile: "status", priority: 90, minWidth: 100 },
      cell: ({ row }) => (
        <Badge variant={row.original.status === "published" ? "success" : "attention"}>
          {t(row.original.status === "published" ? "active" : "draft")}
        </Badge>
      ),
    },
    {
      id: "productCount",
      header: t("products"),
      meta: { mobile: "secondary", priority: 70, minWidth: 110 },
      cell: ({ row }) => {
        const count = row.original.productCount;
        return (
          <span className="whitespace-nowrap text-muted-foreground">
            {count === 1 ? t("productCountOne") : t("productCount", { count })}
          </span>
        );
      },
    },
    {
      accessorKey: "updatedAt",
      header: sortHeader(t("updated")),
      meta: { priority: 40, minWidth: 120 },
      cell: ({ row }) => <DateText value={row.original.updatedAt} />,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, search.trashed, can.canEdit]);

  return (
    <ResourceListPage<BrandListItem>
      title={t("brands")}
      actions={can.canCreate ? <Button asChild><Link to="/admin/brands/new">{t("addBrand")}</Link></Button> : null}
      search={search}
      list="brands"
      countLabel={(count) => t("brandCount", { count })}
      query={listQuery(search, term)}
      pageQuery={(page, limit) => listQuery({ ...search, page, limit }, term)}
      dataKey="brands"
      columns={columns}
      invalidate={[queryKeys.brands.all]}
      empty={{ icon: Award, title: t("emptyTitle"), description: t("emptyBody") }}
      views={{ param: "status", tabs: [
        { value: "published", label: t("active") },
        { value: "draft", label: t("draft") },
      ] }}
      rowTo={editTo}
      rowLabel={(row) => row.name}
      viewUrl={(row) => (row.status === "published" ? getStorefrontPath(`/brands/${row.slug}`) : undefined)}
      lifecycle={{
        canTrash: can.canDelete,
        canRestore: can.canRestore,
        canDelete: can.canPermanentDelete,
        run: (action, rows) => {
          const body = { brands: claims(rows) };
          if (action === "restore") return apiData(postApiV1AdminBrandsRestore({ body }));
          if (action === "delete") return apiData(postApiV1AdminBrandsDeletePermanently({ body }));
          return apiData(postApiV1AdminBrandsTrash({ body }));
        },
      }}
    />
  );
}
