import { createFileRoute } from "@tanstack/react-router";
import CheckoutSettingsPage from "~/components/admin/settings/CheckoutSettingsPage";

export const Route = createFileRoute("/admin/settings/checkout")({
  head: () => ({ meta: [{ title: "Checkout Settings | Scalius Admin" }] }),
  component: CheckoutPage,
});

function CheckoutPage() {
  return <CheckoutSettingsPage />;
}
