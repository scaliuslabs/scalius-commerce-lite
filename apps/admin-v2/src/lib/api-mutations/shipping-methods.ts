import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  createShippingMethod,
  deleteShippingMethod,
  permanentDeleteShippingMethod,
  restoreShippingMethod,
  type ShippingMethodWriteInput,
  updateShippingMethod,
} from "../api-functions/shipping-methods";
import { getServerFnError, queryKeys } from "./shared";

export function useCreateShippingMethod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ShippingMethodWriteInput) =>
      createShippingMethod({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.shippingMethods(),
      });
      toast.success("Shipping method created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create shipping method")),
  });
}

export function useUpdateShippingMethod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string; update: ShippingMethodWriteInput }) =>
      updateShippingMethod({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.shippingMethods(),
      });
      toast.success("Shipping method updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update shipping method")),
  });
}

export function useDeleteShippingMethod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string }) => deleteShippingMethod({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.shippingMethods(),
      });
      toast.success("Shipping method moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to move to trash")),
  });
}

export function usePermanentDeleteShippingMethod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string }) =>
      permanentDeleteShippingMethod({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.shippingMethods(),
      });
      toast.success("Shipping method permanently deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to permanently delete method")),
  });
}

export function useRestoreShippingMethod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string }) => restoreShippingMethod({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.shippingMethods(),
      });
      toast.success("Shipping method restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore shipping method")),
  });
}
