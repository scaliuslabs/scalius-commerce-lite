import { useState } from "react";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { CancelOrderDialog } from "~/components/admin/order-list/CancelOrderDialog";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { orderMessages, orderStatusLabel } from "~/i18n/orders";
import { resourceMessages } from "~/i18n/resource";
import { useUpdateOrderStatus, type UpdateOrderStatusInput } from "~/lib/api-mutations/orders";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import {
  getAdminOrderStatusOptions,
  isAdminOrderStatus,
  type AdminOrderStatusBlock,
} from "~/lib/admin-order-status-policy";
import type { OrderDetailMessageKey } from "~/i18n/order-detail";
import { clearOrderNotice } from "~/lib/order-notice";
import { useCancelRequestGuard } from "./CancelRequestGuard";
import { formatOrderTimestamp } from "./formatters";
import { fulfilledUnits } from "./fulfilment-groups";
import type { Order } from "./types";

type CancelReason = NonNullable<UpdateOrderStatusInput["reason"]>;
export const CANCEL_REASONS: CancelReason[] = ["customer_changed_mind", "unreachable", "fake_order", "out_of_stock", "other"];

/** Units that go back on sale when the order is cancelled: not handed over, stock-tracked items only. */
export function restockedUnits(order: Pick<Order, "items">): number {
  return order.items
    .filter((item) => item.inventoryTracked !== false)
    .reduce((sum, item) => sum + Math.max(0, item.quantity - fulfilledUnits(item)), 0);
}

/** Units handed over (with a courier, picked up, performed): the order can't be cancelled then. */
export function unitsWithCourier(order: Pick<Order, "items">): number {
  return order.items.reduce((sum, item) => sum + fulfilledUnits(item), 0);
}

/** Why Cancelled isn't offered, in the merchant's words; null when it can be. */
export function shippedCancelReason(
  order: Pick<Order, "items">,
  t: (key: "cancel.shippedOne" | "cancel.shippedMany", vars: { count: number }) => string,
): string | null {
  const count = unitsWithCourier(order);
  return count === 0 ? null : t(count === 1 ? "cancel.shippedOne" : "cancel.shippedMany", { count });
}

/** Why a status can't be chosen, in the same words the server uses. */
export function statusBlockText(
  block: AdminOrderStatusBlock,
  order: Pick<Order, "items">,
  t: (key: OrderDetailMessageKey, vars?: { count: number }) => string,
): string {
  switch (block.code) {
    case "with_courier":
      return shippedCancelReason(order, t) ?? t("statusBlock.withCourier");
    case "cancel_needs_refund":
      return t("status.refundToCancel");
    case "cash_not_collected":
      return t("statusBlock.cashFirst");
    case "money_due":
      return t("statusBlock.moneyDue");
  }
}

/**
 * The action that settles the parcel still with the courier, so the order
 * can be cancelled: its card and button name (R3-ORD-04).
 */
export function courierNextStep(order: Pick<Order, "status" | "paymentMethod">): { href: string; label: OrderDetailMessageKey } {
  const status = order.status.toLowerCase();
  // A part-sent order's parcel comes back from its fulfilment card's menu.
  if (status !== "shipped") return { href: "#order-fulfilment", label: "shipments.cameBack" };
  return order.paymentMethod === "cod"
    ? { href: "#order-payment", label: "cod.markReturned" }
    : { href: "#order-shipments", label: "primary.markDelivered" };
}

export function OrderStatusCard({ order }: { order: Order }) {
  const t = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const r = useMessages(resourceMessages);
  const canChangeStatus = useOrderActionPermissions().canChangeOrderStatus;
  const statusMutation = useUpdateOrderStatus();
  const cancelRequest = useCancelRequestGuard(order);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const status = order.status.toLowerCase();
  const refundLocked = Boolean(order.activeRefundOperation?.active);
  const shipmentLocked = order.shipmentRecovery?.activeLock === true;
  // Only changes without side effects are offered; one that can't be chosen says why, right in the menu.
  const options = getAdminOrderStatusOptions(status, { ...order, unitsWithCourier: unitsWithCourier(order) });
  const blocked = new Map(options.filter((option) => option.block).map((option) => [option.status as string, option.block!]));
  const cancelBlock = blocked.get("cancelled");
  const placedAt = formatOrderTimestamp(order.createdAt);
  const changeable = canChangeStatus && !refundLocked && !shipmentLocked && !order.archivedAt && options.length > 0;
  const nextStep = changeable && cancelBlock?.code === "with_courier" ? courierNextStep(order) : null;

  const change = (next: string) => {
    if (!isAdminOrderStatus(next) || blocked.has(next)) return;
    clearOrderNotice(order.id);
    if (next === "cancelled") {
      setConfirmCancel(true);
      return;
    }
    const run = () => statusMutation.mutate({ orderId: order.id, status: next });
    if (next === "confirmed") cancelRequest.guard("confirm", run);
    else run();
  };

  const help = options.length === 0
    ? status === "cancelled" ? t("status.cancelledFinal") : t("status.final")
    : !canChangeStatus
      ? r("readOnly")
      : refundLocked
        ? t("locked.refund")
        : shipmentLocked
          ? t("locked.shipment")
          : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("status.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {changeable ? (
          <SearchableSelect
            value={status}
            onValueChange={change}
            disabled={statusMutation.isPending}
            ariaLabel={t("status.title")}
            triggerClassName="w-full"
            options={[
              { value: status, label: orderStatusLabel(o, status) },
              ...options.map(({ status: value, block }) => ({
                value,
                label: block ? `${orderStatusLabel(o, value)} — ${statusBlockText(block, order, t)}` : orderStatusLabel(o, value),
                disabled: block !== null,
              })),
            ]}
          />
        ) : (
          // A final or locked status is a fact, not a menu.
          <p className="font-medium">{orderStatusLabel(o, status)}</p>
        )}
        {help ? <p className="text-muted-foreground">{help}</p> : null}
        {nextStep && cancelBlock ? (
          <p className="text-muted-foreground">
            {statusBlockText(cancelBlock, order, t)}{" "}
            <a href={nextStep.href} className="text-link hover:underline">{t(nextStep.label)}</a>
          </p>
        ) : null}
        {placedAt ? <p className="text-muted-foreground">{t("status.placedAt", { date: placedAt })}</p> : null}
      </CardContent>
      <CancelOrderDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        orderName={formatOrderNumber(order.orderNumber, order.id)}
        restock={restockedUnits(order)}
        notify={Boolean(order.customerEmail)}
        pending={statusMutation.isPending}
        onConfirm={(reason) => statusMutation.mutate({ orderId: order.id, status: "cancelled", ...(reason ? { reason } : {}) })}
      />
      {cancelRequest.dialog}
    </Card>
  );
}
