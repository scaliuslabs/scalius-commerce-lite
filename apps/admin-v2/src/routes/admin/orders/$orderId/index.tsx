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
        queryClient.ensureQueryData(orderQueryOptions(params.orderId)),
        queryClient.ensureQueryData(orderShipmentsQueryOptions(params.orderId)),
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
  const { data: order } = useSuspenseQuery(orderQueryOptions(orderId));
  const { data: shipments } = useSuspenseQuery(orderShipmentsQueryOptions(orderId));
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

  if (!fullOrder) {
    return <div>Order not found</div>;
  }

  return <OrderView order={fullOrder} />;
}
