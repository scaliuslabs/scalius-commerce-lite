import { createFileRoute } from "@tanstack/react-router";
import { CacheManager } from "~/components/admin/CacheManager";
import { cacheStatsQueryOptions, cacheLastClearedQueryOptions, cacheGroupsQueryOptions } from "~/lib/api.queries";

export const Route = createFileRoute("/admin/settings/cache")({
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData(cacheStatsQueryOptions()),
      queryClient.ensureQueryData(cacheLastClearedQueryOptions()),
      queryClient.ensureQueryData(cacheGroupsQueryOptions()),
    ]);
  },
  head: () => ({ meta: [{ title: "Cache Settings | Scalius Admin" }] }),
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
