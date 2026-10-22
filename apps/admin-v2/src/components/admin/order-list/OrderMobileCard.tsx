import { memo } from "react";
import { Link } from "@tanstack/react-router";
import type { OrderListItem } from "@scalius/core/modules/orders/browser";
import type { RealtimePresence } from "@scalius/shared/realtime";
import { RowPresence } from "~/components/admin/realtime/RowPresence";
import { formatPhoneForDisplay } from "@scalius/shared/phone-input";
import { getStoreRegion } from "~/lib/store-time-zone";
import { cn } from "@scalius/shared/utils";
import { Checkbox } from "../../ui/checkbox";
import { Badge } from "../../ui/badge";
import { useOrderCurrency } from "@/hooks/use-order-currency";
import { orderBadgeVisibility, statusBadgeVariant } from "~/components/admin/orderview/status-badges";
import { useMessages } from "~/i18n";
import { orderMessages, orderStatusLabel } from "~/i18n/orders";
import { orderListMessages } from "~/i18n/order-list";
import { shipmentStatusMessages } from "~/i18n/shipment-status";
import { resourceMessages } from "~/i18n/resource";
import { AttentionMarker, FulfilmentCell, orderName, PaymentCell } from "./order-columns";
import { codToCollect, deliveryMethod, deliveryStatus, orderAttention, TONE_TEXT } from "./order-row-facts";
import { ListDate, listDateLabel } from "~/components/admin/data-table/ListDate";
import { dataTableMessages } from "~/i18n/data-table";
import { unixToDate } from "@scalius/shared/timestamps";
import { shownText } from "~/lib/erased-text";

export { codToCollect } from "./order-row-facts";

/**
 * Phone row, the table's hierarchy in four lines that every card has:
 * "#1001 [!]" and the total; the customer and phone; the status, payment
 * and fulfilment badges; then one muted line with when, where the parcel is
 * (or how it's delivered) and cash still to collect. Tap opens the order.
 */
export const OrderMobileCard = memo(function OrderMobileCard({
  order,
  people,
  dateField,
  selectable,
  isSelected,
  onToggleSelection,
}: {
  order: OrderListItem;
  people?: readonly RealtimePresence[];
  dateField: "createdAt" | "updatedAt";
  selectable: boolean;
  isSelected: boolean;
  onToggleSelection: () => void;
}) {
  const { fmtIn } = useOrderCurrency();
  const t = useMessages(orderListMessages);
  const tr = useMessages(resourceMessages);
  const to = useMessages(orderMessages);
  const customerName = shownText(order.customerName, to("erasedCustomer"));
  const closed = !orderBadgeVisibility(order).payment;
  const collect = codToCollect(order);
  const sh = useMessages(shipmentStatusMessages);
  const delivery = deliveryStatus(order, t, sh);
  const attention = orderAttention(order, t, to)[0] ?? null;
  const dt = useMessages(dataTableMessages);
  const placed = unixToDate(order[dateField] as Date | string | number | null);
  // The whole line on hover, where a narrow phone cuts it (T7).
  const lineTitle = [
    placed ? listDateLabel(placed, new Date(), dt) : null,
    attention ? attention.text : delivery ? delivery.text : deliveryMethod(order, to),
  ].filter(Boolean).join(" · ");
  return (
    <div className="flex items-start gap-1 py-1 pe-3" data-part="order-card">
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
        className="min-w-0 flex-1 space-y-1 rounded-sm py-2 ps-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-center justify-between gap-3 text-body">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="whitespace-nowrap font-mono font-medium">{orderName(order)}</span>
            <AttentionMarker order={order} plain />
            <RowPresence people={people} />
          </span>
          <span className="shrink-0 font-medium tabular-nums">{fmtIn(order.totalAmount, order.currencyCode)}</span>
        </span>
        {/* The name keeps its room; the phone takes what is left and is cut first (T14). */}
        <span className="flex items-center justify-between gap-3 text-body">
          <span title={customerName} className="max-w-full shrink-0 truncate">{customerName}</span>
          {order.customerPhone ? (
            <span title={formatPhoneForDisplay(order.customerPhone, getStoreRegion())} className="min-w-0 truncate font-mono text-muted-foreground">
              {formatPhoneForDisplay(order.customerPhone, getStoreRegion())}
            </span>
          ) : null}
        </span>
        <span className="flex flex-wrap items-center gap-1">
          <Badge variant={statusBadgeVariant(order.status, "order")}>{orderStatusLabel(to, order.status)}</Badge>
          {closed ? null : (
            <>
              <PaymentCell order={order} />
              <FulfilmentCell order={order} />
            </>
          )}
        </span>
        {/* What holds the order up comes first; else where the parcel is, or how it's delivered.
            Cash still to collect keeps its own place at the end: a long line is cut before it, never through it. */}
        <span className="flex items-center justify-between gap-3 text-body text-muted-foreground">
          <span title={lineTitle} className="min-w-0 truncate">
            <ListDate value={order[dateField]} />
            {" · "}
            {attention ? (
              <span className={TONE_TEXT[attention.tone]}>{attention.text}</span>
            ) : delivery ? (
              <span className={cn(TONE_TEXT[delivery.tone])}>{delivery.text}</span>
            ) : deliveryMethod(order, to)}
          </span>
          {collect > 0 ? <span className="shrink-0 text-foreground tabular-nums">{t("codToCollect", { amount: fmtIn(collect, order.currencyCode) })}</span> : null}
        </span>
      </Link>
    </div>
  );
});
