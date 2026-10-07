import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { AppDetailPage } from "~/components/admin/apps/AppDetailPage";
import type { AppPageTab } from "~/components/admin/apps/app-page-tabs";
import { translate } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
import { titleHead } from "~/i18n/page-titles";
import { appQueryOptions } from "~/lib/api-query-options/apps";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/apps/$pluginId")({
  // Overview is the page itself; Settings and Permissions have their own address.
  // (Inline: the route's search check is part of every first download.)
  validateSearch: (search: Record<string, unknown>): { tab?: AppPageTab } =>
    (search.tab === "settings" || search.tab === "permissions" ? { tab: search.tab } : {}),
  loader: ({ context: { queryClient }, params }) => queryClient.ensureQueryData(appQueryOptions(params.pluginId)),
  head: ({ loaderData }) => titleHead(loaderData?.name ?? translate(shellMessages, "apps")),
  errorComponent: RouteErrorComponent,
  component: AppRoute,
});

function AppRoute() {
  const { pluginId } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data } = useSuspenseQuery(appQueryOptions(pluginId));
  return (
    <AppDetailPage
      key={data.id}
      app={data}
      tab={tab}
      onTab={(next) => void navigate({ search: next === "overview" ? {} : { tab: next }, replace: true })}
    />
  );
}
