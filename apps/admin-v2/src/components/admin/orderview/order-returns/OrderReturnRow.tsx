import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { useReconcileOrderReturn } from "~/lib/api-mutations/orders";
import { getOutstandingReceiptQuantity, type OrderReturnDto } from "~/lib/order-return-workflow";
import { formatOrderTimestamp } from "../formatters";
import { statusBadgeVariant } from "../status-badges";
import type { OrderItem } from "../types";
import { getOrderItemName } from "./shared";

export type ReturnDialogAction =
  | { type: "approve"; orderReturn: OrderReturnDto }
  | { type: "receive"; orderReturn: OrderReturnDto }
  | { type: "cancel"; orderReturn: OrderReturnDto };

export function OrderReturnRow({
  orderReturn,
  itemsById,
  canManage,
  onAction,
}: {
  orderReturn: OrderReturnDto;
  itemsById: ReadonlyMap<string, OrderItem>;
  canManage: boolean;
  onAction: (state: ReturnDialogAction) => void;
}) {
  const t = useMessages(orderDetailMessages);
  const resumeMutation = useReconcileOrderReturn();
  const canCancel = (orderReturn.status === "requested" || orderReturn.status === "approved")
    && orderReturn.lines.every((line) => line.receivedQuantity === 0);
  const canReceive = (orderReturn.status === "approved" || orderReturn.status === "receiving")
    && orderReturn.lines.some((line) => getOutstandingReceiptQuantity(line) > 0);

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={statusBadgeVariant(orderReturn.status)}>{t(`return.status.${orderReturn.status}`)}</Badge>
            <span className="font-medium">{orderReturn.reason}</span>
          </div>
          <p className="text-muted-foreground">{formatOrderTimestamp(orderReturn.requestedAt ?? orderReturn.createdAt)}</p>
        </div>
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            {orderReturn.status === "requested" ? (
              <Button type="button" size="sm" variant="outline" onClick={() => onAction({ type: "approve", orderReturn })}>
                {t("returns.review")}
              </Button>
            ) : null}
            {canReceive ? (
              <Button type="button" size="sm" variant="outline" onClick={() => onAction({ type: "receive", orderReturn })}>
                {t("returns.receive")}
              </Button>
            ) : null}
            {canCancel ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => onAction({ type: "cancel", orderReturn })}>
                {t("returns.cancel")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {orderReturn.receiptRecovery ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-destructive">{t("returns.resumeHelp")}</p>
          {canManage ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={resumeMutation.isPending}
              onClick={() => resumeMutation.mutate({ orderId: orderReturn.orderId, returnId: orderReturn.id })}
            >
              {t("returns.resume")}
            </Button>
          ) : null}
        </div>
      ) : null}

      <ul className="space-y-1">
        {orderReturn.lines.map((line) => (
          <li key={line.id}>
            <p className="font-medium">{getOrderItemName(itemsById.get(line.orderItemId))}</p>
            <p className="text-muted-foreground">
              {[
                t("returns.qtyRequested", { count: line.requestedQuantity }),
                t("returns.qtyApproved", { count: line.approvedQuantity }),
                t("returns.qtyReceived", { count: line.receivedQuantity }),
                line.restockQuantity > 0 ? t("returns.qtyRestocked", { count: line.restockQuantity }) : null,
                line.damagedQuantity > 0 ? t("returns.qtyDamaged", { count: line.damagedQuantity }) : null,
                line.reason,
              ].filter(Boolean).join(" · ")}
            </p>
          </li>
        ))}
      </ul>
      {orderReturn.receipts.length > 0 ? (
        <ul className="space-y-1 text-muted-foreground">
          {orderReturn.receipts.map((receipt) => (
            <li key={receipt.id}>
              {formatOrderTimestamp(receipt.createdAt)} · {t("returns.receipt", {
                received: receipt.receivedQuantity,
                restocked: receipt.restockQuantity,
                damaged: receipt.damagedQuantity,
              })}
            </li>
          ))}
        </ul>
      ) : null}
      {orderReturn.notes ? <p className="text-muted-foreground">{orderReturn.notes}</p> : null}
    </li>
  );
}
