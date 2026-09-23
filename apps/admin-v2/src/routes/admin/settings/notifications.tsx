import { createFileRoute } from "@tanstack/react-router";
import {
  CustomerNotificationsCard,
  SendingCard,
  StaffNotificationsCard,
  customerRulesQuery,
  emailQuery,
  smsQuery,
  staffRulesQuery,
} from "~/components/admin/settings/NotificationSettings";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/notifications")({
  loader: ({ context: { queryClient } }) =>
    Promise.allSettled([
      queryClient.ensureQueryData(customerRulesQuery),
      queryClient.ensureQueryData(staffRulesQuery),
      queryClient.ensureQueryData(emailQuery),
      queryClient.ensureQueryData(smsQuery),
    ]),
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
