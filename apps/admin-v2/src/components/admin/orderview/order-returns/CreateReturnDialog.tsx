import { useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
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
import { NumberInput } from "~/components/ui/number-input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { resourceMessages } from "~/i18n/resource";
import { orderErrorMessage, useCreateOrderReturn } from "~/lib/api-mutations/orders";
import {
  StableReturnCommandKey,
  getRemainingReturnableQuantities,
  type OrderReturnDto,
} from "~/lib/order-return-workflow";
import type { Order } from "../types";
import { createReturnCommandKey, getOrderItemName, clampQuantity } from "./shared";

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
  const [errors, setErrors] = useState<{ reason?: string; quantity?: string }>({});
  const mutation = useCreateOrderReturn();
  const commandKey = useRef(new StableReturnCommandKey(createReturnCommandKey));
  // With one returnable line, the whole returnable amount is the likely answer (R3-ORD-14).
  const quantityOf = (itemId: string) => quantities[itemId] ?? (eligibleItems.length === 1 ? remaining.get(itemId) ?? 0 : 0);
  const lines = eligibleItems
    .map((item) => ({ orderItemId: item.id, quantity: quantityOf(item.id) }))
    .filter((line) => line.quantity > 0);

  const submit = () => {
    const next = {
      reason: reason.trim() ? undefined : t("returns.reasonRequired"),
      quantity: lines.length > 0 ? undefined : t("returns.quantityRequired"),
    };
    setErrors(next);
    if (next.reason || next.quantity) {
      document.getElementById(next.reason ? "return-reason" : `return-qty-${eligibleItems[0]?.id}`)?.focus();
      return;
    }
    const intent = { expectedOrderVersion: order.version, reason: reason.trim(), notes: notes.trim() || null, lines };
    mutation.mutate(
      { orderId: order.id, commandKey: commandKey.current.get("create", intent), ...intent },
      {
        onSuccess: () => {
          commandKey.current.clear();
          setReason("");
          setNotes("");
          setQuantities({});
          setErrors({});
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("returns.new")}</DialogTitle>
          <DialogDescription>{t("returns.newHelp")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {mutation.isError ? <Alert variant="destructive"><AlertDescription>{orderErrorMessage(mutation.error)}</AlertDescription></Alert> : null}
          <div className="space-y-2">
            <Label htmlFor="return-reason">{t("returns.reason")}</Label>
            <Input
              id="return-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setErrors((current) => ({ ...current, reason: reason.trim() ? undefined : current.reason }))}
              placeholder={t("returns.reasonPlaceholder")}
              maxLength={500}
              aria-invalid={Boolean(errors.reason) || undefined}
              aria-describedby={errors.reason ? "return-reason-error" : undefined}
            />
            {errors.reason ? <p id="return-reason-error" className="text-destructive">{errors.reason}</p> : null}
          </div>
          <div className="space-y-2">
            <ul className="divide-y rounded-lg border">
              {eligibleItems.map((item) => {
                const max = remaining.get(item.id) ?? 0;
                const name = getOrderItemName(item);
                return (
                  <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2 text-body">
                    <div className="min-w-0">
                      <p className="font-medium">{name}</p>
                      <p className="text-muted-foreground">{t("returns.available", { count: max })}</p>
                    </div>
                    <NumberInput
                      id={`return-qty-${item.id}`}
                      integer
                      className="w-20 shrink-0"
                      aria-label={t("returns.returnQty", { name })}
                      aria-invalid={Boolean(errors.quantity) || undefined}
                      aria-describedby={errors.quantity ? "return-qty-error" : undefined}
                      value={quantityOf(item.id)}
                      onValueChange={(value) => {
                        setQuantities((current) => ({ ...current, [item.id]: clampQuantity(value, max) }));
                        setErrors((current) => ({ ...current, quantity: undefined }));
                      }}
                    />
                  </li>
                );
              })}
            </ul>
            {errors.quantity ? <p id="return-qty-error" className="text-destructive">{errors.quantity}</p> : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="return-notes">{t("returns.notes")}</Label>
            <Textarea id="return-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>{r("cancel")}</Button>
          <Button type="button" onClick={submit} loading={mutation.isPending}>
            {t("returns.request")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
