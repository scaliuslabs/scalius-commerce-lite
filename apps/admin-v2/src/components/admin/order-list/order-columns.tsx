import { Link, useNavigate } from "@tanstack/react-router";
import { Archive, ChevronRight, CircleAlert, Undo } from "lucide-react";
import type { OrderListItem } from "@scalius/core/modules/orders/browser";
import type { RealtimePresence } from "@scalius/shared/realtime";
import { RowPresence } from "~/components/admin/realtime/RowPresence";
import { formatPhoneForDisplay } from "@scalius/shared/phone-input";
import { getStoreRegion } from "~/lib/store-time-zone";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { cn } from "@scalius/shared/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { createSelectColumn } from "~/components/admin/data-table/columns/column-factories";
import { localeWidth } from "~/components/admin/data-table/column-layout";
import { DataTableRowActions } from "~/components/admin/data-table/DataTableRowActions";
import { statusBadgeVariant } from "~/components/admin/orderview/status-badges";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { useAppPaymentMethodNames } from "~/hooks/use-app-payment-method-names";
import { useCurrency } from "~/hooks/use-currency";
import { useOrderCurrency } from "~/hooks/use-order-currency";
import { useMessages } from "~/i18n";
import {
  fulfillmentStatusLabel,
  orderChannelText,
  orderMessages,
  paymentMethodLabel,
  paymentStatusLabel,
} from "~/i18n/orders";
import { resourceMessages } from "~/i18n/resource";
import { orderListMessages, type OrderListMessageKey } from "~/i18n/order-list";
import { shipmentStatusMessages } from "~/i18n/shipment-status";
import type { OrderActionPermissions } from "~/lib/order-action-permissions";
import { canRefreshShipment } from "~/lib/shipment-action-policy";
import { getAdminOrderStatusOptions } from "~/lib/admin-order-status-policy";
import { orderSkipReason } from "./order-bulk-actions";
import { LazyFraudCheckIndicator } from "./LazyFraudCheckIndicator";
import { LazyOrderItemsPopover } from "./LazyOrderItemsPopover";
import { LIST_DATE_WIDTH, ListDate } from "~/components/admin/data-table/ListDate";
import { OrderStatusSelector } from "./OrderStatusSelector";
import { shownText } from "~/lib/erased-text";
import { ShipmentRefreshButton } from "./ShipmentRefreshButton";
import {
  deliveryMethod,
  deliveryStatus,
  fulfilmentShown,
  orderAttention,
  orderNextStep,
  paymentShown,
  TONE_TEXT,
} from "./order-row-facts";

export interface OrderRowHandlers {
  showArchived: boolean;
  /** Rows show the time they are sorted by: last update when sorting by it, otherwise when placed. */
  dateField: "createdAt" | "updatedAt";
  selectable: boolean;
  orderActions: OrderActionPermissions;
  updatingStatusIds: ReadonlySet<string>;
  presence?: ReadonlyMap<string, RealtimePresence[]>;
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

/** A cell's text: one line, cut with an ellipsis, the whole value on hover. */
function Line({ text, className }: { text: string; className?: string }) {
  return <span data-part="value" className={cn("block truncate", className)} title={text}>{text}</span>;
}

/** An empty cell says so the same way on every row. */
function Empty() {
  return <span data-part="value" className="block whitespace-nowrap text-muted-foreground" aria-hidden="true">—</span>;
}

export function OrderNumberLink({ order }: { order: OrderName }) {
  return (
    <Link
      to="/admin/orders/$orderId"
      params={{ orderId: order.id }}
      data-part="number"
      className="whitespace-nowrap rounded-sm font-mono text-body font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {orderName(order)}
    </Link>
  );
}

/**
 * One marker for everything that holds the order up (a failed online payment,
 * a stuck refund or courier booking, a customer request, money owed back, a
 * failed delivery), with the words in its label. The slot is there on every
 * row, so a row with something to do is never wider or taller.
 */
export function AttentionMarker({ order, plain = false }: {
  order: OrderListItem;
  /** Inside a link (the phone card): the icon only, its words are on the card's last line. */
  plain?: boolean;
}) {
  const t = useMessages(orderListMessages);
  const o = useMessages(orderMessages);
  const items = orderAttention(order, t, o);
  if (items.length === 0) return <span data-part="attention" className="size-4 shrink-0" aria-hidden="true" />;
  const text = items.map((item) => item.text).join(" · ");
  const tone = items[0]!.tone === "critical" ? "text-destructive" : "text-warning";
  if (plain) {
    return (
      <span data-part="attention" className={cn("flex size-4 shrink-0 items-center", tone)} aria-hidden="true">
        <CircleAlert className="size-4" />
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-part="attention"
          tabIndex={0}
          role="img"
          aria-label={text}
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            tone,
          )}
        >
          <CircleAlert aria-hidden="true" className="size-4" />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <ul>
          {items.map((item) => <li key={item.text}>{item.text}</li>)}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

function OrderCell({ order, people }: { order: OrderListItem; people?: readonly RealtimePresence[] }) {
  return (
    <div data-part="order" className="flex min-w-0 flex-col">
      <span className="flex items-center gap-1.5">
        <OrderNumberLink order={order} />
        <AttentionMarker order={order} />
      </span>
      <RowPresence people={people} className="max-w-20" />
    </div>
  );
}

function CustomerCell({ order }: { order: OrderListItem }) {
  const o = useMessages(orderMessages);
  return (
    <div data-part="customer" className="flex items-center gap-1">
      {/* Two lines on every row, even without a name or a phone. */}
      <div className="min-w-0 flex-1">
        <Line text={shownText(order.customerName, o("erasedCustomer"))} className="font-medium" />
        {order.customerPhone ? (
          <Line text={formatPhoneForDisplay(order.customerPhone, getStoreRegion())} className="font-mono text-muted-foreground" />
        ) : (
          <Line text={order.customerEmail ?? ""} className="text-muted-foreground" />
        )}
      </div>
      {/* The courier history check needs a phone; an order placed without one shows none. */}
      {order.customerPhone ? (
        <LazyFraudCheckIndicator phone={order.customerPhone} customerName={order.customerName} countryCode={order.shippingCountryCode} compact />
      ) : null}
    </div>
  );
}

function TotalCell({ order }: { order: OrderListItem }) {
  const { fmtIn } = useOrderCurrency();
  return (
    <div data-part="total">
      {/* In the order's own currency (a market's, MARKETS-DESIGN step 6). */}
      <span data-part="value" className="block whitespace-nowrap font-medium tabular-nums">{fmtIn(order.totalAmount, order.currencyCode)}</span>
    </div>
  );
}

/** The payment badge (its method on hover), or an empty cell on a closed order. */
export function PaymentCell({ order }: { order: Pick<OrderListItem, "status" | "paymentStatus" | "paymentMethod"> }) {
  const t = useMessages(orderMessages);
  const status = paymentShown(order);
  if (!status) return <Empty />;
  // An app's method (`<plugin id>:<provider id>`) is named by its provider; only those rows read the names.
  if (isQualifiedProviderId(order.paymentMethod)) return <AppPaymentBadge status={status} method={order.paymentMethod} />;
  return (
    <Badge data-part="value" variant={statusBadgeVariant(status, "payment")} title={paymentMethodLabel(t, order.paymentMethod)}>
      {paymentStatusLabel(t, status, order.paymentMethod)}
    </Badge>
  );
}

function AppPaymentBadge({ status, method }: { status: string; method: string }) {
  const t = useMessages(orderMessages);
  const appNames = useAppPaymentMethodNames(true);
  return (
    <Badge data-part="value" variant={statusBadgeVariant(status, "payment")} title={paymentMethodLabel(t, method, appNames)}>
      {paymentStatusLabel(t, status, method)}
    </Badge>
  );
}

/** Fulfilment ("Ready for pickup" once staff said so), or an empty cell on a closed order. */
export function FulfilmentCell({ order }: { order: Pick<OrderListItem, "status" | "fulfillmentStatus" | "shippingMethodKind" | "pickupReadyAt"> }) {
  const t = useMessages(orderMessages);
  const shown = fulfilmentShown(order);
  if (!shown) return <Empty />;
  if (shown === "readyForPickup") return <Badge data-part="value" variant="info">{t("delivery.readyForPickup")}</Badge>;
  return (
    <Badge data-part="value" variant={statusBadgeVariant(shown, "fulfillment")}>
      {fulfillmentStatusLabel(t, shown)}
    </Badge>
  );
}

/** The courier's word for the parcel (or what holds it up), with its refresh in a slot every row keeps. */
function DeliveryStatusCell({ order, handlers }: { order: OrderListItem; handlers: OrderRowHandlers }) {
  const t = useMessages(orderListMessages);
  const s = useMessages(shipmentStatusMessages);
  const status = deliveryStatus(order, t, s);
  const shipment = order.latestShipment;
  const locked = order.shipmentRecovery?.activeLock === true;
  const refreshable = Boolean(shipment) && handlers.orderActions.canManageOrderShipments && canRefreshShipment(shipment!);
  return (
    <div data-part="delivery" className="flex items-center gap-1">
      {status
        ? <Line text={status.text} className={cn("min-w-0 flex-1", TONE_TEXT[status.tone])} />
        : <span data-part="value" className="block min-w-0 flex-1 whitespace-nowrap text-muted-foreground" aria-hidden="true">—</span>}
      <span data-part="refresh" className="flex size-7 shrink-0 items-center justify-center">
        {refreshable ? (
          <ShipmentRefreshButton
            orderId={order.id}
            shipmentId={shipment!.id}
            disabledReason={locked ? t("block.shipment") : undefined}
            onUpdated={handlers.onShipmentRefreshed}
          />
        ) : null}
      </span>
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
  const t = useMessages(orderListMessages);
  const lockedReason = useStatusLockedReason(order, handlers);
  // Shipping and delivering are done on the order page: say so where the status menu stops at Cancelled.
  const step = orderNextStep(order);
  return (
    <div data-part="status" className="flex items-center">
      <OrderStatusSelector
        status={order.status}
        facts={order}
        isLoading={handlers.updatingStatusIds.has(order.id)}
        lockedReason={lockedReason}
        onStatusUpdate={(status) => handlers.onStatusUpdate(order, status)}
        openOrder={step && step !== "confirm" ? { orderId: order.id, label: t(`nextStep.${step}`) } : undefined}
      />
    </div>
  );
}

function OrderRowActions({ order, handlers }: { order: OrderListItem; handlers: OrderRowHandlers }) {
  const t = useMessages(orderListMessages);
  const tr = useMessages(resourceMessages);
  const navigate = useNavigate();
  const open = () => void navigate({ to: "/admin/orders/$orderId", params: { orderId: order.id } });
  const step = orderNextStep(order);
  // Confirming happens right here; the other steps need the order page, which opens on them.
  const locked = useStatusLockedReason(order, handlers);
  const canConfirm = step === "confirm" && !locked
    && getAdminOrderStatusOptions(order.status, order).some((option) => option.status === "confirmed" && option.block === null);
  const next = canConfirm
    ? { label: t("nextStep.confirm"), onClick: () => handlers.onStatusUpdate(order, "confirmed") }
    : step && step !== "confirm"
      ? { label: t(`nextStep.${step}`), onClick: open }
      : null;
  const others = [
    !handlers.showArchived && handlers.orderActions.canDeleteOrders && !orderSkipReason(order, "archive")
      ? { label: t("archive"), icon: Archive, onClick: () => handlers.onArchive(order) }
      : null,
    handlers.showArchived && handlers.orderActions.canRestoreOrders
      ? { label: t("unarchive"), icon: Undo, onClick: () => handlers.onRestore(order) }
      : null,
  ].filter((action) => action !== null);
  // The menu always lets you open the order. A menu of that one item is not a menu: it is a button.
  if (!next && others.length === 0) {
    const label = `${t("viewOrder")} ${orderName(order)}`;
    return (
      <span data-part="actions" className="block">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/admin/orders/$orderId" params={{ orderId: order.id }} aria-label={label} title={t("viewOrder")}>
            <ChevronRight className="size-4 rtl:rotate-180" aria-hidden="true" />
          </Link>
        </Button>
      </span>
    );
  }
  const actions = [...(next ? [next] : []), { label: t("viewOrder"), onClick: open }, ...others];
  return (
    <span data-part="actions" className="block">
      <DataTableRowActions extraActions={actions} menuLabel={`${tr("moreActions")} ${orderName(order)}`} />
    </span>
  );
}

/**
 * Each column's layout. `minWidth` is the widest its content gets in the
 * dashboard's language (longest badge, date, a capped name) plus the cell's
 * 6px each side, so fitting by it never overflows; `list-layout.test.tsx`
 * measures the content against these. `maxWidth` caps free text, which is
 * cut with an ellipsis there, the whole value on hover.
 */
export const ORDER_COLUMN_LAYOUT = {
  order: { primary: true, minWidth: { en: 104, bn: 108 } },
  // When the order came in identifies it with its number: never stepped aside.
  date: { keep: true, minWidth: LIST_DATE_WIDTH },
  customer: { priority: 96, maxWidth: 176, minWidth: 188 },
  channel: { priority: 40, maxWidth: 140, minWidth: 152 },
  // Money never steps aside (T8: ORD-3).
  total: { minWidth: 120, money: true },
  payment: { priority: 92, minWidth: { en: 136, bn: 178 } },
  fulfillment: { priority: 90, minWidth: { en: 132, bn: 156 } },
  // Payment over fulfilment in one cell, where the two don't fit side by side.
  paymentFulfillment: { priority: 92, minWidth: { en: 136, bn: 178 }, combines: ["payment", "fulfillment"] },
  items: { priority: 30, minWidth: { en: 100, bn: 108 }, numeric: true },
  deliveryStatus: { priority: 70, maxWidth: 176, minWidth: 188 },
  deliveryMethod: { priority: 20, maxWidth: 128, minWidth: 140 },
  status: { priority: 95, minWidth: { en: 112, bn: 148 } },
} as const;

type OrderColumnKey = keyof typeof ORDER_COLUMN_LAYOUT;

/**
 * Shopify's orders columns: Order (presence beneath its number), Date,
 * Customer (name over phone on every row), Channel, Total, Payment,
 * Fulfillment, Items, Delivery
 * status, Delivery method and Status, then any data-backed columns `extra`
 * (apps' fields). Badges are the same size everywhere; an empty cell reads
 * "—". Narrow screens drop the lowest priority first; Order and Date stay.
 */
export function getOrderColumns(handlers: OrderRowHandlers, extra: ColumnDef<OrderListItem, unknown>[] = []): ColumnDef<OrderListItem, unknown>[] {
  const column = (
    id: OrderColumnKey,
    cell: ColumnDef<OrderListItem, unknown>["cell"],
  ): ColumnDef<OrderListItem, unknown> => ({
    id,
    meta: { label: handlers.label?.(id), ...ORDER_COLUMN_LAYOUT[id], minWidth: localeWidth(ORDER_COLUMN_LAYOUT[id].minWidth) },
    header: () => <Title k={id} />,
    cell,
  });
  const columns: ColumnDef<OrderListItem, unknown>[] = [
    column("order", ({ row }) => <OrderCell order={row.original} people={handlers.presence?.get(row.original.id)} />),
    column("date", ({ row }) => (
      <div data-part="date">
        <ListDate value={row.original[handlers.dateField]} className="block" />
      </div>
    )),
    column("customer", ({ row }) => <CustomerCell order={row.original} />),
    column("channel", ({ row }) => <ChannelCell order={row.original} />),
    column("total", ({ row }) => <TotalCell order={row.original} />),
    column("payment", ({ row }) => <div data-part="payment"><PaymentCell order={row.original} /></div>),
    column("fulfillment", ({ row }) => <div data-part="fulfillment"><FulfilmentCell order={row.original} /></div>),
    column("paymentFulfillment", ({ row }) => (
      <div data-part="payment-fulfillment" className="flex flex-col items-start">
        <PaymentCell order={row.original} />
        <FulfilmentCell order={row.original} />
      </div>
    )),
    column("items", ({ row }) => (
      <div data-part="items" className="flex justify-end tabular-nums">
        <LazyOrderItemsPopover orderId={row.original.id} itemCount={row.original.itemCount} />
      </div>
    )),
    column("deliveryStatus", ({ row }) => <DeliveryStatusCell order={row.original} handlers={handlers} />),
    column("deliveryMethod", ({ row }) => <DeliveryMethodCell order={row.original} />),
    column("status", ({ row }) => <StatusCell order={row.original} handlers={handlers} />),
    ...extra,
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

function ChannelCell({ order }: { order: OrderListItem }) {
  const o = useMessages(orderMessages);
  return <div data-part="channel"><Line text={orderChannelText(o, order.channel, order.channelSource)} /></div>;
}

function DeliveryMethodCell({ order }: { order: OrderListItem }) {
  const o = useMessages(orderMessages);
  return <div data-part="method"><Line text={deliveryMethod(order, o)} /></div>;
}
