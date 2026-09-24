import { useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { FolderTree } from "lucide-react";
import {
  postApiV1AdminCategoriesBulkDelete,
  postApiV1AdminCategoriesBulkRestore,
} from "@scalius/api-client/sdk";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import {
  createListSearchValidator,
  normalizeOptionalEnumSearchParam,
  type SearchValidatorInput,
} from "~/lib/list-helpers";
import { adoptListSearch, useListSearch } from "~/lib/list-search";
import { RouteErrorComponent } from "~/lib/route-error";
import { apiData } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { categoriesQueryOptions, type CategoryListItem } from "~/lib/api-query-options/categories";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { Button } from "~/components/ui/button";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { ResourceListPage, ResourceRowLink } from "~/components/admin/resource/ResourceListPage";
import { Badge } from "~/components/ui/badge";
import { DateText, Thumb, sortHeader } from "~/components/admin/resource/columns";
import { translate, useMessages } from "~/i18n";
import { catalogMessages } from "~/i18n/catalog";

const STATUSES = ["published", "draft", "internal"] as const;
const validateBase = createListSearchValidator(["name", "status", "createdAt", "updatedAt"] as const, { sort: "updatedAt" });

function validateCategorySearch(search: SearchValidatorInput) {
  return { ...validateBase(search), status: normalizeOptionalEnumSearchParam(search.status, STATUSES) };
}

function listQuery(search: ReturnType<typeof validateCategorySearch>, term: string) {
  return categoriesQueryOptions({
    page: search.page,
    limit: search.limit,
    search: term || undefined,
    sort: search.sort,
    order: search.order,
    trashed: search.trashed ? "true" : undefined,
    status: search.trashed ? undefined : search.status,
  });
}

export const Route = createFileRoute("/admin/categories/")({
  validateSearch: validateCategorySearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => warmRouteQuery(queryClient, listQuery(deps, adoptListSearch("categories", deps.q))),
  head: () => ({ meta: [{ title: translate(catalogMessages, "categories") }] }),
  component: CategoriesPage,
  errorComponent: RouteErrorComponent,
});

const claims = (rows: CategoryListItem[]) => rows.map((row) => ({ id: row.id, expectedRevision: row.revision }));

function CategoriesPage() {
  const search = Route.useSearch();
  const [term] = useListSearch("categories");
  const t = useMessages(catalogMessages);
  const { getStorefrontPath } = useStorefrontUrl();
  const { categories: can } = useCatalogActionPermissions();
  const editTo = (row: CategoryListItem) => (can.canEdit ? `/admin/categories/${row.id}/edit` : undefined);

  const columns = useMemo<ColumnDef<CategoryListItem, unknown>[]>(() => [
    {
      accessorKey: "name",
      header: sortHeader(t("category")),
      meta: { mobile: "primary", minWidth: 240 },
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-3">
          <Thumb src={row.original.imageUrl ? mediaImageUrl(row.original.imageUrl, 160) : null} icon={FolderTree} />
          <ResourceRowLink to={search.trashed ? undefined : editTo(row.original)}>{row.original.name}</ResourceRowLink>
        </div>
      ),
    },
    {
      accessorKey: "status",
      header: sortHeader(t("status")),
      meta: { mobile: "status", priority: 90, minWidth: 100 },
      cell: ({ row }) => {
        const status = row.original.status;
        return (
          <Badge variant={status === "published" ? "success" : status === "draft" ? "attention" : "secondary"}>
            {t(status === "published" ? "active" : status === "internal" ? "hidden" : "draft")}
          </Badge>
        );
      },
    },
    {
      id: "productCount",
      header: t("products"),
      meta: { mobile: "secondary", priority: 70, minWidth: 110 },
      cell: ({ row }) => {
        const count = row.original.productCount ?? 0;
        const label = count === 1 ? t("productCountOne") : t("productCount", { count });
        return count > 0 ? (
          <Link to="/admin/products" search={{ category: row.original.id } as never} className="whitespace-nowrap text-muted-foreground hover:underline">
            {label}
          </Link>
        ) : (
          <span className="whitespace-nowrap text-muted-foreground">{label}</span>
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
    <ResourceListPage<CategoryListItem>
      title={t("categories")}
      actions={can.canCreate ? <Button asChild><Link to="/admin/categories/new">{t("addCategory")}</Link></Button> : null}
      search={search}
      list="categories"
      countLabel={(count) => t("categoryCount", { count })}
      query={listQuery(search, term)}
      pageQuery={(page, limit) => listQuery({ ...search, page, limit }, term)}
      dataKey="categories"
      columns={columns}
      invalidate={[queryKeys.categories.all, queryKeys.collections.categoryOptions(), queryKeys.products.stats()]}
      empty={{ icon: FolderTree, title: t("categoriesEmptyTitle"), description: t("categoriesEmptyBody") }}
      views={{ param: "status", tabs: [
        { value: "published", label: t("active") },
        { value: "draft", label: t("draft") },
        { value: "internal", label: t("hidden") },
      ] }}
      rowTo={editTo}
      rowLabel={(row) => row.name}
      viewUrl={(row) => (row.status === "published" ? getStorefrontPath(`/categories/${row.slug}`) : undefined)}
      lifecycle={{
        canTrash: can.canDelete,
        canRestore: can.canRestore,
        canDelete: can.canPermanentDelete,
        run: (action, rows) =>
          action === "restore"
            ? apiData(postApiV1AdminCategoriesBulkRestore({ body: { categories: claims(rows) } }))
            : apiData(postApiV1AdminCategoriesBulkDelete({ body: { categories: claims(rows), permanent: action === "delete" } })),
      }}
    />
  );
}
