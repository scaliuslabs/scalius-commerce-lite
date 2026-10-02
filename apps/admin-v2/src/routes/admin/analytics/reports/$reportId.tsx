import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { AnalyticsReportId } from "@scalius/shared/analytics-reports";
import { ReportPage, type ReportView } from "~/components/admin/analytics/ReportPage";
import { useAnalyticsSelection } from "~/components/admin/analytics/AnalyticsToolbar";
import { validateAnalyticsSearch, type AnalyticsSearch } from "~/components/admin/analytics/analytics-selection";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { RouteErrorComponent } from "~/lib/route-error";
import { translate } from "~/i18n";
import type { AnalyticsMessageKey } from "~/i18n/analytics";
import { titleHead } from "~/i18n/page-titles";

type ReportSearch = AnalyticsSearch & ReportView;

function validateReportSearch(search: Record<string, unknown>): ReportSearch {
  const result: ReportSearch = validateAnalyticsSearch(search);
  if (typeof search.sort === "string" && /^[a-z0-9_]{1,64}$/.test(search.sort)) result.sort = search.sort;
  if (search.direction === "asc" || search.direction === "desc") result.direction = search.direction;
  const page = Number(search.page);
  if (Number.isInteger(page) && page > 1 && page <= 10_000) result.page = page;
  return result;
}

export const Route = createFileRoute("/admin/analytics/reports/$reportId")({
  validateSearch: validateReportSearch,
  // Only catalogued reports exist; anything else is a page that doesn't exist (no request).
  // The catalog and the report names come with the report page's own code (already
  // on its way), never with the dashboard's first download.
  loader: async ({ params }) => {
    const [{ isAnalyticsReportId }, { analyticsMessages }] = await Promise.all([
      import("@scalius/shared/analytics-reports"),
      import("~/i18n/analytics"),
    ]);
    if (!isAnalyticsReportId(params.reportId)) throw new AdminApiResponseError("Report not found", 404);
    return { title: translate(analyticsMessages, `report.${params.reportId}` as AnalyticsMessageKey) };
  },
  head: ({ loaderData }) => titleHead(loaderData?.title ?? ""),
  errorComponent: RouteErrorComponent,
  component: AnalyticsReportRoute,
});

function AnalyticsReportRoute() {
  const { reportId } = Route.useParams();
  const search = Route.useSearch();
  const { user } = Route.useRouteContext();
  const navigate = useNavigate({ from: Route.fullPath });
  const { selection, today, granularity, choose } = useAnalyticsSelection(search, user?.id);
  const view: ReportView = { sort: search.sort, direction: search.direction, page: search.page };
  const keep = { from: search.from, to: search.to, comparison: search.comparison, granularity: search.granularity };
  return (
    <ReportPage
      key={reportId}
      reportId={reportId as AnalyticsReportId}
      selection={selection}
      today={today}
      granularity={granularity}
      view={view}
      // A new range starts again at page 1 with the same sort.
      onChange={(patch) => void navigate({ search: { ...choose(patch), sort: view.sort, direction: view.direction }, replace: true })}
      onView={(next) => void navigate({ search: { ...keep, ...next, page: next.page && next.page > 1 ? next.page : undefined }, replace: true })}
    />
  );
}
