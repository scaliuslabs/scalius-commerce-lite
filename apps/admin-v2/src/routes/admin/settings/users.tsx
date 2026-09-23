import { createFileRoute } from "@tanstack/react-router";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { RolesCard, StaffCard, rolesQuery, staffQuery } from "~/components/admin/settings/UsersSettings";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { usePermissions } from "~/contexts/PermissionContext";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/users")({
  loader: ({ context: { queryClient } }) =>
    Promise.allSettled([queryClient.ensureQueryData(staffQuery), queryClient.ensureQueryData(rolesQuery)]),
  head: () => settingsHead("users"),
  errorComponent: RouteErrorComponent,
  component: UsersPage,
});

function UsersPage() {
  const { hasPermission } = usePermissions();
  const canManageStaff = hasPermission(PERMISSIONS.TEAM_MANAGE);
  const canManageRoles = hasPermission(PERMISSIONS.TEAM_MANAGE_ROLES);
  return (
    <SettingsPage page="users" readOnly={!canManageStaff && !canManageRoles}>
      <StaffCard />
      {canManageRoles ? <RolesCard /> : null}
    </SettingsPage>
  );
}
