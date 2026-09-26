// Settings › Policies › Warranty policies (Wave B §5.3): the list with each
// policy's summary, revision and "Used by N products"; add, edit (a new
// revision), archive and restore.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { Label } from "~/components/ui/label";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { warrantyMessages } from "~/i18n/warranty";
import { getServerFnError } from "~/lib/api-helpers";
import { SettingsCard, SettingsCardLoading } from "../SettingsPage";
import { SettingsLoadFailure } from "../SettingsLoadFailure";
import { useArchiveWarrantyPolicy, warrantyPoliciesQueryOptions, type WarrantyPolicy } from "../../warranty/warranty-api";
import { warrantySummary } from "../../warranty/warranty-format";
import { WarrantyPolicyDialog } from "./WarrantyPolicyDialog";

export function WarrantyPoliciesManager() {
  const t = useMessages(warrantyMessages);
  const canEdit = useHasPermission(PERMISSIONS.PRODUCTS_EDIT);
  const [showArchived, setShowArchived] = useState(false);
  const { data, isError, refetch } = useQuery(warrantyPoliciesQueryOptions(showArchived));
  const [editing, setEditing] = useState<{ policy: WarrantyPolicy | null } | null>(null);
  const [archiving, setArchiving] = useState<WarrantyPolicy | null>(null);
  const archive = useArchiveWarrantyPolicy();

  const setArchived = (policy: WarrantyPolicy, archived: boolean) =>
    archive.mutate({ id: policy.id, archive: archived }, {
      onSuccess: () => {
        toast.success(t(archived ? "archivedToast" : "restoredToast"));
        setArchiving(null);
      },
      onError: (error) => void toast.error(getServerFnError(error, t("actionFailed"))),
    });

  if (isError) return <SettingsLoadFailure title={t("loadFailed")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;

  const usedBy = (count: number) => (count === 0 ? t("usedByNone") : count === 1 ? t("usedByOne") : t("usedBy", { count }));

  return (
    <>
      <SettingsCard
        title={t("title")}
        description={t("entryDescription")}
        action={canEdit ? <Button type="button" size="sm" onClick={() => setEditing({ policy: null })}>{t("add")}</Button> : null}
        rows={
          <>
            <div className="flex items-center gap-2 px-4 py-3">
              <Checkbox id="warranty-show-archived" checked={showArchived} onCheckedChange={(value) => setShowArchived(value === true)} />
              <Label htmlFor="warranty-show-archived">{t("showArchived")}</Label>
            </div>
            {data.length === 0 ? (
              <div className="border-t border-border px-4 py-8 text-center">
                <p className="text-body font-medium">{t("empty")}</p>
                <p className="text-body text-muted-foreground">{t("emptyBody")}</p>
              </div>
            ) : (
              <ul>
                {data.map((policy) => (
                  <li key={policy.id} className="flex items-start gap-3 border-t border-border px-4 py-3">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="break-words text-body font-medium">{policy.name}</span>
                        {policy.archivedAt ? <Badge variant="outline">{t("archived")}</Badge> : null}
                      </p>
                      <p className="text-body">{warrantySummary(t, policy)}</p>
                      <p className="text-body text-muted-foreground">
                        {usedBy(policy.productCount)} · {t("revision", { revision: policy.revision })}
                      </p>
                    </div>
                    {canEdit ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button type="button" variant="ghost" size="icon" aria-label={t("actionsFor", { name: policy.name })}>
                            <MoreHorizontal aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {policy.archivedAt ? (
                            <DropdownMenuItem onSelect={() => setArchived(policy, false)}>{t("restore")}</DropdownMenuItem>
                          ) : (
                            <>
                              <DropdownMenuItem onSelect={() => setEditing({ policy })}>{t("edit")}</DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => setArchiving(policy)}>{t("archive")}</DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </>
        }
      />
      <WarrantyPolicyDialog
        policy={editing?.policy ?? null}
        open={editing !== null}
        onOpenChange={(open) => (open ? undefined : setEditing(null))}
      />
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => (open ? undefined : setArchiving(null))}
        title={t("archiveTitle", { name: archiving?.name ?? "" })}
        description={t("archiveBody")}
        confirmLabel={t("archive")}
        isLoading={archive.isPending}
        onConfirm={() => (archiving ? setArchived(archiving, true) : undefined)}
      />
    </>
  );
}
