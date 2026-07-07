import { queryOptions } from "@tanstack/react-query";
import {
  getCacheGroups,
  getCacheLastCleared,
  getCacheStats,
  getStorefrontCacheDlq,
  type StorefrontCacheDlqQueryInput,
} from "../api-functions/cache";
import { queryKeys } from "../query-keys";

const REALTIME_STALE_TIME_MS = 1000 * 10;
export const STOREFRONT_CACHE_DLQ_LIMIT = 8;

export const storefrontCacheDlqQueryKey = (
  input?: StorefrontCacheDlqQueryInput,
) =>
  input !== undefined
    ? ([...queryKeys.cache.all, "storefront-dlq", input] as const)
    : ([...queryKeys.cache.all, "storefront-dlq"] as const);

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

export const storefrontCacheDlqQueryOptions = (
  input: StorefrontCacheDlqQueryInput = {
    status: "pending",
    limit: STOREFRONT_CACHE_DLQ_LIMIT,
  },
) =>
  queryOptions({
    queryKey: storefrontCacheDlqQueryKey(input),
    queryFn: () => getStorefrontCacheDlq({ data: input }),
    staleTime: REALTIME_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
