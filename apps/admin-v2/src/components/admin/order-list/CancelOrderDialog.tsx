import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OrderListItem } from "@scalius/core/modules/orders/browser";
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
import { SearchableSelect } from "~/components/ui/searchable-select";
import { CANCEL_REASONS, restockedUnits } from "~/components/admin/orderview/OrderStatusCard";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import type { UpdateOrderStatusInput } from "~/lib/api-mutations/orders";
import { getOrderItems } from "~/lib/api-query-options/orders";
import { queryKeys } from "~/lib/query-keys";
import { formatOrderNumber } from "@scalius/shared/order-utils";

export type CancelReason = NonNullable<UpdateOrderStatusInput["reason"]>;

/**
 * "Cancel order #1001?" with the units going back to stock and an optional
 * reason: the one cancel confirmation for the order page and the list's status menu.
 */
export function CancelOrderDialog({
  open,
  onOpenChange,
  orderName,
  restock,
  notify,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "#1001" */
  orderName: string;
  /** Units going back to stock; null while unknown (not said rather than guessed). */
  restock: number | null;
  /** The customer has an email, so they get a cancellation message. */
  notify: boolean;
  pending: boolean;
  onConfirm: (reason?: CancelReason) => void;
}) {
  const t = useMessages(orderDetailMessages);
  const [reason, setReason] = useState<CancelReason | "">("");
  const changeOpen = (next: boolean) => {
    // Each opening starts without a reason.
    if (!next) setReason("");
    onOpenChange(next);
  };

  return (
    <AlertDialog open={open} onOpenChange={changeOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("cancel.title", { name: orderName })}</AlertDialogTitle>
          <AlertDialogDescription>
            {[
              t("cancel.body"),
              restock ? t("cancel.restock", { count: restock }) : null,
              notify ? t("cancel.notify") : null,
            ].filter(Boolean).join(" ")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor="cancel-reason">{t("cancel.reason")}</Label>
          <SearchableSelect
            triggerClassName="w-full"
            id="cancel-reason"
            value={reason}
            onValueChange={(value) => setReason(value as CancelReason)}
            placeholder={t("cancel.reasonPlaceholder")}
            options={CANCEL_REASONS.map((value) => ({ value, label: t(`cancel.reason.${value}`) }))}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel.keep")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={() => onConfirm(reason || undefined)}>
            {t("cancel.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The same confirmation for a list row: its items load when it opens, for the restock count. */
export function OrderRowCancelDialog({
  order,
  pending,
  onOpenChange,
  onConfirm,
}: {
  order: OrderListItem | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (order: OrderListItem, reason?: CancelReason) => void;
}) {
  // Kept after closing so the title doesn't blank while the dialog animates out.
  const [shown, setShown] = useState(order);
  if (order && order !== shown) setShown(order);
  const orderId = shown?.id ?? "";
  const items = useQuery({
    queryKey: queryKeys.orders.items(orderId),
    queryFn: () => getOrderItems(orderId),
    enabled: order !== null,
  });
  return (
    <CancelOrderDialog
      open={order !== null}
      onOpenChange={onOpenChange}
      orderName={shown ? formatOrderNumber(shown.orderNumber, shown.id) : ""}
      restock={items.data ? restockedUnits({ items: items.data }) : null}
      notify={Boolean(shown?.customerEmail)}
      pending={pending}
      onConfirm={(reason) => {
        if (order) onConfirm(order, reason);
      }}
    />
  );
}
