import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  bulkDeleteCategories,
  bulkRestoreCategories,
  createCategory,
  deleteCategory,
  deleteCategoryPermanent,
  restoreCategory,
  updateCategory,
  updateCategoryStatus,
  type CategoryRevisionClaim,
  type CreateCategoryInput,
  type UpdateCategoryInput,
} from "../api-functions/categories";
import type { CategoryStatus } from "@scalius/shared/category-publication";
import {
  getServerFnError,
  invalidateProductStatsQueries,
  queryKeys,
} from "./shared";

export function useCreateCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateCategoryInput) => createCategory({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.formOptions(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.categoryOptions(),
      });
      invalidateProductStatsQueries(queryClient);
      toast.success("Category created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create category")),
  });
}

export function useUpdateCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateCategoryInput) => updateCategory({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.detail(variables.id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.formOptions(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.categoryOptions(),
      });
      invalidateProductStatsQueries(queryClient);
      toast.success("Category updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update category")),
  });
}

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

export function useUpdateCategoryStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CategoryRevisionClaim & { status: CategoryStatus }) =>
      updateCategoryStatus({ data }),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.detail(variables.id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.formOptions(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.categoryOptions(),
      });
      toast.success(
        result.status === "published"
          ? "Category published"
          : result.status === "internal"
            ? "Category made internal"
            : "Category moved to draft",
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to change category status")),
  });
}
