import { createFileRoute } from "@tanstack/react-router";
import { CookieBannerCard, CustomerDataCard, trackingHealthQuery, trackingSettingsQuery } from "~/components/admin/settings/PrivacySettings";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { marketsQueryOptions } from "~/lib/api-query-options/markets";
import { RouteErrorComponent } from "~/lib/route-error";
import { viewerHolds } from "~/lib/route-query-warming";

export const Route = createFileRoute("/admin/settings/privacy")({
  // Each card reads only for a role that may see it; a slow read never blocks the page.
  loader: ({ context: { queryClient, ...viewer } }) =>
    Promise.allSettled([
      ...(viewerHolds(viewer, ADMIN_PERMISSIONS.ANALYTICS_VIEW)
        ? [queryClient.ensureQueryData(trackingSettingsQuery), queryClient.ensureQueryData(trackingHealthQuery)]
        : []),
      ...(viewerHolds(viewer, ADMIN_PERMISSIONS.SETTINGS_GENERAL_VIEW) ? [queryClient.ensureQueryData(marketsQueryOptions())] : []),
    ]),
  head: () => settingsHead("privacy"),
  errorComponent: RouteErrorComponent,
  component: PrivacyPage,
});

function PrivacyPage() {
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.ANALYTICS_EDIT);
  return (
    <SettingsPage page="privacy" readOnly={!canEdit}>
      <CookieBannerCard />
      <CustomerDataCard />
    </SettingsPage>
  );
}
