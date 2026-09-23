import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteApiV1AdminSettingsCheckoutLanguagesById,
  patchApiV1AdminSettingsCheckoutLanguagesById,
  postApiV1AdminSettingsCheckoutLanguages,
  postApiV1AdminSettingsCheckoutLanguagesByIdRestore,
  putApiV1AdminSettingsCheckoutLanguagesById,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody } from "../api";
import { getServerFnError, queryKeys } from "./shared";

function useCheckoutLanguageMutation<TVariables>(
  mutationFn: (variables: TVariables) => Promise<unknown>,
  success: string,
  failure: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.checkoutLanguages(),
      });
      toast.success(success);
    },
    onError: (err) => toast.error(getServerFnError(err, failure)),
  });
}

export const useCreateCheckoutLanguage = () =>
  useCheckoutLanguageMutation(
    (body: ApiBody<typeof postApiV1AdminSettingsCheckoutLanguages>) =>
      apiData(postApiV1AdminSettingsCheckoutLanguages({ body })),
    "Checkout language created",
    "Failed to create checkout language",
  );

export const useUpdateCheckoutLanguage = () =>
  useCheckoutLanguageMutation(
    ({ id, update }: {
      id: string;
      update: ApiBody<typeof putApiV1AdminSettingsCheckoutLanguagesById>;
    }) => apiData(putApiV1AdminSettingsCheckoutLanguagesById({ path: { id }, body: update })),
    "Checkout language updated",
    "Failed to update checkout language",
  );

export const useSoftDeleteCheckoutLanguage = () =>
  useCheckoutLanguageMutation(
    ({ id }: { id: string }) =>
      apiData(patchApiV1AdminSettingsCheckoutLanguagesById({ path: { id } })),
    "Checkout language moved to trash",
    "Failed to move to trash",
  );

export const useDeleteCheckoutLanguage = () =>
  useCheckoutLanguageMutation(
    ({ id }: { id: string }) =>
      apiData(deleteApiV1AdminSettingsCheckoutLanguagesById({ path: { id } })),
    "Checkout language permanently deleted",
    "Failed to permanently delete",
  );

export const useRestoreCheckoutLanguage = () =>
  useCheckoutLanguageMutation(
    ({ id }: { id: string }) =>
      apiData(postApiV1AdminSettingsCheckoutLanguagesByIdRestore({ path: { id } })),
    "Checkout language restored",
    "Failed to restore language",
  );
