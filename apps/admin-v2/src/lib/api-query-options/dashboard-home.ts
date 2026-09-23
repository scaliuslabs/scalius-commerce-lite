import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminDashboardActivity,
  getApiV1AdminDashboardHomeSummary,
} from "@scalius/api-client/sdk";
import { apiData, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

const DASHBOARD_STALE_TIME_MS = 1000 * 60 * 2;

export type DashboardSummaryData = ApiResult<typeof getApiV1AdminDashboardHomeSummary>;

export const dashboardSummaryQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.dashboard.summary(),
    queryFn: () => apiData(getApiV1AdminDashboardHomeSummary()),
    staleTime: DASHBOARD_STALE_TIME_MS,
  });

export const dashboardActivityQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.dashboard.activity(),
    queryFn: () => apiData(getApiV1AdminDashboardActivity()),
    staleTime: DASHBOARD_STALE_TIME_MS,
  });
