import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/i18n/page-titles";
import { LocationsManager } from "~/components/admin/settings/locations/LocationsManager";
import { inventoryLocationsQueryOptions } from "~/lib/api-query-options/inventory-locations";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/locations")({
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(inventoryLocationsQueryOptions(false)).catch(() => undefined),
  head: () => settingsHead("locations"),
  errorComponent: RouteErrorComponent,
  component: LocationsPage,
});

function LocationsPage() {
  return (
    <SettingsPage page="locations">
      <LocationsManager />
    </SettingsPage>
  );
}
