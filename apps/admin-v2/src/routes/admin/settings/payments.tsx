import { createFileRoute } from "@tanstack/react-router";
import {
  PaymentMethodsCard,
  PaymentOptionsCard,
} from "~/components/admin/settings/PaymentsSettings";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { EmiPlansCard } from "~/components/admin/settings/EmiPlansCard";
import { emiSettingsQuery } from "~/lib/api-query-options/emi";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/payments")({
  // The screen's query module comes with its own code, not the dashboard's first download.
  loader: async ({ context: { queryClient } }) => {
    const screens = await import("~/lib/api-query-options/settings-screens");
    return Promise.allSettled([
      queryClient.ensureQueryData(screens.paymentMethodsQuery),
      queryClient.ensureQueryData(screens.checkoutFlowQuery),
      queryClient.ensureQueryData(screens.currencyQuery),
      queryClient.ensureQueryData(screens.platformQuery),
      queryClient.ensureQueryData(screens.gatewayQuery("sslcommerz")),
      queryClient.ensureQueryData(screens.gatewayQuery("stripe")),
      queryClient.ensureQueryData(emiSettingsQuery),
    ]);
  },
  head: () => settingsHead("payments"),
  errorComponent: RouteErrorComponent,
  component: PaymentsPage,
});

function PaymentsPage() {
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  return (
    <SettingsPage page="payments" readOnly={!canEdit}>
      <PaymentMethodsCard />
      <PaymentOptionsCard />
      <EmiPlansCard />
    </SettingsPage>
  );
}
