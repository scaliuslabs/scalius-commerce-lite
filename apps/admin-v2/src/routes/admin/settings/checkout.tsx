import { createFileRoute } from "@tanstack/react-router";
import {
  CheckoutTextCard,
  CustomerContactCard,
  CustomerRequestsCard,
} from "~/components/admin/settings/CheckoutSettings";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/checkout")({
  // The screen's query module comes with its own code, not the dashboard's first download.
  loader: async ({ context: { queryClient } }) => {
    const screens = await import("~/lib/api-query-options/settings-screens");
    return Promise.allSettled([
      queryClient.ensureQueryData(screens.checkoutFlowQuery),
      queryClient.ensureQueryData(screens.checkoutReadinessQuery),
      queryClient.ensureQueryData(screens.languagesQuery),
      queryClient.ensureQueryData(screens.customerRequestsQuery),
    ]);
  },
  head: () => settingsHead("checkout"),
  errorComponent: RouteErrorComponent,
  component: CheckoutPage,
});

function CheckoutPage() {
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  return (
    <SettingsPage page="checkout" readOnly={!canEdit}>
      <CustomerContactCard />
      <CheckoutTextCard />
      <CustomerRequestsCard />
    </SettingsPage>
  );
}
