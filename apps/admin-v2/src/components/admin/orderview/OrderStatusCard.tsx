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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { orderMessages, orderStatusLabel } from "~/i18n/orders";
import { resourceMessages } from "~/i18n/resource";
import { useUpdateOrderStatus, type UpdateOrderStatusInput } from "~/lib/api-mutations/orders";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import {
  getAdminOrderCancellationBlockedReason,
  getAdminOrderStatusTransitions,
  isAdminOrderStatus,
} from "~/lib/admin-order-status-policy";
import { clearOrderNotice } from "~/lib/order-notice";
import { formatOrderTimestamp } from "./formatters";
import type { Order } from "./types";

type CancelReason = NonNullable<UpdateOrderStatusInput["reason"]>;
export const CANCEL_REASONS: CancelReason[] = ["customer_changed_mind", "unreachable", "fake_order", "out_of_stock", "other"];

/** Units that go back on sale when the order is cancelled: stock-tracked items only. */
export function restockedUnits(order: Pick<Order, "items">): number {
  return order.items
    .filter((item) => item.inventoryTracked !== false)
    .reduce((sum, item) => sum + item.quantity - (item.shippedQuantity ?? 0), 0);
}

export function OrderStatusCard({ order }: { order: Order }) {
  const t = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const r = useMessages(resourceMessages);
  const canChangeStatus = useOrderActionPermissions().canChangeOrderStatus;
  const statusMutation = useUpdateOrderStatus();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [reason, setReason] = useState<CancelReason | "">("");
  const status = order.status.toLowerCase();
  const refundLocked = Boolean(order.activeRefundOperation?.active);
  const shipmentLocked = order.shipmentRecovery?.activeLock === true;
  const transitions = getAdminOrderStatusTransitions(status, order);
  const cancelBlocked = getAdminOrderCancellationBlockedReason(status, order) !== null;
  const placedAt = formatOrderTimestamp(order.createdAt);
  const restock = restockedUnits(order);
  const changeable = canChangeStatus && !refundLocked && !shipmentLocked && !order.archivedAt && transitions.length > 0;

  const change = (next: string) => {
    if (!isAdminOrderStatus(next)) return;
    clearOrderNotice(order.id);
    if (next === "cancelled") {
      setReason("");
      setConfirmCancel(true);
      return;
    }
    statusMutation.mutate({ orderId: order.id, status: next });
  };

  const help = transitions.length === 0
    ? status === "cancelled" ? t("status.cancelledFinal") : t("status.final")
    : !canChangeStatus
      ? r("readOnly")
      : refundLocked
        ? t("locked.refund")
        : shipmentLocked
          ? t("locked.shipment")
          : cancelBlocked
            ? t("status.refundToCancel")
            : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("status.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {changeable ? (
          <Select value={status} onValueChange={change} disabled={statusMutation.isPending}>
            <SelectTrigger aria-label={t("status.title")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[status, ...transitions].map((value) => (
                <SelectItem key={value} value={value}>
                  {orderStatusLabel(o, value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
            <Select value={reason} onValueChange={(value) => setReason(value as CancelReason)}>
              <SelectTrigger id="cancel-reason">
                <SelectValue placeholder={t("cancel.reasonPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {CANCEL_REASONS.map((value) => (
                  <SelectItem key={value} value={value}>{t(`cancel.reason.${value}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
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
    </Card>
  );
}
