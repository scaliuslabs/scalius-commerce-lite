import { queryOptions } from "@tanstack/react-query";
import {
  getCustomer,
  getCustomerHistory,
  getCustomers,
  type CustomerHistoryQueryInput,
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

export const CUSTOMER_HISTORY_INITIAL_QUERY = {
  historyPage: 1,
  historyLimit: 20,
  ordersPage: 1,
  ordersLimit: 5,
} as const;

export const customerHistoryQueryOptions = (
  id: string,
  params: Omit<CustomerHistoryQueryInput, "id"> = CUSTOMER_HISTORY_INITIAL_QUERY,
) =>
  queryOptions({
    queryKey: queryKeys.customers.history(id, params),
    queryFn: () => getCustomerHistory({ data: { id, ...params } }),
    staleTime: 0,
  });
