import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { OrderView } from "~/components/admin/OrderView";
import { Button } from "~/components/ui/button";
import { translate, useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { orderMessages } from "~/i18n/orders";
import { resourceMessages } from "~/i18n/resource";
import type {
  DeliveryProviderRecord,
} from "~/lib/api-query-options/delivery";
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
} from "~/lib/api-query-options/orders";
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
    shippingMethodId: order.shippingMethodId,
    shippingMethodName: order.shippingMethodName,
    shippingMethodDescription: order.shippingMethodDescription,
    shippingMethodBaseAmountMinor: order.shippingMethodBaseAmountMinor,
    shippingFeeWaived: order.shippingFeeWaived,
    discountAmountMinor: order.discountAmountMinor,
    taxAmountMinor: order.taxAmountMinor,
    totalAmountMinor: order.totalAmountMinor,
    taxLabel: order.taxLabel,
    pricesIncludeTax: order.pricesIncludeTax,
    promotion: order.promotion,
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
    amendmentReadiness: order.amendmentReadiness,
  };
}

export const Route = createFileRoute("/admin/orders/$orderId/")({
  loader: async ({ context: { queryClient }, params }) => {
    await prefetchOrderDetailQueries(queryClient, params.orderId);
  },
  head: ({ params }) => ({
    meta: [{ title: `${translate(orderMessages, "order", { id: params.orderId })} | Scalius` }],
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

function OrderDetailErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const t = useMessages(orderDetailMessages);
  const r = useMessages(resourceMessages);
  return (
    <section className="mx-auto max-w-xl space-y-4 rounded-lg border bg-card p-6">
      <div className="space-y-1">
        <h1 className="text-heading-lg font-semibold">{t("loadFailed")}</h1>
        {error.message ? <p className="text-body text-muted-foreground">{error.message}</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={reset}>{r("retry")}</Button>
        <Button asChild variant="outline">
          <Link to="/admin/orders">{t("backToOrders")}</Link>
        </Button>
      </div>
    </section>
  );
}
