import { createFileRoute } from "@tanstack/react-router";

import { AppsList } from "~/components/admin/apps/AppsList";
import { translate } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
import { titleHead } from "~/i18n/page-titles";
import { appsQueryOptions } from "~/lib/api-query-options/apps";
import { RouteErrorComponent } from "~/lib/route-error";
import { warmRouteQuery } from "~/lib/route-query-warming";

export const Route = createFileRoute("/admin/apps/")({
  loader: ({ context: { queryClient } }) => warmRouteQuery(queryClient, appsQueryOptions()),
  head: () => titleHead(translate(shellMessages, "apps")),
  errorComponent: RouteErrorComponent,
  component: AppsList,
});
