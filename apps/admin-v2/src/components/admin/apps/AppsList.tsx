// Apps (Shopify's Apps page): every app installed in this store, and the
// first-party apps its code can add, in one card. Views with counts (All,
// Active, Installed but not active, Updates available, Available to install),
// a search over name, tagline and category, and a category filter sit above
// the list. A row shows the app's icon, name, status, tagline and, when it
// serves only some countries, which. An installed app's row opens its page;
// an available app's opens its listing with the command that adds it.
import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Blocks, ChevronRight, Search, X } from "lucide-react";
import { EmptyState } from "~/components/admin/resource/EmptyState";
import { IndexTabs } from "~/components/admin/resource/IndexTabs";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Skeleton } from "~/components/ui/skeleton";
import { useOpenedOnce } from "~/hooks/use-opened-once";
import { useLocale, useMessages } from "~/i18n";
import { installedAppsMessages } from "~/i18n/apps";
import { countryName } from "~/lib/country-name";
import { appsQueryOptions, type AppCategory, type AppListing } from "~/lib/api-query-options/apps";
import { AppIcon } from "./AppIcon";
import { APP_VIEWS, appCategories, appMatches, appViewCounts, type AppEntry, type AppView } from "./app-listing";
import { AppStatusBadge } from "./app-status";
import { localizedApp } from "./app-text";

// The available app's listing loads the first time one is opened.
const AvailableAppDialog = lazy(() => import("./AvailableAppDialog").then((module) => ({ default: module.AvailableAppDialog })));

/** The manifest's category order (Shopify's App Store subcategories); the record keeps it complete. */
const CATEGORY_ORDER = Object.keys({
  payments: 0, shipping: 0, orders: 0, inventory: 0, returns: 0, checkout: 0, pricing: 0, marketing: 0, loyalty: 0,
  "store-design": 0, content: 0, notifications: 0, analytics: 0, finances: 0, support: 0, operations: 0, compliance: 0,
} satisfies Record<AppCategory, 0>) as AppCategory[];
const ALL_CATEGORIES = "all";

const VIEW_LABEL = {
  all: "tab_all",
  active: "tab_active",
  inactive: "tab_inactive",
  updates: "tab_updates",
  available: "tab_available",
} as const satisfies Record<AppView, string>;

const ROW = "flex w-full items-start gap-3 px-4 py-3 text-start outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function AppRowContent({ entry }: { entry: AppEntry }) {
  const t = useMessages(installedAppsMessages);
  const app = localizedApp(entry.app, useLocale());
  const countries = app.countries;
  return (
    <>
      <AppIcon src={app.icon} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-body font-medium">{app.name}</span>
          {entry.kind === "installed" ? <AppStatusBadge app={entry.app} /> : <Badge variant="secondary">{t("status_available")}</Badge>}
        </span>
        <span className="line-clamp-2 text-body text-muted-foreground">{app.tagline ?? app.description}</span>
        {countries ? (
          <span className="text-body text-muted-foreground">{t("servesCountries", { countries: countries.map(countryName).join(", ") })}</span>
        ) : null}
      </span>
      <span className="flex h-10 items-center">
        <ChevronRight className="size-4 text-muted-foreground rtl:rotate-180" aria-hidden="true" />
      </span>
    </>
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
  const locale = useLocale();
  const { data, isError, isRefetching, refetch } = useQuery(appsQueryOptions());
  const [view, setView] = useState<AppView>("all");
  const [category, setCategory] = useState<AppCategory | null>(null);
  const [query, setQuery] = useState("");
  // The last app previewed stays in the dialog while it closes.
  const [preview, setPreview] = useState<AppListing | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewLoaded = useOpenedOnce(previewOpen);

  const entries = useMemo<AppEntry[]>(
    () => (data ? [
      ...data.apps.map((app): AppEntry => ({ kind: "installed", app })),
      ...(data.available ?? []).map((app): AppEntry => ({ kind: "available", app })),
    ] : []),
    [data],
  );
  const counts = useMemo(() => appViewCounts(entries), [entries]);
  const categories = useMemo(() => appCategories(entries, CATEGORY_ORDER), [entries]);
  const categoryLabel = (value: AppCategory) => t(`category_${value}`);
  const shown = entries.filter((entry) => appMatches(entry, { view, category, query }, locale, categoryLabel));
  const filtered = view !== "all" || category !== null || query.trim() !== "";
  const clearFilters = () => {
    setView("all");
    setCategory(null);
    setQuery("");
  };

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
  } else if (entries.length === 0) {
    body = <EmptyState icon={Blocks} title={t("emptyTitle")} description={t("emptyBody")} />;
  } else {
    body = (
      <>
        <IndexTabs
          label={t("tabsLabel")}
          value={view}
          onChange={setView}
          tabs={APP_VIEWS.map((value) => ({ value, label: t(VIEW_LABEL[value]), badge: counts[value] }))}
        />
        <div className="flex flex-col gap-2 border-b px-3 py-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
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
          {categories.length > 0 ? (
            <SearchableSelect
              ariaLabel={t("categoryFilter")}
              value={category ?? ALL_CATEGORIES}
              onValueChange={(value) => setCategory(value === ALL_CATEGORIES ? null : (value as AppCategory))}
              options={[
                { value: ALL_CATEGORIES, label: t("allCategories") },
                ...categories.map((value) => ({ value, label: categoryLabel(value) })),
              ]}
              triggerClassName="sm:w-56"
            />
          ) : null}
        </div>
        {shown.length === 0 ? (
          <EmptyState
            icon={Search}
            title={t("noMatchTitle")}
            description={t("noMatchBody")}
            action={filtered ? <Button type="button" variant="outline" onClick={clearFilters}>{t("clearFilters")}</Button> : undefined}
          />
        ) : (
          <ul>
            {shown.map((entry) => (
              <li key={`${entry.kind}:${entry.app.id}`} className="border-t border-border first:border-t-0">
                {entry.kind === "installed" ? (
                  <Link to="/admin/apps/$pluginId" params={{ pluginId: entry.app.id }} className={ROW}>
                    <AppRowContent entry={entry} />
                  </Link>
                ) : (
                  <button
                    type="button"
                    className={ROW}
                    onClick={() => {
                      setPreview(entry.app);
                      setPreviewOpen(true);
                    }}
                  >
                    <AppRowContent entry={entry} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t("title")} />
      <Card className="overflow-clip">{body}</Card>
      {previewLoaded ? (
        <Suspense fallback={null}>
          <AvailableAppDialog app={preview} open={previewOpen} onOpenChange={setPreviewOpen} />
        </Suspense>
      ) : null}
    </div>
  );
}
