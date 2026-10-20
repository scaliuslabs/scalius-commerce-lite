import { createFileRoute } from "@tanstack/react-router";
import { PrivacySettingsCards, TrackingHealthCard, trackingHealthQuery, trackingSettingsQuery } from "~/components/admin/settings/PrivacySettings";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { marketsQueryOptions } from "~/lib/api-query-options/markets";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/privacy")({
  // Each card shows its own failed read; a refused or slow one never blocks the page.
  loader: ({ context: { queryClient } }) =>
    Promise.allSettled([
      queryClient.ensureQueryData(trackingSettingsQuery),
      queryClient.ensureQueryData(trackingHealthQuery),
      queryClient.ensureQueryData(marketsQueryOptions()),
    ]),
  head: () => settingsHead("privacy"),
  errorComponent: RouteErrorComponent,
  component: PrivacyPage,
});

function PrivacyPage() {
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.ANALYTICS_EDIT);
  return (
    <SettingsPage page="privacy" readOnly={!canEdit}>
      <PrivacySettingsCards />
      <TrackingHealthCard />
    </SettingsPage>
  );
}
