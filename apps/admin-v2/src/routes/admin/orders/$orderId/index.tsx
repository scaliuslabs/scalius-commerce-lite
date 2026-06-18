import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { OrderView } from "~/components/admin/OrderView";
import type { DeliveryProviderRecord } from "~/types/api-responses";
import type { Order } from "~/components/admin/orderview/types";
import {
  orderQueryOptions,
  orderShipmentsQueryOptions,
} from "~/lib/api-query-options/orders";
import { deliveryProvidersQueryOptions } from "~/lib/api-query-options/delivery";
import {
  ORDER_DETAIL_PREFETCH_STALE_MS,
  prefetchOrderDetailQueries,
} from "~/lib/order-detail-prefetch";
import { RouteErrorComponent } from "~/lib/route-error";
import type {
  OrderDetailDto,
  OrderShipmentDto,
} from "~/lib/api-functions/orders";
import type { OrderShipment, OrderTimestamp } from "~/components/admin/orderview/types";

type ShipmentMetadata = Record<string, unknown> | string | null;

function toOptionalString(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

function toTimestamp(
  value: unknown,
  fallback: OrderTimestamp = new Date().toISOString(),
): OrderTimestamp {
  return typeof value === "string" || typeof value === "number" || value instanceof Date
    ? value
    : fallback;
}

function toMetadata(value: unknown): ShipmentMetadata {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function toOrderShipment(shipment: OrderShipmentDto): OrderShipment {
  const raw = shipment as Record<string, unknown>;
  const createdAt = toTimestamp(raw.createdAt);
  const updatedAt = toTimestamp(raw.updatedAt, createdAt);
  return {
    id: shipment.id,
    orderId: shipment.orderId,
    providerId: shipment.providerId,
    providerType: shipment.providerType,
    providerName: shipment.providerName,
    externalId: shipment.externalId,
    trackingId: shipment.trackingId,
    trackingUrl:
      typeof raw.trackingUrl === "string" ? raw.trackingUrl : null,
    courierName:
      typeof raw.courierName === "string" ? raw.courierName : null,
    status: shipment.status,
    rawStatus: shipment.rawStatus,
    note: typeof raw.note === "string" ? raw.note : null,
    metadata: toMetadata(raw.metadata),
    shipmentItems:
      typeof raw.shipmentItems === "string" ? raw.shipmentItems : null,
    shipmentAmount:
      typeof raw.shipmentAmount === "number" ? raw.shipmentAmount : null,
    isFinalShipment:
      typeof raw.isFinalShipment === "boolean" ? raw.isFinalShipment : null,
    createdAt,
    updatedAt,
    lastChecked: shipment.lastChecked ?? updatedAt,
  };
}

function toOrderViewModel(
  order: OrderDetailDto,
  shipments: OrderShipmentDto[],
  deliveryProviders: DeliveryProviderRecord[],
): Order {
  return {
    id: order.id,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    customerEmail: order.customerEmail,
    shippingAddress: order.shippingAddress ?? "",
    city: order.city ?? "",
    zone: order.zone ?? "",
    area: order.area,
    notes: order.notes,
    discountAmount: order.discountAmount,
    shippingCharge: order.shippingCharge,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    items: order.items,
    totalAmount: order.totalAmount,
    customerId: order.customerId,
    cityName: toOptionalString(order.cityName),
    zoneName: toOptionalString(order.zoneName),
    areaName: order.areaName,
    shipments: shipments.map(toOrderShipment),
    deliveryProviders,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    paidAmount: order.paidAmount,
    balanceDue: order.balanceDue,
    fulfillmentStatus: order.fulfillmentStatus,
  };
}

export const Route = createFileRoute("/admin/orders/$orderId/")({
  loader: async ({ context: { queryClient }, params }) => {
    try {
      await prefetchOrderDetailQueries(queryClient, params.orderId);
    } catch {
      throw redirect({ to: "/admin/orders" });
    }
  },
  head: ({ params }) => ({
    meta: [{ title: `Order #${params.orderId} | Scalius Admin` }],
  }),
  errorComponent: RouteErrorComponent,
  component: OrderViewPage,
});

function OrderViewPage() {
  const { orderId } = Route.useParams();
  // Poll for webhook-driven updates (shipment status, payment confirmation)
  const { data: order } = useSuspenseQuery({
    ...orderQueryOptions(orderId),
    staleTime: ORDER_DETAIL_PREFETCH_STALE_MS,
    refetchInterval: 30_000,
  });
  const { data: shipments = [] } = useQuery({
    ...orderShipmentsQueryOptions(orderId),
    staleTime: ORDER_DETAIL_PREFETCH_STALE_MS,
    refetchInterval: 30_000,
  });
  const { data: providers = [] } = useQuery({
    ...deliveryProvidersQueryOptions(),
    staleTime: ORDER_DETAIL_PREFETCH_STALE_MS,
  });

  const fullOrder = useMemo(() => {
    if (!order) return null;
    const activeProviders = Array.isArray(providers)
      ? (providers as DeliveryProviderRecord[]).filter((p) => p.isActive)
      : [];
    return toOrderViewModel(order, shipments, activeProviders);
  }, [order, shipments, providers]);

  // fullOrder is guaranteed non-null — useSuspenseQuery ensures order exists
  return <OrderView order={fullOrder!} />;
}
