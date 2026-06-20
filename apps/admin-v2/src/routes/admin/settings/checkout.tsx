import { createFileRoute } from "@tanstack/react-router";
import CheckoutSettingsPage from "~/components/admin/settings/CheckoutSettingsPage";
import { checkoutFlowSettingsQueryOptions } from "~/lib/api-query-options/settings";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/checkout")({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(checkoutFlowSettingsQueryOptions());
  },
  head: () => ({ meta: [{ title: "Checkout Settings | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: CheckoutPage,
});

function CheckoutPage() {
  return <CheckoutSettingsPage />;
}
