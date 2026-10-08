// Registry apps in the Apps list, loaded when the "Available to install" or
// "Updates available" view first opens (the API reads each registry's index,
// so the Apps page's first render never asks for it). Available: apps no one
// has installed, each opening its install listing. Updates: installed apps a
// registry lists in a newer version, each opening its own page.
import { lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { EmptyState } from "~/components/admin/resource/EmptyState";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { useOpenedOnce } from "~/hooks/use-opened-once";
import { useMessages } from "~/i18n";
import { installedAppsMessages } from "~/i18n/apps";
import { appsLifecycleMessages } from "~/i18n/apps-lifecycle";
import { appRegistryQueryOptions, type RegistryApp } from "~/lib/api-query-options/apps-lifecycle";
import { AppIcon } from "./AppIcon";

const RegistryAppDialog = lazy(() => import("./RegistryAppDialog").then((module) => ({ default: module.RegistryAppDialog })));

const ROW = "flex w-full items-start gap-3 px-4 py-3 text-start outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** Every word of the search in the app's name, tagline, description or author. */
export function registryAppMatches(app: RegistryApp, query: string): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [app.name, app.tagline, app.description, app.author].filter(Boolean).join(" ").toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}

function RowContent({ app, registryName, update, chevron }: { app: RegistryApp; registryName: string; update: boolean; chevron: ReactNode }) {
  const t = useMessages(appsLifecycleMessages);
  const main = useMessages(installedAppsMessages);
  return (
    <>
      <AppIcon src={null} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-body font-medium">{app.name}</span>
          {update ? <Badge variant="warning">{t("updateBadge", { version: app.version })}</Badge> : <Badge variant="secondary">{main("status_available")}</Badge>}
          {update ? null : app.signer.trusted ? <Badge variant="success">{t("developerBadgeVerified")}</Badge> : <Badge variant="warning">{t("developerUnknown")}</Badge>}
          {app.compatible ? null : <Badge variant="secondary">{t("needsNewerScalius")}</Badge>}
        </span>
        <span className="line-clamp-2 text-body text-muted-foreground">{app.tagline ?? app.description}</span>
        <span className="text-body text-muted-foreground">{t("registryBy", { author: app.author, registry: registryName })}</span>
      </span>
      <span className="flex h-10 items-center">{chevron}</span>
    </>
  );
}

interface RegistryAppRowsProps {
  view: "available" | "updates";
  query: string;
  /** A category is chosen: registry apps list none. */
  categoryChosen: boolean;
  /** Any filter is on (the empty state offers to clear them). */
  filtered: boolean;
  /** The first-party apps already fill the list, so an empty registry says nothing. */
  hasOther: boolean;
  /** Apps already listed above (an installed app waiting for approval). */
  listed: ReadonlySet<string>;
  onClearFilters: () => void;
  /** The list's own row arrow and empty-state icon: this part imports no icon of its own. */
  chevron: ReactNode;
  emptyIcon: ComponentType<{ className?: string }>;
}

export function RegistryAppRows({ view, query, categoryChosen, filtered, hasOther, listed, onClearFilters, chevron, emptyIcon }: RegistryAppRowsProps) {
  const t = useMessages(appsLifecycleMessages);
  const main = useMessages(installedAppsMessages);
  const { data, isError, isRefetching, refetch } = useQuery(appRegistryQueryOptions());
  const [selected, setSelected] = useState<RegistryApp | null>(null);
  const [open, setOpen] = useState(false);
  const loaded = useOpenedOnce(open);

  if (isError) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-4">
        <p className="text-body text-destructive">{t("registryLoadFailed")}</p>
        <Button type="button" variant="outline" size="sm" loading={isRefetching} onClick={() => void refetch()}>{main("tryAgain")}</Button>
      </div>
    );
  }
  if (!data) {
    return (
      <div aria-busy className="divide-y border-t border-border">
        {[0, 1].map((row) => (
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

  const registryName = (id: string) => data.registries.find((registry) => registry.id === id)?.name ?? id;
  const apps = categoryChosen
    ? []
    : data.apps.filter((app) => (view === "updates" ? app.installed !== null && app.updateAvailable && !listed.has(app.id) : app.installed === null) && registryAppMatches(app, query));
  const unavailable = data.registries.filter((registry) => registry.status === "unavailable");

  return (
    <>
      {view === "available" && !data.officialConfigured ? (
        <p className="border-t border-border px-4 py-3 text-body text-muted-foreground">{t("registryNotSetUp")}</p>
      ) : null}
      {view === "available"
        ? unavailable.map((registry) => (
            <p key={registry.id} className="border-t border-border px-4 py-3 text-body text-muted-foreground">
              {t("registryUnreachable", { name: registry.name, error: registry.error ?? "" })}
            </p>
          ))
        : null}
      {apps.length > 0 ? (
        <ul>
          {apps.map((app) => (
            <li key={`${app.registryId}:${app.id}`} className="border-t border-border">
              {view === "updates" ? (
                <Link to="/admin/apps/$pluginId" params={{ pluginId: app.id }} className={ROW}>
                  <RowContent app={app} registryName={registryName(app.registryId)} update chevron={chevron} />
                </Link>
              ) : (
                <button
                  type="button"
                  className={ROW}
                  onClick={() => {
                    setSelected(app);
                    setOpen(true);
                  }}
                >
                  <RowContent app={app} registryName={registryName(app.registryId)} update={false} chevron={chevron} />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : hasOther ? null : filtered ? (
        <EmptyState
          icon={emptyIcon}
          title={main("noMatchTitle")}
          description={main("noMatchBody")}
          action={<Button type="button" variant="outline" onClick={onClearFilters}>{main("clearFilters")}</Button>}
        />
      ) : (
        <EmptyState icon={emptyIcon} title={t("registryEmptyTitle")} description={t("registryEmptyBody")} />
      )}
      {loaded ? (
        <Suspense fallback={null}>
          <RegistryAppDialog app={selected} installMode={data.installMode} open={open} onOpenChange={setOpen} />
        </Suspense>
      ) : null}
    </>
  );
}
