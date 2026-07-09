import { createFileRoute } from "@tanstack/react-router";

import { TaxSettingsPage } from "~/components/admin/taxes";
import { taxConfigurationQueryOptions } from "~/lib/api-query-options/taxes";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/taxes")({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(taxConfigurationQueryOptions());
  },
  head: () => ({ meta: [{ title: "Taxes | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: TaxSettingsPage,
});
