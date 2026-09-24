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
import { mediaQuery, platformQuery, trustedWebsitesQuery } from "~/lib/api-query-options/settings-screens";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/advanced")({
  loader: ({ context: { queryClient } }) =>
    Promise.allSettled([
      queryClient.ensureQueryData(trustedWebsitesQuery),
      queryClient.ensureQueryData(mediaQuery),
      queryClient.ensureQueryData(platformQuery),
    ]),
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
