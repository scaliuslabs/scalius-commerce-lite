import { createFileRoute } from "@tanstack/react-router";
import { DeliveryZonesCard } from "~/components/admin/settings/DeliveryZones";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { CouriersCard, DeliveryAreasCard } from "~/components/admin/settings/ShippingSettings";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/shipping")({
  // The screen's query module comes with its own code, not the dashboard's first download.
  loader: async ({ context: { queryClient } }) => {
    const screens = await import("~/lib/api-query-options/settings-screens");
    return Promise.allSettled([
      queryClient.ensureQueryData(screens.deliveryZonesQuery),
      queryClient.ensureQueryData(screens.areaCountsQuery),
      queryClient.ensureQueryData(screens.couriersQuery),
      queryClient.ensureQueryData(screens.currencyQuery),
      queryClient.ensureQueryData(screens.platformQuery),
    ]);
  },
  head: () => settingsHead("shipping"),
  errorComponent: RouteErrorComponent,
  component: ShippingPage,
});

function ShippingPage() {
  return (
    <SettingsPage page="shipping">
      <DeliveryZonesCard />
      <DeliveryAreasCard />
      <CouriersCard />
    </SettingsPage>
  );
}
