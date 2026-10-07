import { createFileRoute } from "@tanstack/react-router";
import { DeliveryAreasManager } from "~/components/admin/settings/DeliveryAreas";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { PLACE_ADDRESS_COUNTRY } from "@scalius/shared/places";
import { deliveryLocationsQueryOptions } from "~/lib/api-query-options/delivery";
import { placeCountriesQueryOptions } from "~/lib/api-query-options/places";
import { RouteErrorComponent } from "~/lib/route-error";
import { useMessages } from "~/i18n";
import { settingsNavMessages } from "~/i18n/settings";
import { shippingMessages } from "~/i18n/settings-shipping";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/settings/shipping_/areas")({
  // The countries, and Bangladesh's cities (the first list most stores open).
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      queryClient.ensureQueryData(placeCountriesQueryOptions()),
      queryClient.ensureQueryData(deliveryLocationsQueryOptions({ country: PLACE_ADDRESS_COUNTRY, level: 1, page: 1, limit: 20 })),
    ]).catch(() => undefined),
  head: () => pageHead("deliveryAreas"),
  errorComponent: RouteErrorComponent,
  component: DeliveryAreasPage,
});

function DeliveryAreasPage() {
  const t = useMessages(shippingMessages);
  const nav = useMessages(settingsNavMessages);
  return (
    <SettingsPage page="shipping" title={t("areasPageTitle")} back={{ to: "/admin/settings/shipping", label: nav("shipping") }}>
      <DeliveryAreasManager />
    </SettingsPage>
  );
}
