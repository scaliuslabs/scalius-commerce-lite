import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteApiV1AdminAnalyticsById,
  deleteApiV1AdminAnalyticsByIdPermanent,
  postApiV1AdminAnalyticsByIdRestore,
  postApiV1AdminAnalyticsByIdToggle,
} from "@scalius/api-client/sdk";
import { apiData } from "../api";
import type { AnalyticsScriptsListResponse } from "../api-query-options/analytics";

interface AnalyticsRevisionClaim {
  id: string;
  expectedRevision: number;
}
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

export function useToggleAnalyticsScript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isActive, expectedRevision, allowDuplicateProvider }: AnalyticsRevisionClaim & {
      isActive: boolean;
      allowDuplicateProvider?: boolean;
    }) => apiData(postApiV1AdminAnalyticsByIdToggle({
      path: { id },
      body: { isActive, expectedRevision, allowDuplicateProvider: allowDuplicateProvider ?? false },
    })),
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
    mutationFn: ({ id, expectedRevision }: AnalyticsRevisionClaim) =>
      apiData(deleteApiV1AdminAnalyticsById({ path: { id }, body: { expectedRevision } })),
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
    mutationFn: ({ id, expectedRevision }: AnalyticsRevisionClaim) =>
      apiData(postApiV1AdminAnalyticsByIdRestore({ path: { id }, body: { expectedRevision } })),
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
    mutationFn: ({ id, expectedRevision }: AnalyticsRevisionClaim) =>
      apiData(deleteApiV1AdminAnalyticsByIdPermanent({ path: { id }, body: { expectedRevision } })),
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
