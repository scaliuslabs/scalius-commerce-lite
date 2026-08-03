import { createFileRoute } from "@tanstack/react-router";
import { CacheManager } from "~/components/admin/CacheManager";
import { cacheGroupsQueryOptions } from "~/lib/api-query-options/cache";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/cache")({
  loader: ({ context: { queryClient } }) => {
    if (typeof window === "undefined") return;

    void queryClient.prefetchQuery(cacheGroupsQueryOptions());
  },
  head: () => ({ meta: [{ title: "Cache Settings | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: CacheSettingsPage,
});

function CacheSettingsPage() {
  return (
    <div className="container max-w-6xl space-y-4 py-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Cache</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Inspect or purge the public API and storefront cache domains.
        </p>
      </div>

      <CacheManager />
    </div>
  );
}
