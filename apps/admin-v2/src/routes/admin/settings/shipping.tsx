import { createFileRoute } from "@tanstack/react-router";
import { DeliveryZonesCard } from "~/components/admin/settings/DeliveryZones";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { CouriersCard, DeliveryAreasCard } from "~/components/admin/settings/ShippingSettings";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import {
  areaCountsQuery,
  couriersQuery,
  currencyQuery,
  deliveryZonesQuery,
  platformQuery,
} from "~/lib/api-query-options/settings-screens";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/shipping")({
  loader: ({ context: { queryClient } }) =>
    Promise.allSettled([
      queryClient.ensureQueryData(deliveryZonesQuery),
      queryClient.ensureQueryData(areaCountsQuery),
      queryClient.ensureQueryData(couriersQuery),
      queryClient.ensureQueryData(currencyQuery),
      queryClient.ensureQueryData(platformQuery),
    ]),
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
