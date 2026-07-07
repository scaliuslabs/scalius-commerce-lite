import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { AnalyticsProviderHealth } from "~/components/admin/AnalyticsProviderHealth";
import { AnalyticsList } from "~/components/admin/AnalyticsList";
import {
  analyticsProviderHealthQueryOptions,
  analyticsScriptsQueryOptions,
} from "~/lib/api-query-options/analytics";
import type { AnalyticsScript } from "~/types/api-responses";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/analytics/")({
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData(analyticsScriptsQueryOptions()),
      queryClient.ensureQueryData(analyticsProviderHealthQueryOptions()),
    ]);
  },
  head: () => ({ meta: [{ title: "Analytics Scripts | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: AnalyticsPage,
});

function AnalyticsPage() {
  const { data } = useSuspenseQuery(analyticsScriptsQueryOptions());
  const { data: providerHealth } = useSuspenseQuery(
    analyticsProviderHealthQueryOptions(),
  );
  const scripts = (Array.isArray(data) ? data : []) as AnalyticsScript[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analytics Scripts</h1>
        <p className="text-muted-foreground">
          Manage analytics and tracking scripts for your site.
        </p>
      </div>
      <AnalyticsProviderHealth health={providerHealth} />
      <AnalyticsList analytics={scripts} />
    </div>
  );
}
