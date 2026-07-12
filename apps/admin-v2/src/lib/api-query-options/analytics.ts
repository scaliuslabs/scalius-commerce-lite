import { queryOptions } from "@tanstack/react-query";
import {
  getAnalyticsProviderHealth,
  getAnalyticsScript,
  getAnalyticsScripts,
  type AnalyticsQueryInput,
} from "../api-functions/analytics";
import { queryKeys } from "../query-keys";

const LOOKUP_STALE_TIME_MS = 1000 * 60 * 10;

export const analyticsScriptsQueryOptions = (params: AnalyticsQueryInput) =>
  queryOptions({
    queryKey: queryKeys.analytics.list(params),
    queryFn: () => getAnalyticsScripts({ data: params }),
    staleTime: LOOKUP_STALE_TIME_MS,
  });

export const analyticsProviderHealthQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.analytics.providerHealth(),
    queryFn: () => getAnalyticsProviderHealth(),
    staleTime: 0,
  });

export const analyticsScriptQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.analytics.detail(id),
    queryFn: () => getAnalyticsScript({ data: { id } }),
    staleTime: 0,
  });
