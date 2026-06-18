import { queryOptions } from "@tanstack/react-query";
import {
  getCacheGroups,
  getCacheLastCleared,
  getCacheStats,
} from "../api-functions/cache";
import { queryKeys } from "../query-keys";

const REALTIME_STALE_TIME_MS = 1000 * 10;

export const cacheStatsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.cache.stats(),
    queryFn: () => getCacheStats(),
    staleTime: REALTIME_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

export const cacheLastClearedQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.cache.lastCleared(),
    queryFn: () => getCacheLastCleared(),
    staleTime: REALTIME_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

export const cacheGroupsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.cache.groups(),
    queryFn: () => getCacheGroups(),
    staleTime: REALTIME_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
