import { useRef, useState } from "react";
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
import { useReceiveOrderReturn } from "~/lib/api-mutations/orders";
import {
  StableReturnCommandKey,
  getOutstandingReceiptQuantity,
  type OrderReturnDto,
} from "~/lib/order-return-workflow";
import type { OrderItem } from "../types";
import { createReturnCommandKey, getOrderItemName, parseReturnQuantity } from "./shared";

interface ReceiptDraft { received: number; restock: number }

/** Every received unit is either restocked or recorded as damaged. */
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
  const [draft, setDraft] = useState<Record<string, ReceiptDraft>>(() =>
    Object.fromEntries((orderReturn?.lines ?? []).map((line) => [line.id, { received: 0, restock: 0 }])),
  );
  const [notes, setNotes] = useState("");
  const mutation = useReceiveOrderReturn();
  const commandKey = useRef(new StableReturnCommandKey(createReturnCommandKey));
  if (!orderReturn) return <Dialog open={false} onOpenChange={onOpenChange} />;
  const lines = orderReturn.lines.flatMap((line) => {
    const current = draft[line.id] ?? { received: 0, restock: 0 };
    if (current.received <= 0) return [];
    return [{
      lineId: line.id,
      receivedQuantity: current.received,
      restockQuantity: current.restock,
      damagedQuantity: current.received - current.restock,
    }];
  });

  const totals = lines.reduce(
    (sum, line) => ({
      received: sum.received + line.receivedQuantity,
      restock: sum.restock + line.restockQuantity,
      damaged: sum.damaged + line.damagedQuantity,
    }),
    { received: 0, restock: 0, damaged: 0 },
  );

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("returns.receiveTitle")}</DialogTitle>
          <DialogDescription>{t("returns.receiveHelp")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <ul className="divide-y rounded-md border">
            {orderReturn.lines.map((line) => {
              const outstanding = getOutstandingReceiptQuantity(line);
              const current = draft[line.id] ?? { received: 0, restock: 0 };
              const name = getOrderItemName(itemsById.get(line.orderItemId));
              return (
                <li key={line.id} className="space-y-2 px-3 py-2 text-body">
                  <div>
                    <p className="font-medium">{name}</p>
                    <p className="text-muted-foreground">
                      {t("returns.awaiting", { count: outstanding })}
                      {line.inventoryTracked ? "" : ` · ${t("returns.untracked")}`}
                    </p>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <Label className="grid">
                      <span>{t("returns.received")}</span>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={outstanding}
                        aria-label={t("returns.receivedQty", { name })}
                        value={current.received}
                        onChange={(e) => {
                          const received = parseReturnQuantity(e.target.value, outstanding);
                          setDraft((existing) => ({
                            ...existing,
                            [line.id]: {
                              received,
                              restock: line.inventoryTracked ? Math.min(existing[line.id]?.restock ?? 0, received) : 0,
                            },
                          }));
                        }}
                      />
                    </Label>
                    <Label className="grid">
                      <span>{t("returns.restock")}</span>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={current.received}
                        aria-label={t("returns.restockQty", { name })}
                        disabled={!line.inventoryTracked || current.received === 0}
                        value={current.restock}
                        onChange={(e) => setDraft((existing) => ({
                          ...existing,
                          [line.id]: { ...current, restock: parseReturnQuantity(e.target.value, current.received) },
                        }))}
                      />
                    </Label>
                    <div className="grid gap-1 text-body font-medium">
                      <span>{t("returns.damaged")}</span>
                      <p className="py-2 font-normal" aria-label={t("returns.damagedQty", { count: current.received - current.restock })}>
                        {current.received - current.restock}
                      </p>
                    </div>
                  </div>
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
          <Button type="button" onClick={submit} disabled={lines.length === 0 || mutation.isPending}>
            {totals.received > 0 ? t("returns.receiveSummary", totals) : t("returns.receiveSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
