import { createFileRoute } from "@tanstack/react-router";
import { AiAccessCard } from "~/components/admin/agent-access/AiAccessCard";
import { AppKindCard } from "~/components/admin/settings/AppKindCard";
import { AiDraftingCard } from "~/components/admin/agent-access/AiDraftingCard";
import {
  FacebookCard,
  FraudCheckCard,
  ScannerCard,
  TrackingCard,
} from "~/components/admin/settings/AppsSettings";
import { AppProviderSheetHost } from "~/components/admin/apps/AppProviderSheetHost";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { usePermissions } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { fraudCheckerProvidersQueryOptions } from "~/lib/api-query-options/fraud-checker";
import { aiAccessQuery, appProvidersQuery, metaQuery, trackingQuery } from "~/lib/api-query-options/settings-screens";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/integrations")({
  // Cards hide themselves for roles that can't view them; a refused read is fine here.
  loader: ({ context: { queryClient } }) =>
    Promise.allSettled([
      queryClient.ensureQueryData(trackingQuery),
      queryClient.ensureQueryData(metaQuery),
      queryClient.ensureQueryData(fraudCheckerProvidersQueryOptions()),
      queryClient.ensureQueryData(appProvidersQuery("fraud")),
      queryClient.ensureQueryData(aiAccessQuery),
      queryClient.ensureQueryData(appProvidersQuery("ai")),
      queryClient.ensureQueryData(appProvidersQuery("search")),
    ]),
  head: () => settingsHead("integrations"),
  errorComponent: RouteErrorComponent,
  component: IntegrationsPage,
});

const EDIT_PERMISSIONS = [
  ADMIN_PERMISSIONS.ANALYTICS_CREATE,
  ADMIN_PERMISSIONS.ANALYTICS_EDIT,
  ADMIN_PERMISSIONS.ANALYTICS_TOGGLE,
  ADMIN_PERMISSIONS.SETTINGS_FRAUD_CHECKER_EDIT,
  ADMIN_PERMISSIONS.PRODUCTS_EDIT,
  ADMIN_PERMISSIONS.AGENT_ACCESS_MANAGE,
];

function IntegrationsPage() {
  const { hasPermission } = usePermissions();
  return (
    <AppProviderSheetHost>
      <SettingsPage page="integrations" readOnly={!EDIT_PERMISSIONS.some(hasPermission)}>
        <TrackingCard />
        <FacebookCard />
        <FraudCheckCard />
        <ScannerCard />
        <AiAccessCard />
        <AiDraftingCard />
        <AppKindCard kind="search" />
      </SettingsPage>
    </AppProviderSheetHost>
  );
}
