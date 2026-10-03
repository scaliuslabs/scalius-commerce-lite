import { createFileRoute } from "@tanstack/react-router";
import { ReportsList } from "~/components/admin/analytics/ReportsList";
import { useAnalyticsSelection } from "~/components/admin/analytics/AnalyticsToolbar";
import { validateAnalyticsSearch } from "~/components/admin/analytics/analytics-selection";
import { analyticsReportCatalogQueryOptions } from "~/lib/api-query-options/analytics";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/analytics/reports/")({
  validateSearch: validateAnalyticsSearch,
  loader: ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(analyticsReportCatalogQueryOptions());
  },
  head: () => pageHead("reports"),
  errorComponent: RouteErrorComponent,
  component: ReportsPage,
});

function ReportsPage() {
  const search = Route.useSearch();
  const { user } = Route.useRouteContext();
  // Reports open on the range last chosen on the overview or a report.
  const { selection } = useAnalyticsSelection(search, user?.id);
  return <ReportsList search={{ from: selection.from, to: selection.to }} />;
}
