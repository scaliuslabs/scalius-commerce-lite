import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Activity, AlertCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import { AnalyticsProviderHealth } from "~/components/admin/AnalyticsProviderHealth";
import { AnalyticsList } from "~/components/admin/AnalyticsList";
import { DataTableToolbar } from "~/components/admin/data-table/DataTableToolbar";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  analyticsProviderHealthQueryOptions,
  analyticsScriptsQueryOptions,
} from "~/lib/api-query-options/analytics";
import {
  createListSearchValidator,
  normalizeOptionalEnumSearchParam,
} from "~/lib/list-helpers";
import { usePermissions } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";

const PROVIDER_TYPES = [
  "google_analytics",
  "google_tag_manager",
  "facebook_pixel",
  "tiktok_pixel",
  "cloudflare_web_analytics",
  "custom",
] as const;
const STATUS_TYPES = ["active", "inactive"] as const;
const validateBaseSearch = createListSearchValidator(
  ["name", "type", "createdAt", "updatedAt"] as const,
  { limit: 20, sort: "updatedAt" },
);

function validateAnalyticsSearch(search: Record<string, unknown>) {
  return {
    ...validateBaseSearch(search as never),
    type: normalizeOptionalEnumSearchParam(search.type, PROVIDER_TYPES),
    status: normalizeOptionalEnumSearchParam(search.status, STATUS_TYPES),
  };
}

function mapParams(search: ReturnType<typeof validateAnalyticsSearch>) {
  return {
    page: search.page,
    limit: search.limit,
    search: search.search || undefined,
    type: search.type,
    status: search.trashed ? undefined : search.status,
    sort: search.sort,
    order: search.order,
    showTrashed: search.trashed,
  };
}

export const Route = createFileRoute("/admin/analytics/")({
  validateSearch: validateAnalyticsSearch,
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps }) => {
    await Promise.all([
      queryClient.ensureQueryData(analyticsScriptsQueryOptions(mapParams(deps))),
      queryClient.ensureQueryData(analyticsProviderHealthQueryOptions()),
    ]);
  },
  head: ({ match }) => ({
    meta: [{
      title: `${match.search.trashed ? "Analytics Trash" : "Analytics"} | Scalius Admin`,
    }],
  }),
  pendingComponent: AnalyticsPagePending,
  errorComponent: AnalyticsPageError,
  component: AnalyticsPage,
});

function AnalyticsPagePending() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading analytics integrations">
      <div className="flex items-start justify-between gap-3 border-b pb-4">
        <div className="space-y-2"><Skeleton className="h-7 w-36" /><Skeleton className="h-4 w-72 max-w-[70vw]" /></div>
        <Skeleton className="h-9 w-28" />
      </div>
      <Skeleton className="h-16 w-full" />
      <div className="flex flex-wrap gap-2"><Skeleton className="h-9 min-w-52 flex-1" /><Skeleton className="h-9 w-40" /><Skeleton className="h-9 w-32" /></div>
      <div className="space-y-2 sm:hidden">
        {Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-44 w-full" />)}
      </div>
      <div className="hidden overflow-hidden rounded-lg border sm:block">
        <Skeleton className="h-10 rounded-none" />
        {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-14 rounded-none border-t bg-muted/60" />)}
      </div>
      <span className="sr-only">Loading analytics integrations</span>
    </div>
  );
}

function AnalyticsPageError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex min-h-72 flex-col items-center justify-center rounded-lg border border-dashed px-6 text-center" role="alert">
      <span className="rounded-lg border border-destructive/20 bg-destructive/5 p-3">
        <AlertCircle className="h-6 w-6 text-destructive" />
      </span>
      <h1 className="mt-3 text-base font-semibold">Analytics integrations could not be loaded</h1>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        The integration list or provider readiness check failed. No saved status has been assumed.
      </p>
      <Button type="button" variant="outline" size="sm" className="mt-4" onClick={reset}>
        <RefreshCw className="mr-2 h-4 w-4" />Retry
      </Button>
    </div>
  );
}

function AnalyticsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const canCreate = hasPermission(ADMIN_PERMISSIONS.ANALYTICS_CREATE);
  const { data } = useSuspenseQuery(analyticsScriptsQueryOptions(mapParams(search)));
  const { data: providerHealth } = useSuspenseQuery(analyticsProviderHealthQueryOptions());
  const hasFilters = Boolean(search.search || search.type || search.status);

  const updateSearch = (values: Record<string, unknown>) => {
    void navigate({
      search: ((previous: Record<string, unknown>) => ({
        ...previous,
        ...values,
      })) as never,
    });
  };

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            <h1 className="text-2xl font-bold tracking-tight">
              {search.trashed ? "Analytics trash" : "Analytics"}
            </h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {search.trashed
              ? "Restore saved integrations or remove their source permanently."
              : "Control what measures buyer activity and verify each provider before activation."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => updateSearch({
              trashed: !search.trashed,
              status: undefined,
              page: 1,
            })}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {search.trashed ? "View integrations" : "View trash"}
          </Button>
          {!search.trashed && canCreate ? (
            <Button size="sm" asChild>
              <Link to="/admin/analytics/new">
                <Plus className="mr-2 h-4 w-4" />
                Add integration
              </Link>
            </Button>
          ) : null}
        </div>
      </header>

      {!search.trashed ? <AnalyticsProviderHealth health={providerHealth} /> : null}

      <section aria-label="Analytics integrations" className="space-y-2">
        <DataTableToolbar
          searchValue={search.search}
          onSearchChange={(value) => updateSearch({ search: value, page: 1 })}
          searchPlaceholder="Find integration or identifier…"
          filters={
            <>
              <Select
                value={search.type ?? "all"}
                onValueChange={(value) => updateSearch({
                  type: value === "all" ? undefined : value,
                  page: 1,
                })}
              >
                <SelectTrigger className="h-9 w-[190px]">
                  <SelectValue placeholder="All providers" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All providers</SelectItem>
                  <SelectItem value="cloudflare_web_analytics">Cloudflare Web Analytics</SelectItem>
                  <SelectItem value="google_analytics">Google Analytics 4</SelectItem>
                  <SelectItem value="google_tag_manager">Google Tag Manager</SelectItem>
                  <SelectItem value="facebook_pixel">Meta Pixel</SelectItem>
                  <SelectItem value="tiktok_pixel">TikTok Pixel</SelectItem>
                  <SelectItem value="custom">Custom code</SelectItem>
                </SelectContent>
              </Select>
              {!search.trashed ? (
                <Select
                  value={search.status ?? "all"}
                  onValueChange={(value) => updateSearch({
                    status: value === "all" ? undefined : value,
                    page: 1,
                  })}
                >
                  <SelectTrigger className="h-9 w-[140px]">
                    <SelectValue placeholder="Any status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any status</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              ) : null}
            </>
          }
        />

        <AnalyticsList
          scripts={data.scripts}
          pagination={data.pagination}
          showTrashed={search.trashed}
          hasFilters={hasFilters}
          onClearFilters={() => updateSearch({
            search: "",
            type: undefined,
            status: undefined,
            page: 1,
          })}
          onPageChange={(page) => updateSearch({ page })}
          onLimitChange={(limit) => updateSearch({ limit, page: 1 })}
        />
      </section>
    </div>
  );
}
