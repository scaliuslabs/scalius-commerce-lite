import { createFileRoute } from "@tanstack/react-router";
import { DeliveryZonesCard, LocalPickupCard } from "~/components/admin/settings/DeliveryZones";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { CouriersCard, DeliveryAreasCard } from "~/components/admin/settings/ShippingSettings";
import { ShippingProfilesCard } from "~/components/admin/settings/ShippingProfiles";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import {
  areaCountsQuery,
  couriersQuery,
  currencyQuery,
  deliveryZonesQuery,
  platformQuery,
  shippingProfilesQuery,
} from "~/lib/api-query-options/settings-screens";
import { RouteErrorComponent } from "~/lib/route-error";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { viewerHolds } from "~/lib/route-query-warming";

export const Route = createFileRoute("/admin/settings/shipping")({
  // Each card reads only for a role that may see it (the page opens for any of the three).
  loader: ({ context: { queryClient, ...viewer } }) =>
    Promise.allSettled([
      ...(viewerHolds(viewer, ADMIN_PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW)
        ? [queryClient.ensureQueryData(deliveryZonesQuery), queryClient.ensureQueryData(shippingProfilesQuery)]
        : []),
      ...(viewerHolds(viewer, ADMIN_PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_VIEW) ? [queryClient.ensureQueryData(areaCountsQuery)] : []),
      ...(viewerHolds(viewer, ADMIN_PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW) ? [queryClient.ensureQueryData(couriersQuery)] : []),
      queryClient.ensureQueryData(currencyQuery),
      ...(viewerHolds(viewer, ADMIN_PERMISSIONS.SETTINGS_GENERAL_VIEW) ? [queryClient.ensureQueryData(platformQuery)] : []),
    ]),
  head: () => settingsHead("shipping"),
  errorComponent: RouteErrorComponent,
  component: ShippingPage,
});

function ShippingPage() {
  return (
    <SettingsPage page="shipping">
      <DeliveryZonesCard />
      <LocalPickupCard />
      <ShippingProfilesCard />
      <DeliveryAreasCard />
      <CouriersCard />
    </SettingsPage>
  );
}
