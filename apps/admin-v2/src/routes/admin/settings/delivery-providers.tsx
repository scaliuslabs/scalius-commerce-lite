import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { DeliveryProviderSettings } from "~/components/admin/delivery-providers";
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
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Delivery Providers</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure and manage delivery service integrations.
        </p>
      </div>
      <DeliveryProviderSettings providers={providers} apiBaseUrl="" />
    </div>
  );
}
