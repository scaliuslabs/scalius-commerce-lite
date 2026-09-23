import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminAnalytics,
  getApiV1AdminAnalyticsByIdSource,
  getApiV1AdminAnalyticsHealth,
} from "@scalius/api-client/sdk";
import { apiData, type ApiQuery, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

const LOOKUP_STALE_TIME_MS = 1000 * 60 * 10;

export type AnalyticsScriptsListResponse = ApiResult<typeof getApiV1AdminAnalytics>;
export type AnalyticsScriptSummary = AnalyticsScriptsListResponse["scripts"][number];
export type AnalyticsScript = ApiResult<typeof getApiV1AdminAnalyticsByIdSource>;
export type AnalyticsProviderHealthResponse = ApiResult<typeof getApiV1AdminAnalyticsHealth>;

export const analyticsScriptsQueryOptions = (
  query: ApiQuery<typeof getApiV1AdminAnalytics>,
) =>
  queryOptions({
    queryKey: queryKeys.analytics.list(query),
    queryFn: () => apiData(getApiV1AdminAnalytics({ query })),
    staleTime: LOOKUP_STALE_TIME_MS,
  });

export const analyticsProviderHealthQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.analytics.providerHealth(),
    queryFn: () => apiData(getApiV1AdminAnalyticsHealth()),
    staleTime: 0,
  });

export const analyticsScriptQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.analytics.detail(id),
    queryFn: () => apiData(getApiV1AdminAnalyticsByIdSource({ path: { id } })),
    staleTime: 0,
  });
