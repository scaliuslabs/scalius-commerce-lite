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
import { adoptListSearch, listSearchKey, useListSearch } from "~/lib/list-search";
import { RouteErrorComponent } from "~/lib/route-error";
import { apiData } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { collectionsQueryOptions, type CollectionSummaryDto } from "~/lib/api-query-options/collections";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { Button } from "~/components/ui/button";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { ResourceListPage, ResourceRowLink, inChunks, useResourceMutation } from "~/components/admin/resource/ResourceListPage";
import { Badge } from "~/components/ui/badge";
import { DateText, sortHeader } from "~/components/admin/resource/columns";
import { translate, useMessages } from "~/i18n";
import { catalogMessages } from "~/i18n/catalog";
import { dataTableMessages } from "~/i18n/data-table";

const validateCollectionSearch = createListSearchValidator(
  ["name", "presentation", "isActive", "sortOrder", "updatedAt"] as const,
  { sort: "sortOrder", order: "asc" },
);

function listQuery(search: ReturnType<typeof validateCollectionSearch>, term: string) {
  return collectionsQueryOptions({
    page: search.page,
    limit: search.limit,
    search: term || undefined,
    sort: search.sort,
    order: search.order,
    trashed: search.trashed ? "true" : undefined,
  });
}

export const Route = createFileRoute("/admin/collections/")({
  validateSearch: validateCollectionSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => warmRouteQuery(queryClient, listQuery(deps, adoptListSearch(listSearchKey("collections", deps), deps.q))),
  head: () => ({ meta: [{ title: translate(catalogMessages, "collections") }] }),
  component: CollectionsPage,
  errorComponent: RouteErrorComponent,
});

const INVALIDATE = [queryKeys.collections.all];
const ids = (rows: CollectionSummaryDto[]) => rows.map((row) => row.id);

function CollectionsPage() {
  const search = Route.useSearch();
  const [term] = useListSearch(listSearchKey("collections", search));
  const t = useMessages(catalogMessages);
  const tableCopy = useMessages(dataTableMessages);
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
      meta: { mobile: "primary", minWidth: 220 },
      cell: ({ row }) => <ResourceRowLink to={search.trashed ? undefined : editTo(row.original)}>{row.original.name}</ResourceRowLink>,
    },
    {
      id: "products",
      header: t("products"),
      meta: { mobile: "secondary", priority: 70, minWidth: 160 },
      cell: ({ row }) => {
        const config = normalizeCollectionConfig(row.original.config);
        return (
          <span className="line-clamp-2 text-muted-foreground">
            {config.source === "dynamic"
              ? config.categoryIds.length === 1 ? t("autoOneCategory") : t("autoFromCategories", { count: config.categoryIds.length })
              : config.productIds.length === 1 ? t("productCountOne") : t("productCount", { count: config.productIds.length })}
            {config.showOnHomepage ? ` · ${t("onHomepage")}` : ""}
          </span>
        );
      },
    },
    {
      accessorKey: "isActive",
      header: sortHeader(t("status")),
      meta: { mobile: "status", priority: 90, minWidth: 100 },
      cell: ({ row }) => (
        <Badge variant={row.original.isActive ? "success" : "attention"}>{t(row.original.isActive ? "active" : "draft")}</Badge>
      ),
    },
    {
      accessorKey: "updatedAt",
      header: sortHeader(t("updated")),
      meta: { priority: 40, minWidth: 120 },
      cell: ({ row }) => <DateText value={row.original.updatedAt} />,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, search.trashed, can.canEdit]);

  // Drag to reorder in display order (the list kit also requires every row loaded).
  const reorderable =
    can.canReorder && !search.trashed && !term && search.sort === "sortOrder" && search.order === "asc";

  return (
    <ResourceListPage<CollectionSummaryDto>
      title={t("collections")}
      defaultSortLabel={tableCopy("manualOrder")}
      actions={can.canCreate ? <Button asChild><Link to="/admin/collections/new">{t("addCollection")}</Link></Button> : null}
      search={search}
      list="collections"
      countLabel={(count) => t("collectionCount", { count })}
      query={listQuery(search, term)}
      pageQuery={(page, limit) => listQuery({ ...search, page, limit }, term)}
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
          <Button variant="outline" size="sm" disabled={update.isPending} onClick={() => update.mutate({ variables: { kind: "activate", ids: ids(rows) }, success: t("statusUpdated") }, { onSuccess: done })}>
            {t("setActive")}
          </Button>
          <Button variant="outline" size="sm" disabled={update.isPending} onClick={() => update.mutate({ variables: { kind: "deactivate", ids: ids(rows) }, success: t("statusUpdated") }, { onSuccess: done })}>
            {t("setDraft")}
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
