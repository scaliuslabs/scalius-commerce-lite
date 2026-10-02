import { createFileRoute } from "@tanstack/react-router";

import { AppsList } from "~/components/admin/apps/AppsList";
import { translate } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
import { titleHead } from "~/i18n/page-titles";
import { RouteErrorComponent } from "~/lib/route-error";
import { warmRouteQuery } from "~/lib/route-query-warming";

export const Route = createFileRoute("/admin/apps/")({
  // The read's module comes with the page's own code, not the dashboard's first download.
  loader: async ({ context: { queryClient } }) => {
    const { appsQueryOptions } = await import("~/lib/api-query-options/apps");
    return warmRouteQuery(queryClient, appsQueryOptions());
  },
  head: () => titleHead(translate(shellMessages, "apps")),
  errorComponent: RouteErrorComponent,
  component: AppsList,
});
