import { queryOptions } from "@tanstack/react-query";
import { getCacheGroups } from "../api-functions/cache";
import { queryKeys } from "../query-keys";

export const cacheGroupsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.cache.groups(),
    queryFn: () => getCacheGroups(),
    staleTime: 60_000,
  });
