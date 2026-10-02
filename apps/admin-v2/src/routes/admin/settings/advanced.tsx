import { createFileRoute } from "@tanstack/react-router";
import {
  ImageDeliveryCard,
  RefreshStoreCard,
  SignInAccessCard,
  TrustedWebsitesCard,
} from "~/components/admin/settings/AdvancedSettings";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/advanced")({
  // The screen's query module comes with its own code, not the dashboard's first download.
  loader: async ({ context: { queryClient } }) => {
    const screens = await import("~/lib/api-query-options/settings-screens");
    return Promise.allSettled([
      queryClient.ensureQueryData(screens.trustedWebsitesQuery),
      queryClient.ensureQueryData(screens.mediaQuery),
      queryClient.ensureQueryData(screens.platformQuery),
    ]);
  },
  head: () => settingsHead("advanced"),
  errorComponent: RouteErrorComponent,
  component: AdvancedSettingsPage,
});

function AdvancedSettingsPage() {
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  return (
    <SettingsPage page="advanced" readOnly={!canEdit}>
      <TrustedWebsitesCard />
      <ImageDeliveryCard />
      <SignInAccessCard />
      <RefreshStoreCard />
    </SettingsPage>
  );
}
