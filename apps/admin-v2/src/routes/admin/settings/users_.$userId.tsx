import { useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteApiV1AdminAuthUsersById,
  deleteApiV1AdminRbacUserPermissions,
  deleteApiV1AdminRbacUserRoles,
  postApiV1AdminAuthUsersByIdResendSetup,
  postApiV1AdminAuthUsersByIdSuspension,
  postApiV1AdminRbacUserPermissions,
  postApiV1AdminRbacUserRoles,
} from "@scalius/api-client/sdk";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useSaveBar } from "~/components/admin/shared/SaveBar";
import { SettingsLoadFailure } from "~/components/admin/settings/SettingsLoadFailure";
import { SettingsCard, SettingsCardLoading, SettingsPage } from "~/components/admin/settings/SettingsPage";
import {
  PermissionChecklist,
  failure,
  rolesQuery,
  saveFailure,
  staffQuery,
  useAccessRefresh,
  useRoleName,
  useViewer,
} from "~/components/admin/settings/UsersSettings";
import {
  accessChanges,
  canGrantRole,
  effectivePermissions,
  getStaffStatus,
  normalizeAccess,
  sameAccess,
  setAccessPermissions,
  staffActions,
  type StaffActions,
  type StaffStatus,
} from "~/components/admin/settings/staff-access";
import { apiClient, apiData } from "~/lib/api";
import type { AdminUser } from "~/lib/api-query-options/rbac";
import { queryKeys } from "~/lib/query-keys";
import { RouteErrorComponent } from "~/lib/route-error";
import { translate, useMessages } from "~/i18n";
import { settingsMessages, settingsNavMessages } from "~/i18n/settings";
import { usersMessages } from "~/i18n/settings-users";

// Stopgap until `pnpm generate:sdk` adds postApiV1AdminAuthUsersByIdRemove.
const removeStaff = (id: string) =>
  apiData(apiClient.post<{ success: boolean; data: { message: string } }>({
    url: "/api/v1/admin/auth/users/{id}/remove",
    path: { id },
  }));

// One staff member, Shopify style: their roles and permissions, then the
// account actions at the bottom (restore, suspend, cancel invite, remove).
export const Route = createFileRoute("/admin/settings/users_/$userId")({
  loader: ({ context: { queryClient } }) =>
    Promise.allSettled([queryClient.ensureQueryData(staffQuery), queryClient.ensureQueryData(rolesQuery)]),
  head: () => ({ meta: [{ title: `${translate(settingsNavMessages, "users")} | Scalius Admin` }] }),
  errorComponent: RouteErrorComponent,
  component: StaffMemberPage,
});

function StaffMemberPage() {
  const { userId } = Route.useParams();
  const t = useMessages(usersMessages);
  const nav = useMessages(settingsNavMessages);
  const viewer = useViewer();
  const staff = useQuery(staffQuery);
  const member = staff.data?.find((candidate) => candidate.id === userId);
  const back = { to: "/admin/settings/users" as const, label: nav("users") };

  if (staff.isError) {
    return (
      <SettingsPage page="users" back={back} title={nav("users")}>
        <SettingsLoadFailure title={t("staffTitle")} onRetry={staff.refetch} />
      </SettingsPage>
    );
  }
  if (!staff.data) {
    return (
      <SettingsPage page="users" back={back} title={nav("users")}>
        <SettingsCardLoading />
      </SettingsPage>
    );
  }
  if (!member) {
    return (
      <SettingsPage page="users" back={back} title={nav("users")}>
        <SettingsCard description={t("notFound")} />
      </SettingsPage>
    );
  }

  const status = getStaffStatus(member);
  const actions = staffActions({ id: member.id, isSuperAdmin: member.isSuperAdmin, status }, viewer);
  return (
    <SettingsPage
      page="users"
      back={back}
      title={member.name}
      actions={status !== "ready" ? <Badge variant="secondary">{t(status)}</Badge> : null}
    >
      <SettingsCard title={member.email} action={actions.resendInvite ? <ResendInvite member={member} status={status} /> : null} />
      {actions.editAccess ? <StaffAccessForm key={member.id} member={member} /> : null}
      <AccountActions member={member} actions={actions} />
    </SettingsPage>
  );
}

function ResendInvite({ member, status }: { member: AdminUser; status: StaffStatus }) {
  const t = useMessages(usersMessages);
  const queryClient = useQueryClient();
  const resend = useMutation({
    mutationFn: () => apiData(postApiV1AdminAuthUsersByIdResendSetup({ path: { id: member.id } })),
    onSuccess: () => toast.success(t("inviteSent")),
    onError: (error) => toast.error(failure(error, t, t("actionFailed"))),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers.all }),
  });
  return (
    <Button type="button" variant="outline" size="sm" loading={resend.isPending} onClick={() => resend.mutate()}>
      {status === "invite_expired" ? t("sendNewInvite") : t("resendInvite")}
    </Button>
  );
}

function StaffAccessForm({ member }: { member: AdminUser }) {
  const t = useMessages(usersMessages);
  const common = useMessages(settingsMessages);
  const roleName = useRoleName();
  const viewer = useViewer();
  const refresh = useAccessRefresh();
  const { data: roles, isError, refetch } = useQuery(rolesQuery);
  const saved = useMemo(
    () => normalizeAccess({ roleIds: member.roles.map((role) => role.id), ...member.overrides }),
    [member],
  );
  const [draft, setDraft] = useState(saved);
  // A partial list would turn into wrong changes; don't edit what we can't fully see.
  const locked = !roles || member.rolesTruncated || member.overridesTruncated;
  const noRole = draft.roleIds.length === 0;
  const save = useMutation({
    mutationFn: async () => {
      const changes = accessChanges(saved, draft);
      const userId = member.id;
      for (const roleId of changes.addRoles) await apiData(postApiV1AdminRbacUserRoles({ body: { userId, roleId } }));
      for (const roleId of changes.removeRoles) await apiData(deleteApiV1AdminRbacUserRoles({ body: { userId, roleId } }));
      for (const { permission, granted } of changes.setOverrides) {
        await apiData(postApiV1AdminRbacUserPermissions({ body: { userId, permission, granted } }));
      }
      for (const permission of changes.clearOverrides) {
        await apiData(deleteApiV1AdminRbacUserPermissions({ body: { userId, permission } }));
      }
    },
    // Some calls may have landed before a failure; always reload what's true.
    onSettled: refresh,
  });
  useSaveBar({
    dirty: !sameAccess(saved, draft),
    saving: save.isPending,
    invalid: locked || noRole,
    save: () => save.mutateAsync().catch((error: unknown) => {
      throw saveFailure(error, t, common("saveFailed"));
    }),
    discard: () => setDraft(saved),
  });
  if (isError) return <SettingsLoadFailure title={t("roles")} onRetry={refetch} />;
  if (!roles) return <SettingsCardLoading />;
  const effective = effectivePermissions(draft, roles);
  const canGrant = (permission: string) => viewer.isOwner || viewer.permissions.has(permission);
  return (
    <>
      <SettingsCard title={t("roles")} description={roles.some((role) => !canGrantRole(role, viewer)) ? t("onlyYourAccess") : undefined}>
        <div role="group" aria-label={t("roles")}>
          {roles.map((role) => {
            const held = draft.roleIds.includes(role.id);
            return (
              <label key={role.id} className="flex min-h-11 items-start gap-3 py-2.5 text-body">
                <span className="flex h-lh items-center">
                  <Checkbox
                    checked={held}
                    // Anyone may take a role away; only roles within your own access can be given.
                    disabled={locked || (!held && !canGrantRole(role, viewer))}
                    onCheckedChange={(on) =>
                      setDraft({
                        ...draft,
                        roleIds: on === true ? [...draft.roleIds, role.id] : draft.roleIds.filter((id) => id !== role.id),
                      })}
                  />
                </span>
                {roleName(role)}
              </label>
            );
          })}
        </div>
        {noRole ? <p role="alert" className="text-body text-destructive">{t("pickRole")}</p> : null}
      </SettingsCard>
      <SettingsCard
        title={t("permissions")}
        description={member.rolesTruncated || member.overridesTruncated ? t("accessTooLarge") : t("personalHelp")}
        rows={
          <PermissionChecklist
            id={`staff-${member.id}`}
            checked={effective}
            disabled={locked}
            canGrant={canGrant}
            onChange={(next) => setDraft(setAccessPermissions(draft, roles, next))}
          />
        }
      />
    </>
  );
}

/** The account actions, bottom-left and apart from the save bar (Shopify's staff page). */
function AccountActions({ member, actions }: { member: AdminUser; actions: StaffActions }) {
  const t = useMessages(usersMessages);
  const common = useMessages(settingsMessages);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<"suspend" | "cancelInvite" | "remove" | null>(null);
  const reload = () => queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers.all });
  const onError = (error: unknown) => toast.error(failure(error, t, t("actionFailed")));
  const leave = async (message: string) => {
    toast.success(message);
    setConfirm(null);
    await reload();
    await navigate({ to: "/admin/settings/users" });
  };
  const suspend = useMutation({
    mutationFn: (suspended: boolean) =>
      apiData(postApiV1AdminAuthUsersByIdSuspension({ path: { id: member.id }, body: { suspended } })),
    onSuccess: async (_, suspended) => {
      toast.success(t(suspended ? "accessSuspended" : "restored"));
      setConfirm(null);
      await reload();
    },
    onError,
  });
  const cancelInvite = useMutation({
    mutationFn: () => apiData(deleteApiV1AdminAuthUsersById({ path: { id: member.id } })),
    onSuccess: () => leave(t("inviteCancelled")),
    onError,
  });
  const remove = useMutation({
    mutationFn: () => removeStaff(member.id),
    onSuccess: () => leave(t("staffRemoved")),
    onError,
  });
  const busy = suspend.isPending || cancelInvite.isPending || remove.isPending;
  if (!actions.restore && !actions.suspend && !actions.cancelInvite && !actions.remove) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {actions.restore ? (
        <Button type="button" variant="outline" disabled={busy} loading={suspend.isPending} onClick={() => suspend.mutate(false)}>
          {t("restoreAccess")}
        </Button>
      ) : null}
      {actions.suspend ? (
        <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirm("suspend")}>
          {t("suspendAccess")}
        </Button>
      ) : null}
      {actions.cancelInvite ? (
        <Button type="button" variant="destructive" disabled={busy} onClick={() => setConfirm("cancelInvite")}>
          {t("cancelInvite")}
        </Button>
      ) : null}
      {actions.remove ? (
        <Button type="button" variant="destructive" disabled={busy} onClick={() => setConfirm("remove")}>
          {t("removeStaff")}
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirm === "suspend"}
        onOpenChange={(open) => setConfirm(open ? "suspend" : null)}
        title={t("suspendTitle", { name: member.name })}
        description={t("suspendConfirm")}
        confirmLabel={t("suspend")}
        cancelLabel={common("cancel")}
        loadingLabel={t("suspending")}
        isLoading={suspend.isPending}
        onConfirm={() => suspend.mutate(true)}
      />
      <ConfirmDialog
        open={confirm === "cancelInvite"}
        onOpenChange={(open) => setConfirm(open ? "cancelInvite" : null)}
        title={t("cancelInviteTitle", { name: member.name })}
        description={t("cancelInviteConfirm")}
        confirmLabel={t("cancelInvite")}
        cancelLabel={t("keepInvite")}
        loadingLabel={t("cancellingInvite")}
        isLoading={cancelInvite.isPending}
        onConfirm={() => cancelInvite.mutate()}
      />
      <ConfirmDialog
        open={confirm === "remove"}
        onOpenChange={(open) => setConfirm(open ? "remove" : null)}
        title={t("removeTitle", { name: member.name })}
        description={t("removeConfirm")}
        confirmLabel={t("removeStaff")}
        cancelLabel={common("cancel")}
        loadingLabel={t("removing")}
        isLoading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}
