import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { analyticsToday } from "@scalius/shared/analytics-period";
import { getStoreTimeZone } from "~/lib/store-time-zone";
import { AnalyticsOverview } from "~/components/admin/analytics/AnalyticsOverview";
import { useAnalyticsSelection } from "~/components/admin/analytics/AnalyticsToolbar";
import {
  effectiveGranularity,
  readSavedSelection,
  resolveAnalyticsSelection,
  validateAnalyticsSearch,
} from "~/components/admin/analytics/analytics-selection";
import { analyticsOverviewQueryOptions } from "~/lib/api-query-options/analytics";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/analytics/")({
  validateSearch: validateAnalyticsSearch,
  loaderDeps: ({ search }) => search,
  // The overview read starts with the navigation, for the range the page will show.
  loader: ({ context: { queryClient, user }, deps }) => {
    const today = analyticsToday(getStoreTimeZone());
    const selection = resolveAnalyticsSelection(deps, readSavedSelection(user?.id, today), today);
    void queryClient.prefetchQuery(analyticsOverviewQueryOptions({
      from: selection.from,
      to: selection.to,
      comparison: selection.comparison,
      granularity: effectiveGranularity(selection),
    }));
  },
  head: () => pageHead("analytics"),
  errorComponent: RouteErrorComponent,
  component: AnalyticsPage,
});

function AnalyticsPage() {
  const search = Route.useSearch();
  const { user } = Route.useRouteContext();
  const navigate = useNavigate({ from: Route.fullPath });
  const { selection, today, granularity, choose } = useAnalyticsSelection(search, user?.id);
  return (
    <AnalyticsOverview
      selection={selection}
      today={today}
      granularity={granularity}
      onChange={(patch) => void navigate({ search: choose(patch), replace: true })}
    />
  );
}
