import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminOrders,
  getApiV1AdminOrdersById,
  getApiV1AdminOrdersByIdCod,
  getApiV1AdminOrdersByIdFormData,
  getApiV1AdminOrdersByIdItems,
  getApiV1AdminOrdersByIdNotifications,
  getApiV1AdminOrdersByIdPayments,
  getApiV1AdminOrdersByIdReturns,
  getApiV1AdminOrdersByIdShipments,
  getApiV1AdminOrdersByIdTimeline,
  getApiV1AdminOrdersCatalogProducts,
  type postApiV1AdminOrdersQuote,
} from "@scalius/api-client/sdk";
import { apiData, type ApiQuery, type ApiResult, type WithTimestamps } from "../api";
import { queryKeys } from "../query-keys";

const FAST_STALE_TIME_MS = 1000 * 30;
const ORDER_CATALOG_STALE_TIME_MS = 1000 * 60 * 2;

export type OrdersQuery = ApiQuery<typeof getApiV1AdminOrders>;
export type OrdersListPayload = ApiResult<typeof getApiV1AdminOrders>;
export type OrderDetailDto = ApiResult<typeof getApiV1AdminOrdersById>;
export type OrderItemDto = ApiResult<typeof getApiV1AdminOrdersByIdItems>[number];
export type OrderShipmentDto = ApiResult<typeof getApiV1AdminOrdersByIdShipments>[number];
export type OrderPaymentsPayload = ApiResult<typeof getApiV1AdminOrdersByIdPayments>;
export type OrderTimelineEvent = ApiResult<typeof getApiV1AdminOrdersByIdTimeline>["events"][number];
export type ManualOrderQuotePayload = ApiResult<typeof postApiV1AdminOrdersQuote>;

type ApiNotification =
  ApiResult<typeof getApiV1AdminOrdersByIdNotifications>["notifications"][number];
export type OrderNotificationReceiptDto = WithTimestamps<
  ApiNotification["receipts"][number],
  "nextAttemptAt" | "lastAttemptAt" | "acceptedAt" | "deliveredAt" | "failedAt" | "skippedAt"
>;
export type OrderNotificationOutboxDto = WithTimestamps<
  Omit<ApiNotification, "receipts">,
  "queuedAt" | "sentAt"
> & { receipts: OrderNotificationReceiptDto[] };

export const getOrderItems = (orderId: string) =>
  apiData(getApiV1AdminOrdersByIdItems({ path: { id: orderId } }));

export const ordersQueryOptions = (query: OrdersQuery) =>
  queryOptions({
    queryKey: queryKeys.orders.list(query),
    queryFn: () => apiData(getApiV1AdminOrders({ query })),
    staleTime: FAST_STALE_TIME_MS,
  });

export const orderQueryOptions = (id: string) =>
  queryOptions({
    queryKey: queryKeys.orders.detail(id),
    queryFn: () => apiData(getApiV1AdminOrdersById({ path: { id } })),
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
      apiData(getApiV1AdminOrdersCatalogProducts({
        query: { page: pageParam, limit, search: search || undefined },
      })),
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
    queryFn: () => apiData(getApiV1AdminOrdersByIdFormData({ path: { id } })),
    staleTime: 0,
  });

export const orderPaymentsQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: queryKeys.orders.payments(orderId),
    queryFn: () => apiData(getApiV1AdminOrdersByIdPayments({ path: { id: orderId } })),
    staleTime: 0,
  });

export const orderNotificationsQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: queryKeys.orders.notifications(orderId),
    queryFn: async () =>
      (await apiData(getApiV1AdminOrdersByIdNotifications({ path: { id: orderId } }))) as {
        notifications: OrderNotificationOutboxDto[];
      },
    staleTime: 0,
  });

export const orderReturnsQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: queryKeys.orders.returns(orderId),
    queryFn: () => apiData(getApiV1AdminOrdersByIdReturns({ path: { id: orderId } })),
    staleTime: 0,
  });

export const orderCodQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: queryKeys.orders.cod(orderId),
    queryFn: () => apiData(getApiV1AdminOrdersByIdCod({ path: { id: orderId } })),
    staleTime: 0,
  });

export const orderShipmentsQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: queryKeys.orders.shipments(orderId),
    queryFn: () => apiData(getApiV1AdminOrdersByIdShipments({ path: { id: orderId } })),
    staleTime: 0,
  });

/** Staff comments and what happened to the order, newest first. */
export const orderTimelineQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: ["orders", "timeline", orderId] as const,
    queryFn: () => apiData(getApiV1AdminOrdersByIdTimeline({ path: { id: orderId } })),
    staleTime: 0,
  });
