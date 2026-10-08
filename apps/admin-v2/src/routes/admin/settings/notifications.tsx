import { createFileRoute } from "@tanstack/react-router";
import {
  CustomerNotificationsCard,
  SendingCard,
  StaffNotificationsCard,
} from "~/components/admin/settings/NotificationSettings";
import { AppProviderSheetHost } from "~/components/admin/apps/AppProviderSheetHost";
import { AppKindCard } from "~/components/admin/settings/AppKindCard";
import { BrowserNotificationsCard } from "~/components/admin/settings/BrowserNotificationsCard";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { appProvidersQuery, customerRulesQuery, emailQuery, smsQuery } from "~/lib/api-query-options/settings-screens";
import { RouteErrorComponent } from "~/lib/route-error";
import { webPushQuery, webPushSupported } from "~/lib/web-push";

export const Route = createFileRoute("/admin/settings/notifications")({
  loader: ({ context: { queryClient } }) =>
    Promise.allSettled([
      queryClient.ensureQueryData(customerRulesQuery),
      queryClient.ensureQueryData(emailQuery),
      queryClient.ensureQueryData(smsQuery),
      queryClient.ensureQueryData(appProvidersQuery("push")),
      queryClient.ensureQueryData(appProvidersQuery("messaging")),
      // "Notifications on this device" reads this staff member's browsers; only a browser with Web Push asks.
      webPushSupported() ? queryClient.ensureQueryData(webPushQuery) : Promise.resolve(),
    ]),
  head: () => settingsHead("notifications"),
  errorComponent: RouteErrorComponent,
  component: NotificationsPage,
});

function NotificationsPage() {
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT);
  return (
    <AppProviderSheetHost>
      <SettingsPage page="notifications" readOnly={!canEdit}>
        <CustomerNotificationsCard />
        <StaffNotificationsCard />
        <SendingCard />
        <BrowserNotificationsCard />
        <AppKindCard kind="messaging" />
      </SettingsPage>
    </AppProviderSheetHost>
  );
}
