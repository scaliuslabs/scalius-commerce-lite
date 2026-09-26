import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
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
import { adoptListSearch, listSearchKey, useListSearch } from "~/lib/list-search";
import { RouteErrorComponent } from "~/lib/route-error";
import { apiData } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { warmRouteQuery } from "~/lib/route-query-warming";
import {
  categoriesQueryOptions,
  categoryFormOptionsQueryOptions,
  type CategoryListItem,
} from "~/lib/api-query-options/categories";
import { categoryPathLabel, indexCategories } from "~/lib/category-tree";
import { MoveCategoryDialog, type MoveTarget } from "~/components/admin/catalog/MoveCategoryDialog";
import { categoryFormMessages } from "~/i18n/category-form";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { Button } from "~/components/ui/button";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { ResourceListPage, ResourceRowLink } from "~/components/admin/resource/ResourceListPage";
import { Badge } from "~/components/ui/badge";
import { DateText, Thumb, sortHeader } from "~/components/admin/resource/columns";
import { useMessages } from "~/i18n";
import { catalogMessages } from "~/i18n/catalog";
import { pageHead } from "~/i18n/page-titles";

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
  loader: ({ context: { queryClient }, deps }) => Promise.all([
    warmRouteQuery(queryClient, listQuery(deps, adoptListSearch(listSearchKey("categories", deps, "status"), deps.q))),
    // Rows name their parents (the stored path) from the lookup list.
    queryClient.ensureQueryData(categoryFormOptionsQueryOptions()).catch(() => null),
  ]),
  head: () => pageHead("categories"),
  component: CategoriesPage,
  errorComponent: RouteErrorComponent,
});

const claims = (rows: CategoryListItem[]) => rows.map((row) => ({ id: row.id, expectedRevision: row.revision }));

function CategoriesPage() {
  const search = Route.useSearch();
  const [term] = useListSearch(listSearchKey("categories", search, "status"));
  const t = useMessages(catalogMessages);
  const { getStorefrontPath } = useStorefrontUrl();
  const { categories: can } = useCatalogActionPermissions();
  const editTo = (row: CategoryListItem) => (can.canEdit ? `/admin/categories/${row.id}/edit` : undefined);
  const { data: lookup } = useQuery(categoryFormOptionsQueryOptions());
  const f = useMessages(categoryFormMessages);
  // The dialog stays mounted; each opening gets a fresh picker by bumping its key.
  const [moving, setMoving] = useState<{ key: number; target: MoveTarget | null }>({ key: 0, target: null });
  const byId = useMemo(() => indexCategories(lookup?.categories ?? []), [lookup]);

  const columns = useMemo<ColumnDef<CategoryListItem, unknown>[]>(() => [
    {
      accessorKey: "name",
      header: sortHeader(t("category")),
      meta: { mobile: "primary", minWidth: 240 },
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-3">
          <Thumb src={row.original.imageUrl ? mediaImageUrl(row.original.imageUrl, 160) : null} icon={FolderTree} />
          <div className="min-w-0">
            <ResourceRowLink to={search.trashed ? undefined : editTo(row.original)}>{row.original.name}</ResourceRowLink>
            {row.original.parentId && byId.has(row.original.parentId) ? (
              <p className="truncate text-body text-muted-foreground">{categoryPathLabel(row.original.parentId, byId)}</p>
            ) : null}
          </div>
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
  ], [t, search.trashed, can.canEdit, byId]);

  return (
    <>
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
      rowActions={(row) => (can.canEdit && !search.trashed ? [{
        label: f("moveCategory"),
        onClick: () => setMoving((current) => ({
          key: current.key + 1,
          target: { id: row.id, name: row.name, parentId: row.parentId, revision: row.revision },
        })),
      }] : [])}
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
    <MoveCategoryDialog key={moving.key} target={moving.target} onClose={() => setMoving((current) => ({ ...current, target: null }))} />
    </>
  );
}
