import { createFileRoute } from "@tanstack/react-router";
import CheckoutSettingsPage from "~/components/admin/settings/CheckoutSettingsPage";
import { authSettingsQueryOptions, paymentMethodsQueryOptions, shippingMethodsQueryOptions } from "~/lib/api.queries";
import { RouteErrorComponent } from "~/lib/list-helpers";

export const Route = createFileRoute("/admin/settings/checkout")({
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData(authSettingsQueryOptions()),
      queryClient.ensureQueryData(paymentMethodsQueryOptions()),
      queryClient.ensureQueryData(shippingMethodsQueryOptions({ page: 1, limit: 50 })),
    ]);
  },
  head: () => ({ meta: [{ title: "Checkout Settings | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: CheckoutPage,
});

function CheckoutPage() {
  return <CheckoutSettingsPage />;
}
