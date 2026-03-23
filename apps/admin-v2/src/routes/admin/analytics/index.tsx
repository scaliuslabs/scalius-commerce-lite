import { createFileRoute } from "@tanstack/react-router";
import { AnalyticsList } from "~/components/admin/AnalyticsList";
import { getAnalyticsScripts } from "~/lib/api.functions";

export const Route = createFileRoute("/admin/analytics/")({
  loader: async () => {
    const result = await getAnalyticsScripts().catch(() => []);
    const scripts = (Array.isArray(result) ? result : []) as any[];
    return { scripts };
  },
  head: () => ({ meta: [{ title: "Analytics Scripts | Scalius Admin" }] }),
  component: AnalyticsPage,
});

function AnalyticsPage() {
  const { scripts } = Route.useLoaderData();

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
