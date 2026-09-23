import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { orderMessages, orderStatusLabel } from "~/i18n/orders";
import { resourceMessages } from "~/i18n/resource";
import { useUpdateOrderStatus } from "~/lib/api-mutations/orders";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import {
  getAdminOrderCancellationBlockedReason,
  getAdminOrderStatusTransitions,
  isAdminOrderStatus,
} from "~/lib/admin-order-status-policy";
import { formatOrderTimestamp } from "./formatters";
import type { Order } from "./types";

export function OrderStatusCard({ order }: { order: Order }) {
  const t = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const r = useMessages(resourceMessages);
  const canChangeStatus = useOrderActionPermissions().canChangeOrderStatus;
  const statusMutation = useUpdateOrderStatus();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const status = order.status.toLowerCase();
  const refundLocked = Boolean(order.activeRefundOperation?.active);
  const shipmentLocked = order.shipmentRecovery?.activeLock === true;
  const transitions = getAdminOrderStatusTransitions(status, order);
  const cancelBlocked = getAdminOrderCancellationBlockedReason(status, order) !== null;
  const placedAt = formatOrderTimestamp(order.createdAt);

  const handleStatusChange = (next: string) => {
    if (!isAdminOrderStatus(next)) return void toast.error(r("actionFailed"));
    if (!canChangeStatus) return void toast.error(r("readOnly"));
    if (refundLocked) return void toast.error(t("locked.refund"));
    if (shipmentLocked) return void toast.error(t("locked.shipment"));
    if (next === "cancelled") return setConfirmCancel(true);
    statusMutation.mutate({ orderId: order.id, status: next });
  };

  const help = !canChangeStatus
    ? r("readOnly")
    : refundLocked
      ? t("locked.refund")
      : shipmentLocked
        ? t("locked.shipment")
        : transitions.length === 0
          ? status === "cancelled" ? t("status.cancelledFinal") : t("status.final")
          : cancelBlocked
            ? t("status.refundToCancel")
            : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("status.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <Select
          value={status}
          onValueChange={handleStatusChange}
          disabled={statusMutation.isPending || refundLocked || shipmentLocked || !canChangeStatus || transitions.length === 0}
        >
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
        {help ? <p className="text-muted-foreground">{help}</p> : null}
        {placedAt ? <p className="text-muted-foreground">{t("status.placedAt", { date: placedAt })}</p> : null}
      </CardContent>
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title={t("cancel.title", { id: order.id })}
        description={t("cancel.body", { count: order.items.reduce((sum, item) => sum + item.quantity, 0) })}
        confirmLabel={t("cancel.confirm")}
        cancelLabel={t("cancel.keep")}
        onConfirm={() => statusMutation.mutate({ orderId: order.id, status: "cancelled" })}
      />
    </Card>
  );
}
