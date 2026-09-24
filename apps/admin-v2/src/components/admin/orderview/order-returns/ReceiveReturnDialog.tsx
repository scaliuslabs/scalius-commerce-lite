import { useRef, useState } from "react";
import { Alert } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { NumberInput } from "~/components/ui/number-input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { formatNumber, useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { resourceMessages } from "~/i18n/resource";
import { orderErrorMessage, useReceiveOrderReturn } from "~/lib/api-mutations/orders";
import {
  StableReturnCommandKey,
  getOutstandingReceiptQuantity,
  type OrderReturnDto,
  type OrderReturnLineDto,
} from "~/lib/order-return-workflow";
import type { OrderItem } from "../types";
import { createReturnCommandKey, getOrderItemName, clampQuantity } from "./shared";

interface ReceiptDraft { received: number; restock: number }

/**
 * Receipt lines for the API. A tracked item is split into back-in-stock and
 * damaged; an untracked item is only received, which the server records as
 * "not put back into stock" (never shown as damaged).
 */
export function buildReceiptLines(lines: readonly OrderReturnLineDto[], draft: Record<string, ReceiptDraft>) {
  return lines.flatMap((line) => {
    const current = draft[line.id] ?? { received: 0, restock: 0 };
    if (current.received <= 0) return [];
    const restock = line.inventoryTracked ? Math.min(current.restock, current.received) : 0;
    return [{
      lineId: line.id,
      receivedQuantity: current.received,
      restockQuantity: restock,
      damagedQuantity: current.received - restock,
    }];
  });
}

export function ReceiveReturnDialog({
  orderReturn,
  itemsById,
  open,
  onOpenChange,
}: {
  /** The return being acted on; the dialog stays mounted without one. */
  orderReturn: OrderReturnDto | null;
  itemsById: ReadonlyMap<string, OrderItem>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(orderDetailMessages);
  const r = useMessages(resourceMessages);
  // Nothing is pre-filled: what goes back on sale is the merchant's call.
  const [draft, setDraft] = useState<Record<string, ReceiptDraft>>({});
  const [notes, setNotes] = useState("");
  const mutation = useReceiveOrderReturn();
  const commandKey = useRef(new StableReturnCommandKey(createReturnCommandKey));
  if (!orderReturn) return <Dialog open={false} onOpenChange={onOpenChange} />;
  const lines = buildReceiptLines(orderReturn.lines, draft);
  const received = lines.reduce((sum, line) => sum + line.receivedQuantity, 0);

  const submit = () => {
    if (lines.length === 0) return;
    const intent = { expectedVersion: orderReturn.version, notes: notes.trim() || null, lines };
    mutation.mutate(
      { orderId: orderReturn.orderId, returnId: orderReturn.id, commandKey: commandKey.current.get("receive", intent), ...intent },
      {
        onSuccess: () => {
          commandKey.current.clear();
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("returns.receiveTitle")}</DialogTitle>
          <DialogDescription>{t("returns.receiveHelp")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {mutation.isError ? <Alert variant="destructive">{orderErrorMessage(mutation.error)}</Alert> : null}
          <ul className="divide-y rounded-lg border">
            {orderReturn.lines.map((line) => {
              const outstanding = getOutstandingReceiptQuantity(line);
              const current = draft[line.id] ?? { received: 0, restock: 0 };
              const name = getOrderItemName(itemsById.get(line.orderItemId));
              if (outstanding === 0) return null;
              const setReceived = (value: number | null) => {
                const next = clampQuantity(value, outstanding);
                setDraft((existing) => ({
                  ...existing,
                  [line.id]: { received: next, restock: line.inventoryTracked ? Math.min(existing[line.id]?.restock ?? 0, next) : 0 },
                }));
              };
              return (
                <li key={line.id} className="space-y-2 px-3 py-2 text-body">
                  <div>
                    <p className="font-medium">{name}</p>
                    <p className="text-muted-foreground">
                      {t("returns.awaiting", { count: outstanding })}
                      {line.inventoryTracked ? "" : ` · ${t("returns.untracked")}`}
                    </p>
                  </div>
                  {line.inventoryTracked ? (
                    <div className="grid grid-cols-3 gap-2">
                      <Label className="grid">
                        <span>{t("returns.received")}</span>
                        <NumberInput
                          integer
                          aria-label={t("returns.receivedQty", { name })}
                          value={current.received}
                          onValueChange={setReceived}
                        />
                      </Label>
                      <Label className="grid">
                        <span>{t("returns.restock")}</span>
                        <NumberInput
                          integer
                          aria-label={t("returns.restockQty", { name })}
                          disabled={current.received === 0}
                          value={current.restock}
                          onValueChange={(value) => setDraft((existing) => ({
                            ...existing,
                            [line.id]: { ...current, restock: clampQuantity(value, current.received) },
                          }))}
                        />
                      </Label>
                      <div className="grid gap-1 font-medium">
                        <span>{t("returns.damaged")}</span>
                        <p className="py-2 font-normal tabular-nums" aria-label={t("returns.damagedQty", { count: current.received - current.restock })}>
                          {formatNumber(current.received - current.restock)}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <Label className="grid max-w-40">
                      <span>{t("returns.received")}</span>
                      <NumberInput
                        integer
                        aria-label={t("returns.receivedQty", { name })}
                        value={current.received}
                        onValueChange={setReceived}
                      />
                    </Label>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="space-y-2">
            <Label htmlFor={`receipt-notes-${orderReturn.id}`}>{t("returns.notes")}</Label>
            <Textarea id={`receipt-notes-${orderReturn.id}`} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>{r("cancel")}</Button>
          <Button type="button" onClick={submit} disabled={lines.length === 0} loading={mutation.isPending}>
            {received > 0 ? t("returns.receiveCount", { count: received }) : t("returns.receiveSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
