import { createFileRoute } from "@tanstack/react-router";
import { DeliveryProviderSettings } from "~/components/admin/delivery-providers";
import { getDeliveryProviders } from "~/lib/api.functions";

export const Route = createFileRoute("/admin/settings/delivery-providers")({
  loader: async () => {
    const result = await getDeliveryProviders().catch(() => []);
    const providers = (Array.isArray(result) ? result : []) as any[];
    return { providers, apiBaseUrl: "" };
  },
  head: () => ({ meta: [{ title: "Delivery Providers | Scalius Admin" }] }),
  component: DeliveryProvidersPage,
});

function DeliveryProvidersPage() {
  const { providers, apiBaseUrl } = Route.useLoaderData();

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Delivery Providers</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure and manage delivery service integrations.
        </p>
      </div>
      <DeliveryProviderSettings providers={providers} apiBaseUrl={apiBaseUrl} />
    </div>
  );
}
