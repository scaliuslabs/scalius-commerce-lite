import { createFileRoute } from "@tanstack/react-router";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { RolesCard, StaffCard } from "~/components/admin/settings/UsersSettings";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { usePermissions } from "~/contexts/PermissionContext";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/users")({
  // The screen's query module comes with its own code, not the dashboard's first download.
  loader: async ({ context: { queryClient } }) => {
    const screens = await import("~/lib/api-query-options/settings-screens");
    return Promise.allSettled([queryClient.ensureQueryData(screens.staffQuery), queryClient.ensureQueryData(screens.rolesQuery)]);
  },
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
