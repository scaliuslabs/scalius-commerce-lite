import { memo } from "react";
import { Link } from "@tanstack/react-router";
import type { OrderListItem } from "@scalius/core/modules/orders/orders.types";
import { formatPhoneForDisplay } from "@scalius/shared/phone-input";
import { Checkbox } from "../../ui/checkbox";
import { useCurrency } from "@/hooks/use-currency";
import { Badge } from "../../ui/badge";
import { orderBadgeVisibility, statusBadgeVariant } from "~/components/admin/orderview/status-badges";
import { useMessages } from "~/i18n";
import { orderMessages, orderStatusLabel } from "~/i18n/orders";
import { orderListMessages } from "~/i18n/order-list";
import { resourceMessages } from "~/i18n/resource";
import { FulfillmentBadge, OrderAttentionBadges, orderName, PaymentBadge, useDeliveryOverride } from "./order-columns";
import { ListDate } from "./ListDate";

/** Cash the courier still has to collect for an open cash-on-delivery order, or 0. */
export function codToCollect(order: Pick<OrderListItem, "status" | "paymentMethod" | "paymentStatus" | "totalAmount" | "paidAmount">): number {
  if (order.paymentMethod !== "cod" || !orderBadgeVisibility(order).payment) return 0;
  if (order.paymentStatus !== "unpaid" && order.paymentStatus !== "partial") return 0;
  return Math.max(0, order.totalAmount - order.paidAmount);
}

/** Phone row: "#1001 · total", the customer and phone, then date, cash to collect and badges; tap opens the order. */
export const OrderMobileCard = memo(function OrderMobileCard({
  order,
  dateField,
  selectable,
  isSelected,
  onToggleSelection,
}: {
  order: OrderListItem;
  dateField: "createdAt" | "updatedAt";
  selectable: boolean;
  isSelected: boolean;
  onToggleSelection: () => void;
}) {
  const { fmt } = useCurrency();
  const t = useMessages(orderListMessages);
  const tr = useMessages(resourceMessages);
  const to = useMessages(orderMessages);
  const closed = !orderBadgeVisibility(order).payment;
  const collect = codToCollect(order);
  const deliveryOverride = useDeliveryOverride(order);
  return (
    <div className="flex items-start gap-1 py-1 pr-3">
      {selectable ? (
        // 44px touch target around the 16px box.
        <label className="flex size-11 shrink-0 items-center justify-center">
          <Checkbox
            checked={isSelected}
            onCheckedChange={onToggleSelection}
            aria-label={tr("select", { name: to("order", { number: orderName(order) }) })}
          />
        </label>
      ) : null}
      <Link
        to="/admin/orders/$orderId"
        params={{ orderId: order.id }}
        className="min-w-0 flex-1 space-y-1 rounded-sm py-2 pl-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-baseline justify-between gap-3 text-body">
          <span className="font-mono font-medium">{orderName(order)}</span>
          <span className="shrink-0 font-medium tabular-nums">{fmt(order.totalAmount)}</span>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-body">
          <span className="min-w-0 break-words">{order.customerName}</span>
          <span className="shrink-0 font-mono text-muted-foreground">{formatPhoneForDisplay(order.customerPhone)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <ListDate value={order[dateField]} className="mr-1 text-body text-muted-foreground" />
          {collect > 0 ? (
            <span className="mr-1 text-body tabular-nums">{t("codToCollect", { amount: fmt(collect) })}</span>
          ) : null}
          {closed ? (
            <Badge variant={statusBadgeVariant(order.status, "order")}>{orderStatusLabel(to, order.status)}</Badge>
          ) : null}
          <OrderAttentionBadges order={order} />
          <PaymentBadge order={order} />
          <FulfillmentBadge order={order} />
          {/* A closed order's status badge already says "Returned". */}
          {deliveryOverride && !closed ? <Badge variant="destructive">{deliveryOverride}</Badge> : null}
        </div>
      </Link>
    </div>
  );
});
