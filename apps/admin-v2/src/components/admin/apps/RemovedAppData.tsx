// Data from removed apps (docs/platform/PLUGINS.md, "Uninstalling"): an app
// that is no longer installed (uninstalled keeping its data, or a bundled app
// taken out of the deployment) leaves its object types, custom fields and
// settings in the store. Wherever that data appears it reads "From a removed
// app: <name>" instead of "Managed by", and each app's group has one "Delete
// data" (Super Admin, confirmed, under the revision the page listed).
// Reinstalling the app takes its data back. Staff who cannot see Apps get the
// app's id and no group card, as with "Managed by".
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatList } from "@scalius/shared/locale-words";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { usePermissions } from "~/contexts/PermissionContext";
import { getLocale, useMessages } from "~/i18n";
import { removedAppDataMessages } from "~/i18n/removed-app-data";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { deleteRemovedAppData, removedAppDataQueryOptions, type RemovedAppData } from "~/lib/api-query-options/apps";
import { customFieldKeys } from "~/lib/api-query-options/custom-fields";
import { objectKeys } from "~/lib/api-query-options/objects";
import { queryKeys } from "~/lib/query-keys";
import { toast } from "~/lib/toast";

type RemovedAppDataKey = keyof typeof removedAppDataMessages.en;

function summary(group: RemovedAppData, t: (key: RemovedAppDataKey, vars?: Record<string, number>) => string): string {
  const parts = [
    group.objectTypes > 0 ? t("objectTypes", { count: group.objectTypes }) : null,
    group.records > 0 ? t("records", { count: group.records }) : null,
    group.customFields > 0 ? t("customFields", { count: group.customFields }) : null,
    group.keyValues > 0 ? t("keyValues", { count: group.keyValues }) : null,
    group.customerRoles > 0 ? t("customerRoles", { count: group.customerRoles }) : null,
    group.jobs > 0 ? t("jobs", { count: group.jobs }) : null,
    group.catalogItems > 0 ? t("catalogItems", { count: group.catalogItems }) : null,
    group.settings ? t("settings") : null,
  ].filter((part): part is string => part !== null);
  return formatList(parts, getLocale());
}

/**
 * The removed apps' groups that `show` keeps (every group by default), each
 * with what it holds and, for a Super Admin, "Delete data". Renders nothing
 * when there is none, or for staff who cannot see Apps.
 */
export function RemovedAppDataCard({ show }: { show?: (group: RemovedAppData) => boolean }) {
  const t = useMessages(removedAppDataMessages);
  const { hasPermission, isSuperAdmin } = usePermissions();
  const canView = hasPermission(PERMISSIONS.APPS_VIEW);
  const queryClient = useQueryClient();
  const { data } = useQuery({ ...removedAppDataQueryOptions(), enabled: canView });
  // The last group asked about stays in the dialog while it closes.
  const [confirming, setConfirming] = useState<RemovedAppData | null>(null);
  const [open, setOpen] = useState(false);
  const remove = useMutation({
    mutationFn: deleteRemovedAppData,
    onSuccess: ({ catalogKept }) => {
      toast.success(catalogKept > 0 ? t("deletedKept", { count: catalogKept }) : t("deleted"));
    },
    onError: (error) => {
      toast.error(error instanceof AdminApiResponseError && error.status === 409 ? t("changed") : t("deleteFailed"));
    },
    onSettled: async () => {
      setOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.apps.removedData() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.apps.list() }),
        queryClient.invalidateQueries({ queryKey: objectKeys.all }),
        queryClient.invalidateQueries({ queryKey: customFieldKeys.all }),
      ]);
    },
  });
  const groups = (data ?? []).filter((group) => (show ? show(group) : true));

  return (
    <>
      {groups.length > 0 ? (
        <Card data-slot="removed-app-data">
          <CardHeader>
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>{t("body")}</CardDescription>
          </CardHeader>
          <ul>
            {groups.map((group) => (
              <li key={group.id} className="flex flex-wrap items-start justify-between gap-3 border-t border-border px-4 py-3">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="break-words text-body font-medium">{group.name}</span>
                    <Badge variant="warning">{t("fromRemovedApp", { app: group.name })}</Badge>
                  </p>
                  <p className="break-words text-body text-muted-foreground">
                    <code>{group.id}</code> · {summary(group, t)}
                  </p>
                  {isSuperAdmin ? null : <p className="text-body text-muted-foreground">{t("superAdminOnly")}</p>}
                </div>
                {isSuperAdmin ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() => {
                      setConfirming(group);
                      setOpen(true);
                    }}
                  >
                    {t("deleteData")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => (remove.isPending ? undefined : setOpen(next))}
        title={t("deleteTitle", { app: confirming?.name ?? "" })}
        description={confirming ? t("deleteBody", { what: summary(confirming, t) }) : ""}
        confirmLabel={t("deleteData")}
        loadingLabel={t("deleting")}
        isLoading={remove.isPending}
        onConfirm={() => {
          if (confirming) remove.mutate(confirming);
        }}
      />
    </>
  );
}
