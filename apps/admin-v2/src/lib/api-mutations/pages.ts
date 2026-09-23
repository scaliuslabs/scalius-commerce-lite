import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteApiV1AdminPagesById,
  deleteApiV1AdminPagesByIdPermanent,
  postApiV1AdminPagesBulkDelete,
  postApiV1AdminPagesBulkPublish,
  postApiV1AdminPagesBulkRestore,
  postApiV1AdminPagesBulkUnpublish,
  postApiV1AdminPagesByIdRestore,
} from "@scalius/api-client/sdk";
import { apiData } from "../api";
import type { PageRevisionClaim } from "../api-query-options/pages";
import { getServerFnError, queryKeys } from "./shared";

export function useDeletePage(entityName = "Page") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedRevision }: PageRevisionClaim) =>
      apiData(deleteApiV1AdminPagesById({ path: { id }, body: { expectedRevision } })),
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
    mutationFn: ({ id, expectedRevision }: PageRevisionClaim) =>
      apiData(deleteApiV1AdminPagesByIdPermanent({ path: { id }, body: { expectedRevision } })),
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
    mutationFn: ({ id, expectedRevision }: PageRevisionClaim) =>
      apiData(postApiV1AdminPagesByIdRestore({ path: { id }, body: { expectedRevision } })),
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
    mutationFn: (body: { pages: PageRevisionClaim[]; permanent?: boolean }) =>
      apiData(postApiV1AdminPagesBulkDelete({ body })),
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
      apiData(postApiV1AdminPagesBulkRestore({ body: { pages } })),
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
      apiData(postApiV1AdminPagesBulkPublish({ body: { pages } })),
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
      apiData(postApiV1AdminPagesBulkUnpublish({ body: { pages } })),
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
