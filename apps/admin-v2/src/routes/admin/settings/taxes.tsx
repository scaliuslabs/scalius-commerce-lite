import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { TaxSettingsPage } from "~/components/admin/taxes";
import {
  normalizeTaxWorkspaceSection,
  type TaxWorkspaceSection,
} from "~/components/admin/taxes/tax-workspace-sections";
import { taxConfigurationQueryOptions } from "~/lib/api-query-options/taxes";
import {
  ADMIN_ACCESS_DENIED_PATH,
  canAccessAdminPath,
} from "~/lib/admin-access";
import { getFreshAdminRouteContext } from "~/lib/admin-route-context";
import { RouteErrorComponent } from "~/lib/route-error";

export async function requireFreshTaxesRouteAuthority() {
  const context = await getFreshAdminRouteContext();
  if (!canAccessAdminPath("/admin/settings/taxes", context)) {
    throw redirect({ to: ADMIN_ACCESS_DENIED_PATH, replace: true });
  }
  return context;
}

export function validateTaxesSearch(search: Record<string, unknown>) {
  return { section: normalizeTaxWorkspaceSection(search.section) };
}

export const Route = createFileRoute("/admin/settings/taxes")({
  validateSearch: validateTaxesSearch,
  beforeLoad: requireFreshTaxesRouteAuthority,
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(taxConfigurationQueryOptions());
  },
  head: () => ({ meta: [{ title: "Taxes | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: TaxesPage,
});

function TaxesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const handleSectionChange = useCallback(
    (section: TaxWorkspaceSection) => {
      void navigate({
        search: ((previous: Record<string, unknown>) => ({
          ...previous,
          section,
        })) as never,
      });
    },
    [navigate],
  );

  return (
    <TaxSettingsPage
      section={search.section}
      onSectionChange={handleSectionChange}
    />
  );
}
