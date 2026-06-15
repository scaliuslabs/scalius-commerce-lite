import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  bulkDeleteCustomers,
  createCustomer,
  deleteCustomer,
  permanentDeleteCustomer,
  restoreCustomer,
  updateCustomer,
  type BulkDeleteCustomersInput,
  type CreateCustomerInput,
  type UpdateCustomerInput,
} from "../api-functions/customers";
import {
  getServerFnError,
  invalidateDashboardQueries,
  queryKeys,
} from "./shared";

export function useCreateCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateCustomerInput) => createCustomer({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.customers.list() });
      invalidateDashboardQueries(queryClient);
      toast.success("Customer created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create customer")),
  });
}

export function useUpdateCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateCustomerInput) => updateCustomer({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.customers.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.customers.detail(variables.id),
      });
      toast.success("Customer updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update customer")),
  });
}

export function useDeleteCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteCustomer({ data: { id } }),
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
    mutationFn: (id: string) => permanentDeleteCustomer({ data: { id } }),
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
    mutationFn: (id: string) => restoreCustomer({ data: { id } }),
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
    mutationFn: (data: BulkDeleteCustomersInput) => bulkDeleteCustomers({ data }),
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
