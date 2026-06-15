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
  type CreateCategoryInput,
  type UpdateCategoryInput,
} from "../api-functions/categories";
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
    mutationFn: (id: string) => deleteCategory({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.formOptions(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.categoryOptions(),
      });
      invalidateProductStatsQueries(queryClient);
      queryClient.removeQueries({ queryKey: queryKeys.categories.detail(id) });
      toast.success("Category moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete category")),
  });
}

export function usePermanentDeleteCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteCategoryPermanent({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.formOptions(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.categoryOptions(),
      });
      invalidateProductStatsQueries(queryClient);
      queryClient.removeQueries({ queryKey: queryKeys.categories.detail(id) });
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
    mutationFn: (id: string) => restoreCategory({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.formOptions(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.categoryOptions(),
      });
      invalidateProductStatsQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.detail(id),
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
    mutationFn: (data: { categoryIds: string[]; permanent?: boolean }) =>
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
          ? `${variables.categoryIds.length} categories permanently deleted`
          : `${variables.categoryIds.length} categories moved to trash`,
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete categories")),
  });
}

export function useBulkRestoreCategories() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (categoryIds: string[]) =>
      bulkRestoreCategories({ data: { categoryIds } }),
    onSuccess: (_data, categoryIds) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.categories.formOptions(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.categoryOptions(),
      });
      invalidateProductStatsQueries(queryClient);
      toast.success(`${categoryIds.length} categories restored`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore categories")),
  });
}
