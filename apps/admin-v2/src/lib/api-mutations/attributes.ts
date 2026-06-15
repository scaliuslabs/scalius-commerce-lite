import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  bulkDeleteAttributes,
  bulkRestoreAttributes,
  createAttribute,
  deleteAttribute,
  deleteAttributePermanent,
  restoreAttribute,
  updateAttribute,
  type CreateAttributeInput,
  type UpdateAttributeInput,
} from "../api-functions/attributes";
import { getServerFnError, queryKeys } from "./shared";

export function useCreateAttribute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateAttributeInput) => createAttribute({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attributes.list() });
      toast.success("Attribute created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create attribute")),
  });
}

export function useUpdateAttribute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateAttributeInput) => updateAttribute({ data }),
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
    mutationFn: (id: string) => deleteAttribute({ data: { id } }),
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
    mutationFn: (id: string) => deleteAttributePermanent({ data: { id } }),
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
    mutationFn: (id: string) => restoreAttribute({ data: { id } }),
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
    mutationFn: (data: { ids: string[]; permanent?: boolean }) =>
      bulkDeleteAttributes({ data }),
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

export function useBulkRestoreAttributes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { ids: string[] }) => bulkRestoreAttributes({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attributes.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.attributes.values(),
      });
      toast.success(`${variables.ids.length} attribute(s) restored`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore attributes")),
  });
}
