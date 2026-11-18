import { lazy, Suspense, useEffect, useState } from "react";
import { formatOrderNumber } from "~/lib/order-number";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useOpenedOnce } from "~/hooks/use-opened-once";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { orderMessages, orderStatusLabel } from "~/i18n/orders";
import { resourceMessages } from "~/i18n/resource";
import { usePutOrderStockBack, useUpdateOrderStatus } from "~/lib/api-mutations/orders";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import type { OrderActionBlock } from "@scalius/shared/order-admin-actions";
import type { OrderDetailMessageKey } from "~/i18n/order-detail";
import { clearOrderNotice } from "~/lib/order-notice";
import { useCancelRequestGuard } from "./CancelRequestGuard";
import { restockedUnits, shippedCancelReason, unitsHandedOverForGood } from "./cancel-order";
import { listedActions, statusLock } from "./order-actions";
import type { OrderActionRequest } from "./primary-action";
import type { Order } from "./types";

/** Why a status can't be chosen, from the reason the server listed it with. */
export function statusBlockText(
  reason: OrderActionBlock,
  order: Pick<Order, "items">,
  t: (key: OrderDetailMessageKey, vars?: { count: number }) => string,
): string {
  switch (reason) {
    case "handed_over": return shippedCancelReason(order, t) ?? t("statusBlock.withCourier");
    case "cancel_needs_refund": return t("status.refundToCancel");
    case "cash_not_collected": return t("statusBlock.cashFirst");
    case "on_hold": return t("statusBlock.onHold");
    case "refund_in_progress": return t("locked.refund");
    case "courier_check": return t("locked.shipment");
    case "payment_in_progress": return t("locked.payment");
    default: return t("statusBlock.moneyDue");
  }
}

/**
 * The action that settles the parcel still with the courier, so the order
 * can be cancelled: its card and button name (R3-ORD-04).
 */
// The cancel confirmation (its reason picker) loads when first asked for.
const CancelOrderDialog = lazy(() => import("~/components/admin/order-list/CancelOrderDialog").then((module) => ({ default: module.CancelOrderDialog })));

export function courierNextStep(order: Pick<Order, "status" | "paymentMethod">): { href: string; label: OrderDetailMessageKey } {
  const status = order.status.toLowerCase();
  // A part-sent order's parcel comes back from its fulfilment card's menu.
  if (status !== "shipped") return { href: "#order-fulfilment", label: "shipments.cameBack" };
  return order.paymentMethod === "cod"
    ? { href: "#order-payment", label: "cod.markReturned" }
    : { href: "#order-shipments", label: "primary.markDelivered" };
}

/**
 * Whether the header's "Cancel order…" is offered (null: not at all) and what
 * blocks it right now: the server's Cancelled move, as the status card shows it.
 */
export function orderCancelChoice(order: Order, canChangeStatus: boolean): { block: OrderActionBlock | null } | null {
  const actions = listedActions(order);
  if (!canChangeStatus || statusLock(actions)) return null;
  const cancel = actions.moves.find((move) => move.status === "cancelled");
  return cancel ? { block: cancel.reason } : null;
}

export function OrderStatusCard({ order, request }: { order: Order; request?: OrderActionRequest | null }) {
  const t = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const r = useMessages(resourceMessages);
  const canChangeStatus = useOrderActionPermissions().canChangeOrderStatus;
  const statusMutation = useUpdateOrderStatus();
  const putStockBack = usePutOrderStockBack();
  const cancelRequest = useCancelRequestGuard(order);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancelLoaded = useOpenedOnce(confirmCancel);
  const status = order.status.toLowerCase();
  // The server's moves (only changes without side effects); one that can't be chosen says why, right in the menu.
  const actions = listedActions(order);
  const options = actions.moves;
  const lock = statusLock(actions);
  const cancelBlock = options.find((option) => option.status === "cancelled")?.reason ?? null;
  const changeable = canChangeStatus && !lock && options.length > 0;
  // Only a parcel can come back; nothing undoes a key or a service already handed over.
  const nextStep = changeable && cancelBlock === "handed_over" && unitsHandedOverForGood(order) === 0 ? courierNextStep(order) : null;

  const change = (value: string) => {
    const next = options.find((option) => option.status === value && option.available)?.status;
    if (!next) return;
    clearOrderNotice(order.id);
    if (next === "cancelled") {
      setConfirmCancel(true);
      return;
    }
    const run = () => statusMutation.mutate({ orderId: order.id, status: next });
    if (next === "confirmed") cancelRequest.guard("confirm", run);
    else run();
  };

  // "Cancel order…" in the header's More actions opens the same confirmation.
  useEffect(() => {
    if (request?.action === "cancel" && changeable) change("cancelled");
    // Only a new request should open the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id]);

  const help = options.length === 0
    ? status === "cancelled" ? t("status.cancelledFinal") : t("status.final")
    : !canChangeStatus
      ? r("readOnly")
      // An archive explains itself in the page title.
      : lock && lock !== "archived"
        ? statusBlockText(lock, order, t)
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
              ...options.map(({ status: value, reason }) => ({
                value,
                label: reason ? `${orderStatusLabel(o, value)} — ${statusBlockText(reason, order, t)}` : orderStatusLabel(o, value),
                disabled: reason !== null,
              })),
            ]}
          />
        ) : (
          // A final or locked status is a fact, not a menu.
          <p className="font-medium">{orderStatusLabel(o, status)}</p>
        )}
        {help ? <p className="text-muted-foreground">{help}</p> : null}
        {order.stockHeld ? (
          // A refund cancelled the order but its location refused the stock: why, and the remedy.
          <div role="note" className="space-y-2 border-t pt-2">
            <p className="font-medium">{t("stockHeld.title")}</p>
            <p className="text-muted-foreground">
              {t(`stockHeld.reason.${order.stockHeld.reason}`, {
                skus: order.stockHeld.skus.length > 0 ? t("stockHeld.skus", { skus: order.stockHeld.skus.join(", ") }) : "",
              })}
            </p>
            {canChangeStatus && !order.archivedAt ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={putStockBack.isPending}
                onClick={() => {
                  clearOrderNotice(order.id);
                  putStockBack.mutate({ orderId: order.id });
                }}
              >
                {t("stockHeld.action")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {nextStep && cancelBlock ? (
          <p className="text-muted-foreground">
            {statusBlockText(cancelBlock, order, t)}{" "}
            <a href={nextStep.href} className="text-link hover:underline">{t(nextStep.label)}</a>
          </p>
        ) : null}
      </CardContent>
      {cancelLoaded ? (
        <Suspense fallback={null}>
          <CancelOrderDialog
            open={confirmCancel}
            onOpenChange={setConfirmCancel}
            orderName={formatOrderNumber(order.orderNumber, order.id)}
            restock={restockedUnits(order)}
            notify={Boolean(order.customerEmail)}
            pending={statusMutation.isPending}
            onConfirm={(reason, notifyCustomer) => statusMutation.mutate({
              orderId: order.id,
              status: "cancelled",
              ...(reason ? { reason } : {}),
              ...(notifyCustomer === false ? { notifyCustomer: false } : {}),
            })}
          />
        </Suspense>
      ) : null}
      {cancelRequest.dialog}
    </Card>
  );
}
