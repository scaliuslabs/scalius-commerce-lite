import { useState, type ReactNode } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteApiV1AdminRbacRolesById,
  postApiV1AdminRbacRoles,
  putApiV1AdminRbacRolesById,
} from "@scalius/api-client/sdk";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { useSaveBar } from "~/components/admin/shared/SaveBar";
import { SettingsLoadFailure } from "~/components/admin/settings/SettingsLoadFailure";
import { SettingsCard, SettingsCardLoading, SettingsField, SettingsPage } from "~/components/admin/settings/SettingsPage";
import {
  PermissionChecklist,
  failure,
  saveFailure,
  useAccessRefresh,
  useRoleName,
  useViewer,
} from "~/components/admin/settings/UsersSettings";
import { roleKey } from "~/components/admin/settings/staff-access";
import { apiData } from "~/lib/api";
import type { RbacRole } from "~/lib/api-query-options/rbac";
import { rolesQuery } from "~/lib/api-query-options/settings-screens";
import { RouteErrorComponent } from "~/lib/route-error";
import { useMessages } from "~/i18n";
import { settingsMessages, settingsNavMessages } from "~/i18n/settings";
import { usersMessages } from "~/i18n/settings-users";
import { pageHead } from "~/i18n/page-titles";

const NEW_ROLE = "new";

// A role is a full page (Shopify): the name, then permissions in collapsible
// sections. `/roles/new?from=<id>` starts a custom role from another one.
export const Route = createFileRoute("/admin/settings/users_/roles/$roleId")({
  validateSearch: (search: Record<string, unknown>): { from?: string } =>
    typeof search.from === "string" ? { from: search.from } : {},
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(rolesQuery).catch(() => undefined),
  head: () => pageHead("roles"),
  errorComponent: RouteErrorComponent,
  component: RolePage,
});

function RolePage() {
  const { roleId } = Route.useParams();
  const { from } = Route.useSearch();
  const t = useMessages(usersMessages);
  const nav = useMessages(settingsNavMessages);
  const roleName = useRoleName();
  const roles = useQuery(rolesQuery);
  const back = { to: "/admin/settings/users" as const, label: nav("users") };
  const creating = roleId === NEW_ROLE;
  const role = creating ? null : roles.data?.find((candidate) => candidate.id === roleId);
  const template = creating && from ? roles.data?.find((candidate) => candidate.id === from) : undefined;

  const page = (title: string, body: ReactNode, actions?: ReactNode) => (
    <SettingsPage page="users" back={back} title={title} actions={actions}>{body}</SettingsPage>
  );
  if (roles.isError) return page(t("rolesTitle"), <SettingsLoadFailure title={t("rolesTitle")} onRetry={roles.refetch} />);
  if (!roles.data) return page(t("rolesTitle"), <SettingsCardLoading />);
  if (role === undefined) return page(t("rolesTitle"), <SettingsCard description={t("notFound")} />);

  if (role?.isSystem) {
    return page(
      roleName(role),
      <RoleForm key={role.id} role={role} readOnly />,
      <Button variant="outline" size="sm" asChild>
        <Link to="/admin/settings/users/roles/$roleId" params={{ roleId: NEW_ROLE }} search={{ from: role.id }}>
          {t("duplicateRole")}
        </Link>
      </Button>,
    );
  }
  return page(
    role ? role.displayName : t("addRole"),
    <RoleForm
      key={role?.id ?? `new:${template?.id ?? ""}`}
      role={role}
      initial={template ? { name: t("copyOf", { name: roleName(template) }), permissions: template.permissions } : undefined}
    />,
  );
}

function RoleForm({ role, initial, readOnly = false }: {
  role: RbacRole | null;
  initial?: { name: string; permissions: readonly string[] };
  readOnly?: boolean;
}) {
  const t = useMessages(usersMessages);
  const common = useMessages(settingsMessages);
  const roleName = useRoleName();
  const viewer = useViewer();
  const refresh = useAccessRefresh();
  const navigate = useNavigate();
  const [saved, setSaved] = useState(() => ({
    name: role ? roleName(role) : "",
    permissions: [...(role?.permissions ?? [])].sort(),
  }));
  const [draft, setDraft] = useState(() => (initial
    ? { name: initial.name, permissions: [...initial.permissions].sort() }
    : saved));
  const nameError = draft.name.trim() ? undefined : t("roleNameRequired");
  useSaveBar({
    fields: { name: "role-name", displayName: "role-name" },
    dirty: !readOnly && JSON.stringify(draft) !== JSON.stringify(saved),
    invalid: Boolean(nameError),
    save: async () => {
      const displayName = draft.name.trim();
      try {
        if (role) {
          await apiData(putApiV1AdminRbacRolesById({ path: { id: role.id }, body: { displayName, permissions: draft.permissions } }));
          setSaved(draft);
          await refresh();
          return;
        }
        const created = await apiData(postApiV1AdminRbacRoles({
          body: { name: roleKey(displayName), displayName, permissions: draft.permissions },
        }));
        setSaved(draft);
        await refresh();
        // Still saving, so the leave-page guard lets this through.
        await navigate({ to: "/admin/settings/users/roles/$roleId", params: { roleId: created.role.id }, replace: true });
      } catch (error) {
        throw saveFailure(error, t, common("saveFailed"), t("roleExists"));
      }
    },
    discard: () => setDraft(saved),
  });
  const checked = new Set(draft.permissions);
  const canGrant = (permission: string) => viewer.isOwner || viewer.permissions.has(permission);
  return (
    <>
      <Card>
        <CardContent className="pt-4">
          <SettingsField id="role-name" label={t("roleName")} error={readOnly ? undefined : nameError} help={readOnly ? t("builtInHelp") : undefined}>
            <Input
              id="role-name"
              maxLength={100}
              disabled={readOnly}
              aria-describedby={readOnly ? "role-name-note" : undefined}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </SettingsField>
        </CardContent>
      </Card>
      <SettingsCard
        title={t("permissions")}
        rows={
          <PermissionChecklist
            id={`role-${role?.id ?? "new"}`}
            checked={checked}
            disabled={readOnly}
            canGrant={canGrant}
            onChange={(next) => setDraft({ ...draft, permissions: [...next].sort() })}
          />
        }
      />
      {role && !readOnly ? <DeleteRole role={role} /> : null}
    </>
  );
}

/** Bottom-left, Shopify style. A role that staff still hold can't be deleted; the dialog says why. */
function DeleteRole({ role }: { role: RbacRole }) {
  const t = useMessages(usersMessages);
  const common = useMessages(settingsMessages);
  const roleName = useRoleName();
  const refresh = useAccessRefresh();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const remove = useMutation({
    mutationFn: () => apiData(deleteApiV1AdminRbacRolesById({ path: { id: role.id } })),
    onSuccess: async () => {
      toast.success(t("roleDeleted"));
      setOpen(false);
      await refresh();
      await navigate({ to: "/admin/settings/users" });
    },
    onError: (error) => toast.error(failure(error, t, t("actionFailed"), t("roleInUse"))),
  });
  const inUse = role.staffCount > 0;
  return (
    <div>
      <Button type="button" variant="destructive" onClick={() => setOpen(true)}>{t("deleteRole")}</Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{common("deleteNamed", { name: roleName(role) })}</AlertDialogTitle>
            <AlertDialogDescription>
              {inUse
                ? role.staffCount === 1 ? t("roleInUseOne") : t("roleInUseMany", { count: role.staffCount })
                : t("deleteRoleConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>{common("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={inUse || remove.isPending}
              onClick={(event) => {
                event.preventDefault();
                remove.mutate();
              }}
            >
              {remove.isPending ? t("deletingRole") : common("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
