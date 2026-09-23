import { createFileRoute } from "@tanstack/react-router";
import {
  ImageDeliveryCard,
  RefreshStoreCard,
  SignInAccessCard,
  TrustedWebsitesCard,
  mediaQuery,
  trustedWebsitesQuery,
} from "~/components/admin/settings/AdvancedSettings";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { platformQuery } from "~/components/admin/settings/StoreSettings";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
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
