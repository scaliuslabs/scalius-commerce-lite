import { createFileRoute } from "@tanstack/react-router";
import { AiAccessCard, aiAccessQuery } from "~/components/admin/agent-access/AiAccessCard";
import {
  FacebookCard,
  FraudCheckCard,
  ScannerCard,
  TrackingCard,
  metaQuery,
  trackingQuery,
} from "~/components/admin/settings/AppsSettings";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { usePermissions } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { fraudCheckerProvidersQueryOptions } from "~/lib/api-query-options/fraud-checker";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/apps")({
  // Cards hide themselves for roles that can't view them; a refused read is fine here.
  loader: ({ context: { queryClient } }) =>
    Promise.allSettled([
      queryClient.ensureQueryData(trackingQuery),
      queryClient.ensureQueryData(metaQuery),
      queryClient.ensureQueryData(fraudCheckerProvidersQueryOptions()),
      queryClient.ensureQueryData(aiAccessQuery),
    ]),
  head: () => settingsHead("apps"),
  errorComponent: RouteErrorComponent,
  component: AppsPage,
});

const EDIT_PERMISSIONS = [
  ADMIN_PERMISSIONS.ANALYTICS_CREATE,
  ADMIN_PERMISSIONS.ANALYTICS_EDIT,
  ADMIN_PERMISSIONS.ANALYTICS_TOGGLE,
  ADMIN_PERMISSIONS.SETTINGS_FRAUD_CHECKER_EDIT,
  ADMIN_PERMISSIONS.PRODUCTS_EDIT,
  ADMIN_PERMISSIONS.AGENT_ACCESS_MANAGE,
];

function AppsPage() {
  const { hasPermission } = usePermissions();
  return (
    <SettingsPage page="apps" readOnly={!EDIT_PERMISSIONS.some(hasPermission)}>
      <TrackingCard />
      <FacebookCard />
      <FraudCheckCard />
      <ScannerCard />
      <AiAccessCard />
    </SettingsPage>
  );
}
