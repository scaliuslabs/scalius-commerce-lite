import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { PluginSurface } from "~/components/admin/apps/ui/PluginSurface";
import { SurfaceLoadError, SurfaceSkeleton } from "~/components/admin/apps/ui/surface-states";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { translate, useMessages } from "~/i18n";
import { appUiMessages } from "~/i18n/app-ui";
import { shellMessages } from "~/i18n/shell";
import { titleHead } from "~/i18n/page-titles";
import { appSurfacesQueryOptions } from "~/lib/api-query-options/apps";
import { RouteErrorComponent } from "~/lib/route-error";

const QUERY_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * An app page's query (from an app-page link) passes through to the app's
 * route: plain strings only, the same bounds the UI schema allows.
 */
function appPageQuery(search: Record<string, unknown>): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(search)) {
    if (Object.keys(query).length >= 20) break;
    if (!QUERY_KEY.test(key) || key === "cursor") continue;
    if (typeof value === "string" && value.length <= 512) query[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) query[key] = String(value);
  }
  return query;
}

export const Route = createFileRoute("/admin/apps/$pluginId_/pages/$pageId")({
  // Typed as an opaque object: an index-signature search type here would
  // narrow every string-addressed navigation's search in the dashboard to
  // `never`. At runtime it is the sanitized query (`appPageQuery`).
  validateSearch: (search: Record<string, unknown>): object => appPageQuery(search),
  loader: async ({ context: { queryClient }, params }) => {
    const { appSurfacesQueryOptions: options } = await import("~/lib/api-query-options/apps");
    const apps = await queryClient.ensureQueryData(options()).catch(() => null);
    const page = apps?.find((app) => app.id === params.pluginId)?.pages.find((entry) => entry.id === params.pageId);
    return { title: page?.title ?? null };
  },
  head: ({ loaderData }) => titleHead(loaderData?.title ?? translate(shellMessages, "apps")),
  errorComponent: RouteErrorComponent,
  component: AppPageRoute,
});

function Unavailable() {
  const t = useMessages(appUiMessages);
  return (
    <>
      <PageHeader title={t("pageUnavailableTitle")} />
      <Card>
        <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
          <p className="text-body text-muted-foreground">{t("pageUnavailableBody")}</p>
          <div className="pt-3">
            <Button variant="outline" asChild>
              <Link to="/admin/apps">{t("backToApps")}</Link>
            </Button>
          </div>
        </div>
      </Card>
    </>
  );
}

function AppPageRoute() {
  const { pluginId, pageId } = Route.useParams();
  const rawSearch = Route.useSearch();
  const search = useMemo(() => appPageQuery(rawSearch as Record<string, unknown>), [rawSearch]);
  const surfaces = useQuery(appSurfacesQueryOptions());
  if (surfaces.isPending) return <SurfaceSkeleton variant="page" />;
  if (surfaces.isError) {
    return (
      <>
        <PageHeader title={translate(shellMessages, "apps")} />
        <SurfaceLoadError message={translate(appUiMessages, "loadFailedBody")} retrying={surfaces.isFetching} onRetry={() => void surfaces.refetch()} />
      </>
    );
  }
  const app = surfaces.data.find((entry) => entry.id === pluginId);
  const page = app?.pages.find((entry) => entry.id === pageId);
  if (!app || !page) return <Unavailable />;
  return (
    <PluginSurface
      // Another page, or another link query, starts again from the first table page.
      key={`${pluginId}:${pageId}:${JSON.stringify(search)}`}
      app={app}
      route={page.route}
      query={search}
      variant="page"
      title={page.title}
    />
  );
}
