import { queryOptions } from "@tanstack/react-query";
import {
  getDashboardActivity,
  getDashboardSummary,
} from "../api-functions/dashboard-home";
import { queryKeys } from "../query-keys";

const DASHBOARD_STALE_TIME_MS = 1000 * 60 * 2;

export const dashboardSummaryQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.dashboard.summary(),
    queryFn: () => getDashboardSummary(),
    staleTime: DASHBOARD_STALE_TIME_MS,
  });

export const dashboardActivityQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.dashboard.activity(),
    queryFn: () => getDashboardActivity(),
    staleTime: DASHBOARD_STALE_TIME_MS,
  });
