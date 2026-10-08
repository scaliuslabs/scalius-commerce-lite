import { createFileRoute } from "@tanstack/react-router";
import {
  CheckoutTextCard,
  CustomerContactCard,
  CustomerRequestsCard,
} from "~/components/admin/settings/CheckoutSettings";
import { AppProviderSheetHost } from "~/components/admin/apps/AppProviderSheetHost";
import { AppKindCard } from "~/components/admin/settings/AppKindCard";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import {
  appProvidersQuery,
  checkoutFlowQuery,
  checkoutReadinessQuery,
  customerRequestsQuery,
  languagesQuery,
} from "~/lib/api-query-options/settings-screens";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/checkout")({
  loader: ({ context: { queryClient } }) =>
    Promise.allSettled([
      queryClient.ensureQueryData(checkoutFlowQuery),
      queryClient.ensureQueryData(checkoutReadinessQuery),
      queryClient.ensureQueryData(languagesQuery),
      queryClient.ensureQueryData(customerRequestsQuery),
      queryClient.ensureQueryData(appProvidersQuery("address")),
    ]),
  head: () => settingsHead("checkout"),
  errorComponent: RouteErrorComponent,
  component: CheckoutPage,
});

function CheckoutPage() {
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  return (
    <AppProviderSheetHost>
      <SettingsPage page="checkout" readOnly={!canEdit}>
        <CustomerContactCard />
        <CheckoutTextCard />
        <CustomerRequestsCard />
        <AppKindCard kind="address" />
      </SettingsPage>
    </AppProviderSheetHost>
  );
}
