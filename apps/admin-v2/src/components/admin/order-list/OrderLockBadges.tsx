import type { OrderListItem } from "@scalius/core/modules/orders/orders.types";
import { Badge } from "~/components/ui/badge";
import { useMessages } from "~/i18n";
import { orderListMessages } from "~/i18n/order-list";

type LockedOrder = Pick<OrderListItem, "paymentRecovery" | "activeRefundOperation" | "shipmentRecovery">;

/** Small badges for work that blocks other actions: online payment, refund, courier booking. */
export function OrderLockBadges({ order }: { order: LockedOrder }) {
  const t = useMessages(orderListMessages);
  const payment = order.paymentRecovery;
  const refund = order.activeRefundOperation;
  const shipment = order.shipmentRecovery;
  return (
    <>
      {payment && payment.state !== "none" ? (
        <Badge
          variant={payment.state === "needs_attention" ? "destructive" : "outline"}
          title={payment.message ?? payment.label}
        >
          {t(`recovery.${payment.state}`)}
        </Badge>
      ) : null}
      {refund?.active ? (
        <Badge variant={refund.severity === "danger" ? "destructive" : "outline"} title={refund.message}>
          {t("refundInProgress")}
        </Badge>
      ) : null}
      {shipment && shipment.state !== "none" ? (
        <Badge
          variant={shipment.severity === "danger" ? "destructive" : "outline"}
          title={shipment.message ?? shipment.label}
        >
          {t("courierCheck")}
        </Badge>
      ) : null}
    </>
  );
}
