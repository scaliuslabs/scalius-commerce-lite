import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { AnalyticsList } from "~/components/admin/AnalyticsList";
import { analyticsScriptsQueryOptions } from "~/lib/api-query-options/analytics";
import type { AnalyticsScript } from "~/types/api-responses";
import { RouteErrorComponent } from "~/lib/route-error";

export const Route = createFileRoute("/admin/analytics/")({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(analyticsScriptsQueryOptions());
  },
  head: () => ({ meta: [{ title: "Analytics Scripts | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: AnalyticsPage,
});

function AnalyticsPage() {
  const { data } = useSuspenseQuery(analyticsScriptsQueryOptions());
  const scripts = (Array.isArray(data) ? data : []) as AnalyticsScript[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analytics Scripts</h1>
        <p className="text-muted-foreground">
          Manage analytics and tracking scripts for your site.
        </p>
      </div>
      <AnalyticsList analytics={scripts} />
    </div>
  );
}
