import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { OrderView } from "~/components/admin/OrderView";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { resourceMessages } from "~/i18n/resource";
import type { DeliveryProviderRecord } from "~/lib/api-query-options/delivery";
import type { Order, OrderShipment, OrderTimestamp } from "~/components/admin/orderview/types";
import {
  orderQueryOptions,
  orderShipmentsQueryOptions,
  type OrderDetailDto,
  type OrderShipmentDto,
} from "~/lib/api-query-options/orders";
import { deliveryProvidersQueryOptions } from "~/lib/api-query-options/delivery";
import { isAdminApiNotFoundError } from "~/lib/admin-api-error";
import { useOrderListReturnHref } from "~/lib/order-list-return";
import {
  ORDER_DETAIL_PREFETCH_STALE_MS,
  prefetchOrderDetailQueries,
} from "~/lib/order-detail-prefetch";
import { getOrderActionPermissions } from "~/lib/order-action-permissions";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useHydrated } from "~/hooks/use-hydrated";
import {
  resolveOrderOperationalReadState,
  type OrderOperationalReadState,
} from "~/lib/order-operational-read-state";
import { titleHead } from "~/i18n/page-titles";

function toOrderShipment(shipment: OrderShipmentDto, fallbackTimestamp: OrderTimestamp): OrderShipment {
  const raw = shipment as Record<string, unknown>;
  const createdAt = typeof raw.createdAt === "string" || typeof raw.createdAt === "number"
    ? raw.createdAt
    : fallbackTimestamp;
  const updatedAt = typeof raw.updatedAt === "string" || typeof raw.updatedAt === "number"
    ? raw.updatedAt
    : createdAt;
  const metadata = raw.metadata;
  return {
    id: shipment.id,
    orderId: shipment.orderId,
    providerId: shipment.providerId,
    providerType: shipment.providerType,
    providerName: shipment.providerName,
    externalId: shipment.externalId,
    trackingId: shipment.trackingId,
    trackingUrl: typeof raw.trackingUrl === "string" ? raw.trackingUrl : null,
    courierName: typeof raw.courierName === "string" ? raw.courierName : null,
    status: shipment.status,
    rawStatus: shipment.rawStatus,
    note: typeof raw.note === "string" ? raw.note : null,
    metadata: typeof metadata === "string" || (metadata && typeof metadata === "object" && !Array.isArray(metadata))
      ? metadata as OrderShipment["metadata"]
      : null,
    shipmentAmount: typeof raw.shipmentAmount === "number" ? raw.shipmentAmount : null,
    isFinalShipment: typeof raw.isFinalShipment === "boolean" ? raw.isFinalShipment : null,
    createdAt,
    updatedAt,
    lastChecked: shipment.lastChecked ?? updatedAt,
  };
}

function toOrderViewModel(
  order: OrderDetailDto,
  shipments: OrderShipmentDto[],
  deliveryProviders: DeliveryProviderRecord[],
  operationalReads: Order["operationalReads"],
): Order {
  return {
    ...order,
    shippingAddress: order.shippingAddress ?? "",
    city: order.city ?? "",
    zone: order.zone ?? "",
    cityName: order.cityName ?? undefined,
    zoneName: order.zoneName ?? undefined,
    supportRequests: order.supportRequests ?? [],
    shipments: shipments.map((shipment) => toOrderShipment(shipment, order.createdAt)),
    deliveryProviders,
    operationalReads,
  };
}

function readState(query: { isLoading: boolean; isError: boolean; isFetching: boolean; data: unknown }, hydrated: boolean): OrderOperationalReadState {
  return resolveOrderOperationalReadState({
    hydrated,
    loading: query.isLoading,
    error: query.isError,
    fetching: query.isFetching,
    hasData: query.data !== undefined,
  });
}

export const Route = createFileRoute("/admin/orders/$orderId/")({
  loader: async ({ context, params }) => {
    const { canManageOrderShipments } = getOrderActionPermissions(
      (permission) => context.isSuperAdmin || context.permissions.includes(permission),
    );
    const order = await prefetchOrderDetailQueries(context.queryClient, params.orderId, {
      couriers: canManageOrderShipments,
    });
    return { name: formatOrderNumber(order.orderNumber, order.id) };
  },
  head: ({ loaderData }) => titleHead(loaderData?.name ?? ""),
  errorComponent: OrderDetailErrorComponent,
  component: OrderViewPage,
});

function OrderViewPage() {
  const { orderId } = Route.useParams();
  const isHydrated = useHydrated();
  const { canManageOrderShipments } = useOrderActionPermissions();
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
  // The courier list is only readable by staff who can book couriers.
  const providersQuery = useQuery({
    ...deliveryProvidersQueryOptions(),
    enabled: isHydrated && canManageOrderShipments,
    staleTime: ORDER_DETAIL_PREFETCH_STALE_MS,
  });

  const { data: shipments, isLoading: shipmentsLoading, isError: shipmentsError, isFetching: shipmentsFetching } = shipmentsQuery;
  const { data: providers, isLoading: providersLoading, isError: providersError, isFetching: providersFetching } = providersQuery;
  const fullOrder = useMemo(() => toOrderViewModel(
    order,
    isHydrated && Array.isArray(shipments) ? shipments : [],
    isHydrated && Array.isArray(providers)
      ? (providers as DeliveryProviderRecord[]).filter((provider) => provider.isActive)
      : [],
    {
      shipments: readState({ data: shipments, isLoading: shipmentsLoading, isError: shipmentsError, isFetching: shipmentsFetching }, isHydrated),
      deliveryProviders: readState({ data: providers, isLoading: providersLoading, isError: providersError, isFetching: providersFetching }, isHydrated),
    },
  ), [
    isHydrated, order,
    shipments, shipmentsLoading, shipmentsError, shipmentsFetching,
    providers, providersLoading, providersError, providersFetching,
  ]);

  return <OrderView order={fullOrder} />;
}

/** A missing order can't be retried; an unreachable server can. */
function OrderDetailErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const t = useMessages(orderDetailMessages);
  const r = useMessages(resourceMessages);
  const router = useRouter();
  const backTo = useOrderListReturnHref();
  const notFound = isAdminApiNotFoundError(error);
  const status = (error as { status?: unknown }).status;
  const unreachable = !notFound && (typeof status !== "number" || status >= 500);
  return (
    <section className="mx-auto max-w-xl space-y-4 rounded-xl bg-card p-6 shadow-card">
      <div className="space-y-1">
        <h1 className="text-heading-lg font-semibold">
          {notFound ? t("notFound") : unreachable ? t("error.network") : t("loadFailed")}
        </h1>
        <p className="text-body text-muted-foreground">
          {notFound ? t("notFoundHelp") : unreachable ? t("error.networkHelp") : error.message}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {notFound ? null : (
          <Button type="button" onClick={() => { reset(); void router.invalidate(); }}>{r("retry")}</Button>
        )}
        <Button asChild variant={notFound ? "default" : "outline"}>
          <Link to={backTo}>{t("backToOrders")}</Link>
        </Button>
      </div>
    </section>
  );
}
