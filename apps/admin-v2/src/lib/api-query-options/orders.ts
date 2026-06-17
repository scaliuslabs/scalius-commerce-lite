import { queryOptions } from "@tanstack/react-query";
import {
  getOrder,
  getOrderCod,
  getOrderFormData,
  getOrderItems,
  getOrders,
  getOrderPayments,
  getOrderShipments,
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

export const orderQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.orders.detail(id),
    queryFn: () => getOrder({ data: { id } }),
    staleTime: 0,
  });

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
