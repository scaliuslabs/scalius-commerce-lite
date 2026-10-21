// Content → Content types: every content type (the merchant's and the apps')
// with its entry count and whether the online store can show it. A type opens
// on its entries. A type of an app that is no longer installed reads "From a
// removed app", and that app's data can be deleted from the card above.
import { RowLink } from "~/components/admin/data-table/RowLink";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { useStaticTable } from "~/components/admin/data-table/use-static-table";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { EmptyState } from "~/components/admin/states";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { AppOwnerBadge } from "~/components/admin/apps/app-owner";
import { RemovedAppDataCard } from "~/components/admin/apps/RemovedAppData";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { usePermissions } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { objectMessages } from "~/i18n/objects";
import { objectTypesQueryOptions } from "~/lib/api-query-options/objects";

type ContentType = NonNullable<Awaited<ReturnType<NonNullable<ReturnType<typeof objectTypesQueryOptions>["queryFn"]>>>>[number];

export function ObjectTypesList() {
  const t = useMessages(objectMessages);
  const canEdit = usePermissions().hasPermission(PERMISSIONS.OBJECTS_EDIT);
  const types = useQuery(objectTypesQueryOptions());
  const rows = useMemo(() => types.data?.filter((type) => type.admin !== "none") ?? [], [types.data]);
  const create = canEdit ? (
    <Button asChild>
      <Link to="/admin/objects/new">{t("create")}</Link>
    </Button>
  ) : null;

  const columns = useMemo<ColumnDef<ContentType, unknown>[]>(() => [
    {
      id: "name",
      header: t("columnName"),
      meta: { primary: true, minWidth: 220, maxWidth: 420 },
      cell: ({ row }) => (
        <span className="block min-w-0">
          <RowLink
            to={`/admin/objects/${row.original.handle}`}
            title={row.original.name}
            className="block truncate font-medium text-foreground hover:underline"
          >
            {row.original.name}
          </RowLink>
          <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <code title={row.original.handle} className="min-w-0 truncate">{row.original.handle}</code>
            {row.original.owner === "app" ? <AppOwnerBadge namespace={row.original.namespace} managedLabel={() => t("managedByApp")} /> : null}
          </span>
        </span>
      ),
    },
    {
      id: "entries",
      header: t("columnEntries"),
      meta: { numeric: true, priority: 70, minWidth: 110 },
      cell: ({ row }) => t("recordCount", { count: row.original.recordCount }),
    },
    {
      id: "store",
      header: t("columnStore"),
      meta: { mobile: "status", priority: 60, minWidth: 140 },
      cell: ({ row }) => (row.original.storefront
        ? <Badge variant="success">{t("shownOnStore")}</Badge>
        : <Badge variant="secondary">{t("privateType")}</Badge>),
    },
  ], [t]);
  const { table } = useStaticTable(rows, columns);
  const nothingYet = !types.isPending && !types.isError && rows.length === 0;

  return (
    <div className="pb-8">
      {/* The explanation rides in the header's meta line, never loose on the page (K5); the first-run card says it itself (E1). */}
      <PageHeader title={t("pageTitle")} meta={nothingYet ? undefined : t("pageDescription")} actions={nothingYet ? null : create} />
      <div className="mb-4 empty:hidden">
        <RemovedAppDataCard show={(group) => group.objectTypes > 0} />
      </div>
      {nothingYet ? (
        <EmptyState icon={FileText} title={t("emptyTitle")} description={t("emptyBody")} action={create} />
      ) : (
        <DataTable
          variant="card"
          table={table}
          isLoading={types.isPending}
          isFetching={types.isFetching}
          error={types.isError ? types.error : undefined}
          onRetry={() => void types.refetch()}
          what={t("pageTitle")}
          layoutKey="content-types"
          defaultSortLabel={false}
          paginate={false}
          getRowHref={(type) => `/admin/objects/${type.handle}`}
        />
      )}
    </div>
  );
}
