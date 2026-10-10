// One content type's entries: title, status and when each changed. Entries
// open on their own page; a private type says the online store cannot show
// its entries yet.
import { RowLink } from "~/components/admin/data-table/RowLink";
import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { ListDate } from "~/components/admin/data-table/ListDate";
import { serverTableFeatures, useTable, type ColumnDef } from "~/components/admin/data-table/table-config";
import { EmptyState } from "~/components/admin/states";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { usePermissions } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { metaobjectMessages } from "~/i18n/metaobjects";
import { METAOBJECT_ENTRY_PAGE_SIZE, metaobjectEntriesQueryOptions } from "~/lib/api-query-options/metaobjects";
import { useAppName } from "./use-app-name";

export function MetaobjectEntriesList({ definitionId }: { definitionId: string }) {
  const t = useMessages(metaobjectMessages);
  const permissions = usePermissions();
  const canEdit = permissions.hasPermission(PERMISSIONS.METAOBJECTS_EDIT);
  const [page, setPage] = useState(1);
  const entries = useQuery({ ...metaobjectEntriesQueryOptions(definitionId, page), placeholderData: keepPreviousData });
  const definition = entries.data?.definition;
  const rows = useMemo(() => entries.data?.entries ?? [], [entries.data]);
  const total = entries.data?.total ?? 0;
  const appOwned = definition?.owner === "app";
  const appName = useAppName(definition?.namespace ?? "", appOwned);
  const add = canEdit ? (
    <Button asChild>
      <Link to="/admin/metaobjects/$definitionId/entries/new" params={{ definitionId }}>{t("addEntry")}</Link>
    </Button>
  ) : null;
  const typeAction = (
    <Button asChild variant="outline">
      <Link to="/admin/metaobjects/$definitionId/settings" params={{ definitionId }}>
        {canEdit && !appOwned ? t("editType") : t("viewType")}
      </Link>
    </Button>
  );

  const columns = useMemo<ColumnDef<(typeof rows)[number], unknown>[]>(() => [
    {
      id: "title",
      header: t("columnTitle"),
      meta: { primary: true, minWidth: 220, maxWidth: 480 },
      cell: ({ row }) => {
        const name = row.original.displayName || t("untitledEntry");
        return (
          <RowLink
            to={`/admin/metaobjects/${definitionId}/entries/${row.original.id}`}
            title={name}
            className="block truncate font-medium text-foreground hover:underline"
          >
            {name}
          </RowLink>
        );
      },
    },
    {
      id: "status",
      header: t("columnStatus"),
      meta: { mobile: "status", priority: 80, minWidth: 110 },
      cell: ({ row }) => <StatusBadge status={row.original.status === "published" ? "active" : "draft"}>{t(row.original.status)}</StatusBadge>,
    },
    {
      id: "updated",
      header: t("columnUpdated"),
      meta: { priority: 50, minWidth: 150 },
      cell: ({ row }) => <ListDate value={row.original.updatedAt} />,
    },
  ], [definitionId, t]);
  const table = useTable({
    features: serverTableFeatures,
    data: rows,
    columns,
    getRowId: (row) => row.id,
    manualPagination: true,
    manualSorting: true,
    rowCount: total,
    pageCount: Math.max(1, Math.ceil(total / METAOBJECT_ENTRY_PAGE_SIZE)),
    state: { pagination: { pageIndex: page - 1, pageSize: METAOBJECT_ENTRY_PAGE_SIZE }, sorting: [] },
    onPaginationChange: (updater) => {
      const next = typeof updater === "function" ? updater({ pageIndex: page - 1, pageSize: METAOBJECT_ENTRY_PAGE_SIZE }) : updater;
      setPage(next.pageIndex + 1);
    },
  });
  const nothingYet = !entries.isPending && !entries.isError && total === 0;

  return (
    <div className="pb-8">
      <PageHeader
        backTo="/admin/metaobjects"
        title={definition?.name ?? t("pageTitle")}
        status={appOwned ? <Badge variant="info">{t("managedByAppName", { app: appName })}</Badge> : undefined}
        actions={definition ? <>{typeAction}{nothingYet ? null : add}</> : null}
      />
      <p className="mb-4 max-w-3xl text-body text-muted-foreground">{definition?.description || t("entriesHelp")}</p>
      {definition && !definition.storefrontAccess ? (
        <Alert variant="info" className="mb-4">
          <AlertDescription>
            <p>{t("privateNote")}</p>
            {canEdit && !appOwned ? (
              <Link to="/admin/metaobjects/$definitionId/settings" params={{ definitionId }} className="text-link underline">
                {t("privateNoteAction")}
              </Link>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {nothingYet ? (
        <EmptyState icon={FileText} title={t("entriesEmptyTitle")} description={t("entriesEmptyBody")} action={add} help={false} />
      ) : (
        <DataTable
          variant="card"
          table={table}
          isLoading={entries.isPending}
          isFetching={entries.isFetching}
          error={entries.isError ? entries.error : undefined}
          onRetry={() => void entries.refetch()}
          what={t("columnTitle")}
          layoutKey="content-entries"
          density="compact"
          defaultSortLabel={false}
          pageSizeOptions={[METAOBJECT_ENTRY_PAGE_SIZE]}
          getRowHref={(entry) => `/admin/metaobjects/${definitionId}/entries/${entry.id}`}
        />
      )}
    </div>
  );
}
