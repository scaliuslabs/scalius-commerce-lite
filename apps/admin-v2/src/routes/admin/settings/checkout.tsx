import { createFileRoute } from "@tanstack/react-router";
import CheckoutSettingsPage from "~/components/admin/settings/CheckoutSettingsPage";
import { authSettingsQueryOptions } from "~/lib/api-query-options/settings";
import { RouteErrorComponent } from "~/lib/list-helpers";

export const Route = createFileRoute("/admin/settings/checkout")({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(authSettingsQueryOptions());
  },
  head: () => ({ meta: [{ title: "Checkout Settings | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: CheckoutPage,
});

function CheckoutPage() {
  return <CheckoutSettingsPage />;
}
