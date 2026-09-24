import { createFileRoute, redirect } from "@tanstack/react-router";

import {
  TaxCollectionCard,
  TaxGroupsCard,
  TaxOverridesCard,
  TaxRatesCard,
} from "~/components/admin/taxes/TaxesSettings";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { useHasPermission } from "~/contexts/PermissionContext";
import {
  firstTaxOverridesQuery,
  taxConfigurationQueryOptions,
  taxSettingsQueryOptions,
} from "~/lib/api-query-options/taxes";
import {
  ADMIN_ACCESS_DENIED_PATH,
  canAccessAdminPath,
} from "~/lib/admin-access";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { getFreshAdminRouteContext } from "~/lib/admin-route-context";
import { RouteErrorComponent } from "~/lib/route-error";

/** Re-reads the viewer's permissions so a revoked tax viewer never loads tax data. */
export async function requireFreshTaxesRouteAuthority() {
  const context = await getFreshAdminRouteContext();
  if (!canAccessAdminPath("/admin/settings/taxes", context)) {
    throw redirect({ to: ADMIN_ACCESS_DENIED_PATH, replace: true });
  }
  return context;
}

export const Route = createFileRoute("/admin/settings/taxes")({
  beforeLoad: requireFreshTaxesRouteAuthority,
  loader: ({ context: { queryClient } }) =>
    Promise.allSettled([
      queryClient.ensureQueryData(taxConfigurationQueryOptions()),
      queryClient.ensureQueryData(taxSettingsQueryOptions()),
      queryClient.ensureQueryData(firstTaxOverridesQuery),
    ]),
  head: () => settingsHead("taxes"),
  errorComponent: RouteErrorComponent,
  component: TaxesPage,
});

function TaxesPage() {
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.TAXES_MANAGE);
  return (
    <SettingsPage page="taxes" readOnly={!canEdit}>
      <TaxCollectionCard />
      <TaxGroupsCard />
      <TaxRatesCard />
      <TaxOverridesCard />
    </SettingsPage>
  );
}
