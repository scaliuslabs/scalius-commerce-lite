import { createFileRoute, redirect } from "@tanstack/react-router";

import { TaxSettingsPage } from "~/components/admin/taxes";
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

export const Route = createFileRoute("/admin/settings/taxes")({
  beforeLoad: requireFreshTaxesRouteAuthority,
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(taxConfigurationQueryOptions());
  },
  head: () => ({ meta: [{ title: "Taxes | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: TaxSettingsPage,
});
