import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  bulkDeletePages,
  bulkPublishPages,
  bulkRestorePages,
  bulkUnpublishPages,
  deletePage,
  permanentDeletePage,
  restorePage,
  type PageRevisionClaim,
} from "../api-functions/pages";
import { getServerFnError, queryKeys } from "./shared";

export function useDeletePage(entityName = "Page") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (claim: PageRevisionClaim) => deletePage({ data: claim }),
    onSuccess: (_data, claim) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      queryClient.removeQueries({ queryKey: queryKeys.pages.detail(claim.id) });
      toast.success(`${entityName} moved to trash`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete page")),
  });
}

export function usePermanentDeletePage(entityName = "Page") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (claim: PageRevisionClaim) =>
      permanentDeletePage({ data: claim }),
    onSuccess: (_data, claim) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      queryClient.removeQueries({ queryKey: queryKeys.pages.detail(claim.id) });
      toast.success(`${entityName} permanently deleted`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to permanently delete page")),
  });
}

export function useRestorePage(entityName = "Page") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (claim: PageRevisionClaim) => restorePage({ data: claim }),
    onSuccess: (_data, claim) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.pages.detail(claim.id),
      });
      toast.success(`${entityName} restored`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore page")),
  });
}

export function useBulkDeletePages(entityPlural = "pages") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { pages: PageRevisionClaim[]; permanent?: boolean }) =>
      bulkDeletePages({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      toast.success(
        variables.permanent
          ? `${variables.pages.length} ${entityPlural} permanently deleted`
          : `${variables.pages.length} ${entityPlural} moved to trash`,
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete pages")),
  });
}

export function useBulkRestorePages(entityPlural = "pages") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pages: PageRevisionClaim[]) =>
      bulkRestorePages({ data: { pages } }),
    onSuccess: (_data, pages) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      toast.success(`${pages.length} ${entityPlural} restored`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore pages")),
  });
}

export function useBulkPublishPages(
  entitySingular = "page",
  entityPlural = "pages",
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pages: PageRevisionClaim[]) =>
      bulkPublishPages({ data: { pages } }),
    onSuccess: (_data, pages) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      toast.success(
        `${pages.length} ${pages.length === 1 ? entitySingular : entityPlural} published`,
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to publish pages")),
  });
}

export function useBulkUnpublishPages(
  entitySingular = "page",
  entityPlural = "pages",
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pages: PageRevisionClaim[]) =>
      bulkUnpublishPages({ data: { pages } }),
    onSuccess: (_data, pages) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pages.list() });
      toast.success(
        `${pages.length} ${pages.length === 1 ? entitySingular : entityPlural} moved to draft`,
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to unpublish pages")),
  });
}
