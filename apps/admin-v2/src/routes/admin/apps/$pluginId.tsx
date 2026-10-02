import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { AppDetailPage } from "~/components/admin/apps/AppDetailPage";
import { translate } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
import { titleHead } from "~/i18n/page-titles";
import { appQueryOptions } from "~/lib/api-query-options/apps";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/apps/$pluginId")({
  // The read's module comes with the page's own code, not the dashboard's first download.
  loader: async ({ context: { queryClient }, params }) => {
    const { appQueryOptions: options } = await import("~/lib/api-query-options/apps");
    return queryClient.ensureQueryData(options(params.pluginId));
  },
  head: ({ loaderData }) => titleHead(loaderData?.name ?? translate(shellMessages, "apps")),
  errorComponent: RouteErrorComponent,
  component: AppRoute,
});

function AppRoute() {
  const { pluginId } = Route.useParams();
  const { data } = useSuspenseQuery(appQueryOptions(pluginId));
  return <AppDetailPage key={data.id} app={data} />;
}
