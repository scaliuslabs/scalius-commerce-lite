import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { localizedAppPage } from "~/components/admin/apps/app-detail-text";
import { localizedSurfaces } from "~/components/admin/apps/app-text";
import { PluginSurface } from "~/components/admin/apps/ui/PluginSurface";
import type { AppSurfaces } from "~/components/admin/apps/ui/surfaces";
import { ProvidedByChip } from "~/components/admin/apps/ProvidedByChip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { SurfaceLoadError, SurfaceSkeleton } from "~/components/admin/apps/ui/surface-states";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { translate, useLocale, useMessages } from "~/i18n";
import { appSurfacesMessages } from "~/i18n/app-surfaces";
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
    const apps = await queryClient.ensureQueryData(appSurfacesQueryOptions()).catch(() => null);
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

type Surfaces = AppSurfaces;
type Page = Surfaces["pages"][number];

/**
 * An app page with tabs (Polaris Tabs under the page title): each tab is its
 * own admin route, chosen by `?tab=`; the first opens by default. The app's
 * tab document draws below; its own title gives way to the page's.
 */
function TabbedAppPage({ app, page, tabs, search }: { app: Surfaces; page: Page; tabs: NonNullable<Page["tabs"]>; search: Record<string, string> }) {
  const t = useMessages(appSurfacesMessages);
  const navigate = Route.useNavigate();
  const { tab: requested, ...query } = search;
  const active = tabs.find((tab) => tab.id === requested) ?? tabs[0]!;
  return (
    <>
      <PageHeader title={page.title} status={<ProvidedByChip pluginId={app.id} appName={app.name} />} />
      <Tabs
        value={active.id}
        onValueChange={(next) => void navigate({ search: (next === tabs[0]!.id ? {} : { tab: next }) as never, replace: true })}
      >
        <TabsList aria-label={t("tabsLabel")}>
          {tabs.map((tab) => <TabsTrigger key={tab.id} value={tab.id}>{tab.title}</TabsTrigger>)}
        </TabsList>
        <TabsContent value={active.id}>
          <PluginSurface
            // Another tab, or another link query, starts again from the first table page.
            key={`${app.id}:${page.id}:${active.id}:${JSON.stringify(query)}`}
            app={app}
            route={active.route}
            query={query}
            variant="tab"
            title={active.title}
          />
        </TabsContent>
      </Tabs>
    </>
  );
}

function AppPageRoute() {
  const { pluginId, pageId } = Route.useParams();
  const rawSearch = Route.useSearch();
  const search = useMemo(() => appPageQuery(rawSearch as Record<string, unknown>), [rawSearch]);
  const surfaces = useQuery(appSurfacesQueryOptions());
  const locale = useLocale();
  if (surfaces.isPending) return <SurfaceSkeleton variant="page" />;
  if (surfaces.isError) {
    return (
      <>
        <PageHeader title={translate(shellMessages, "apps")} />
        <SurfaceLoadError message={translate(appUiMessages, "loadFailedBody")} retrying={surfaces.isFetching} onRetry={() => void surfaces.refetch()} />
      </>
    );
  }
  const found = surfaces.data.find((entry) => entry.id === pluginId);
  // Titles and tab names in the dashboard's language.
  const app = found ? localizedSurfaces(found, locale) : undefined;
  const raw = found?.pages.find((entry) => entry.id === pageId);
  const page = found && raw ? localizedAppPage(found, raw, locale) : undefined;
  if (!app || !page) return <Unavailable />;
  if (page.tabs) return <TabbedAppPage app={app} page={page} tabs={page.tabs} search={search} />;
  return (
    <PluginSurface
      // Another page, or another link query, starts again from the first table page.
      key={`${pluginId}:${pageId}:${JSON.stringify(search)}`}
      app={app}
      route={page.route}
      query={search}
      variant="page"
      title={page.title}
      badge={<ProvidedByChip pluginId={app.id} appName={app.name} />}
    />
  );
}
