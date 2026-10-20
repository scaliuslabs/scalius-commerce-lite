import { useQuery } from "@tanstack/react-query";
import { AppActionsMenu } from "~/components/admin/apps/ui/AppActions";
import { AppResourceCards } from "~/components/admin/apps/ui/AppResourceCards";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { orderReturnMessages } from "~/i18n/order-returns";
import { useReconcileOrderReturn } from "~/lib/api-mutations/orders";
import { hasSeveralLocations, inventoryLocationsQueryOptions } from "~/lib/api-query-options/inventory-locations";
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
  const t = useMessages(orderReturnMessages);
  const resumeMutation = useReconcileOrderReturn();
  const canCancel = (orderReturn.status === "requested" || orderReturn.status === "approved")
    && orderReturn.lines.every((line) => line.receivedQuantity === 0);
  const canReceive = (orderReturn.status === "approved" || orderReturn.status === "receiving")
    && orderReturn.lines.some((line) => getOutstandingReceiptQuantity(line) > 0);
  const trackedLineIds = new Set(orderReturn.lines.filter((line) => line.inventoryTracked).map((line) => line.id));
  const courierReturn = orderReturn.source === "cod_return_to_sender";
  // A store with several locations sees where each receipt's units went back into stock.
  const restocked = orderReturn.receipts.some((receipt) => receipt.restockQuantity > 0 && receipt.restockLocationId);
  const { data: locations } = useQuery({ ...inventoryLocationsQueryOptions(true), enabled: restocked });
  const locationName = (id: string | null) => (id && hasSeveralLocations(locations)
    ? locations?.find((location) => location.id === id)?.name ?? null
    : null);

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={statusBadgeVariant(orderReturn.status)}>{t(`return.status.${orderReturn.status}`)}</Badge>
            <span className="font-medium">{courierReturn ? t("returns.courierReturn") : orderReturn.reason}</span>
          </div>
          <p className="text-muted-foreground">{formatOrderTimestamp(orderReturn.requestedAt ?? orderReturn.createdAt)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage && orderReturn.status === "requested" ? (
            <Button type="button" size="sm" variant="outline" onClick={() => onAction({ type: "approve", orderReturn })}>
              {t("returns.review")}
            </Button>
          ) : null}
          {canManage && canReceive ? (
            <Button type="button" size="sm" variant="outline" onClick={() => onAction({ type: "receive", orderReturn })}>
              {t("returns.receive")}
            </Button>
          ) : null}
          {canManage && canCancel ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => onAction({ type: "cancel", orderReturn })}>
              {t("returns.cancel")}
            </Button>
          ) : null}
          {/* Apps' actions for this return (apps.use); nothing when no app offers one. */}
          <AppActionsMenu target="return" id={orderReturn.id} size="sm" />
        </div>
      </div>

      {orderReturn.receiptRecovery ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-destructive">{t("returns.resumeHelp")}</p>
          {canManage ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={resumeMutation.isPending}
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
                orderReturn.status === "requested" ? null : t("returns.qtyApproved", { count: line.approvedQuantity }),
                line.receivedQuantity > 0 ? t("returns.qtyReceived", { count: line.receivedQuantity }) : null,
                line.restockQuantity > 0 ? t("returns.qtyRestocked", { count: line.restockQuantity }) : null,
                // Untracked items are received, never "damaged": their stock isn't counted.
                line.inventoryTracked && line.damagedQuantity > 0 ? t("returns.qtyDamaged", { count: line.damagedQuantity }) : null,
                !courierReturn && line.reason && line.reason !== orderReturn.reason ? line.reason : null,
              ].filter(Boolean).join(" · ")}
            </p>
          </li>
        ))}
      </ul>
      {orderReturn.receipts.length > 0 ? (
        <ul className="space-y-1 text-muted-foreground">
          {orderReturn.receipts.map((receipt) => {
            const restockedAt = receipt.restockQuantity > 0 ? locationName(receipt.restockLocationId) : null;
            return (
              <li key={receipt.id}>
                {formatOrderTimestamp(receipt.createdAt)} · {trackedLineIds.has(receipt.returnLineId)
                  ? t("returns.receipt", {
                      received: receipt.receivedQuantity,
                      restocked: receipt.restockQuantity,
                      damaged: receipt.damagedQuantity,
                    })
                  : t("returns.qtyReceived", { count: receipt.receivedQuantity })}
                {restockedAt ? ` · ${t("returns.restockedAt", { location: restockedAt })}` : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {orderReturn.notes ? <p className="text-muted-foreground">{orderReturn.notes}</p> : null}
      {/* Apps' cards for this return, inside the Returns card (never a card in a card). */}
      <AppResourceCards target="return" id={orderReturn.id} inline className="space-y-3" />
    </li>
  );
}
