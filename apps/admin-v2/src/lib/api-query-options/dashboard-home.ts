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

function normalizeDashboardActivityData(
  data: DashboardActivityData | null | undefined,
): DashboardActivityData {
  if (!data || !Array.isArray(data.dailyActivityData)) {
    return EMPTY_DASHBOARD_ACTIVITY;
  }

  return data;
}

async function getDashboardActivityForQuery(): Promise<DashboardActivityData> {
  const data = await getDashboardActivity();
  return normalizeDashboardActivityData(data);
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
