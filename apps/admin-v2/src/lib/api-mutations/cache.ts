import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  clearCache,
  clearCacheGroup,
  type CacheGroupsPayload,
  type CacheLastClearedPayload,
} from "../api-functions/cache";
import { getServerFnError, queryKeys } from "./shared";

function updateClearedTimestamps(
  previous: CacheLastClearedPayload | undefined,
  groups: string[],
  timestamp: number,
): CacheLastClearedPayload {
  const timestamps = { ...(previous?.timestamps ?? {}) };
  for (const group of groups) {
    timestamps[group] = timestamp;
  }
  return { timestamps };
}

function invalidateCacheReadModels(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: queryKeys.cache.stats() });
  queryClient.invalidateQueries({ queryKey: queryKeys.cache.lastCleared() });
}

export function useClearCacheGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (groupName: string) =>
      clearCacheGroup({ data: { groupName } }),
    onSuccess: (result, groupName) => {
      const clearedGroups = result.groups.length > 0 ? result.groups : [groupName];
      queryClient.setQueryData<CacheLastClearedPayload>(
        queryKeys.cache.lastCleared(),
        (previous) =>
          updateClearedTimestamps(previous, clearedGroups, Date.now()),
      );
      invalidateCacheReadModels(queryClient);

      const groupLabel =
        queryClient.getQueryData<CacheGroupsPayload>(queryKeys.cache.groups())
          ?.groups[groupName]?.label ?? groupName;
      toast.success(`${groupLabel} cache cleared`);
    },
    onError: (err, groupName) =>
      toast.error(getServerFnError(err, `Failed to clear ${groupName} cache`)),
  });
}

export function useClearCache() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => clearCache(),
    onSuccess: () => {
      const groups = queryClient.getQueryData<CacheGroupsPayload>(
        queryKeys.cache.groups(),
      )?.groups;
      queryClient.setQueryData<CacheLastClearedPayload>(
        queryKeys.cache.lastCleared(),
        (previous) =>
          updateClearedTimestamps(
            previous,
            Object.keys(groups ?? previous?.timestamps ?? {}),
            Date.now(),
          ),
      );
      invalidateCacheReadModels(queryClient);
      toast.success("All cache cleared successfully");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to clear all cache")),
  });
}
