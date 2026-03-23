import { createFileRoute } from "@tanstack/react-router";
import CheckoutSettingsPage from "~/components/admin/settings/CheckoutSettingsPage";
import { authSettingsQueryOptions, paymentMethodsQueryOptions, shippingMethodsQueryOptions } from "~/lib/api.queries";

export const Route = createFileRoute("/admin/settings/checkout")({
  loader: async ({ context: { queryClient } }) => {
    // Prefetch data for the default "Checkout Flow" tab (authSettings)
    // and payment methods/shipping methods for other tabs
    void queryClient.prefetchQuery(authSettingsQueryOptions());
    void queryClient.prefetchQuery(paymentMethodsQueryOptions());
    void queryClient.prefetchQuery(shippingMethodsQueryOptions({ page: 1, limit: 50 }));
  },
  head: () => ({ meta: [{ title: "Checkout Settings | Scalius Admin" }] }),
  component: CheckoutPage,
});

function CheckoutPage() {
  return <CheckoutSettingsPage />;
}
