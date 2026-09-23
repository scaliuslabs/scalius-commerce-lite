import { memo } from "react";
import { Link } from "@tanstack/react-router";
import type { OrderListItem } from "@scalius/core/modules/orders/orders.types";
import { Checkbox } from "../../ui/checkbox";
import { useCurrency } from "@/hooks/use-currency";
import { Badge } from "../../ui/badge";
import { orderBadgeVisibility, statusBadgeVariant } from "~/components/admin/orderview/status-badges";
import { useMessages } from "~/i18n";
import { orderMessages, orderStatusLabel } from "~/i18n/orders";
import { resourceMessages } from "~/i18n/resource";
import { FulfillmentBadge, PaymentBadge } from "./order-columns";
import { ListDate } from "./ListDate";

/** Phone row: "#id · total", then the customer, then date and badges; tap opens the order. */
export const OrderMobileCard = memo(function OrderMobileCard({
  order,
  selectable,
  isSelected,
  onToggleSelection,
}: {
  order: OrderListItem;
  selectable: boolean;
  isSelected: boolean;
  onToggleSelection: () => void;
}) {
  const { fmt } = useCurrency();
  const tr = useMessages(resourceMessages);
  const to = useMessages(orderMessages);
  const closed = !orderBadgeVisibility(order).payment;
  return (
    <div className="flex items-start gap-3 px-3 py-3">
      {selectable ? (
        <label className="-my-2 -ml-3 flex shrink-0 p-3.5">
          <Checkbox
            checked={isSelected}
            onCheckedChange={onToggleSelection}
            aria-label={tr("select", { name: `#${order.id}` })}
          />
        </label>
      ) : null}
      <Link
        to="/admin/orders/$orderId"
        params={{ orderId: order.id }}
        className="min-w-0 flex-1 space-y-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-baseline justify-between gap-3 text-body">
          <span className="min-w-0 break-all font-mono font-medium">#{order.id}</span>
          <span className="shrink-0 font-medium tabular-nums">{fmt(order.totalAmount)}</span>
        </div>
        <p className="break-words text-body">{order.customerName}</p>
        <div className="flex flex-wrap items-center gap-1">
          <ListDate value={order.createdAt} className="mr-1 text-body text-muted-foreground" />
          {closed ? (
            <Badge variant={statusBadgeVariant(order.status, "order")}>{orderStatusLabel(to, order.status)}</Badge>
          ) : null}
          <PaymentBadge order={order} />
          <FulfillmentBadge order={order} />
        </div>
      </Link>
    </div>
  );
});
