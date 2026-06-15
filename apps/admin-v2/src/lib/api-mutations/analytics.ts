import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  createAnalyticsScript,
  deleteAnalyticsScript,
  updateAnalyticsScript,
} from "../api-functions/analytics";
import { getServerFnError, queryKeys } from "./shared";

export function useCreateAnalyticsScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      createAnalyticsScript({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics.list() });
      toast.success("Analytics script created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create analytics script")),
  });
}

export function useUpdateAnalyticsScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string } & Record<string, unknown>) =>
      updateAnalyticsScript({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.analytics.detail(variables.id),
      });
      toast.success("Analytics script updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update analytics script")),
  });
}

export function useDeleteAnalyticsScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteAnalyticsScript({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics.list() });
      queryClient.removeQueries({ queryKey: queryKeys.analytics.detail(id) });
      toast.success("Analytics script deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete analytics script")),
  });
}
