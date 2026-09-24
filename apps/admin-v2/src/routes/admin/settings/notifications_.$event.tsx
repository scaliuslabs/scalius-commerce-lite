import { createFileRoute } from "@tanstack/react-router";
import { isOrderNotificationType } from "@scalius/core/modules/notifications/notification-types";
import { NotificationTemplateEditor } from "~/components/admin/settings/NotificationTemplateEditor";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { customerRulesQuery, templatesQuery } from "~/lib/api-query-options/settings-screens";
import { RouteErrorComponent } from "~/lib/route-error";
import { translate, useMessages } from "~/i18n";
import { settingsNavMessages } from "~/i18n/settings";
import { notificationEventMessages } from "~/i18n/notification-events";
import { titleHead } from "~/i18n/page-titles";
import { notificationTemplateMessages } from "~/i18n/settings-notifications";

// One customer message (e.g. "Order shipped"), opened from Settings → Notifications.
export const Route = createFileRoute("/admin/settings/notifications_/$event")({
  loader: ({ context: { queryClient } }) =>
    Promise.allSettled([
      queryClient.ensureQueryData(templatesQuery),
      queryClient.ensureQueryData(customerRulesQuery),
    ]),
  head: ({ params }) =>
    titleHead(
      isOrderNotificationType(params.event)
        ? translate(notificationEventMessages, params.event)
        : translate(settingsNavMessages, "notifications"),
    ),
  errorComponent: RouteErrorComponent,
  component: NotificationMessagePage,
});

function NotificationMessagePage() {
  const { event } = Route.useParams();
  const nav = useMessages(settingsNavMessages);
  const events = useMessages(notificationEventMessages);
  const t = useMessages(notificationTemplateMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT);
  const known = isOrderNotificationType(event);
  return (
    <SettingsPage
      page="notifications"
      title={known ? events(event) : nav("notifications")}
      back={{ to: "/admin/settings/notifications", label: nav("notifications") }}
      readOnly={known && !canEdit}
    >
      {known ? (
        <NotificationTemplateEditor event={event} />
      ) : (
        <p className="text-body text-muted-foreground">{t("notFound")}</p>
      )}
    </SettingsPage>
  );
}
