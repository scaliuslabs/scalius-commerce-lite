import { queryOptions } from "@tanstack/react-query";
import {
  getCustomer,
  getCustomerHistory,
  getCustomers,
  type CustomersQueryInput,
} from "../api-functions/customers";
import { queryKeys } from "../query-keys";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;

export const customersQueryOptions = (params: CustomersQueryInput) =>
  queryOptions({
    queryKey: queryKeys.customers.list(params),
    queryFn: () => getCustomers({ data: params }),
    staleTime: MODERATE_STALE_TIME_MS,
  });

export const customerQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.customers.detail(id),
    queryFn: () => getCustomer({ data: { id } }),
    staleTime: 0,
  });

export const customerHistoryQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.customers.history(id),
    queryFn: () => getCustomerHistory({ data: { id } }),
    staleTime: 0,
  });
