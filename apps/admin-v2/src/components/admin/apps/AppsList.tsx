// Apps (Shopify's Settings → Apps): the apps installed in this store, and the
// apps it can add, in one card with two views and one search. An installed
// row shows the app's icon, name, status, what it does and how many of its
// features are on (or why it stopped), and opens its page. The "Add apps"
// view lists the first-party apps this store's code can add and, when it
// first opens, the apps in the store's registries; each opens its listing.
// Upload (Paid: a sandbox runs uploaded apps), the registries and the
// emergency stop sit in the header.
import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Blocks, ChevronRight, Search, X } from "lucide-react";
import { EmptyState, FilteredEmptyState } from "~/components/admin/states/EmptyState";
import { IndexTabs } from "~/components/admin/resource/IndexTabs";
import { Page } from "~/components/admin/resource/Page";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { useOpenedOnce } from "~/hooks/use-opened-once";
import { useLocale, useMessages } from "~/i18n";
import { installedAppsMessages } from "~/i18n/apps";
import { appsLifecycleMessages } from "~/i18n/apps-lifecycle";
import { countryName } from "~/lib/country-name";
import { appsQueryOptions, type AppCategory, type AppListing, type AppSummary } from "~/lib/api-query-options/apps";
import { AppIcon } from "./AppIcon";
import { appMatches } from "./app-listing";
import { AppStatusBadge } from "./app-status";
import { RemovedAppDataCard } from "./RemovedAppData";
import { localizedApp } from "./app-text";

// The available app's listing loads the first time one is opened.
const AvailableAppDialog = lazy(() => import("./AvailableAppDialog").then((module) => ({ default: module.AvailableAppDialog })));
// Upload, the emergency stop and the registries load after the list;
// registry apps load when "Add apps" first opens (the API reads each registry).
const AppsToolbar = lazy(() => import("./AppsToolbar").then((module) => ({ default: module.AppsToolbar })));
const RegistryAppRows = lazy(() => import("./RegistryAppRows").then((module) => ({ default: module.RegistryAppRows })));

type View = "installed" | "add";

const ROW = "flex w-full items-start gap-3 px-4 py-3 text-start outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

const chevron = <ChevronRight className="size-4 text-muted-foreground rtl:rotate-180" aria-hidden="true" />;

function RowText({ app, extra }: { app: AppSummary | AppListing; extra: ReactNode }) {
  const shown = localizedApp(app, useLocale());
  return (
    <>
      <span title={shown.tagline ?? shown.description} className="line-clamp-2 text-body text-muted-foreground">{shown.tagline ?? shown.description}</span>
      {extra}
    </>
  );
}

function InstalledRow({ app }: { app: AppSummary }) {
  const t = useMessages(installedAppsMessages);
  const shown = localizedApp(app, useLocale());
  const stopped = (app.status === "disabled" || app.status === "failed") && app.failureReason;
  return (
    <Link to="/admin/apps/$pluginId" params={{ pluginId: app.id }} className={ROW}>
      <AppIcon src={app.icon} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-body font-medium">{shown.name}</span>
          <AppStatusBadge app={app} />
        </span>
        <RowText
          app={app}
          extra={stopped ? (
            <span className="text-body text-destructive wrap-anywhere">{app.failureReason}</span>
          ) : app.featureCount.total > 0 ? (
            <span className="text-body text-muted-foreground">{t("featuresOn", { on: app.featureCount.on, total: app.featureCount.total })}</span>
          ) : null}
        />
      </span>
      <span className="flex h-10 items-center">{chevron}</span>
    </Link>
  );
}

function AvailableRow({ app, onOpen }: { app: AppListing; onOpen: () => void }) {
  const t = useMessages(installedAppsMessages);
  const shown = localizedApp(app, useLocale());
  return (
    <button type="button" className={ROW} onClick={onOpen}>
      <AppIcon src={app.icon} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body font-medium">{shown.name}</span>
        <RowText
          app={app}
          extra={app.countries ? (
            <span className="text-body text-muted-foreground">{t("servesCountries", { countries: app.countries.map(countryName).join(", ") })}</span>
          ) : null}
        />
      </span>
      <span className="flex h-10 items-center">{chevron}</span>
    </button>
  );
}

function AppsSkeleton() {
  return (
    <div aria-busy className="divide-y">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-start gap-3 px-4 py-3">
          <Skeleton className="size-10" />
          <div className="flex flex-1 flex-col gap-0.5">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function AppsList() {
  const t = useMessages(installedAppsMessages);
  const lifecycle = useMessages(appsLifecycleMessages);
  const locale = useLocale();
  const { data, isError, isRefetching, refetch } = useQuery(appsQueryOptions());
  // A store with nothing installed opens on the apps it can add.
  const [chosen, setChosen] = useState<View | null>(null);
  const view: View = chosen ?? (data && data.apps.length === 0 ? "add" : "installed");
  const [query, setQuery] = useState("");
  // The last app previewed stays in the dialog while it closes.
  const [preview, setPreview] = useState<AppListing | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewLoaded = useOpenedOnce(previewOpen);

  const categoryLabel = (value: AppCategory) => t(`category_${value}`);
  const installed = useMemo(() => data?.apps.filter((app) => appMatches(app, query, locale, categoryLabel)) ?? [], [data, query, locale]); // eslint-disable-line react-hooks/exhaustive-deps -- labels follow the locale
  const available = useMemo(() => data?.available.filter((app) => appMatches(app, query, locale, categoryLabel)) ?? [], [data, query, locale]); // eslint-disable-line react-hooks/exhaustive-deps -- labels follow the locale
  const searching = query.trim() !== "";
  const noMatch = <FilteredEmptyState title={t("noMatchTitle")} description={t("noMatchBody")} onClearFilters={() => setQuery("")} />;

  let body: ReactNode;
  if (isError) {
    body = (
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-4">
        <p className="text-body text-destructive">{t("listFailed")}</p>
        <Button type="button" variant="outline" size="sm" loading={isRefetching} onClick={() => void refetch()}>{t("tryAgain")}</Button>
      </div>
    );
  } else if (!data) {
    body = <AppsSkeleton />;
  } else {
    body = (
      <>
        <IndexTabs
          label={t("tabsLabel")}
          value={view}
          onChange={setChosen}
          tabs={[
            { value: "installed", label: t("tab_installed"), badge: data.apps.length },
            { value: "add", label: t("tab_add") },
          ]}
        />
        <div className="border-b px-3 py-2">
          <div className="relative min-w-0">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("searchApps")}
              aria-label={t("searchApps")}
              // eslint-disable-next-line shadcn/no-restyle -- room for the inline search icon and clear button
              className="ps-8 pe-11 sm:pe-9"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label={t("clearSearch")}
                className="absolute end-0 top-0 flex size-11 items-center justify-center text-muted-foreground hover:text-foreground sm:size-9"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>
        {view === "installed" ? (
          installed.length > 0 ? (
            <ul>
              {installed.map((app) => <li key={app.id} className="border-t border-border first:border-t-0"><InstalledRow app={app} /></li>)}
            </ul>
          ) : searching ? noMatch : (
            <EmptyState
              card={false}
              help={false}
              icon={Blocks}
              title={t("emptyTitle")}
              description={t("emptyBody")}
              action={<Button type="button" onClick={() => setChosen("add")}>{t("browseApps")}</Button>}
            />
          )
        ) : (
          <>
            {available.length > 0 ? (
              <ul>
                {available.map((app) => (
                  <li key={app.id} className="border-t border-border first:border-t-0">
                    <AvailableRow
                      app={app}
                      onOpen={() => {
                        setPreview(app);
                        setPreviewOpen(true);
                      }}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
            <Suspense fallback={null}>
              <RegistryAppRows
                query={query}
                chevron={chevron}
                hasOther={available.length > 0}
                empty={() => (searching ? noMatch : <EmptyState card={false} help={false} icon={Blocks} title={lifecycle("registryEmptyTitle")} description={lifecycle("registryEmptyBody")} />)}
              />
            </Suspense>
          </>
        )}
      </>
    );
  }

  return (
    <Page width="detail">
      <PageHeader
        title={t("title")}
        actions={data ? (
          <Suspense fallback={null}>
            <AppsToolbar apps={data.apps} sandboxAvailable={data.sandboxAvailable} />
          </Suspense>
        ) : undefined}
      />
      <Card className="overflow-clip">{body}</Card>
      <div className="mt-4 empty:hidden">
        <RemovedAppDataCard />
      </div>
      {previewLoaded ? (
        <Suspense fallback={null}>
          <AvailableAppDialog app={preview} open={previewOpen} onOpenChange={setPreviewOpen} />
        </Suspense>
      ) : null}
    </Page>
  );
}
