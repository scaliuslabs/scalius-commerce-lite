import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { WebhooksSettings } from "~/components/admin/settings/webhooks/WebhooksSettings";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/webhooks")({
  // A refused or failed read shows the card's own retry.
  // The read's module comes with the page's own code, not the dashboard's first download.
  loader: async ({ context: { queryClient } }) => {
    const { webhooksQueryOptions: options } = await import("~/lib/api-query-options/webhooks");
    return Promise.allSettled([queryClient.ensureQueryData(options())]);
  },
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
