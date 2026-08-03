import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  clearCache,
  clearCacheGroup,
  type CacheGroupsPayload,
} from "../api-functions/cache";
import { getServerFnError, queryKeys } from "./shared";

export function useClearCacheGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (groupName: string) => clearCacheGroup({ data: { groupName } }),
    onSuccess: (_result, groupName) => {
      const label =
        queryClient.getQueryData<CacheGroupsPayload>(queryKeys.cache.groups())
          ?.groups[groupName]?.label ?? groupName;
      toast.success(`${label} cache purged`);
    },
    onError: (error, groupName) =>
      toast.error(getServerFnError(error, `Failed to purge ${groupName} cache`)),
  });
}

export function useClearCache() {
  return useMutation({
    mutationFn: () => clearCache(),
    onSuccess: () => toast.success("All public caches purged"),
    onError: (error) =>
      toast.error(getServerFnError(error, "Failed to purge public caches")),
  });
}
