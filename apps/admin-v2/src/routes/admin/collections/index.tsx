import { useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Layers3 } from "lucide-react";
import {
  postApiV1AdminCollectionsBulkActivate,
  postApiV1AdminCollectionsBulkDeactivate,
  postApiV1AdminCollectionsBulkDelete,
  postApiV1AdminCollectionsBulkRestore,
  postApiV1AdminCollectionsReorder,
} from "@scalius/api-client/sdk";
import { normalizeCollectionConfig } from "@scalius/core/modules/collections/collection-config";
import { createListSearchValidator } from "~/lib/list-helpers";
import { RouteErrorComponent } from "~/lib/route-error";
import { apiData } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { collectionsQueryOptions, type CollectionSummaryDto } from "~/lib/api-query-options/collections";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { Button } from "~/components/ui/button";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { ResourceListPage, ResourceRowLink, inChunks, useResourceMutation } from "~/components/admin/resource/ResourceListPage";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { sortHeader } from "~/components/admin/resource/columns";
import { translate, useMessages } from "~/i18n";
import { catalogMessages } from "~/i18n/catalog";

const validateCollectionSearch = createListSearchValidator(
  ["name", "presentation", "isActive", "sortOrder", "updatedAt"] as const,
  { sort: "sortOrder", order: "asc", limit: 50 },
);

function listQuery(search: ReturnType<typeof validateCollectionSearch>) {
  return collectionsQueryOptions({
    page: search.page,
    limit: search.limit,
    search: search.search || undefined,
    sort: search.sort,
    order: search.order,
    trashed: search.trashed ? "true" : undefined,
  });
}

export const Route = createFileRoute("/admin/collections/")({
  validateSearch: validateCollectionSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => warmRouteQuery(queryClient, listQuery(deps)),
  head: () => ({ meta: [{ title: translate(catalogMessages, "collections") }] }),
  component: CollectionsPage,
  errorComponent: RouteErrorComponent,
});

const INVALIDATE = [queryKeys.collections.all];
const ids = (rows: CollectionSummaryDto[]) => rows.map((row) => row.id);

function CollectionsPage() {
  const search = Route.useSearch();
  const t = useMessages(catalogMessages);
  const { collections: can } = useCatalogActionPermissions();
  const update = useResourceMutation(
    (action: { kind: "activate" | "deactivate"; ids: string[] } | { kind: "reorder"; items: Array<{ id: string; sortOrder: number; expectedVersion: number }> }) =>
      action.kind === "reorder"
        ? apiData(postApiV1AdminCollectionsReorder({ body: { items: action.items } }))
        : inChunks(action.ids, (ids) =>
            action.kind === "activate"
              ? apiData(postApiV1AdminCollectionsBulkActivate({ body: { ids } }))
              : apiData(postApiV1AdminCollectionsBulkDeactivate({ body: { ids } })),
          ),
    INVALIDATE,
  );
  const editTo = (row: CollectionSummaryDto) => (can.canEdit ? `/admin/collections/${row.id}/edit` : undefined);

  const columns = useMemo<ColumnDef<CollectionSummaryDto, unknown>[]>(() => [
    {
      accessorKey: "name",
      header: sortHeader(t("collection")),
      meta: { mobile: "primary" },
      cell: ({ row }) => <ResourceRowLink to={search.trashed ? undefined : editTo(row.original)}>{row.original.name}</ResourceRowLink>,
    },
    {
      id: "products",
      header: t("products"),
      meta: { mobile: "secondary" },
      cell: ({ row }) => {
        const config = normalizeCollectionConfig(row.original.config);
        return (
          <span className="text-muted-foreground">
            {config.source === "dynamic"
              ? t("autoFromCategories", { count: config.categoryIds.length })
              : config.productIds.length === 1 ? t("productCountOne") : t("handPicked", { count: config.productIds.length })}
            {config.showOnHomepage ? ` · ${t("onHomepage")}` : ""}
          </span>
        );
      },
    },
    {
      accessorKey: "isActive",
      header: sortHeader(t("status")),
      meta: { mobile: "status" },
      cell: ({ row }) => (
        <StatusBadge tone={row.original.isActive ? "success" : "neutral"}>{t(row.original.isActive ? "active" : "inactive")}</StatusBadge>
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, search.trashed, can.canEdit]);

  // Drag to reorder in display order (the list kit also requires every row loaded).
  const reorderable =
    can.canReorder && !search.trashed && !search.search && search.sort === "sortOrder" && search.order === "asc";

  return (
    <ResourceListPage<CollectionSummaryDto>
      title={t("collections")}
      actions={can.canCreate ? <Button asChild><Link to="/admin/collections/new">{t("addCollection")}</Link></Button> : null}
      search={search}
      query={listQuery(search)}
      pageQuery={(page, limit) => listQuery({ ...search, page, limit })}
      dataKey="collections"
      columns={columns}
      invalidate={INVALIDATE}
      empty={{ icon: Layers3, title: t("collectionsEmptyTitle"), description: t("collectionsEmptyBody") }}
      rowTo={editTo}
      rowLabel={(row) => row.name}
      sortable={reorderable}
      onReorder={(from, to, rows) => {
        const next = [...rows];
        const [moved] = next.splice(from, 1);
        if (!moved) return;
        next.splice(to, 0, moved);
        update.mutate({
          variables: { kind: "reorder", items: next.map((row, index) => ({ id: row.id, sortOrder: index, expectedVersion: row.version })) },
          success: t("reordered"),
        });
      }}
      bulkActions={can.canToggleStatus ? (rows, done) => (
        <>
          <Button variant="outline" size="sm" disabled={update.isPending} onClick={() => update.mutate({ variables: { kind: "activate", ids: ids(rows) }, success: t("activated") }, { onSuccess: done })}>
            {t("activate")}
          </Button>
          <Button variant="outline" size="sm" disabled={update.isPending} onClick={() => update.mutate({ variables: { kind: "deactivate", ids: ids(rows) }, success: t("deactivated") }, { onSuccess: done })}>
            {t("deactivate")}
          </Button>
        </>
      ) : undefined}
      lifecycle={{
        canTrash: can.canDelete,
        canRestore: can.canRestore,
        canDelete: can.canPermanentDelete,
        run: (action, rows) =>
          action === "restore"
            ? apiData(postApiV1AdminCollectionsBulkRestore({ body: { ids: ids(rows) } }))
            : apiData(postApiV1AdminCollectionsBulkDelete({ body: { collectionIds: ids(rows), permanent: action === "delete" } })),
      }}
    />
  );
}
