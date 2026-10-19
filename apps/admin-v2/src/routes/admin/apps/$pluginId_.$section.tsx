import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";

import { AppDetailPage } from "~/components/admin/apps/AppDetailPage";
import { appSectionPath, resolveAppSection, usesSections } from "~/components/admin/apps/app-sections";
import { translate } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
import { titleHead } from "~/i18n/page-titles";
import { appQueryOptions } from "~/lib/api-query-options/apps";
import { RouteErrorComponent } from "~/lib/route-error";

/**
 * One section of an app's page: a feature, its own Settings or its Activity.
 * A capability page links here by provider id ("Set up bKash" is
 * `/admin/apps/scalius.bangladesh/bkash`); a segment that names no section
 * of this app goes to the right one, else to the app's overview.
 */
export const Route = createFileRoute("/admin/apps/$pluginId_/$section")({
  loader: ({ context: { queryClient }, params }) => queryClient.ensureQueryData(appQueryOptions(params.pluginId)),
  head: ({ loaderData }) => titleHead(loaderData?.name ?? translate(shellMessages, "apps")),
  errorComponent: RouteErrorComponent,
  component: AppSectionRoute,
});

function AppSectionRoute() {
  const { pluginId, section } = Route.useParams();
  const { data } = useSuspenseQuery(appQueryOptions(pluginId));
  const resolved = usesSections(data) ? resolveAppSection(data, section) : null;
  if (!resolved || resolved.key !== section || resolved.kind === "overview") {
    return <Navigate to={appSectionPath(data.id, resolved?.key ?? "overview")} replace />;
  }
  return <AppDetailPage key={data.id} app={data} sectionKey={section} />;
}
