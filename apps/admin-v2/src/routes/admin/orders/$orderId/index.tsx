import { createFileRoute, redirect } from "@tanstack/react-router";
import { OrderView } from "~/components/admin/OrderView";
import { getOrder, getOrderShipments, getDeliveryProviders } from "~/lib/api.functions";

export const Route = createFileRoute("/admin/orders/$orderId/")({
  loader: async ({ params }) => {
    const [orderResult, shipments, providers] = await Promise.all([
      getOrder({ data: { id: params.orderId } }).catch(() => null),
      getOrderShipments({ data: { orderId: params.orderId } }).catch(() => []),
      getDeliveryProviders().catch(() => []),
    ]);
    if (!orderResult) throw redirect({ to: "/admin/orders" });
    const o = orderResult as any;
    const activeProviders = Array.isArray(providers) ? (providers as any[]).filter((p: any) => p.isActive) : [];
    return {
      order: o,
      items: o.items || [],
      totalAmount: o.totalAmount,
      cityName: o.cityName || "",
      zoneName: o.zoneName || "",
      areaName: o.areaName || null,
      shipments: Array.isArray(shipments) ? shipments : [],
      deliveryProviders: activeProviders,
    };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `Order #${loaderData?.order?.id || ""} | Scalius Admin` }],
  }),
  component: OrderViewPage,
});

function OrderViewPage() {
  const data = Route.useLoaderData();

  if (!data.order) {
    return <div>Order not found</div>;
  }

  return <OrderView order={data.order} />;
}
