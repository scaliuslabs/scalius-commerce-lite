// One content type's entries: title, status and when each changed. Entries
// open on their own page; a private type says the online store cannot show
// its entries yet.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { ListDate } from "~/components/admin/data-table/ListDate";
import { EmptyState } from "~/components/admin/resource/EmptyState";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { AdminListPagination } from "~/components/admin/shared/AdminListPagination";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { usePermissions } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { metaobjectMessages } from "~/i18n/metaobjects";
import { resourceMessages } from "~/i18n/resource";
import { METAOBJECT_ENTRY_PAGE_SIZE, metaobjectEntriesQueryOptions } from "~/lib/api-query-options/metaobjects";
import { useAppName } from "./use-app-name";

export function MetaobjectEntriesList({ definitionId }: { definitionId: string }) {
  const t = useMessages(metaobjectMessages);
  const r = useMessages(resourceMessages);
  const permissions = usePermissions();
  const canEdit = permissions.hasPermission(PERMISSIONS.METAOBJECTS_EDIT);
  const [page, setPage] = useState(1);
  const entries = useQuery(metaobjectEntriesQueryOptions(definitionId, page));
  const definition = entries.data?.definition;
  const rows = entries.data?.entries ?? [];
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

  return (
    <div className="pb-8">
      <PageHeader
        backTo="/admin/metaobjects"
        title={definition?.name ?? t("pageTitle")}
        status={appOwned ? <Badge variant="info">{t("managedByAppName", { app: appName })}</Badge> : undefined}
        actions={definition ? <>{typeAction}{total > 0 ? add : null}</> : null}
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
      {entries.isError ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-body">{t("entriesLoadFailed")}</p>
          <Button variant="outline" size="sm" onClick={() => void entries.refetch()}>{r("retry")}</Button>
        </Card>
      ) : entries.isPending ? (
        <Card className="space-y-3 p-4">
          {[0, 1, 2].map((index) => <Skeleton key={index} className="h-10 w-full" />)}
        </Card>
      ) : total === 0 ? (
        <Card>
          <EmptyState icon={FileText} title={t("entriesEmptyTitle")} description={t("entriesEmptyBody")} action={add} />
        </Card>
      ) : (
        <Card className="overflow-clip">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead data-pin="primary">{t("columnTitle")}</TableHead>
                <TableHead>{t("columnStatus")}</TableHead>
                <TableHead>{t("columnUpdated")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell data-pin="primary">
                    <Link
                      to="/admin/metaobjects/$definitionId/entries/$entryId"
                      params={{ definitionId, entryId: entry.id }}
                      className="line-clamp-2 break-words font-medium text-foreground hover:underline"
                    >
                      {entry.displayName || t("untitledEntry")}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={entry.status === "published" ? "active" : "draft"}>{t(entry.status)}</StatusBadge>
                  </TableCell>
                  <TableCell><ListDate value={entry.updatedAt} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <AdminListPagination
            pagination={{ total, page, limit: METAOBJECT_ENTRY_PAGE_SIZE, totalPages: Math.max(1, Math.ceil(total / METAOBJECT_ENTRY_PAGE_SIZE)) }}
            onPageChange={setPage}
          />
        </Card>
      )}
    </div>
  );
}
