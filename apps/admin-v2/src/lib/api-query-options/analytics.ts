import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminReports,
  getApiV1AdminReportsByReportId,
  getApiV1AdminReportsOverview,
} from "@scalius/api-client/sdk";
import type { AnalyticsReportId } from "@scalius/shared/analytics-reports";
import type { AnalyticsComparison, AnalyticsGranularity } from "@scalius/shared/analytics-period";
import { apiData, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

/** Sales numbers move with every order; a minute keeps tab switches instant. */
const ANALYTICS_STALE_TIME_MS = 60_000;

export type AnalyticsOverviewQuery = {
  from: string;
  to: string;
  comparison: AnalyticsComparison;
  granularity: AnalyticsGranularity;
};

export type AnalyticsReportQuery = {
  from?: string;
  to?: string;
  granularity?: AnalyticsGranularity;
  sort?: string;
  direction?: "asc" | "desc";
  page: number;
  pageSize: number;
};

export type AnalyticsOverview = ApiResult<typeof getApiV1AdminReportsOverview>;
export type AnalyticsReportCatalog = ApiResult<typeof getApiV1AdminReports>;
export type AnalyticsReportPage = ApiResult<typeof getApiV1AdminReportsByReportId>;

/** Changing the range keeps the last answer on screen (dimmed) until the new one arrives. */
export const analyticsOverviewQueryOptions = (query: AnalyticsOverviewQuery) =>
  queryOptions({
    queryKey: queryKeys.reports.overview(query),
    queryFn: () => apiData(getApiV1AdminReportsOverview({ query })),
    staleTime: ANALYTICS_STALE_TIME_MS,
    placeholderData: keepPreviousData,
  });

export const analyticsReportCatalogQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.reports.catalog(),
    queryFn: () => apiData(getApiV1AdminReports()),
    staleTime: 5 * 60_000,
  });

export const analyticsReportQueryOptions = (reportId: AnalyticsReportId, query: AnalyticsReportQuery) =>
  queryOptions({
    queryKey: queryKeys.reports.report(reportId, query),
    queryFn: () => apiData(getApiV1AdminReportsByReportId({ path: { reportId }, query })),
    staleTime: ANALYTICS_STALE_TIME_MS,
    placeholderData: keepPreviousData,
  });
