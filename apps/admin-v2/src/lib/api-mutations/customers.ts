import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteApiV1AdminCustomersById,
  deleteApiV1AdminCustomersByIdPermanent,
  postApiV1AdminCustomersBulkDelete,
  postApiV1AdminCustomersByIdRestore,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody } from "../api";
import {
  getServerFnError,
  invalidateDashboardQueries,
  queryKeys,
} from "./shared";

export function useDeleteCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiData(deleteApiV1AdminCustomersById({ path: { id } })),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.customers.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.removeQueries({ queryKey: queryKeys.customers.detail(id) });
      toast.success("Customer moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete customer")),
  });
}

export function usePermanentDeleteCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiData(deleteApiV1AdminCustomersByIdPermanent({ path: { id } })),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.customers.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.removeQueries({ queryKey: queryKeys.customers.detail(id) });
      toast.success("Customer permanently deleted");
    },
    onError: (err) =>
      toast.error(
        getServerFnError(err, "Failed to permanently delete customer"),
      ),
  });
}

export function useRestoreCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiData(postApiV1AdminCustomersByIdRestore({ path: { id } })),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.customers.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.customers.detail(id),
      });
      toast.success("Customer restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore customer")),
  });
}

export function useBulkDeleteCustomers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ApiBody<typeof postApiV1AdminCustomersBulkDelete>) =>
      apiData(postApiV1AdminCustomersBulkDelete({ body })),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.customers.list() });
      invalidateDashboardQueries(queryClient);
      toast.success(
        variables.permanent
          ? `${variables.customerIds.length} customers permanently deleted`
          : `${variables.customerIds.length} customers moved to trash`,
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete customers")),
  });
}
