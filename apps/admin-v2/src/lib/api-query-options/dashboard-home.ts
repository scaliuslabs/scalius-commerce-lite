import { queryOptions } from "@tanstack/react-query";
import {
  getDashboardActivity,
  getDashboardSummary,
  type DashboardActivityData,
} from "../api-functions/dashboard-home";
import { queryKeys } from "../query-keys";

const DASHBOARD_STALE_TIME_MS = 1000 * 60 * 2;
const EMPTY_DASHBOARD_ACTIVITY: DashboardActivityData = {
  dailyActivityData: [],
};

async function getDashboardActivityForQuery(): Promise<DashboardActivityData> {
  const data = await getDashboardActivity();
  return data ?? EMPTY_DASHBOARD_ACTIVITY;
}

export const dashboardSummaryQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.dashboard.summary(),
    queryFn: () => getDashboardSummary(),
    staleTime: DASHBOARD_STALE_TIME_MS,
  });

export const dashboardActivityQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.dashboard.activity(),
    queryFn: () => getDashboardActivityForQuery(),
    staleTime: DASHBOARD_STALE_TIME_MS,
  });
