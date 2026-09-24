import { useState } from "react";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Label } from "~/components/ui/label";
import { NativeSelect } from "~/components/ui/native-select";
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
import type { Order } from "./types";

type CancelReason = NonNullable<UpdateOrderStatusInput["reason"]>;
export const CANCEL_REASONS: CancelReason[] = ["customer_changed_mind", "unreachable", "fake_order", "out_of_stock", "other"];

/** Units that go back on sale when the order is cancelled: unsent, stock-tracked items only. */
export function restockedUnits(order: Pick<Order, "items">): number {
  return order.items
    .filter((item) => item.inventoryTracked !== false)
    .reduce((sum, item) => sum + Math.max(0, item.quantity - (item.shippedQuantity ?? 0)), 0);
}

/** Units with a courier: the order can't be cancelled until they come back or are delivered. */
export function unitsWithCourier(order: Pick<Order, "items">): number {
  return order.items.reduce((sum, item) => sum + Math.max(0, item.shippedQuantity ?? 0), 0);
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

export function OrderStatusCard({ order }: { order: Order }) {
  const t = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const r = useMessages(resourceMessages);
  const canChangeStatus = useOrderActionPermissions().canChangeOrderStatus;
  const statusMutation = useUpdateOrderStatus();
  const cancelRequest = useCancelRequestGuard(order);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [reason, setReason] = useState<CancelReason | "">("");
  const status = order.status.toLowerCase();
  const refundLocked = Boolean(order.activeRefundOperation?.active);
  const shipmentLocked = order.shipmentRecovery?.activeLock === true;
  // Every next status is listed; one that can't be chosen says why, right in the menu.
  const options = getAdminOrderStatusOptions(status, { ...order, unitsWithCourier: unitsWithCourier(order) });
  const blocked = new Map(options.filter((option) => option.block).map((option) => [option.status as string, option.block!]));
  const placedAt = formatOrderTimestamp(order.createdAt);
  const restock = restockedUnits(order);
  const changeable = canChangeStatus && !refundLocked && !shipmentLocked && !order.archivedAt && options.length > 0;

  const change = (next: string) => {
    if (!isAdminOrderStatus(next) || blocked.has(next)) return;
    clearOrderNotice(order.id);
    if (next === "cancelled") {
      setReason("");
      setConfirmCancel(true);
      return;
    }
    const run = () => statusMutation.mutate({ orderId: order.id, status: next });
    if (next === "confirmed" || next === "shipped") cancelRequest.guard(next === "confirmed" ? "confirm" : "send", run);
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
          <NativeSelect
            value={status}
            onValueChange={change}
            disabled={statusMutation.isPending}
            aria-label={t("status.title")}
          >
            <option value={status}>{orderStatusLabel(o, status)}</option>
            {options.map(({ status: value, block }) => (
              <option key={value} value={value} disabled={block !== null}>
                {/* A native option holds text only: the reason follows the greyed-out choice. */}
                {block
                  ? `${orderStatusLabel(o, value)} — ${statusBlockText(block, order, t)}`
                  : orderStatusLabel(o, value)}
              </option>
            ))}
          </NativeSelect>
        ) : (
          // A final or locked status is a fact, not a menu.
          <p className="font-medium">{orderStatusLabel(o, status)}</p>
        )}
        {help ? <p className="text-muted-foreground">{help}</p> : null}
        {placedAt ? <p className="text-muted-foreground">{t("status.placedAt", { date: placedAt })}</p> : null}
      </CardContent>
      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("cancel.title", { name: formatOrderNumber(order.orderNumber, order.id) })}</AlertDialogTitle>
            <AlertDialogDescription>
              {[
                t("cancel.body"),
                restock > 0 ? t("cancel.restock", { count: restock }) : null,
                order.customerEmail ? t("cancel.notify") : null,
              ].filter(Boolean).join(" ")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="cancel-reason">{t("cancel.reason")}</Label>
            <NativeSelect
              id="cancel-reason"
              value={reason}
              onValueChange={(value) => setReason(value as CancelReason)}
              placeholder={t("cancel.reasonPlaceholder")}
            >
              {CANCEL_REASONS.map((value) => (
                <option key={value} value={value}>{t(`cancel.reason.${value}`)}</option>
              ))}
            </NativeSelect>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel.keep")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={statusMutation.isPending}
              onClick={() => statusMutation.mutate({
                orderId: order.id,
                status: "cancelled",
                ...(reason ? { reason } : {}),
              })}
            >
              {t("cancel.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {cancelRequest.dialog}
    </Card>
  );
}
