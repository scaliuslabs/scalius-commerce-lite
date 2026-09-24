import type { QueryClient } from "@tanstack/react-query";
import { currencySettingsQueryOptions } from "./api-query-options/currency";
import { deliveryProvidersQueryOptions } from "./api-query-options/delivery";
import {
  orderCodQueryOptions,
  orderNotificationsQueryOptions,
  orderPaymentsQueryOptions,
  orderQueryOptions,
  orderReturnsQueryOptions,
  orderShipmentsQueryOptions,
  orderTimelineQueryOptions,
} from "./api-query-options/orders";

type OrderDetailQueryClient = Pick<QueryClient, "ensureQueryData" | "prefetchQuery">;

export const ORDER_DETAIL_PREFETCH_STALE_MS = 30_000;

function warm(query: Promise<unknown>) {
  void query.catch((error) => {
    console.warn("Order detail warm query skipped", error);
  });
}

/**
 * Loads the order (required) and, in the same round trip, every read its
 * cards need, so the page arrives whole instead of card by card. The courier
 * list is only readable by staff who can book couriers, so it is skipped for
 * everyone else instead of failing with a 403. Cash on delivery tracking is
 * read once the order says it is a COD order.
 */
export async function prefetchOrderDetailQueries(
  queryClient: OrderDetailQueryClient,
  orderId: string,
  options: { couriers: boolean },
) {
  const order = queryClient.ensureQueryData({
    ...orderQueryOptions(orderId),
    staleTime: Infinity,
  });

  warm(queryClient.prefetchQuery({ ...orderShipmentsQueryOptions(orderId), staleTime: Infinity }));
  warm(queryClient.prefetchQuery({ ...orderPaymentsQueryOptions(orderId), staleTime: Infinity }));
  warm(queryClient.prefetchQuery({ ...orderReturnsQueryOptions(orderId), staleTime: ORDER_DETAIL_PREFETCH_STALE_MS }));
  warm(queryClient.prefetchQuery({ ...orderNotificationsQueryOptions(orderId), staleTime: ORDER_DETAIL_PREFETCH_STALE_MS }));
  warm(queryClient.prefetchQuery({ ...orderTimelineQueryOptions(orderId), staleTime: ORDER_DETAIL_PREFETCH_STALE_MS }));
  warm(queryClient.prefetchQuery(currencySettingsQueryOptions()));
  if (options.couriers) warm(queryClient.prefetchQuery(deliveryProvidersQueryOptions()));

  const loaded = await order;
  if (loaded.paymentMethod === "cod") {
    warm(queryClient.prefetchQuery({ ...orderCodQueryOptions(orderId), staleTime: Infinity }));
  }
  return loaded;
}
