import { queryOptions } from "@tanstack/react-query";
import {
  getAnalyticsScript,
  getAnalyticsScripts,
} from "../api-functions/analytics";
import { queryKeys } from "../query-keys";

const LOOKUP_STALE_TIME_MS = 1000 * 60 * 10;

export const analyticsScriptsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.analytics.list(),
    queryFn: () => getAnalyticsScripts(),
    staleTime: LOOKUP_STALE_TIME_MS,
  });

export const analyticsScriptQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.analytics.detail(id),
    queryFn: () => getAnalyticsScript({ data: { id } }),
    staleTime: 0,
  });
