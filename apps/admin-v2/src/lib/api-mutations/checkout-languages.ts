import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  createCheckoutLanguage,
  deleteCheckoutLanguage,
  restoreCheckoutLanguage,
  softDeleteCheckoutLanguage,
  type CheckoutLanguageWriteInput,
  updateCheckoutLanguage,
} from "../api-functions/checkout-languages";
import { getServerFnError, queryKeys } from "./shared";

export function useCreateCheckoutLanguage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CheckoutLanguageWriteInput) =>
      createCheckoutLanguage({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.checkoutLanguages(),
      });
      toast.success("Checkout language created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create checkout language")),
  });
}

export function useUpdateCheckoutLanguage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string; update: CheckoutLanguageWriteInput }) =>
      updateCheckoutLanguage({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.checkoutLanguages(),
      });
      toast.success("Checkout language updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update checkout language")),
  });
}

export function useSoftDeleteCheckoutLanguage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string }) => softDeleteCheckoutLanguage({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.checkoutLanguages(),
      });
      toast.success("Checkout language moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to move to trash")),
  });
}

export function useDeleteCheckoutLanguage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string }) => deleteCheckoutLanguage({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.checkoutLanguages(),
      });
      toast.success("Checkout language permanently deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to permanently delete")),
  });
}

export function useRestoreCheckoutLanguage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { id: string }) => restoreCheckoutLanguage({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.checkoutLanguages(),
      });
      toast.success("Checkout language restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore language")),
  });
}
