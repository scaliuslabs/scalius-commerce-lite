import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  bulkDeleteDeliveryLocations,
  cleanAllDeliveryLocations,
  createDeliveryLocation,
  deleteDeliveryLocation,
  type DeliveryLocationWriteInput,
  updateDeliveryLocation,
} from "../api-functions/delivery";
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
    mutationFn: (data: DeliveryLocationWriteInput) =>
      createDeliveryLocation({ data }),
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
    mutationFn: (data: {
      id: string;
      update: Partial<DeliveryLocationWriteInput>;
    }) => updateDeliveryLocation({ data }),
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
    mutationFn: (data: { id: string }) => deleteDeliveryLocation({ data }),
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
    mutationFn: (data: { ids: string[] }) =>
      bulkDeleteDeliveryLocations({ data }),
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
    mutationFn: () => cleanAllDeliveryLocations(),
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
