import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { OrderView } from "~/components/admin/OrderView";
import { Button } from "~/components/ui/button";
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
import type {
  OrderDetailDto,
  OrderShipmentDto,
} from "~/lib/api-functions/orders";
import type { OrderShipment, OrderTimestamp } from "~/components/admin/orderview/types";
import { useHydrated } from "~/hooks/use-hydrated";
import {
  resolveOrderOperationalReadState,
  type OrderOperationalReadState,
} from "~/lib/order-operational-read-state";

type ShipmentMetadata = Record<string, unknown> | string | null;

function toOptionalString(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

function toTimestamp(
  value: unknown,
  fallback: OrderTimestamp,
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

function toOrderShipment(
  shipment: OrderShipmentDto,
  fallbackTimestamp: OrderTimestamp,
): OrderShipment {
  const raw = shipment as Record<string, unknown>;
  const createdAt = toTimestamp(raw.createdAt, fallbackTimestamp);
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
  operationalReads: {
    shipments: OrderOperationalReadState;
    deliveryProviders: OrderOperationalReadState;
  },
): Order {
  return {
    id: order.id,
    version: order.version,
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
    currencyCode: order.currencyCode,
    currencyDecimalPlaces: order.currencyDecimalPlaces,
    subtotalAmountMinor: order.subtotalAmountMinor,
    shippingAmountMinor: order.shippingAmountMinor,
    discountAmountMinor: order.discountAmountMinor,
    taxAmountMinor: order.taxAmountMinor,
    totalAmountMinor: order.totalAmountMinor,
    taxLabel: order.taxLabel,
    pricesIncludeTax: order.pricesIncludeTax,
    customerId: order.customerId,
    cityName: toOptionalString(order.cityName),
    zoneName: toOptionalString(order.zoneName),
    areaName: order.areaName,
    shipments: shipments.map((shipment) => toOrderShipment(shipment, order.createdAt)),
    deliveryProviders,
    operationalReads,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    paidAmount: order.paidAmount,
    balanceDue: order.balanceDue,
    fulfillmentStatus: order.fulfillmentStatus,
    refundAttempts: order.refundAttempts,
    activeRefundOperation: order.activeRefundOperation,
    shipmentRecovery: order.shipmentRecovery,
    paymentRecovery: order.paymentRecovery,
    supportRequests: order.supportRequests ?? [],
    fullEditReadiness: order.fullEditReadiness,
  };
}

export const Route = createFileRoute("/admin/orders/$orderId/")({
  loader: async ({ context: { queryClient }, params }) => {
    await prefetchOrderDetailQueries(queryClient, params.orderId);
  },
  head: ({ params }) => ({
    meta: [{ title: `Order #${params.orderId} | Scalius Admin` }],
  }),
  errorComponent: OrderDetailErrorComponent,
  component: OrderViewPage,
});

function OrderViewPage() {
  const { orderId } = Route.useParams();
  const isHydrated = useHydrated();
  // Poll for webhook-driven updates (shipment status, payment confirmation)
  const { data: order } = useSuspenseQuery({
    ...orderQueryOptions(orderId),
    staleTime: ORDER_DETAIL_PREFETCH_STALE_MS,
    refetchInterval: 30_000,
  });
  const shipmentsQuery = useQuery({
    ...orderShipmentsQueryOptions(orderId),
    enabled: isHydrated,
    staleTime: ORDER_DETAIL_PREFETCH_STALE_MS,
    refetchInterval: 30_000,
  });
  const providersQuery = useQuery({
    ...deliveryProvidersQueryOptions(),
    enabled: isHydrated,
    staleTime: ORDER_DETAIL_PREFETCH_STALE_MS,
  });

  const fullOrder = useMemo(() => {
    const hydratedShipments = isHydrated && Array.isArray(shipmentsQuery.data)
      ? shipmentsQuery.data
      : [];
    const activeProviders = isHydrated && Array.isArray(providersQuery.data)
      ? (providersQuery.data as DeliveryProviderRecord[]).filter((p) => p.isActive)
      : [];
    return toOrderViewModel(order, hydratedShipments, activeProviders, {
      shipments: resolveOrderOperationalReadState({
        hydrated: isHydrated,
        loading: shipmentsQuery.isLoading,
        error: shipmentsQuery.isError,
        fetching: shipmentsQuery.isFetching,
        hasData: shipmentsQuery.data !== undefined,
      }),
      deliveryProviders: resolveOrderOperationalReadState({
        hydrated: isHydrated,
        loading: providersQuery.isLoading,
        error: providersQuery.isError,
        fetching: providersQuery.isFetching,
        hasData: providersQuery.data !== undefined,
      }),
    });
  }, [
    isHydrated,
    order,
    providersQuery.data,
    providersQuery.isError,
    providersQuery.isFetching,
    providersQuery.isLoading,
    shipmentsQuery.data,
    shipmentsQuery.isError,
    shipmentsQuery.isFetching,
    shipmentsQuery.isLoading,
  ]);

  return <OrderView order={fullOrder} />;
}

function OrderDetailErrorComponent({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <section className="mx-auto max-w-xl rounded-lg border bg-card p-6 shadow-sm">
      <h1 className="text-lg font-semibold">Order could not be loaded</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {error.message || "The order detail service did not return a usable response."}
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={reset}>
          Try again
        </Button>
        <Button asChild type="button" size="sm" variant="outline">
          <Link to="/admin/orders">Back to orders</Link>
        </Button>
      </div>
    </section>
  );
}
