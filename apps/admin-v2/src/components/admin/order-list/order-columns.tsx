import { Link } from "@tanstack/react-router";
import { Archive, Undo } from "lucide-react";
import type { OrderListItem } from "@scalius/core/modules/orders/orders.types";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { Badge } from "~/components/ui/badge";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { createSelectColumn } from "~/components/admin/data-table/columns/column-factories";
import { DataTableRowActions } from "~/components/admin/data-table/DataTableRowActions";
import { orderBadgeVisibility, statusBadgeVariant } from "~/components/admin/orderview/status-badges";
import ShipmentStatusIndicator from "~/components/admin/ShipmentStatusIndicator";
import { useCurrency } from "~/hooks/use-currency";
import { useMessages } from "~/i18n";
import {
  fulfillmentStatusLabel,
  orderMessages,
  paymentMethodLabel,
  paymentStatusLabel,
} from "~/i18n/orders";
import { resourceMessages } from "~/i18n/resource";
import { orderListMessages, type OrderListMessageKey } from "~/i18n/order-list";
import type { OrderActionPermissions } from "~/lib/order-action-permissions";
import { canRefreshShipment } from "~/lib/shipment-action-policy";
import { orderSkipReason } from "./order-bulk-actions";
import { LazyFraudCheckIndicator } from "./LazyFraudCheckIndicator";
import { LazyOrderItemsPopover } from "./LazyOrderItemsPopover";
import { ListDate } from "./ListDate";
import { OrderLockBadges } from "./OrderLockBadges";
import { OrderStatusSelector } from "./OrderStatusSelector";

export interface OrderRowHandlers {
  showArchived: boolean;
  /** Rows show the time they are sorted by: last update when sorting by it, otherwise when placed. */
  dateField: "createdAt" | "updatedAt";
  selectable: boolean;
  orderActions: OrderActionPermissions;
  updatingStatusIds: ReadonlySet<string>;
  onArchive: (order: OrderListItem) => void;
  onRestore: (order: OrderListItem) => void;
  onStatusUpdate: (order: OrderListItem, status: string) => void;
  onShipmentRefreshed: () => void;
  /** Column names for the column menu. */
  label?: (key: OrderListMessageKey) => string;
}

type OrderName = Pick<OrderListItem, "id" | "orderNumber">;

export const orderName = (order: OrderName) => formatOrderNumber(order.orderNumber, order.id);

function Title({ k }: { k: OrderListMessageKey }) {
  const t = useMessages(orderListMessages);
  return <>{t(k)}</>;
}

export function OrderNumberLink({ order }: { order: OrderName }) {
  return (
    <Link
      to="/admin/orders/$orderId"
      params={{ orderId: order.id }}
      className="rounded-sm font-mono text-body font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {orderName(order)}
    </Link>
  );
}

/** Payment badge; hidden (null) on closed orders, whose status badge already tells the story. */
export function PaymentBadge({ order }: { order: Pick<OrderListItem, "status" | "paymentStatus"> }) {
  const t = useMessages(orderMessages);
  if (!orderBadgeVisibility(order).payment) return null;
  return (
    <Badge variant={statusBadgeVariant(order.paymentStatus, "payment")}>
      {paymentStatusLabel(t, order.paymentStatus)}
    </Badge>
  );
}

export function FulfillmentBadge({ order }: { order: Pick<OrderListItem, "status" | "fulfillmentStatus"> }) {
  const t = useMessages(orderMessages);
  if (!orderBadgeVisibility(order).fulfillment) return null;
  return (
    <Badge variant={statusBadgeVariant(order.fulfillmentStatus, "fulfillment")}>
      {fulfillmentStatusLabel(t, order.fulfillmentStatus)}
    </Badge>
  );
}

/** What needs the merchant's attention: an open customer request or money owed back. */
export function OrderAttentionBadges({ order }: { order: Pick<OrderListItem, "openRequestType" | "refundDue"> }) {
  const t = useMessages(orderMessages);
  return (
    <>
      {order.openRequestType ? <Badge variant="attention">{t(`request.${order.openRequestType}`)}</Badge> : null}
      {order.refundDue > 0 ? <Badge variant="warning">{t("refundOwed")}</Badge> : null}
    </>
  );
}

/** Amount over its payment badge; the payment method is the badge's hover text, so rows stay two lines. */
function TotalCell({ order }: { order: OrderListItem }) {
  const { fmt } = useCurrency();
  const t = useMessages(orderMessages);
  return (
    <div className="space-y-1 text-right">
      <p className="font-medium tabular-nums">{fmt(order.totalAmount)}</p>
      {orderBadgeVisibility(order).payment ? (
        <span title={paymentMethodLabel(t, order.paymentMethod)} className="inline-flex">
          <PaymentBadge order={order} />
        </span>
      ) : null}
    </div>
  );
}

/**
 * What the order page says about delivery when the courier status is out of
 * date: a returned order reads "Returned" and a recorded failed cash-on-delivery
 * attempt "Delivery failed · attempt 1", never "In transit".
 */
export function useDeliveryOverride(order: Pick<OrderListItem, "status" | "cod">): string | undefined {
  const t = useMessages(orderListMessages);
  if (order.status.toLowerCase() === "returned") return t("shipment.returned");
  if (order.cod?.status === "failed") return t("deliveryFailed", { count: order.cod.deliveryAttempts });
  return undefined;
}

function FulfillmentCell({ order, handlers }: { order: OrderListItem; handlers: OrderRowHandlers }) {
  const t = useMessages(orderListMessages);
  const deliveryOverride = useDeliveryOverride(order);
  const shipment = order.latestShipment;
  const locked = order.shipmentRecovery?.activeLock === true;
  return (
    <div className="space-y-1">
      <FulfillmentBadge order={order} />
      {!shipment && !orderBadgeVisibility(order).fulfillment ? (
        <span className="text-muted-foreground">—</span>
      ) : null}
      {shipment ? (
        <ShipmentStatusIndicator
          shipment={{ id: shipment.id, status: shipment.status, orderId: order.id }}
          label={deliveryOverride}
          showLastChecked={false}
          canRefresh={
            handlers.orderActions.canManageOrderShipments
            && canRefreshShipment(shipment)
            && !locked
          }
          refreshDisabledReason={locked ? t("block.shipment") : undefined}
          onStatusUpdated={handlers.onShipmentRefreshed}
        />
      ) : null}
    </div>
  );
}

/** Why the order's status can't be changed from the list right now, if it can't. */
function useStatusLockedReason(order: OrderListItem, handlers: OrderRowHandlers): string | undefined {
  const t = useMessages(orderListMessages);
  const tr = useMessages(resourceMessages);
  if (handlers.showArchived) return t("restoreToChange");
  if (!handlers.orderActions.canChangeOrderStatus) return tr("readOnly");
  if (order.activeRefundOperation?.active) return t("block.refund");
  if (order.shipmentRecovery?.activeLock) return t("block.shipment");
  return undefined;
}

function StatusCell({ order, handlers }: { order: OrderListItem; handlers: OrderRowHandlers }) {
  const lockedReason = useStatusLockedReason(order, handlers);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <OrderStatusSelector
        status={order.status}
        facts={order}
        isLoading={handlers.updatingStatusIds.has(order.id)}
        lockedReason={lockedReason}
        onStatusUpdate={(status) => handlers.onStatusUpdate(order, status)}
      />
      <OrderAttentionBadges order={order} />
      <OrderLockBadges order={order} />
    </div>
  );
}

function OrderRowActions({ order, handlers }: { order: OrderListItem; handlers: OrderRowHandlers }) {
  const t = useMessages(orderListMessages);
  const tr = useMessages(resourceMessages);
  const actions = [
    !handlers.showArchived && handlers.orderActions.canDeleteOrders && !orderSkipReason(order, "archive")
      ? { label: t("archive"), icon: Archive, onClick: () => handlers.onArchive(order) }
      : null,
    handlers.showArchived && handlers.orderActions.canRestoreOrders
      ? { label: t("unarchive"), icon: Undo, onClick: () => handlers.onRestore(order) }
      : null,
  ].filter((action) => action !== null);
  if (actions.length === 0) return null;
  return <DataTableRowActions extraActions={actions} menuLabel={`${tr("moreActions")} ${orderName(order)}`} />;
}

export function getOrderColumns(handlers: OrderRowHandlers): ColumnDef<OrderListItem, unknown>[] {
  // Column menu names, and what gives way first on a narrow screen: Items, then
  // Fulfillment, then Total, Status and Customer; the order number never does.
  // Minimums are what the cells really need (date line, status pill, amount
  // over its payment badge), so columns step aside by priority, not by overflow.
  const meta = (key: OrderListMessageKey, layout: { priority?: number; minWidth: number; numeric?: boolean; primary?: boolean }) => ({
    label: handlers.label?.(key),
    ...layout,
  });
  const columns: ColumnDef<OrderListItem, unknown>[] = [
    {
      id: "order",
      meta: meta("order", { primary: true, minWidth: 130 }),
      header: () => <Title k="order" />,
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="whitespace-nowrap"><OrderNumberLink order={row.original} /></span>
          <ListDate value={row.original[handlers.dateField]} className="whitespace-nowrap text-body text-muted-foreground" />
        </div>
      ),
    },
    {
      id: "customer",
      meta: meta("customer", { priority: 96, minWidth: 160 }),
      header: () => <Title k="customer" />,
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="line-clamp-2 break-words font-medium">{row.original.customerName}</p>
          <div className="flex items-center gap-1 text-body text-muted-foreground">
            <span className="whitespace-nowrap font-mono">{formatPhoneForDisplay(row.original.customerPhone)}</span>
            <LazyFraudCheckIndicator phone={row.original.customerPhone} customerName={row.original.customerName} />
          </div>
        </div>
      ),
    },
    {
      id: "total",
      meta: meta("total", { priority: 94, minWidth: 110, numeric: true }),
      header: () => <Title k="total" />,
      cell: ({ row }) => <TotalCell order={row.original} />,
    },
    {
      id: "fulfillment",
      meta: meta("fulfillment", { priority: 60, minWidth: 150 }),
      header: () => <Title k="fulfillment" />,
      cell: ({ row }) => <FulfillmentCell order={row.original} handlers={handlers} />,
    },
    {
      id: "items",
      meta: meta("items", { priority: 30, minWidth: 100, numeric: true }),
      header: () => <Title k="items" />,
      cell: ({ row }) => (
        <div className="flex justify-end tabular-nums">
          <LazyOrderItemsPopover orderId={row.original.id} itemCount={row.original.itemCount} />
        </div>
      ),
    },
    {
      id: "status",
      meta: meta("status", { priority: 95, minWidth: 150 }),
      header: () => <Title k="status" />,
      cell: ({ row }) => <StatusCell order={row.original} handlers={handlers} />,
    },
    {
      id: "actions",
      header: () => null,
      cell: ({ row }) => <OrderRowActions order={row.original} handlers={handlers} />,
    },
  ];

  if (handlers.selectable) {
    columns.unshift(createSelectColumn<OrderListItem>({ getLabel: (row) => orderName(row as OrderListItem) }));
  }
  return columns;
}
