import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteApiV1AdminSettingsShippingMethodsById,
  deleteApiV1AdminSettingsShippingMethodsByIdPermanentDelete,
  postApiV1AdminSettingsShippingMethods,
  postApiV1AdminSettingsShippingMethodsByIdRestore,
  putApiV1AdminSettingsShippingMethodsById,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody } from "../api";
import { getServerFnError, queryKeys } from "./shared";

function invalidateShippingMethodQueries(
  queryClient: ReturnType<typeof useQueryClient>,
) {
  queryClient.invalidateQueries({
    queryKey: queryKeys.settings.shippingMethods(),
  });
  queryClient.invalidateQueries({
    queryKey: queryKeys.settings.checkoutReadiness(),
  });
}

export const trashShippingMethod = (id: string) =>
  apiData(deleteApiV1AdminSettingsShippingMethodsById({ path: { id } }));
export const permanentDeleteShippingMethod = (id: string) =>
  apiData(deleteApiV1AdminSettingsShippingMethodsByIdPermanentDelete({ path: { id } }));
export const restoreShippingMethod = (id: string) =>
  apiData(postApiV1AdminSettingsShippingMethodsByIdRestore({ path: { id } }));

export function useCreateShippingMethod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ApiBody<typeof postApiV1AdminSettingsShippingMethods>) =>
      apiData(postApiV1AdminSettingsShippingMethods({ body })),
    onSuccess: () => {
      invalidateShippingMethodQueries(queryClient);
      toast.success("Shipping method created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create shipping method")),
  });
}

export function useUpdateShippingMethod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, update }: {
      id: string;
      update: ApiBody<typeof putApiV1AdminSettingsShippingMethodsById>;
    }) => apiData(putApiV1AdminSettingsShippingMethodsById({ path: { id }, body: update })),
    onSuccess: () => {
      invalidateShippingMethodQueries(queryClient);
      toast.success("Shipping method updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update shipping method")),
  });
}

export function useDeleteShippingMethod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => trashShippingMethod(id),
    onSuccess: () => {
      invalidateShippingMethodQueries(queryClient);
      toast.success("Shipping method moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to move to trash")),
  });
}

export function usePermanentDeleteShippingMethod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => permanentDeleteShippingMethod(id),
    onSuccess: () => {
      invalidateShippingMethodQueries(queryClient);
      toast.success("Shipping method permanently deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to permanently delete method")),
  });
}

export function useRestoreShippingMethod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => restoreShippingMethod(id),
    onSuccess: () => {
      invalidateShippingMethodQueries(queryClient);
      toast.success("Shipping method restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore shipping method")),
  });
}
