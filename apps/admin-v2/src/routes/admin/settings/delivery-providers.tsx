import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { DeliveryProviderSettings } from "~/components/admin/delivery-providers";
import { SettingsLayout } from "~/components/admin/settings/SettingsLayout";
import { deliveryProvidersQueryOptions } from "~/lib/api-query-options/delivery";
import type { DeliveryProviderRecord } from "~/types/api-responses";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/delivery-providers")({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(deliveryProvidersQueryOptions());
  },
  head: () => ({ meta: [{ title: "Delivery Providers | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: DeliveryProvidersPage,
});

function DeliveryProvidersPage() {
  const { data } = useSuspenseQuery(deliveryProvidersQueryOptions());
  const providers = (Array.isArray(data) ? data : []) as DeliveryProviderRecord[];

  return (
    <SettingsLayout
      pathname="/admin/settings/delivery-providers"
      title="Delivery providers"
      description="Couriers that can receive shipments from this store."
    >
      <DeliveryProviderSettings providers={providers} apiBaseUrl="" />
    </SettingsLayout>
  );
}
