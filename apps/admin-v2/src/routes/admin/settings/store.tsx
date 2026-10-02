import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { BusinessCard, StoreDefaultsCard, WebAddressesCard } from "~/components/admin/settings/StoreSettings";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/store")({
  // The screen's query module comes with its own code, not the dashboard's first download.
  loader: async ({ context: { queryClient } }) => {
    const screens = await import("~/lib/api-query-options/settings-screens");
    return Promise.allSettled([
      queryClient.ensureQueryData(screens.businessQuery),
      queryClient.ensureQueryData(screens.platformQuery),
      queryClient.ensureQueryData(screens.currencyQuery),
      queryClient.ensureQueryData(screens.countriesQuery),
    ]);
  },
  head: () => settingsHead("store"),
  errorComponent: RouteErrorComponent,
  component: StoreSettingsPage,
});

function StoreSettingsPage() {
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  return (
    <SettingsPage page="store" readOnly={!canEdit}>
      <BusinessCard />
      <WebAddressesCard />
      <StoreDefaultsCard />
    </SettingsPage>
  );
}
