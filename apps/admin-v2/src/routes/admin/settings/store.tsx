import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import {
  BusinessCard,
  StoreDefaultsCard,
  WebAddressesCard,
  businessQuery,
  countriesQuery,
  currencyQuery,
  platformQuery,
} from "~/components/admin/settings/StoreSettings";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/store")({
  loader: ({ context: { queryClient } }) =>
    Promise.allSettled([
      queryClient.ensureQueryData(businessQuery),
      queryClient.ensureQueryData(platformQuery),
      queryClient.ensureQueryData(currencyQuery),
      queryClient.ensureQueryData(countriesQuery),
    ]),
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
