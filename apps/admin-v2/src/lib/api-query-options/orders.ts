import { queryOptions } from "@tanstack/react-query";
import {
  getOrders,
  type OrdersQueryInput,
} from "../api-functions/orders";
import { queryKeys } from "../query-keys";

const FAST_STALE_TIME_MS = 1000 * 30;

export const ordersQueryOptions = (params: OrdersQueryInput) =>
  queryOptions({
    queryKey: queryKeys.orders.list(params),
    queryFn: () => getOrders({ data: params }),
    staleTime: FAST_STALE_TIME_MS,
  });
