import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  bulkDeleteCollections,
  bulkRestoreCollections,
  createCollection,
  deleteCollection,
  deleteCollectionPermanent,
  reorderCollections,
  restoreCollection,
  updateCollection,
  type CreateCollectionInput,
  type UpdateCollectionInput,
} from "../api-functions/collections";
import {
  getServerFnError,
  invalidateCollectionLookupQueries,
  queryKeys,
} from "./shared";

export function useCreateCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateCollectionInput) => createCollection({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections.list() });
      invalidateCollectionLookupQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.formOptions(),
      });
      toast.success("Collection created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create collection")),
  });
}

export function useUpdateCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateCollectionInput) => updateCollection({ data }),
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
    mutationFn: (id: string) => deleteCollection({ data: { id } }),
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
    mutationFn: (id: string) => deleteCollectionPermanent({ data: { id } }),
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
    mutationFn: (id: string) => restoreCollection({ data: { id } }),
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
    mutationFn: (data: { items: { id: string; sortOrder: number }[] }) =>
      reorderCollections({ data }),
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
      bulkDeleteCollections({
        data: { collectionIds: data.ids, permanent: data.permanent },
      }),
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

export function useBulkRestoreCollections() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { ids: string[] }) => bulkRestoreCollections({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections.list() });
      invalidateCollectionLookupQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.collections.formOptions(),
      });
      toast.success(`${variables.ids.length} collection(s) restored`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore collections")),
  });
}
