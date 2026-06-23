import type { QueryClient } from "@tanstack/react-query";
import { currencySettingsQueryOptions } from "./api-query-options/currency";
import { deliveryProvidersQueryOptions } from "./api-query-options/delivery";
import {
  orderCodQueryOptions,
  orderPaymentsQueryOptions,
  orderQueryOptions,
  orderShipmentsQueryOptions,
} from "./api-query-options/orders";

type OrderDetailQueryClient = Pick<QueryClient, "ensureQueryData" | "prefetchQuery">;

export const ORDER_DETAIL_PREFETCH_STALE_MS = 30_000;

export async function prefetchOrderDetailQueries(
  queryClient: OrderDetailQueryClient,
  orderId: string,
) {
  const order = await queryClient.ensureQueryData({
    ...orderQueryOptions(orderId),
    staleTime: Infinity,
  });

  const optionalWarmQueries = [
    queryClient.prefetchQuery({
      ...orderShipmentsQueryOptions(orderId),
      staleTime: Infinity,
    }),
    queryClient.prefetchQuery({
      ...orderPaymentsQueryOptions(orderId),
      staleTime: Infinity,
    }),
    queryClient.prefetchQuery(currencySettingsQueryOptions()),
    queryClient.prefetchQuery(deliveryProvidersQueryOptions()),
  ];

  if (order.paymentMethod === "cod") {
    optionalWarmQueries.push(
      queryClient.prefetchQuery({
        ...orderCodQueryOptions(orderId),
        staleTime: Infinity,
      }),
    );
  }

  for (const query of optionalWarmQueries) {
    void query.catch((error) => {
      console.warn("Order detail warm query skipped", error);
    });
  }
}
