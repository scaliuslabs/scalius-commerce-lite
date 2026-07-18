import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import type { AnalyticsScriptsListResponse } from "~/types/api-responses";
import {
  createAnalyticsScript,
  deleteAnalyticsScript,
  permanentlyDeleteAnalyticsScript,
  restoreAnalyticsScript,
  toggleAnalyticsScript,
  updateAnalyticsScript,
  type AnalyticsRevisionClaim,
  type ToggleAnalyticsScriptInput,
  type UpdateAnalyticsScriptInput,
} from "../api-functions/analytics";
import { getServerFnError, queryKeys } from "./shared";

function invalidateAnalytics(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: queryKeys.analytics.all });
}

export function removeAnalyticsScriptFromListPage(
  current: AnalyticsScriptsListResponse | undefined,
  id: string,
): AnalyticsScriptsListResponse | undefined {
  if (!current?.scripts.some((script) => script.id === id)) return current;

  const total = Math.max(0, current.pagination.total - 1);
  return {
    scripts: current.scripts.filter((script) => script.id !== id),
    pagination: {
      ...current.pagination,
      total,
      totalPages: Math.ceil(total / current.pagination.limit),
    },
  };
}

function removeAnalyticsScriptFromCachedLists(queryClient: QueryClient, id: string) {
  queryClient.setQueriesData<AnalyticsScriptsListResponse>(
    { queryKey: queryKeys.analytics.list() },
    (current) => removeAnalyticsScriptFromListPage(current, id),
  );
}

function reconcileAnalyticsLifecycleMove(queryClient: QueryClient, id: string) {
  removeAnalyticsScriptFromCachedLists(queryClient, id);
  void queryClient.invalidateQueries({
    queryKey: queryKeys.analytics.list(),
    refetchType: "none",
  });
  void queryClient.invalidateQueries({
    queryKey: queryKeys.analytics.providerHealth(),
  });
}

export function useCreateAnalyticsScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => createAnalyticsScript({ data }),
    onSuccess: () => {
      invalidateAnalytics(queryClient);
      toast.success("Analytics draft created");
    },
    onError: (error) => toast.error(
      getServerFnError(error, "Could not create the analytics draft."),
    ),
  });
}

export function useUpdateAnalyticsScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateAnalyticsScriptInput) => updateAnalyticsScript({ data }),
    onSuccess: (_data, variables) => {
      invalidateAnalytics(queryClient);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.analytics.detail(variables.id),
      });
      toast.success("Analytics script saved");
    },
    onError: (error) => toast.error(
      getServerFnError(error, "Could not save the analytics script. Reload before retrying."),
    ),
  });
}

export function useToggleAnalyticsScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ToggleAnalyticsScriptInput) => toggleAnalyticsScript({ data }),
    onSuccess: (result) => {
      invalidateAnalytics(queryClient);
      toast.success(result.message);
    },
    onError: (error) => toast.error(
      getServerFnError(error, "Could not change analytics status. Reload and try again."),
    ),
  });
}

export function useDeleteAnalyticsScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (claim: AnalyticsRevisionClaim) => deleteAnalyticsScript({ data: claim }),
    onSuccess: (_data, claim) => {
      reconcileAnalyticsLifecycleMove(queryClient, claim.id);
      queryClient.removeQueries({ queryKey: queryKeys.analytics.detail(claim.id) });
      toast.success("Analytics script moved to trash");
    },
    onError: (error) => toast.error(
      getServerFnError(error, "Could not move the analytics script to trash."),
    ),
  });
}

export function useRestoreAnalyticsScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (claim: AnalyticsRevisionClaim) => restoreAnalyticsScript({ data: claim }),
    onSuccess: (_data, claim) => {
      reconcileAnalyticsLifecycleMove(queryClient, claim.id);
      toast.success("Analytics script restored as inactive");
    },
    onError: (error) => toast.error(
      getServerFnError(error, "Could not restore the analytics script."),
    ),
  });
}

export function usePermanentDeleteAnalyticsScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (claim: AnalyticsRevisionClaim) => permanentlyDeleteAnalyticsScript({ data: claim }),
    onSuccess: (_data, claim) => {
      reconcileAnalyticsLifecycleMove(queryClient, claim.id);
      queryClient.removeQueries({ queryKey: queryKeys.analytics.detail(claim.id) });
      toast.success("Analytics script permanently deleted");
    },
    onError: (error) => toast.error(
      getServerFnError(error, "Could not permanently delete the analytics script."),
    ),
  });
}
