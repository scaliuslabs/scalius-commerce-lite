import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  deleteApiV1AdminAuthUsersById,
  deleteApiV1AdminRbacRolesById,
  deleteApiV1AdminRbacUserPermissions,
  deleteApiV1AdminRbacUserRoles,
  postApiV1AdminAuthUsers,
  postApiV1AdminAuthUsersByIdResendSetup,
  postApiV1AdminAuthUsersByIdSuspension,
  postApiV1AdminRbacRoles,
  postApiV1AdminRbacUserPermissions,
  postApiV1AdminRbacUserRoles,
  putApiV1AdminRbacRolesById,
} from "@scalius/api-client/sdk";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { usePermissions } from "~/contexts/PermissionContext";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { readApiFieldIssues } from "~/lib/api-field-errors";
import { refreshAdminRouteContext } from "~/lib/admin-route-context";
import { apiData } from "~/lib/api";
import { getAdminUsers, getRbacRoles, type AdminUser, type RbacRole } from "~/lib/api-query-options/rbac";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { permissionGroupMessages, permissionMessages, usersMessages } from "~/i18n/settings-users";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useSaveBar } from "../shared/SaveBar";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsDialog, SettingsField, SettingsRow, SettingsCardLoading } from "./SettingsPage";
import {
  OWNER_ROLE,
  PERMISSION_GROUPS,
  accessChanges,
  effectivePermissions,
  getStaffStatus,
  normalizeAccess,
  roleKey,
  sameAccess,
  setPermission,
  staffActions,
  type StaffActions,
  type StaffStatus,
} from "./staff-access";

export const staffQuery = { queryKey: queryKeys.adminUsers.list(), queryFn: getAdminUsers };
export const rolesQuery = { queryKey: queryKeys.rbac.roles(), queryFn: getRbacRoles };

type Messages = (key: keyof typeof usersMessages.en, vars?: Record<string, string | number>) => string;

function useViewer() {
  const { user } = useRouteContext({ from: "/admin" });
  const { hasPermission, isSuperAdmin } = usePermissions();
  return {
    id: user.id,
    isOwner: isSuperAdmin,
    canManageStaff: hasPermission(PERMISSIONS.TEAM_MANAGE),
    canManageRoles: hasPermission(PERMISSIONS.TEAM_MANAGE_ROLES),
  };
}

/** Roles and access changed: reload staff and roles, then the signed-in admin's own permissions. */
function useAccessRefresh() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.rbac.all }),
    ]);
    await refreshAdminRouteContext(router);
  };
}

function failure(error: unknown, t: Messages, fallback: string, conflict?: string): string {
  if (error instanceof AdminApiResponseError) {
    if (error.status === 403) return t("noAuthority");
    if (error.status === 409 && conflict) return conflict;
    // The API refuses to suspend the last active administrator.
    if (error.status === 400 && /last active administrator/i.test(error.message)) return t("lastManager");
  }
  return fallback;
}

/** A save-bar rejection: field problems pass through to be marked in place; the rest in plain words. */
function saveFailure(error: unknown, t: Messages, fallback: string, conflict?: string): Error {
  return readApiFieldIssues(error) ? (error as Error) : new Error(failure(error, t, fallback, conflict));
}

/** Roles a viewer may hand out: only the store owner hands out the owner role. */
function assignableRoles(roles: readonly RbacRole[], isOwner: boolean, keep: readonly string[] = []) {
  return roles.filter((role) => role.name !== OWNER_ROLE || isOwner || keep.includes(role.id));
}

function PermissionChecklist({
  id,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  checked: ReadonlySet<string>;
  disabled: boolean;
  onChange: (permission: string, on: boolean) => void;
}) {
  const group = useMessages(permissionGroupMessages);
  const label = useMessages(permissionMessages);
  return PERMISSION_GROUPS.map(({ group: key, permissions }) => (
    <div key={key} role="group" aria-labelledby={`${id}-${key}`} className="space-y-1 border-t border-border pt-3">
      <p id={`${id}-${key}`} className="text-body font-medium">{group(key)}</p>
      <div className="grid sm:grid-cols-2">
        {permissions.map((permission) => (
          <label key={permission} className="flex min-h-11 items-start gap-3 py-3 text-body">
            <Checkbox
              className="mt-0.5"
              checked={checked.has(permission)}
              disabled={disabled}
              onCheckedChange={(on) => onChange(permission, on === true)}
            />
            {label(permission)}
          </label>
        ))}
      </div>
    </div>
  ));
}

// ── Staff ───────────────────────────────────────────────────────────────

function AddStaffForm() {
  const t = useMessages(usersMessages);
  const common = useMessages(settingsMessages);
  const viewer = useViewer();
  const queryClient = useQueryClient();
  const roles = useQuery(rolesQuery);
  const empty = { name: "", email: "", roleId: "" };
  const [draft, setDraft] = useState(empty);
  const add = useMutation({
    mutationFn: () =>
      apiData(postApiV1AdminAuthUsers({
        body: { name: draft.name.trim(), email: draft.email.trim(), roleId: draft.roleId },
      })),
    onSuccess: async (result) => {
      if (result.emailFailed) toast.warning(t("inviteNotSent"));
      await queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers.all });
    },
  });
  useSaveBar({
    fields: { name: "staff-name", email: "staff-email", roleId: "staff-role" },
    dirty: Boolean(draft.name || draft.email || draft.roleId),
    saving: add.isPending,
    invalid: !draft.name.trim() || !/^\S+@\S+\.\S+$/.test(draft.email.trim()) || !draft.roleId,
    // The banner shows the reason; name the known conflicts in plain words.
    save: () => add.mutateAsync().catch((error: unknown) => {
      throw saveFailure(error, t, common("saveFailed"), t("emailTaken"));
    }),
    discard: () => setDraft(empty),
  });
  const choices = assignableRoles(roles.data ?? [], viewer.isOwner);
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsField id="staff-name" label={t("name")}>
          <Input
            id="staff-name"
            autoComplete="off"
            maxLength={100}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </SettingsField>
        <SettingsField id="staff-email" label={t("email")}>
          <Input
            id="staff-email"
            type="email"
            autoComplete="off"
            maxLength={320}
            value={draft.email}
            onChange={(event) => setDraft({ ...draft, email: event.target.value })}
          />
        </SettingsField>
      </div>
      {roles.isError ? (
        <SettingsLoadFailure title={t("roles")} onRetry={roles.refetch} />
      ) : (
        <SettingsField id="staff-role" label={t("role")} help={roles.data && !choices.length ? t("noRoles") : undefined}>
          <Select value={draft.roleId} onValueChange={(roleId) => setDraft({ ...draft, roleId })} disabled={!choices.length}>
            <SelectTrigger id="staff-role" aria-describedby={roles.data && !choices.length ? "staff-role-note" : undefined}>
              <SelectValue placeholder={t("chooseRole")} />
            </SelectTrigger>
            <SelectContent>
              {choices.map((role) => (
                <SelectItem key={role.id} value={role.id}>{role.displayName}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsField>
      )}
    </>
  );
}

function StaffAccessForm({ member }: { member: AdminUser }) {
  const t = useMessages(usersMessages);
  const common = useMessages(settingsMessages);
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
  const noAccess = draft.roleIds.length === 0 && draft.grants.length === 0;
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
    invalid: locked || noAccess,
    save: () => save.mutateAsync().catch((error: unknown) => {
      throw saveFailure(error, t, common("saveFailed"));
    }),
    discard: () => setDraft(saved),
  });
  if (isError) return <SettingsLoadFailure title={t("roles")} onRetry={refetch} />;
  if (!roles) return <SettingsCardLoading />;
  const effective = effectivePermissions(draft, roles);
  return (
    <>
      <div role="group" aria-labelledby="staff-roles" className="space-y-1">
        <p id="staff-roles" className="text-body font-medium">{t("roles")}</p>
        {assignableRoles(roles, viewer.isOwner, saved.roleIds).map((role) => (
          <label key={role.id} className="flex min-h-11 items-start gap-3 py-3 text-body">
            <Checkbox
              className="mt-0.5"
              checked={draft.roleIds.includes(role.id)}
              disabled={locked}
              onCheckedChange={(on) =>
                setDraft({
                  ...draft,
                  roleIds: on === true ? [...draft.roleIds, role.id] : draft.roleIds.filter((id) => id !== role.id),
                })}
            />
            {role.displayName}
          </label>
        ))}
        {noAccess ? <p role="alert" className="text-body text-destructive">{t("pickRole")}</p> : null}
      </div>
      <div className="space-y-3">
        <div>
          <p className="text-body font-medium">{t("permissions")}</p>
          <p className="text-body text-muted-foreground">
            {member.rolesTruncated || member.overridesTruncated ? t("accessTooLarge") : t("personalHelp")}
          </p>
        </div>
        <PermissionChecklist
          id={`staff-${member.id}`}
          checked={effective}
          disabled={locked}
          onChange={(permission, on) => setDraft(setPermission(draft, roles, permission, on))}
        />
      </div>
    </>
  );
}

function StaffActionButtons({ member, status, actions }: { member: AdminUser; status: StaffStatus; actions: StaffActions }) {
  const t = useMessages(usersMessages);
  const common = useMessages(settingsMessages);
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<"suspend" | "cancelInvite" | null>(null);
  const reload = () => queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers.all });
  const onError = (error: unknown) => toast.error(failure(error, t, t("actionFailed")));
  const resend = useMutation({
    mutationFn: () => apiData(postApiV1AdminAuthUsersByIdResendSetup({ path: { id: member.id } })),
    onSuccess: () => toast.success(t("inviteSent")),
    onError,
    onSettled: reload,
  });
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
  const revoke = useMutation({
    mutationFn: () => apiData(deleteApiV1AdminAuthUsersById({ path: { id: member.id } })),
    onSuccess: async () => {
      toast.success(t("inviteCancelled"));
      setConfirm(null);
      await reload();
    },
    onError,
  });
  const busy = resend.isPending || suspend.isPending || revoke.isPending;
  if (!actions.resendInvite && !actions.cancelInvite && !actions.restore && !actions.suspend) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {actions.resendInvite ? (
        <Button type="button" variant="outline" disabled={busy} onClick={() => resend.mutate()}>
          {status === "invite_expired" ? t("sendNewInvite") : t("resendInvite")}
        </Button>
      ) : null}
      {actions.restore ? (
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          loading={suspend.isPending && suspend.variables === false}
          onClick={() => suspend.mutate(false)}
        >
          {t("restoreAccess")}
        </Button>
      ) : null}
      {actions.cancelInvite ? (
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirm("cancelInvite")}>
          {t("cancelInvite")}
        </Button>
      ) : null}
      {actions.suspend ? (
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirm("suspend")}>
          {t("suspendAccess")}
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
        isLoading={revoke.isPending}
        onConfirm={() => revoke.mutate()}
      />
    </div>
  );
}

function StaffRow({ member, viewer }: { member: AdminUser; viewer: ReturnType<typeof useViewer> }) {
  const t = useMessages(usersMessages);
  const status = getStaffStatus(member);
  const actions = staffActions({ id: member.id, isSuperAdmin: member.isSuperAdmin, status }, viewer);
  const editable = Object.values(actions).some(Boolean);
  const roleNames = member.roles.map((role) => role.displayName).join(", ");
  const row = (
    <SettingsRow
      disabled={!editable}
      label={
        <span className="flex flex-wrap items-center gap-2">
          {member.name}
          {member.id === viewer.id ? <Badge variant="outline">{t("you")}</Badge> : null}
          {member.isSuperAdmin ? <Badge variant="outline">{t("owner")}</Badge> : null}
          {status !== "ready" ? <Badge variant="secondary">{t(status)}</Badge> : null}
        </span>
      }
      value={[member.email, roleNames || (member.isSuperAdmin ? "" : t("noRole"))].filter(Boolean).join(" · ")}
    />
  );
  if (!editable) return row;
  return (
    <SettingsDialog title={member.name} description={member.email} trigger={row}>
      {actions.editAccess ? <StaffAccessForm member={member} /> : null}
      <StaffActionButtons member={member} status={status} actions={actions} />
    </SettingsDialog>
  );
}

export function StaffCard() {
  const t = useMessages(usersMessages);
  const viewer = useViewer();
  const { data, isError, refetch } = useQuery(staffQuery);
  if (isError) return <SettingsLoadFailure title={t("staffTitle")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;
  return (
    <SettingsCard id="staff"
      title={t("staffTitle")}
      action={
        viewer.canManageStaff ? (
          <SettingsDialog
            title={t("addStaff")}
            description={t("addStaffHelp")}
            trigger={<Button type="button" variant="outline" size="sm">{t("addStaff")}</Button>}
          >
            <AddStaffForm />
          </SettingsDialog>
        ) : null
      }
      rows={data.map((member) => <StaffRow key={member.id} member={member} viewer={viewer} />)}
    />
  );
}

// ── Roles ───────────────────────────────────────────────────────────────

function RoleForm({ role }: { role: RbacRole | null }) {
  const t = useMessages(usersMessages);
  const common = useMessages(settingsMessages);
  const refresh = useAccessRefresh();
  const readOnly = role?.isSystem === true;
  const [saved] = useState(() => ({ name: role?.displayName ?? "", permissions: [...(role?.permissions ?? [])].sort() }));
  const [draft, setDraft] = useState(saved);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useMutation({
    mutationFn: () => {
      const displayName = draft.name.trim();
      return role
        ? apiData(putApiV1AdminRbacRolesById({ path: { id: role.id }, body: { displayName, permissions: draft.permissions } }))
        : apiData(postApiV1AdminRbacRoles({ body: { name: roleKey(displayName), displayName, permissions: draft.permissions } }));
    },
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => apiData(deleteApiV1AdminRbacRolesById({ path: { id: role!.id } })),
    onSuccess: async () => {
      toast.success(t("roleDeleted"));
      setConfirmDelete(false);
      await refresh();
    },
    onError: (error) => toast.error(failure(error, t, t("actionFailed"), t("roleInUse"))),
  });
  useSaveBar({
    fields: { name: "role-name", displayName: "role-name" },
    dirty: !readOnly && JSON.stringify(draft) !== JSON.stringify(saved),
    saving: save.isPending,
    invalid: !draft.name.trim(),
    save: () => save.mutateAsync().catch((error: unknown) => {
      throw saveFailure(error, t, common("saveFailed"), t("roleExists"));
    }),
    discard: () => setDraft(saved),
  });
  const checked = new Set(draft.permissions);
  return (
    <>
      <SettingsField id="role-name" label={t("roleName")} help={readOnly ? t("builtInHelp") : undefined}>
        <Input
          id="role-name"
          maxLength={100}
          disabled={readOnly}
          aria-describedby={readOnly ? "role-name-note" : undefined}
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </SettingsField>
      <div className="space-y-3">
        <p className="text-body font-medium">{t("permissions")}</p>
        <PermissionChecklist
          id={`role-${role?.id ?? "new"}`}
          checked={checked}
          disabled={readOnly}
          onChange={(permission, on) => {
            if (on) checked.add(permission);
            else checked.delete(permission);
            setDraft({ ...draft, permissions: [...checked].sort() });
          }}
        />
      </div>
      {role && !readOnly ? (
        <>
          <Button type="button" variant="ghost" onClick={() => setConfirmDelete(true)}>
            {t("deleteRole")}
          </Button>
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={common("deleteNamed", { name: role.displayName })}
            description={t("deleteRoleConfirm", { name: role.displayName })}
            confirmLabel={common("delete")}
            cancelLabel={common("cancel")}
            isLoading={remove.isPending}
            loadingLabel={t("deletingRole")}
            onConfirm={() => remove.mutate()}
          />
        </>
      ) : null}
    </>
  );
}

export function RolesCard() {
  const t = useMessages(usersMessages);
  const { data, isError, refetch } = useQuery(rolesQuery);
  const staff = useQuery(staffQuery);
  if (isError) return <SettingsLoadFailure title={t("rolesTitle")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;
  const staffCount = (roleId: string) =>
    staff.data?.filter((member) => member.roles.some((role) => role.id === roleId)).length;
  const summary = (role: RbacRole) => {
    const permissions = role.permissions.length === 1 ? t("permissionCountOne") : t("permissionCount", { count: role.permissions.length });
    const count = staffCount(role.id);
    return count === undefined ? permissions : `${permissions} · ${t("staffCount", { count })}`;
  };
  return (
    <SettingsCard id="roles"
      title={t("rolesTitle")}
      description={data.length ? undefined : t("noRolesYet")}
      action={
        <SettingsDialog
          title={t("addRole")}
          trigger={<Button type="button" variant="outline" size="sm">{t("addRole")}</Button>}
        >
          <RoleForm role={null} />
        </SettingsDialog>
      }
      rows={
        data.length
          ? data.map((role) => (
              <SettingsDialog
                key={role.id}
                title={role.isSystem ? role.displayName : t("editRole", { name: role.displayName })}
                trigger={
                  <SettingsRow
                    label={
                      <span className="flex items-center gap-2">
                        {role.displayName}
                        {role.isSystem ? <Badge variant="secondary">{t("builtIn")}</Badge> : null}
                      </span>
                    }
                    value={summary(role)}
                  />
                }
              >
                <RoleForm role={role} />
              </SettingsDialog>
            ))
          : null
      }
    />
  );
}
