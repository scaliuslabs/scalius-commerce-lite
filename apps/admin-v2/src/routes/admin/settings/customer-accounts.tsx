import { createFileRoute } from "@tanstack/react-router";
import { CustomerSignInCard } from "~/components/admin/settings/CustomerSignInCard";
import { MarketingConsentCard } from "~/components/admin/settings/MarketingConsentCard";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/customer-accounts")({
  // The screen's query module comes with its own code, not the dashboard's first download.
  loader: async ({ context: { queryClient } }) => {
    const screens = await import("~/lib/api-query-options/settings-screens");
    return Promise.allSettled([
      queryClient.ensureQueryData(screens.signInPolicyQuery),
      queryClient.ensureQueryData(screens.customerRulesQuery),
      queryClient.ensureQueryData(screens.marketingConsentQuery),
    ]);
  },
  head: () => settingsHead("customerAccounts"),
  errorComponent: RouteErrorComponent,
  component: CustomerAccountsPage,
});

function CustomerAccountsPage() {
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  return (
    <SettingsPage page="customerAccounts" readOnly={!canEdit}>
      <CustomerSignInCard />
      <MarketingConsentCard />
    </SettingsPage>
  );
}
