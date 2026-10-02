import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { LocationsManager } from "~/components/admin/settings/locations/LocationsManager";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/locations")({
  // The read's module (with its location writes) comes with the page's own code, not the first download.
  loader: async ({ context: { queryClient } }) => {
    const { inventoryLocationsQueryOptions } = await import("~/lib/api-query-options/inventory-locations");
    return queryClient.ensureQueryData(inventoryLocationsQueryOptions(false)).catch(() => undefined);
  },
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
