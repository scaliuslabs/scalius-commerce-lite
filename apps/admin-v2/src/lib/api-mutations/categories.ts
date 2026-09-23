import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  bulkDeleteCategories,
  bulkRestoreCategories,
  deleteCategory,
  deleteCategoryPermanent,
  restoreCategory,
  type CategoryRevisionClaim,
} from "../api-functions/categories";
import {
  getServerFnError,
  invalidateProductStatsQueries,
  queryKeys,
} from "./shared";

export function useDeleteCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (claim: CategoryRevisionClaim) => deleteCategory({ data: claim }),
    onSuccess: (_data, claim) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.formOptions(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.categoryOptions(),
      });
      invalidateProductStatsQueries(queryClient);
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
    mutationFn: (claim: CategoryRevisionClaim) => deleteCategoryPermanent({ data: claim }),
    onSuccess: (_data, claim) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.formOptions(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.categoryOptions(),
      });
      invalidateProductStatsQueries(queryClient);
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
    mutationFn: (claim: CategoryRevisionClaim) => restoreCategory({ data: claim }),
    onSuccess: (_data, claim) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.formOptions(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.categoryOptions(),
      });
      invalidateProductStatsQueries(queryClient);
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
    mutationFn: (data: { categories: CategoryRevisionClaim[]; permanent?: boolean }) =>
      bulkDeleteCategories({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.formOptions(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.categoryOptions(),
      });
      invalidateProductStatsQueries(queryClient);
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
      bulkRestoreCategories({ data: { categories } }),
    onSuccess: (_data, categories) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.formOptions(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.categoryOptions(),
      });
      invalidateProductStatsQueries(queryClient);
      toast.success(`${categories.length} categories restored`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore categories")),
  });
}
