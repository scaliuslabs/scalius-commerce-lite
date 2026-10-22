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
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Checkbox } from "~/components/ui/checkbox";
import { CANCEL_REASONS, restockedUnits } from "~/components/admin/orderview/cancel-order";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import type { UpdateOrderStatusInput } from "~/lib/api-mutations/orders";
import { getOrderItems } from "~/lib/api-query-options/orders";
import { queryKeys } from "~/lib/query-keys";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { Field } from "~/components/ui/field";

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
  /** The customer has an email, so they can get a cancellation message. */
  notify: boolean;
  pending: boolean;
  onConfirm: (reason?: CancelReason, notifyCustomer?: boolean) => void;
}) {
  const t = useMessages(orderDetailMessages);
  const [reason, setReason] = useState<CancelReason | "">("");
  // Shopify's "Send a notification to the customer": on by default, off for a test or duplicate order.
  const [sendMessage, setSendMessage] = useState(true);
  const changeOpen = (next: boolean) => {
    // Each opening starts without a reason, and with the message on.
    if (!next) {
      setReason("");
      setSendMessage(true);
    }
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
            ].filter(Boolean).join(" ")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field id="cancel-reason" label={t("cancel.reason")}>
          <SearchableSelect
            triggerClassName="w-full"
            id="cancel-reason"
            value={reason}
            onValueChange={(value) => setReason(value as CancelReason)}
            placeholder={t("cancel.reasonPlaceholder")}
            options={CANCEL_REASONS.map((value) => ({ value, label: t(`cancel.reason.${value}`) }))}
          />
        </Field>
        {notify ? (
          <label className="flex items-start gap-3 text-body">
            <Checkbox checked={sendMessage} onCheckedChange={(checked) => setSendMessage(checked === true)} className="mt-0.5" />
            <span>{t("cancel.notifyChoice")}</span>
          </label>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel.keep")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={() => onConfirm(reason || undefined, notify ? sendMessage : undefined)}>
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
  onConfirm: (order: OrderListItem, reason?: CancelReason, notifyCustomer?: boolean) => void;
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
      onConfirm={(reason, notifyCustomer) => {
        if (order) onConfirm(order, reason, notifyCustomer);
      }}
    />
  );
}
