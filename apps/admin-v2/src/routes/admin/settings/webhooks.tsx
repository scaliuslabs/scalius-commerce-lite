import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/i18n/page-titles";
import { WebhooksSettings } from "~/components/admin/settings/webhooks/WebhooksSettings";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { webhooksQueryOptions } from "~/lib/api-query-options/webhooks";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/webhooks")({
  // A refused or failed read shows the card's own retry.
  loader: ({ context: { queryClient } }) => Promise.allSettled([queryClient.ensureQueryData(webhooksQueryOptions())]),
  head: () => settingsHead("webhooks"),
  errorComponent: RouteErrorComponent,
  component: WebhooksPage,
});

function WebhooksPage() {
  const canManage = useHasPermission(ADMIN_PERMISSIONS.WEBHOOKS_MANAGE);
  return (
    <SettingsPage page="webhooks" readOnly={!canManage}>
      <WebhooksSettings />
    </SettingsPage>
  );
}
