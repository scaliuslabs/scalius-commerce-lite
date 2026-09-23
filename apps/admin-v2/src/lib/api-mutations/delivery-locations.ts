import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteApiV1AdminSettingsDeliveryLocations,
  deleteApiV1AdminSettingsDeliveryLocationsAll,
  deleteApiV1AdminSettingsDeliveryLocationsById,
  postApiV1AdminSettingsDeliveryLocations,
  putApiV1AdminSettingsDeliveryLocationsById,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody } from "../api";
import { getServerFnError, queryKeys } from "./shared";

function invalidateDeliveryLocationQueries(
  queryClient: ReturnType<typeof useQueryClient>,
) {
  queryClient.invalidateQueries({
    queryKey: queryKeys.settings.deliveryLocations(),
  });
  queryClient.invalidateQueries({
    queryKey: queryKeys.settings.deliveryLocationsAll(),
  });
  queryClient.invalidateQueries({
    queryKey: queryKeys.settings.checkoutReadiness(),
  });
}

export function useCreateDeliveryLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ApiBody<typeof postApiV1AdminSettingsDeliveryLocations>) =>
      apiData(postApiV1AdminSettingsDeliveryLocations({ body })),
    onSuccess: () => {
      invalidateDeliveryLocationQueries(queryClient);
      toast.success("Location created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create location")),
  });
}

export function useUpdateDeliveryLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, update }: {
      id: string;
      update: ApiBody<typeof putApiV1AdminSettingsDeliveryLocationsById>;
    }) => apiData(putApiV1AdminSettingsDeliveryLocationsById({ path: { id }, body: update })),
    onSuccess: () => {
      invalidateDeliveryLocationQueries(queryClient);
      toast.success("Location updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update location")),
  });
}

export function useDeleteDeliveryLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      apiData(deleteApiV1AdminSettingsDeliveryLocationsById({ path: { id } })),
    onSuccess: () => {
      invalidateDeliveryLocationQueries(queryClient);
      toast.success("Location deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete location")),
  });
}

export function useBulkDeleteDeliveryLocations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { ids: string[] }) =>
      apiData(deleteApiV1AdminSettingsDeliveryLocations({ body })),
    onSuccess: (_data, variables) => {
      invalidateDeliveryLocationQueries(queryClient);
      toast.success(`${variables.ids.length} location(s) deleted`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete locations")),
  });
}

export function useCleanAllDeliveryLocations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiData(deleteApiV1AdminSettingsDeliveryLocationsAll({ body: { confirmDeleteAll: true } })),
    onSuccess: () => {
      invalidateDeliveryLocationQueries(queryClient);
      toast.success("All delivery locations cleared");
    },
    onError: (err) =>
      toast.error(
        getServerFnError(err, "Failed to clean all delivery locations"),
      ),
  });
}
