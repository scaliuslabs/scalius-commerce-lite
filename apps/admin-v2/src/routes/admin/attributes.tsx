import { useMemo, useRef, useState } from "react";
import { IdText } from "~/components/admin/data-table/cells";
import { createFileRoute } from "@tanstack/react-router";
import { ListTree } from "lucide-react";
import {
  deleteApiV1AdminAttributesById,
  deleteApiV1AdminAttributesByIdPermanent,
  postApiV1AdminAttributesBulkDelete,
  postApiV1AdminAttributesBulkRestore,
} from "@scalius/api-client/sdk";
import { createListSearchValidator } from "~/lib/list-helpers";
import { adoptListSearch, listSearchKey, useListSearch } from "~/lib/list-search";
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
import { AttributeGroupsDialog } from "~/components/admin/attributes-manager/components/AttributeGroupsDialog";
import { attributeTypeMessages } from "~/i18n/attribute-types";
import { formatNumber, useMessages } from "~/i18n";
import { catalogMessages } from "~/i18n/catalog";
import { dataTableMessages } from "~/i18n/data-table";
import { pageHead } from "~/i18n/page-titles";

const validateAttributeSearch = createListSearchValidator(
  ["name", "slug", "filterable", "updatedAt"] as const,
  { sort: "name", order: "asc" },
);

function listQuery(search: ReturnType<typeof validateAttributeSearch>, term: string) {
  return attributesQueryOptions({
    page: search.page,
    limit: search.limit,
    search: term || undefined,
    sort: search.sort,
    order: search.order,
    trashed: search.trashed ? "true" : undefined,
  });
}

export const Route = createFileRoute("/admin/attributes")({
  validateSearch: validateAttributeSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => warmRouteQuery(queryClient, listQuery(deps, adoptListSearch(listSearchKey("attributes", deps), deps.q))),
  head: () => pageHead("attributes"),
  component: AttributesPage,
  errorComponent: RouteErrorComponent,
});

const INVALIDATE = [queryKeys.attributes.all];

function AttributesPage() {
  const search = Route.useSearch();
  const [term] = useListSearch(listSearchKey("attributes", search));
  const t = useMessages(catalogMessages);
  const tableCopy = useMessages(dataTableMessages);
  const a = useMessages(attributeTypeMessages);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const { attributes: can } = useCatalogActionPermissions();
  const [editing, setEditingState] = useState<AttributeDto | "new" | null>(null);
  // The dialog stays mounted so it can animate closed; each opening gets a
  // fresh form by bumping its key, while closing keeps the last target.
  const [dialog, setDialog] = useState<{ key: number; target: AttributeDto | "new" }>({ key: 0, target: "new" });
  const setEditing = (target: AttributeDto | "new" | null) => {
    if (target !== null) setDialog((current) => ({ key: current.key + 1, target }));
    setEditingState(target);
  };
  const [values, setValues] = useState<AttributeDto | null>(null);
  const valuesOpener = useRef<HTMLElement | null>(null);

  const columns = useMemo<ColumnDef<AttributeDto, unknown>[]>(() => [
    {
      accessorKey: "name",
      header: sortHeader(t("attribute")),
      meta: { mobile: "primary", minWidth: 200 },
      cell: ({ row }) =>
        can.canEdit && !search.trashed ? (
          <button type="button" className="line-clamp-2 break-words text-left font-medium hover:underline" onClick={() => setEditing(row.original)}>
            {row.original.name}
          </button>
        ) : (
          <span className="line-clamp-2 break-words font-medium">{row.original.name}</span>
        ),
    },
    {
      accessorKey: "slug",
      header: sortHeader(t("handle")),
      meta: { mobile: "secondary", priority: 60, minWidth: 140 },
      cell: ({ row }) => <IdText value={row.original.slug} className="text-muted-foreground" />,
    },
    {
      id: "valueType",
      header: a("type"),
      meta: { priority: 70, minWidth: 110 },
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-muted-foreground">
          {a(`type_${row.original.valueType}`)}
          {row.original.unit ? ` · ${row.original.unit}` : ""}
        </span>
      ),
    },
    {
      id: "values",
      header: t("values"),
      meta: { numeric: true, priority: 80, minWidth: 80 },
      cell: ({ row }) => (
        <button
          type="button"
          className="tabular-nums text-muted-foreground hover:underline disabled:no-underline"
          disabled={search.trashed}
          onClick={(event) => {
            valuesOpener.current = event.currentTarget;
            setValues(row.original);
          }}
        >
          {formatNumber(row.original.valueCount)}
        </button>
      ),
    },
    {
      accessorKey: "filterable",
      header: sortHeader(t("filterable")),
      meta: { mobile: "status", priority: 50, minWidth: 110 },
      cell: ({ row }) => (row.original.filterable ? <StatusBadge tone="neutral">{t("filterableYes")}</StatusBadge> : null),
    },
  ], [t, a, can.canEdit, search.trashed]);

  return (
    <>
      <ResourceListPage<AttributeDto>
        title={t("attributes")}
        defaultSortLabel={tableCopy("nameAZ")}
        actions={(
          <>
            <Button variant="outline" onClick={() => setGroupsOpen(true)}>{a("groups")}</Button>
            {can.canCreate ? <Button onClick={() => setEditing("new")}>{t("addAttribute")}</Button> : null}
          </>
        )}
        search={search}
        list="attributes"
        countLabel={(count) => t("attributeCount", { count })}
        query={listQuery(search, term)}
        pageQuery={(page, limit) => listQuery({ ...search, page, limit }, term)}
        dataKey="attributes"
        columns={columns}
        invalidate={INVALIDATE}
        rowLabel={(row) => row.name}
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
      <AttributeGroupsDialog open={groupsOpen} onClose={() => setGroupsOpen(false)} canEdit={can.canEdit} />
      <AttributeDialog
        key={dialog.key}
        open={editing !== null}
        attribute={dialog.target === "new" ? undefined : dialog.target}
        onClose={() => setEditing(null)}
      />
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
