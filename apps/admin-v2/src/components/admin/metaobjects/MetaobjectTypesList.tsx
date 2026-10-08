// Content → Content types: every content type (the merchant's and the apps')
// with its entry count and whether the online store can show it. A type opens
// on its entries.
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { EmptyState } from "~/components/admin/resource/EmptyState";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { usePermissions } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { metaobjectMessages } from "~/i18n/metaobjects";
import { resourceMessages } from "~/i18n/resource";
import { metaobjectDefinitionsQueryOptions } from "~/lib/api-query-options/metaobjects";

export function MetaobjectTypesList() {
  const t = useMessages(metaobjectMessages);
  const r = useMessages(resourceMessages);
  const canEdit = usePermissions().hasPermission(PERMISSIONS.METAOBJECTS_EDIT);
  const types = useQuery(metaobjectDefinitionsQueryOptions());
  const rows = types.data ?? [];
  const create = canEdit ? (
    <Button asChild>
      <Link to="/admin/metaobjects/new">{t("create")}</Link>
    </Button>
  ) : null;

  return (
    <div className="pb-8">
      <PageHeader title={t("pageTitle")} actions={rows.length > 0 ? create : null} />
      <p className="mb-4 max-w-3xl text-body text-muted-foreground">{t("pageDescription")}</p>
      {types.isError ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-body">{t("loadFailed")}</p>
          <Button variant="outline" size="sm" onClick={() => void types.refetch()}>{r("retry")}</Button>
        </Card>
      ) : types.isPending ? (
        <Card className="space-y-3 p-4">
          {[0, 1, 2].map((index) => <Skeleton key={index} className="h-10 w-full" />)}
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState icon={FileText} title={t("emptyTitle")} description={t("emptyBody")} action={create} help />
        </Card>
      ) : (
        <Card className="overflow-clip">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead data-pin="primary">{t("columnName")}</TableHead>
                <TableHead data-numeric="">{t("columnEntries")}</TableHead>
                <TableHead>{t("columnStore")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((type) => (
                <TableRow key={type.id}>
                  <TableCell data-pin="primary">
                    <Link
                      to="/admin/metaobjects/$definitionId"
                      params={{ definitionId: type.id }}
                      className="line-clamp-2 break-words font-medium text-foreground hover:underline"
                    >
                      {type.name}
                    </Link>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
                      <code className="break-all">{type.handle}</code>
                      {type.owner === "app" ? <Badge variant="info">{t("managedByApp")}</Badge> : null}
                    </span>
                  </TableCell>
                  <TableCell data-numeric="">{t("entryCount", { count: type.entryCount })}</TableCell>
                  <TableCell>
                    {type.storefrontAccess ? <Badge variant="success">{t("shownOnStore")}</Badge> : <Badge variant="secondary">{t("privateType")}</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
