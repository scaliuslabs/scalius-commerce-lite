import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { OrderView } from "~/components/admin/OrderView";
import type { DeliveryProviderRecord } from "~/types/api-responses";
import type { Order } from "~/components/admin/orderview/types";
import {
  orderQueryOptions,
  orderShipmentsQueryOptions,
  deliveryProvidersQueryOptions,
} from "~/lib/api.queries";

export const Route = createFileRoute("/admin/orders/$orderId/")({
  loader: async ({ context: { queryClient }, params }) => {
    try {
      await Promise.all([
        queryClient.ensureQueryData({ ...orderQueryOptions(params.orderId), staleTime: Infinity }),
        queryClient.ensureQueryData({ ...orderShipmentsQueryOptions(params.orderId), staleTime: Infinity }),
        queryClient.ensureQueryData(deliveryProvidersQueryOptions()),
      ]);
    } catch {
      throw redirect({ to: "/admin/orders" });
    }
  },
  head: ({ params }) => ({
    meta: [{ title: `Order #${params.orderId} | Scalius Admin` }],
  }),
  component: OrderViewPage,
});

function OrderViewPage() {
  const { orderId } = Route.useParams();
  // Poll for webhook-driven updates (shipment status, payment confirmation)
  const { data: order } = useSuspenseQuery({
    ...orderQueryOptions(orderId),
    refetchInterval: 30_000,
  });
  const { data: shipments } = useSuspenseQuery({
    ...orderShipmentsQueryOptions(orderId),
    refetchInterval: 30_000,
  });
  const { data: providers } = useSuspenseQuery(deliveryProvidersQueryOptions());

  const fullOrder = useMemo(() => {
    if (!order) return null;
    const activeProviders = Array.isArray(providers)
      ? (providers as DeliveryProviderRecord[]).filter((p) => p.isActive)
      : [];
    return {
      ...(order as Record<string, unknown>),
      shipments: Array.isArray(shipments) ? shipments : [],
      deliveryProviders: activeProviders,
    } as Order;
  }, [order, shipments, providers]);

  // fullOrder is guaranteed non-null — useSuspenseQuery ensures order exists
  return <OrderView order={fullOrder!} />;
}
