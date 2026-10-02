import { createFileRoute } from "@tanstack/react-router";
import { AiAccessCard } from "~/components/admin/agent-access/AiAccessCard";
import {
  FacebookCard,
  FraudCheckCard,
  ScannerCard,
  TrackingCard,
} from "~/components/admin/settings/AppsSettings";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { usePermissions } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { fraudCheckerProvidersQueryOptions } from "~/lib/api-query-options/fraud-checker";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/integrations")({
  // Cards hide themselves for roles that can't view them; a refused read is fine here.
  // The screen's query module comes with its own code, not the dashboard's first download.
  loader: async ({ context: { queryClient } }) => {
    const screens = await import("~/lib/api-query-options/settings-screens");
    return Promise.allSettled([
      queryClient.ensureQueryData(screens.trackingQuery),
      queryClient.ensureQueryData(screens.metaQuery),
      queryClient.ensureQueryData(fraudCheckerProvidersQueryOptions()),
      queryClient.ensureQueryData(screens.aiAccessQuery),
    ]);
  },
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
    <SettingsPage page="integrations" readOnly={!EDIT_PERMISSIONS.some(hasPermission)}>
      <TrackingCard />
      <FacebookCard />
      <FraudCheckCard />
      <ScannerCard />
      <AiAccessCard />
    </SettingsPage>
  );
}
