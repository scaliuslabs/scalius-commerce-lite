import { Badge } from "~/components/ui/badge";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import {
  fulfillmentStatusLabel,
  orderMessages,
  orderStatusLabel,
  paymentStatusLabel,
} from "~/i18n/orders";
import { orderBadgeVisibility, statusBadgeVariant } from "./status-badges";
import type { Order } from "./types";

/**
 * The order page title's badges, always in this order on every screen
 * (Shopify's): payment, then fulfilment, or the closed status alone when the
 * order's story is over (a cancelled order never also reads "Unpaid"), then
 * Archived, then an unread reply (it links to the Messages card lower down).
 */
export function OrderHeaderBadges({ order }: {
  order: Pick<Order, "status" | "paymentStatus" | "paymentMethod" | "fulfillmentStatus" | "archivedAt" | "conversation">;
}) {
  const t = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const status = order.status.toLowerCase();
  const shown = orderBadgeVisibility(order);
  const closed = !shown.payment && !shown.fulfillment;
  return (
    <div className="flex flex-wrap gap-1" data-testid="order-header-badges">
      {closed ? <Badge variant={statusBadgeVariant(status, "order")}>{orderStatusLabel(o, status)}</Badge> : null}
      {shown.payment && order.paymentStatus ? (
        <Badge variant={statusBadgeVariant(order.paymentStatus, "payment")}>{paymentStatusLabel(o, order.paymentStatus, order.paymentMethod)}</Badge>
      ) : null}
      {shown.fulfillment && order.fulfillmentStatus ? (
        <Badge variant={statusBadgeVariant(order.fulfillmentStatus, "fulfillment")}>{fulfillmentStatusLabel(o, order.fulfillmentStatus)}</Badge>
      ) : null}
      {order.archivedAt ? <Badge variant="secondary">{o("archived")}</Badge> : null}
      {order.conversation?.unread ? (
        <a href="#order-requests" className="inline-flex min-h-11 items-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-6">
          <Badge variant="info">{t("messages.unread")}</Badge>
        </a>
      ) : null}
    </div>
  );
}
