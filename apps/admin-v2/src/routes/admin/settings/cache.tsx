import { createFileRoute } from "@tanstack/react-router";
import { CacheManager } from "~/components/admin/CacheManager";
import { cacheStatsQueryOptions, cacheLastClearedQueryOptions, cacheGroupsQueryOptions } from "~/lib/api-query-options/cache";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/cache")({
  loader: ({ context: { queryClient } }) => {
    if (typeof window === "undefined") return;

    void queryClient.prefetchQuery(cacheStatsQueryOptions());
    void queryClient.prefetchQuery(cacheLastClearedQueryOptions());
    void queryClient.prefetchQuery(cacheGroupsQueryOptions());
  },
  head: () => ({ meta: [{ title: "Cache Settings | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: CacheSettingsPage,
});

function CacheSettingsPage() {
  return (
    <div className="container py-8 space-y-8 max-w-6xl">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-extrabold tracking-tight bg-gradient-to-br from-foreground to-foreground/70 bg-clip-text text-transparent">
            Cache Settings
          </h1>
          <p className="text-muted-foreground text-lg">
            Manage application cache to improve storefront performance
          </p>
        </div>
      </div>

      <CacheManager />
    </div>
  );
}
