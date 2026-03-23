import { createFileRoute } from "@tanstack/react-router";
import CheckoutSettingsPage from "~/components/admin/settings/CheckoutSettingsPage";
import { authSettingsQueryOptions, paymentMethodsQueryOptions, shippingMethodsQueryOptions } from "~/lib/api.queries";

export const Route = createFileRoute("/admin/settings/checkout")({
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData(authSettingsQueryOptions()),
      queryClient.ensureQueryData(paymentMethodsQueryOptions()),
      queryClient.ensureQueryData(shippingMethodsQueryOptions({ page: 1, limit: 50 })),
    ]);
  },
  head: () => ({ meta: [{ title: "Checkout Settings | Scalius Admin" }] }),
  component: CheckoutPage,
});

function CheckoutPage() {
  return <CheckoutSettingsPage />;
}
