import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteApiV1AdminAttributesById,
  deleteApiV1AdminAttributesByIdPermanent,
  postApiV1AdminAttributesBulkDelete,
  postApiV1AdminAttributesByIdRestore,
  putApiV1AdminAttributesById,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody } from "../api";
import { getServerFnError, queryKeys } from "./shared";

type UpdateAttributeInput = { id: string } & ApiBody<typeof putApiV1AdminAttributesById>;

export function useUpdateAttribute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateAttributeInput) =>
      apiData(putApiV1AdminAttributesById({ path: { id }, body })),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attributes.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.attributes.detail(variables.id),
      });
      toast.success("Attribute updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update attribute")),
  });
}

export function useDeleteAttribute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiData(deleteApiV1AdminAttributesById({ path: { id } })),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attributes.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.attributes.values(),
      });
      queryClient.removeQueries({ queryKey: queryKeys.attributes.detail(id) });
      toast.success("Attribute moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete attribute")),
  });
}

export function usePermanentDeleteAttribute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiData(deleteApiV1AdminAttributesByIdPermanent({ path: { id } })),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attributes.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.attributes.values(),
      });
      queryClient.removeQueries({ queryKey: queryKeys.attributes.detail(id) });
      toast.success("Attribute permanently deleted");
    },
    onError: (err) =>
      toast.error(
        getServerFnError(err, "Failed to permanently delete attribute"),
      ),
  });
}

export function useRestoreAttribute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiData(postApiV1AdminAttributesByIdRestore({ path: { id } })),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attributes.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.attributes.values(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.attributes.detail(id),
      });
      toast.success("Attribute restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore attribute")),
  });
}

export function useBulkDeleteAttributes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { ids: string[]; permanent?: boolean }) =>
      apiData(postApiV1AdminAttributesBulkDelete({ body })),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attributes.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.attributes.values(),
      });
      toast.success(
        `${variables.ids.length} attribute(s) ${variables.permanent ? "permanently deleted" : "moved to trash"}`,
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete attributes")),
  });
}
