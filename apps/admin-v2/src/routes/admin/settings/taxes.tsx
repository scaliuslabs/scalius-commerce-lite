import { createFileRoute, redirect, useLocation } from "@tanstack/react-router";

import {
  TaxCollectionCard,
  TaxGroupsCard,
  TaxOverridesCard,
  TaxRegionsCard,
} from "~/components/admin/taxes/TaxesSettings";
import { useQuery } from "@tanstack/react-query";
import { SettingsAdvanced } from "~/components/admin/settings/SettingsAdvanced";
import { SettingsPage } from "~/components/admin/settings/SettingsPage";
import { TaxRegionPage } from "~/components/admin/taxes/TaxRegionPage";
import { settingsHead } from "~/components/admin/settings/settings-nav";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { taxesMessages } from "~/i18n/settings-taxes";
import {
  firstTaxOverridesQuery,
  taxConfigurationQueryOptions,
  taxRegionQueryOptions,
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

// `?region=<id>`: one country's tax page (its service, rates and regions),
// on this route so the dashboard keeps one Taxes screen.
export const Route = createFileRoute("/admin/settings/taxes")({
  validateSearch: (search: Record<string, unknown>): { region?: string } =>
    typeof search.region === "string" && search.region ? { region: search.region } : {},
  beforeLoad: requireFreshTaxesRouteAuthority,
  loaderDeps: ({ search }) => ({ region: search.region }),
  loader: ({ context: { queryClient }, deps: { region } }) =>
    Promise.allSettled([
      queryClient.ensureQueryData(taxConfigurationQueryOptions()),
      ...(region
        ? [queryClient.ensureQueryData(taxRegionQueryOptions(region))]
        : [queryClient.ensureQueryData(taxSettingsQueryOptions()), queryClient.ensureQueryData(firstTaxOverridesQuery)]),
    ]),
  head: () => settingsHead("taxes"),
  errorComponent: RouteErrorComponent,
  component: TaxesPage,
});

function TaxesPage() {
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.TAXES_MANAGE);
  const t = useMessages(taxesMessages);
  const { region } = Route.useSearch();
  // Tax groups beyond one, and any product override, are for stores that already use them.
  const config = useQuery(taxConfigurationQueryOptions()).data;
  const hash = useLocation({ select: (location) => location.hash });
  // A fresh page per country: switching countries never carries a draft over.
  if (region) return <TaxRegionPage key={region} regionId={region} />;
  return (
    <SettingsPage page="taxes" readOnly={!canEdit}>
      <TaxCollectionCard />
      <TaxRegionsCard />
      <SettingsAdvanced
        label={t("advancedTitle")}
        defaultOpen={(config?.classes.length ?? 0) > 1}
        forceOpen={hash === "taxGroups" || hash === "taxOverrides"}
      >
        <TaxGroupsCard />
        <TaxOverridesCard />
      </SettingsAdvanced>
    </SettingsPage>
  );
}
