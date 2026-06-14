import type { QueryClient } from "@tanstack/react-query";
import {
  currencySettingsQueryOptions,
  deliveryProvidersQueryOptions,
  orderCodQueryOptions,
  orderPaymentsQueryOptions,
  orderQueryOptions,
  orderShipmentsQueryOptions,
} from "./api.queries";

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
    queryClient
      .prefetchQuery({ ...orderPaymentsQueryOptions(orderId), staleTime: Infinity })
      .catch((error) => {
        console.warn("Order payment prefetch skipped", error);
      }),
    queryClient
      .prefetchQuery(currencySettingsQueryOptions())
      .catch((error) => {
        console.warn("Order currency prefetch skipped", error);
      }),
  ];

  if (order.paymentMethod === "cod") {
    optionalWarmQueries.push(
      queryClient
        .prefetchQuery({ ...orderCodQueryOptions(orderId), staleTime: Infinity })
        .catch((error) => {
          console.warn("Order COD prefetch skipped", error);
        }),
    );
  }

  await Promise.all([
    queryClient.ensureQueryData({
      ...orderShipmentsQueryOptions(orderId),
      staleTime: Infinity,
    }),
    queryClient.ensureQueryData(deliveryProvidersQueryOptions()),
    ...optionalWarmQueries,
  ]);
}
