import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  bulkDeletePages,
  bulkRestorePages,
  createPage,
  deletePage,
  permanentDeletePage,
  restorePage,
  updatePage,
  type CreatePageInput,
  type UpdatePageInput,
} from "../api-functions/pages";
import { getServerFnError, queryKeys } from "./shared";

export function useCreatePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreatePageInput) => createPage({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      toast.success("Page created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create page")),
  });
}

export function useUpdatePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdatePageInput) => updatePage({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.pages.detail(variables.id),
      });
      toast.success("Page updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update page")),
  });
}

export function useDeletePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deletePage({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      queryClient.removeQueries({ queryKey: queryKeys.pages.detail(id) });
      toast.success("Page moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete page")),
  });
}

export function usePermanentDeletePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => permanentDeletePage({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      queryClient.removeQueries({ queryKey: queryKeys.pages.detail(id) });
      toast.success("Page permanently deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to permanently delete page")),
  });
}

export function useRestorePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restorePage({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.detail(id) });
      toast.success("Page restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore page")),
  });
}

export function useBulkDeletePages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { pageIds: string[]; permanent?: boolean }) =>
      bulkDeletePages({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      toast.success(
        variables.permanent
          ? `${variables.pageIds.length} pages permanently deleted`
          : `${variables.pageIds.length} pages moved to trash`,
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete pages")),
  });
}

export function useBulkRestorePages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => bulkRestorePages({ data: { ids } }),
    onSuccess: (_data, ids) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      toast.success(`${ids.length} pages restored`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore pages")),
  });
}
