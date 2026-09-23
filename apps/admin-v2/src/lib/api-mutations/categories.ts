import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteApiV1AdminCategoriesById,
  deleteApiV1AdminCategoriesByIdPermanent,
  postApiV1AdminCategoriesBulkDelete,
  postApiV1AdminCategoriesBulkRestore,
  postApiV1AdminCategoriesByIdRestore,
} from "@scalius/api-client/sdk";
import { apiData } from "../api";
import type { CategoryRevisionClaim } from "../api-query-options/categories";
import {
  getServerFnError,
  invalidateProductStatsQueries,
  queryKeys,
} from "./shared";

function invalidateCategoryLists(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() });
  queryClient.invalidateQueries({ queryKey: queryKeys.categories.formOptions() });
  queryClient.invalidateQueries({ queryKey: queryKeys.collections.categoryOptions() });
  invalidateProductStatsQueries(queryClient);
}

export function useDeleteCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedRevision }: CategoryRevisionClaim) =>
      apiData(deleteApiV1AdminCategoriesById({ path: { id }, body: { expectedRevision } })),
    onSuccess: (_data, claim) => {
      invalidateCategoryLists(queryClient);
      queryClient.removeQueries({ queryKey: queryKeys.categories.detail(claim.id) });
      toast.success("Category moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete category")),
  });
}

export function usePermanentDeleteCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedRevision }: CategoryRevisionClaim) =>
      apiData(deleteApiV1AdminCategoriesByIdPermanent({ path: { id }, body: { expectedRevision } })),
    onSuccess: (_data, claim) => {
      invalidateCategoryLists(queryClient);
      queryClient.removeQueries({ queryKey: queryKeys.categories.detail(claim.id) });
      toast.success("Category permanently deleted");
    },
    onError: (err) =>
      toast.error(
        getServerFnError(err, "Failed to permanently delete category"),
      ),
  });
}

export function useRestoreCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedRevision }: CategoryRevisionClaim) =>
      apiData(postApiV1AdminCategoriesByIdRestore({ path: { id }, body: { expectedRevision } })),
    onSuccess: (_data, claim) => {
      invalidateCategoryLists(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.detail(claim.id),
      });
      toast.success("Category restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore category")),
  });
}

export function useBulkDeleteCategories() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { categories: CategoryRevisionClaim[]; permanent?: boolean }) =>
      apiData(postApiV1AdminCategoriesBulkDelete({ body })),
    onSuccess: (_data, variables) => {
      invalidateCategoryLists(queryClient);
      toast.success(
        variables.permanent
          ? `${variables.categories.length} categories permanently deleted`
          : `${variables.categories.length} categories moved to trash`,
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete categories")),
  });
}

export function useBulkRestoreCategories() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (categories: CategoryRevisionClaim[]) =>
      apiData(postApiV1AdminCategoriesBulkRestore({ body: { categories } })),
    onSuccess: (_data, categories) => {
      invalidateCategoryLists(queryClient);
      toast.success(`${categories.length} categories restored`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore categories")),
  });
}
