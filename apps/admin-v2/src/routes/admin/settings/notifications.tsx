import { createFileRoute } from "@tanstack/react-router";
import {
  CustomerNotificationsCard,
  SendingCard,
  StaffNotificationsCard,
} from "~/components/admin/settings/NotificationSettings";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/notifications")({
  // The screen's query module comes with its own code, not the dashboard's first download.
  loader: async ({ context: { queryClient } }) => {
    const screens = await import("~/lib/api-query-options/settings-screens");
    return Promise.allSettled([
      queryClient.ensureQueryData(screens.customerRulesQuery),
      queryClient.ensureQueryData(screens.emailQuery),
      queryClient.ensureQueryData(screens.smsQuery),
    ]);
  },
  head: () => settingsHead("notifications"),
  errorComponent: RouteErrorComponent,
  component: NotificationsPage,
});

function NotificationsPage() {
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT);
  return (
    <SettingsPage page="notifications" readOnly={!canEdit}>
      <CustomerNotificationsCard />
      <StaffNotificationsCard />
      <SendingCard />
    </SettingsPage>
  );
}
