import { createFileRoute } from "@tanstack/react-router";
import { CacheManager } from "~/components/admin/CacheManager";
import { SettingsLayout } from "~/components/admin/settings/SettingsLayout";
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
    <SettingsLayout
      pathname="/admin/settings/cache"
      title="Cache"
      description="Inspect or purge the public API and storefront cache domains."
    >
      <CacheManager />
    </SettingsLayout>
  );
}
