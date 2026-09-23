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

export const fetchCustomerHistory = (id: string, query: CustomerHistoryQuery) =>
  apiData(getApiV1AdminCustomersByIdHistory({ path: { id }, query }));
