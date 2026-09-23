import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminCustomers,
  getApiV1AdminCustomersById,
  getApiV1AdminCustomersByIdHistory,
} from "@scalius/api-client/sdk";
import { apiData, type ApiQuery, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;

export type CustomersListPayload = ApiResult<typeof getApiV1AdminCustomers>;
export type CustomerDto = ApiResult<typeof getApiV1AdminCustomersById>;
export type CustomerHistoryPayload = ApiResult<typeof getApiV1AdminCustomersByIdHistory>;
export type CustomerHistoryCustomer = CustomerHistoryPayload["customer"];
export type CustomerHistoryRecord = CustomerHistoryPayload["history"][number];
export type CustomerOrderSummary = CustomerHistoryPayload["orders"][number];
export type CustomerHistoryPage = CustomerHistoryPayload["pagination"]["history"];
type CustomerHistoryQuery = ApiQuery<typeof getApiV1AdminCustomersByIdHistory>;

export const customersQueryOptions = (query: ApiQuery<typeof getApiV1AdminCustomers>) =>
  queryOptions({
    queryKey: queryKeys.customers.list(query),
    queryFn: () => apiData(getApiV1AdminCustomers({ query })),
    staleTime: MODERATE_STALE_TIME_MS,
  });

export const customerQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.customers.detail(id),
    queryFn: () => apiData(getApiV1AdminCustomersById({ path: { id } })),
    staleTime: 0,
  });

export const CUSTOMER_HISTORY_INITIAL_QUERY = {
  historyPage: 1,
  historyLimit: 20,
  ordersPage: 1,
  ordersLimit: 5,
} as const;

export const fetchCustomerHistory = (id: string, query: CustomerHistoryQuery) =>
  apiData(getApiV1AdminCustomersByIdHistory({
    path: { id },
    query: { ...CUSTOMER_HISTORY_INITIAL_QUERY, ...query },
  }));

export const customerHistoryQueryOptions = (
  id: string,
  query: CustomerHistoryQuery = CUSTOMER_HISTORY_INITIAL_QUERY,
) =>
  queryOptions({
    queryKey: queryKeys.customers.history(id, query),
    queryFn: () => fetchCustomerHistory(id, query),
    staleTime: 0,
  });
