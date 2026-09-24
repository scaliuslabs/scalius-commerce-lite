import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouteContext, useRouter } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { postApiV1AdminAuthUsers } from "@scalius/api-client/sdk";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { cn } from "@scalius/shared/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Input } from "~/components/ui/input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { usePermissions } from "~/contexts/PermissionContext";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { readApiFieldIssues } from "~/lib/api-field-errors";
import { refreshAdminRouteContext } from "~/lib/admin-route-context";
import { apiData } from "~/lib/api";
import type { AdminUser, RbacRole } from "~/lib/api-query-options/rbac";
import { rolesQuery, staffQuery } from "~/lib/api-query-options/settings-screens";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { builtInRoleMessages, permissionGroupMessages, permissionMessages, usersMessages } from "~/i18n/settings-users";
import { useSaveBar } from "../shared/SaveBar";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsDialog, SettingsField, SettingsCardLoading } from "./SettingsPage";
import {
  PERMISSION_GROUPS,
  builtInRole,
  canGrantRole,
  getStaffStatus,
  isDependentPermission,
  lockedReason,
  staffActions,
  togglePermissions,
} from "./staff-access";

export type UsersMessages = (key: keyof typeof usersMessages.en, vars?: Record<string, string | number>) => string;

const EMAIL = /^\S+@\S+\.\S+$/;

export function useViewer() {
  const { user } = useRouteContext({ from: "/admin" });
  const { hasPermission, isSuperAdmin, permissions } = usePermissions();
  return {
    id: user.id,
    isOwner: isSuperAdmin,
    permissions,
    canManageStaff: hasPermission(PERMISSIONS.TEAM_MANAGE),
    canManageRoles: hasPermission(PERMISSIONS.TEAM_MANAGE_ROLES),
  };
}
export type Viewer = ReturnType<typeof useViewer>;

/** Built-in roles in the merchant's language; custom roles as typed. */
export function useRoleName() {
  const builtIn = useMessages(builtInRoleMessages);
  return (role: { name: string; displayName: string }) => {
    const key = builtInRole(role.name);
    return key ? builtIn(key) : role.displayName;
  };
}

/** Roles and access changed: reload staff and roles, then the signed-in admin's own permissions. */
export function useAccessRefresh() {
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

export function failure(error: unknown, t: UsersMessages, fallback: string, conflict?: string): string {
  if (error instanceof AdminApiResponseError) {
    if (error.status === 403) return t("noAuthority");
    if (error.status === 409 && conflict) return conflict;
    // The API refuses to suspend the last active administrator.
    if (error.status === 400 && /last active administrator/i.test(error.message)) return t("lastManager");
  }
  return fallback;
}

/** A save-bar rejection: field problems pass through to be marked in place; the rest in plain words. */
export function saveFailure(error: unknown, t: UsersMessages, fallback: string, conflict?: string): Error {
  return readApiFieldIssues(error) ? (error as Error) : new Error(failure(error, t, fallback, conflict));
}

/**
 * Permissions in collapsible sections, Shopify style: each section has an
 * "All" box, and actions sit under the view permission they need. Ticking an
 * action ticks what it needs; unticking a view unticks what depends on it.
 * Permissions the viewer can't hand out are shown but disabled.
 */
export function PermissionChecklist({
  id,
  checked,
  disabled,
  canGrant = () => true,
  onChange,
}: {
  id: string;
  checked: ReadonlySet<string>;
  disabled: boolean;
  canGrant?: (permission: string) => boolean;
  onChange: (next: Set<string>) => void;
}) {
  const t = useMessages(usersMessages);
  const group = useMessages(permissionGroupMessages);
  const label = useMessages(permissionMessages);
  return PERMISSION_GROUPS.map(({ group: key, permissions }) => {
    const on = permissions.filter((permission) => checked.has(permission)).length;
    const changeable = permissions.filter(canGrant);
    return (
      <div key={key} className="border-t border-border first:border-t-0">
        <Collapsible>
          <div className="flex min-h-12 items-center gap-3 px-4">
            <Checkbox
              aria-label={t("allIn", { group: group(key) })}
              checked={on === permissions.length ? true : on > 0 ? "indeterminate" : false}
              disabled={disabled || changeable.length === 0}
              onCheckedChange={(value) => onChange(togglePermissions(checked, changeable, value === true))}
            />
            <CollapsibleTrigger asChild>
              <button type="button" className="group flex min-h-12 flex-1 items-center gap-2 text-left text-body">
                <span id={`${id}-${key}`} className="flex-1 font-medium">{group(key)}</span>
                <span className="text-muted-foreground tabular-nums">
                  {t("selectedCount", { count: on, total: permissions.length })}
                </span>
                <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
              </button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <div role="group" aria-labelledby={`${id}-${key}`} className="pb-2 pl-11 pr-4">
              {permissions.map((permission) => (
                <label
                  key={permission}
                  className={cn("flex min-h-11 items-start gap-3 py-2.5 text-body", isDependentPermission(permission) && "pl-7")}
                >
                  <span className="flex h-lh items-center">
                    <Checkbox
                      checked={checked.has(permission)}
                      disabled={disabled || !canGrant(permission)}
                      onCheckedChange={(value) => onChange(togglePermissions(checked, [permission], value === true))}
                    />
                  </span>
                  {label(permission)}
                </label>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    );
  });
}

/** A list row: a link when it opens something, otherwise plain text with no chevron. */
function ListRow({ to, params, label, value, note }: {
  to?: "/admin/settings/users/$userId" | "/admin/settings/users/roles/$roleId";
  params?: Record<string, string>;
  label: ReactNode;
  value?: ReactNode;
  note?: ReactNode;
}) {
  const body = (
    <span className="min-w-0 flex-1">
      <span className="block text-body font-medium">{label}</span>
      {value ? <span className="block truncate text-body text-muted-foreground">{value}</span> : null}
      {note ? <span className="block text-body text-muted-foreground">{note}</span> : null}
    </span>
  );
  const row = "flex min-h-14 w-full items-center gap-3 border-t border-border px-4 py-3 text-left first:border-t-0";
  if (!to) return <div className={row}>{body}</div>;
  return (
    <Link to={to} params={params as never} className={cn(row, "hover:bg-muted")}>
      {body}
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </Link>
  );
}

// ── Staff ───────────────────────────────────────────────────────────────

function AddStaffForm() {
  const t = useMessages(usersMessages);
  const common = useMessages(settingsMessages);
  const roleName = useRoleName();
  const viewer = useViewer();
  const queryClient = useQueryClient();
  const roles = useQuery(rolesQuery);
  const empty = { name: "", email: "", roleId: "" };
  const [draft, setDraft] = useState(empty);
  const errors = {
    name: draft.name.trim() ? undefined : t("nameRequired"),
    email: EMAIL.test(draft.email.trim()) ? undefined : t("emailInvalid"),
    roleId: draft.roleId ? undefined : t("chooseRole"),
  };
  useSaveBar({
    fields: { name: "staff-name", email: "staff-email", roleId: "staff-role" },
    dirty: Boolean(draft.name || draft.email || draft.roleId),
    invalid: Object.values(errors).some(Boolean),
    save: async () => {
      try {
        const result = await apiData(postApiV1AdminAuthUsers({
          body: { name: draft.name.trim(), email: draft.email.trim(), roleId: draft.roleId },
        }));
        if (result.emailFailed) toast.warning(t("inviteNotSent"));
        await queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers.all });
      } catch (error) {
        // The banner shows the reason; name the known conflicts in plain words.
        throw saveFailure(error, t, common("saveFailed"), t("emailTaken"));
      }
    },
    discard: () => setDraft(empty),
  });
  const list = roles.data ?? [];
  const limited = list.some((role) => !canGrantRole(role, viewer));
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsField id="staff-name" label={t("name")} error={errors.name}>
          <Input
            id="staff-name"
            autoComplete="off"
            maxLength={100}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </SettingsField>
        <SettingsField id="staff-email" label={t("email")} error={errors.email}>
          <Input
            id="staff-email"
            inputMode="email"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            maxLength={320}
            value={draft.email}
            onChange={(event) => setDraft({ ...draft, email: event.target.value })}
          />
        </SettingsField>
      </div>
      {roles.isError ? (
        <SettingsLoadFailure title={t("roles")} onRetry={roles.refetch} />
      ) : (
        <SettingsField
          id="staff-role"
          label={t("role")}
          error={errors.roleId}
          help={roles.data && !list.length ? t("noRoles") : limited ? t("onlyYourAccess") : undefined}
        >
          <SearchableSelect
            id="staff-role"
            aria-describedby="staff-role-note"
            value={draft.roleId}
            onValueChange={(roleId) => setDraft({ ...draft, roleId })}
            disabled={!list.length}
            placeholder={t("chooseRole")}
            options={list.map((role) => ({ value: role.id, label: roleName(role), disabled: !canGrantRole(role, viewer) }))}
            triggerClassName="w-full"
          />
        </SettingsField>
      )}
    </>
  );
}

function StaffRow({ member, viewer }: { member: AdminUser; viewer: Viewer }) {
  const t = useMessages(usersMessages);
  const roleName = useRoleName();
  const status = getStaffStatus(member);
  const actions = staffActions({ id: member.id, isSuperAdmin: member.isSuperAdmin, status }, viewer);
  const openable = Object.values(actions).some(Boolean);
  const reason = lockedReason(member, viewer);
  const roleNames = member.roles.map(roleName).join(", ");
  return (
    <ListRow
      to={openable ? "/admin/settings/users/$userId" : undefined}
      params={{ userId: member.id }}
      label={
        <span className="flex flex-wrap items-center gap-2">
          {member.name}
          {reason === "self" ? <Badge variant="outline">{t("you")}</Badge> : null}
          {member.isSuperAdmin ? <Badge variant="outline">{t("owner")}</Badge> : null}
          {status !== "ready" ? <Badge variant="secondary">{t(status)}</Badge> : null}
        </span>
      }
      value={[member.email, roleNames || (member.isSuperAdmin ? "" : t("noRole"))].filter(Boolean).join(" · ")}
      note={!openable && reason && (viewer.canManageStaff || viewer.canManageRoles)
        ? t(reason === "self" ? "lockedSelf" : "lockedOwner")
        : undefined}
    />
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
            savedMessage={t("inviteSent")}
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

export function RolesCard() {
  const t = useMessages(usersMessages);
  const roleName = useRoleName();
  const { data, isError, refetch } = useQuery(rolesQuery);
  if (isError) return <SettingsLoadFailure title={t("rolesTitle")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;
  const summary = (role: RbacRole) => [
    role.permissions.length === 1 ? t("permissionCountOne") : t("permissionCount", { count: role.permissions.length }),
    t("staffCount", { count: role.staffCount }),
  ].join(" · ");
  return (
    <SettingsCard id="roles"
      title={t("rolesTitle")}
      description={data.length ? undefined : t("noRolesYet")}
      action={
        <Button type="button" variant="outline" size="sm" asChild>
          <Link to="/admin/settings/users/roles/$roleId" params={{ roleId: "new" }}>{t("addRole")}</Link>
        </Button>
      }
      rows={data.length
        ? data.map((role) => (
            <ListRow
              key={role.id}
              to="/admin/settings/users/roles/$roleId"
              params={{ roleId: role.id }}
              label={
                <span className="flex items-center gap-2">
                  {roleName(role)}
                  {role.isSystem ? <Badge variant="secondary">{t("builtIn")}</Badge> : null}
                </span>
              }
              value={summary(role)}
            />
          ))
        : null}
    />
  );
}
