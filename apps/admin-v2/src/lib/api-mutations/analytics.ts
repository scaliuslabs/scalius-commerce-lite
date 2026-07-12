import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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

function invalidateAnalytics(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.analytics.all });
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
      invalidateAnalytics(queryClient);
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
    onSuccess: () => {
      invalidateAnalytics(queryClient);
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
    onSuccess: () => {
      invalidateAnalytics(queryClient);
      toast.success("Analytics script permanently deleted");
    },
    onError: (error) => toast.error(
      getServerFnError(error, "Could not permanently delete the analytics script."),
    ),
  });
}
