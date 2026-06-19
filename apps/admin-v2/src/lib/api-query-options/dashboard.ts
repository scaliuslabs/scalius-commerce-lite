import { queryOptions } from "@tanstack/react-query";
import { getDashboardData } from "../api-functions/dashboard";
import { queryKeys } from "../query-keys";
export {
  dashboardActivityQueryOptions,
  dashboardSummaryQueryOptions,
} from "./dashboard-home";

const DASHBOARD_STALE_TIME_MS = 1000 * 60 * 2;

export const dashboardQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.dashboard.all,
    queryFn: () => getDashboardData(),
    staleTime: DASHBOARD_STALE_TIME_MS,
  });
