import { useMemo, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { resourceMessages } from "~/i18n/resource";
import { useCreateOrderReturn } from "~/lib/api-mutations/orders";
import {
  StableReturnCommandKey,
  getRemainingReturnableQuantities,
  type OrderReturnDto,
} from "~/lib/order-return-workflow";
import type { Order } from "../types";
import { createReturnCommandKey, getOrderItemName, parseReturnQuantity } from "./shared";

/** Request a return. This never refunds money or changes stock. */
export function CreateReturnDialog({
  order,
  returns,
  open,
  onOpenChange,
}: {
  order: Order;
  returns: readonly OrderReturnDto[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(orderDetailMessages);
  const r = useMessages(resourceMessages);
  const remaining = useMemo(() => getRemainingReturnableQuantities(order.items, returns), [order.items, returns]);
  const eligibleItems = order.items.filter((item) => (remaining.get(item.id) ?? 0) > 0);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const mutation = useCreateOrderReturn();
  const commandKey = useRef(new StableReturnCommandKey(createReturnCommandKey));
  const lines = eligibleItems
    .map((item) => ({ orderItemId: item.id, quantity: quantities[item.id] ?? 0 }))
    .filter((line) => line.quantity > 0);
  const canSubmit = reason.trim().length > 0 && lines.length > 0 && !mutation.isPending;

  const submit = () => {
    if (!canSubmit) return;
    const intent = { expectedOrderVersion: order.version, reason: reason.trim(), notes: notes.trim() || null, lines };
    mutation.mutate(
      { orderId: order.id, commandKey: commandKey.current.get("create", intent), ...intent },
      {
        onSuccess: () => {
          commandKey.current.clear();
          setReason("");
          setNotes("");
          setQuantities({});
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("returns.new")}</DialogTitle>
          <DialogDescription>{t("returns.newHelp")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="return-reason">{t("returns.reason")}</Label>
            <Input
              id="return-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("returns.reasonPlaceholder")}
              maxLength={500}
            />
          </div>
          <ul className="divide-y rounded-md border">
            {eligibleItems.map((item) => {
              const max = remaining.get(item.id) ?? 0;
              const name = getOrderItemName(item);
              return (
                <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2 text-body">
                  <div className="min-w-0">
                    <p className="font-medium">{name}</p>
                    <p className="text-muted-foreground">{t("returns.available", { count: max })}</p>
                  </div>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={max}
                    className="w-20 shrink-0"
                    aria-label={t("returns.returnQty", { name })}
                    value={quantities[item.id] ?? 0}
                    onChange={(e) => setQuantities((current) => ({
                      ...current,
                      [item.id]: parseReturnQuantity(e.target.value, max),
                    }))}
                  />
                </li>
              );
            })}
          </ul>
          <div className="space-y-2">
            <Label htmlFor="return-notes">{t("returns.notes")}</Label>
            <Textarea id="return-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>{r("cancel")}</Button>
          <Button type="button" onClick={submit} disabled={!canSubmit}>
            {t("returns.request")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
