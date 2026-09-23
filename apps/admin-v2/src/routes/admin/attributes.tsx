import { useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ListTree } from "lucide-react";
import {
  deleteApiV1AdminAttributesById,
  deleteApiV1AdminAttributesByIdPermanent,
  postApiV1AdminAttributesBulkDelete,
  postApiV1AdminAttributesBulkRestore,
} from "@scalius/api-client/sdk";
import { createListSearchValidator } from "~/lib/list-helpers";
import { RouteErrorComponent } from "~/lib/route-error";
import { apiData } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { attributesQueryOptions, type AttributeDto } from "~/lib/api-query-options/attributes";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { Button } from "~/components/ui/button";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { ResourceListPage } from "~/components/admin/resource/ResourceListPage";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { sortHeader } from "~/components/admin/resource/columns";
import { AttributeDialog } from "~/components/admin/attributes-manager/components/AttributeDialog";
import { AttributeValueEditor } from "~/components/admin/attributes-manager/components/AttributeValueEditor";
import { AttributeValuesViewer } from "~/components/admin/attributes-manager/components/AttributeValuesViewer";
import { translate, useMessages } from "~/i18n";
import { catalogMessages } from "~/i18n/catalog";

const validateAttributeSearch = createListSearchValidator(
  ["name", "slug", "filterable", "updatedAt"] as const,
  { sort: "name", order: "asc" },
);

function listQuery(search: ReturnType<typeof validateAttributeSearch>) {
  return attributesQueryOptions({
    page: search.page,
    limit: search.limit,
    search: search.search || undefined,
    sort: search.sort,
    order: search.order,
    trashed: search.trashed ? "true" : undefined,
  });
}

export const Route = createFileRoute("/admin/attributes")({
  validateSearch: validateAttributeSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => warmRouteQuery(queryClient, listQuery(deps)),
  head: () => ({ meta: [{ title: translate(catalogMessages, "attributes") }] }),
  component: AttributesPage,
  errorComponent: RouteErrorComponent,
});

const INVALIDATE = [queryKeys.attributes.all];

function AttributesPage() {
  const search = Route.useSearch();
  const t = useMessages(catalogMessages);
  const { attributes: can } = useCatalogActionPermissions();
  const [editing, setEditing] = useState<AttributeDto | "new" | null>(null);
  const [values, setValues] = useState<AttributeDto | null>(null);
  const valuesOpener = useRef<HTMLElement | null>(null);

  const columns = useMemo<ColumnDef<AttributeDto, unknown>[]>(() => [
    {
      accessorKey: "name",
      header: sortHeader(t("attribute")),
      meta: { mobile: "primary" },
      cell: ({ row }) =>
        can.canEdit && !search.trashed ? (
          <button type="button" className="truncate text-left font-medium hover:underline" onClick={() => setEditing(row.original)}>
            {row.original.name}
          </button>
        ) : (
          <span className="truncate font-medium">{row.original.name}</span>
        ),
    },
    {
      accessorKey: "slug",
      header: sortHeader(t("handle")),
      meta: { mobile: "secondary" },
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.slug}</span>,
    },
    {
      id: "values",
      header: t("values"),
      meta: { mobile: "secondary" },
      cell: ({ row }) => (
        <button
          type="button"
          className="text-muted-foreground hover:underline disabled:no-underline"
          disabled={search.trashed}
          onClick={(event) => {
            valuesOpener.current = event.currentTarget;
            setValues(row.original);
          }}
        >
          {t("values")}: {row.original.valueCount}
        </button>
      ),
    },
    {
      accessorKey: "filterable",
      header: sortHeader(t("filterable")),
      meta: { mobile: "status" },
      cell: ({ row }) => (row.original.filterable ? <StatusBadge tone="neutral">{t("filterableYes")}</StatusBadge> : null),
    },
  ], [t, can.canEdit, search.trashed]);

  return (
    <>
      <ResourceListPage<AttributeDto>
        title={t("attributes")}
        actions={can.canCreate ? <Button onClick={() => setEditing("new")}>{t("addAttribute")}</Button> : null}
        search={search}
        query={listQuery(search)}
        dataKey="attributes"
        columns={columns}
        invalidate={INVALIDATE}
        empty={{ icon: ListTree, title: t("attributesEmptyTitle"), description: t("attributesEmptyBody") }}
        rowActions={(row) => [
          ...(can.canEdit ? [{ label: t("editAttribute"), onClick: () => setEditing(row) }] : []),
          {
            label: can.canEdit ? t("editValues") : t("viewValues"),
            onClick: (opener?: HTMLElement) => {
              valuesOpener.current = opener ?? null;
              setValues(row);
            },
          },
        ]}
        lifecycle={{
          canTrash: can.canDelete,
          canRestore: can.canRestore,
          canDelete: can.canPermanentDelete,
          run: (action, rows) => {
            const ids = rows.map((row) => row.id);
            if (action === "restore") return apiData(postApiV1AdminAttributesBulkRestore({ body: { ids } }));
            if (rows.length > 1) return apiData(postApiV1AdminAttributesBulkDelete({ body: { ids, permanent: action === "delete" } }));
            return action === "delete"
              ? apiData(deleteApiV1AdminAttributesByIdPermanent({ path: { id: ids[0]! } }))
              : apiData(deleteApiV1AdminAttributesById({ path: { id: ids[0]! } }));
          },
        }}
      />
      {editing ? <AttributeDialog attribute={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} /> : null}
      {can.canEdit ? (
        <AttributeValueEditor
          key={values?.id ?? "closed"}
          attributeId={values?.id ?? null}
          attributeName={values?.name ?? null}
          onClose={() => setValues(null)}
          openerRef={valuesOpener}
        />
      ) : (
        <AttributeValuesViewer
          attributeId={values?.id ?? null}
          attributeName={values?.name ?? null}
          onClose={() => setValues(null)}
          openerRef={valuesOpener}
        />
      )}
    </>
  );
}
