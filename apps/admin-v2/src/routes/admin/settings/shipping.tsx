import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import {
  CouriersCard,
  DeliveryAreasCard,
  DeliveryChargesCard,
  areaCountsQuery,
  couriersQuery,
  shippingRatesQuery,
} from "~/components/admin/settings/ShippingSettings";
import { currencyQuery, platformQuery } from "~/components/admin/settings/StoreSettings";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/shipping")({
  loader: ({ context: { queryClient } }) =>
    Promise.allSettled([
      queryClient.ensureQueryData(shippingRatesQuery),
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
      <DeliveryChargesCard />
      <DeliveryAreasCard />
      <CouriersCard />
    </SettingsPage>
  );
}
