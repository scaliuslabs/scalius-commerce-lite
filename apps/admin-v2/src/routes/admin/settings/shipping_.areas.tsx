import { createFileRoute } from "@tanstack/react-router";
import { DeliveryAreasManager } from "~/components/admin/settings/DeliveryAreas";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { deliveryLocationsQueryOptions } from "~/lib/api-query-options/delivery";
import { RouteErrorComponent } from "~/lib/route-error";
import { translate, useMessages } from "~/i18n";
import { settingsNavMessages } from "~/i18n/settings";
import { shippingMessages } from "~/i18n/settings-shipping";

export const Route = createFileRoute("/admin/settings/shipping_/areas")({
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(deliveryLocationsQueryOptions({ type: "city", page: 1, limit: 20 })).catch(() => undefined),
  head: () => ({ meta: [{ title: `${translate(shippingMessages, "areasPageTitle")} | Scalius Admin` }] }),
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
