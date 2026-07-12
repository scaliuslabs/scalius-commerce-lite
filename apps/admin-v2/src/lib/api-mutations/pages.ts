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
  type PageRevisionClaim,
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
    mutationFn: (claim: PageRevisionClaim) => deletePage({ data: claim }),
    onSuccess: (_data, claim) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      queryClient.removeQueries({ queryKey: queryKeys.pages.detail(claim.id) });
      toast.success("Page moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete page")),
  });
}

export function usePermanentDeletePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (claim: PageRevisionClaim) => permanentDeletePage({ data: claim }),
    onSuccess: (_data, claim) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      queryClient.removeQueries({ queryKey: queryKeys.pages.detail(claim.id) });
      toast.success("Page permanently deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to permanently delete page")),
  });
}

export function useRestorePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (claim: PageRevisionClaim) => restorePage({ data: claim }),
    onSuccess: (_data, claim) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.detail(claim.id) });
      toast.success("Page restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore page")),
  });
}

export function useBulkDeletePages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { pages: PageRevisionClaim[]; permanent?: boolean }) =>
      bulkDeletePages({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      toast.success(
        variables.permanent
          ? `${variables.pages.length} pages permanently deleted`
          : `${variables.pages.length} pages moved to trash`,
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete pages")),
  });
}

export function useBulkRestorePages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pages: PageRevisionClaim[]) => bulkRestorePages({ data: { pages } }),
    onSuccess: (_data, pages) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      toast.success(`${pages.length} pages restored`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore pages")),
  });
}
