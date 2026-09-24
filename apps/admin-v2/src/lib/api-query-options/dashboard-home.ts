import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminDashboardActivity,
  getApiV1AdminDashboardHomeSummary,
  getApiV1AdminInventoryAlerts,
  getApiV1AdminOrders,
} from "@scalius/api-client/sdk";
import { apiData } from "../api";
import { queryKeys } from "../query-keys";

const DASHBOARD_STALE_TIME_MS = 1000 * 60 * 2;


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

/** Home's "orders to fulfil" count: one row, the total is what matters. */
export const homeOpenOrdersQueryOptions = () =>
  queryOptions({
    queryKey: ["home", "open-orders"] as const,
    queryFn: () => apiData(getApiV1AdminOrders({ query: { view: "unfulfilled", limit: 1 } })),
  });

export const homeLowStockQueryOptions = () =>
  queryOptions({
    queryKey: ["home", "low-stock"] as const,
    queryFn: () => apiData(getApiV1AdminInventoryAlerts({ query: { status: "active" } })),
  });

/** Home's store-readiness tasks can wait a few minutes between reads. */
export const HOME_FEED_STALE_TIME_MS = 5 * 60_000;
