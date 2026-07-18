import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  getOrderCatalogProducts,
  getOrder,
  getOrderCod,
  getOrderFormData,
  getOrderItems,
  getOrderNotifications,
  getOrders,
  getOrderPayments,
  getOrderReturns,
  getOrderShipments,
  type OrdersQueryInput,
} from "../api-functions/orders";
import { queryKeys } from "../query-keys";

const FAST_STALE_TIME_MS = 1000 * 30;
const ORDER_CATALOG_STALE_TIME_MS = 1000 * 60 * 2;

export const ordersQueryOptions = (params: OrdersQueryInput) =>
  queryOptions({
    queryKey: queryKeys.orders.list(params),
    queryFn: () => getOrders({ data: params }),
    staleTime: FAST_STALE_TIME_MS,
  });

export const orderQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.orders.detail(id),
    queryFn: () => getOrder({ data: { id } }),
    staleTime: 0,
  });

export const orderCatalogProductsQueryOptions = (input: {
  search?: string;
  limit?: number;
}) => {
  const search = input.search?.trim() ?? "";
  const limit = input.limit ?? 10;
  return infiniteQueryOptions({
    queryKey: queryKeys.orders.catalogProducts({ search, limit }),
    queryFn: ({ pageParam }) =>
      getOrderCatalogProducts({ data: { page: pageParam, limit, search } }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.pagination.page < lastPage.pagination.totalPages
        ? lastPage.pagination.page + 1
        : undefined,
    staleTime: ORDER_CATALOG_STALE_TIME_MS,
  });
};

export const orderFormDataQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.orders.formData(id),
    queryFn: () => getOrderFormData({ data: { id } }),
    staleTime: 0,
  });

export const orderItemsQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: queryKeys.orders.items(orderId),
    queryFn: () => getOrderItems({ data: { orderId } }),
    staleTime: FAST_STALE_TIME_MS,
  });

export const orderPaymentsQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: queryKeys.orders.payments(orderId),
    queryFn: () => getOrderPayments({ data: { orderId } }),
    staleTime: 0,
  });

export const orderNotificationsQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: queryKeys.orders.notifications(orderId),
    queryFn: () => getOrderNotifications({ data: { orderId } }),
    staleTime: 0,
  });

export const orderReturnsQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: queryKeys.orders.returns(orderId),
    queryFn: () => getOrderReturns({ data: { orderId } }),
    staleTime: 0,
  });

export const orderCodQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: queryKeys.orders.cod(orderId),
    queryFn: () => getOrderCod({ data: { orderId } }),
    staleTime: 0,
  });

export const orderShipmentsQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: queryKeys.orders.shipments(orderId),
    queryFn: () => getOrderShipments({ data: { orderId } }),
    staleTime: 0,
  });
