import { createFileRoute } from "@tanstack/react-router";
import {
  PaymentMethodsCard,
  PaymentOptionsCard,
} from "~/components/admin/settings/PaymentsSettings";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import {
  checkoutFlowQuery,
  currencyQuery,
  gatewayQuery,
  paymentMethodsQuery,
  platformQuery,
} from "~/lib/api-query-options/settings-screens";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/payments")({
  loader: ({ context: { queryClient } }) =>
    Promise.allSettled([
      queryClient.ensureQueryData(paymentMethodsQuery),
      queryClient.ensureQueryData(checkoutFlowQuery),
      queryClient.ensureQueryData(currencyQuery),
      queryClient.ensureQueryData(platformQuery),
      queryClient.ensureQueryData(gatewayQuery("sslcommerz")),
      queryClient.ensureQueryData(gatewayQuery("stripe")),
    ]),
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
    </SettingsPage>
  );
}
