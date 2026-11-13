import { Badge } from "~/components/ui/badge";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { orderMessages } from "~/i18n/orders";
import { orderTitleBadges } from "./status-badges";
import type { Order } from "./types";

/**
 * The order page title's badges, always in this order on every screen
 * (Shopify's): payment, then fulfilment, or the closed status first when the
 * order's story is over (a cancelled order never also reads "Unpaid"), then
 * Archived, then an unread reply (it links to the Messages card lower down).
 */
export function OrderHeaderBadges({ order }: {
  order: Pick<Order, "status" | "paymentStatus" | "paymentMethod" | "fulfillmentStatus" | "archivedAt" | "conversation">
    & Partial<Pick<Order, "shippingMethodKind" | "requiresShipping" | "paidAmount" | "pickupReadyAt" | "pickup">>
    & { disputedAmount?: number | null };
}) {
  const t = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const badges = orderTitleBadges({ ...order, pickupReadyAt: order.pickupReadyAt ?? order.pickup?.readyAt ?? null });
  return (
    <div className="flex flex-wrap gap-1" data-testid="order-header-badges">
      {badges.map((badge) => <Badge key={badge.key} variant={badge.variant}>{o(badge.key)}</Badge>)}
      {order.archivedAt ? <Badge variant="secondary">{o("archived")}</Badge> : null}
      {order.conversation?.unread ? (
        <a href="#order-requests" className="inline-flex min-h-11 items-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:min-h-6">
          <Badge variant="info">{t("messages.unread")}</Badge>
        </a>
      ) : null}
    </div>
  );
}
