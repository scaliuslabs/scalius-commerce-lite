import { createFileRoute } from "@tanstack/react-router";
import { CustomerSignInCard, signInPolicyQuery } from "~/components/admin/settings/CustomerSignInCard";
import { customerRulesQuery } from "~/components/admin/settings/NotificationSettings";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/customer-accounts")({
  loader: ({ context: { queryClient } }) =>
    Promise.allSettled([
      queryClient.ensureQueryData(signInPolicyQuery),
      queryClient.ensureQueryData(customerRulesQuery),
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
    </SettingsPage>
  );
}
