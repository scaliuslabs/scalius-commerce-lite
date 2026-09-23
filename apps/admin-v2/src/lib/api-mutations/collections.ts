import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteApiV1AdminCollectionsById,
  deleteApiV1AdminCollectionsByIdPermanent,
  postApiV1AdminCollectionsBulkDelete,
  postApiV1AdminCollectionsByIdRestore,
  postApiV1AdminCollectionsReorder,
  putApiV1AdminCollectionsById,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody } from "../api";
import {
  getServerFnError,
  invalidateCollectionLookupQueries,
  queryKeys,
} from "./shared";

export function useUpdateCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & ApiBody<typeof putApiV1AdminCollectionsById>) =>
      apiData(putApiV1AdminCollectionsById({ path: { id }, body })),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections.list() });
      invalidateCollectionLookupQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.detail(variables.id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.formOptions(),
      });
      toast.success("Collection updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update collection")),
  });
}

export function useDeleteCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiData(deleteApiV1AdminCollectionsById({ path: { id } })),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections.list() });
      invalidateCollectionLookupQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.formOptions(),
      });
      queryClient.removeQueries({ queryKey: queryKeys.collections.detail(id) });
      toast.success("Collection moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete collection")),
  });
}

export function usePermanentDeleteCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiData(deleteApiV1AdminCollectionsByIdPermanent({ path: { id } })),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections.list() });
      invalidateCollectionLookupQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.formOptions(),
      });
      queryClient.removeQueries({ queryKey: queryKeys.collections.detail(id) });
      toast.success("Collection permanently deleted");
    },
    onError: (err) =>
      toast.error(
        getServerFnError(err, "Failed to permanently delete collection"),
      ),
  });
}

export function useRestoreCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiData(postApiV1AdminCollectionsByIdRestore({ path: { id } })),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections.list() });
      invalidateCollectionLookupQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.formOptions(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.detail(id),
      });
      toast.success("Collection restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore collection")),
  });
}

export function useReorderCollections() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ApiBody<typeof postApiV1AdminCollectionsReorder>) =>
      apiData(postApiV1AdminCollectionsReorder({ body })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections.list() });
      invalidateCollectionLookupQueries(queryClient);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to reorder collections")),
  });
}

export function useBulkDeleteCollections() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { ids: string[]; permanent?: boolean }) =>
      apiData(postApiV1AdminCollectionsBulkDelete({
        body: { collectionIds: data.ids, permanent: data.permanent },
      })),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections.list() });
      invalidateCollectionLookupQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.formOptions(),
      });
      toast.success(
        `${variables.ids.length} collection(s) ${variables.permanent ? "permanently deleted" : "moved to trash"}`,
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete collections")),
  });
}
