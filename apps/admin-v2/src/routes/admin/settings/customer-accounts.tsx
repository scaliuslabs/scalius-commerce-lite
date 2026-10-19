import { createFileRoute } from "@tanstack/react-router";
import { CustomerSignInCard } from "~/components/admin/settings/CustomerSignInCard";
import { AppKindCard } from "~/components/admin/settings/AppKindCard";
import { MarketingConsentCard } from "~/components/admin/settings/MarketingConsentCard";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { appProvidersQuery, customerRulesQuery, marketingConsentQuery, signInPolicyQuery } from "~/lib/api-query-options/settings-screens";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/customer-accounts")({
  loader: ({ context: { queryClient } }) =>
    Promise.allSettled([
      queryClient.ensureQueryData(signInPolicyQuery),
      queryClient.ensureQueryData(customerRulesQuery),
      queryClient.ensureQueryData(marketingConsentQuery),
      queryClient.ensureQueryData(appProvidersQuery("identity")),
    ]),
  head: () => settingsHead("customerAccounts"),
  errorComponent: RouteErrorComponent,
  component: CustomerAccountsPage,
});

function CustomerAccountsPage() {
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  return (
    <SettingsPage page="customerAccounts" readOnly={!canEdit}>
      <CustomerSignInCard />
      <AppKindCard kind="identity" />
      <MarketingConsentCard />
    </SettingsPage>
  );
}
