import { createFileRoute } from "@tanstack/react-router";
import { CacheManager } from "~/components/admin/CacheManager";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/settings/cache")({
  head: () => ({ meta: [{ title: "Cache Settings | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: CacheSettingsPage,
});

function CacheSettingsPage() {
  return (
    <div className="container max-w-3xl space-y-4 py-6">
      <h1 className="text-xl font-semibold tracking-tight">Cache</h1>
      <CacheManager />
    </div>
  );
}
