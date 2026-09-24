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

/** What the merchant is expected to receive: every approved unit still out, all back in stock when tracked. */
export function defaultReceiptDraft(lines: readonly OrderReturnLineDto[]): Record<string, ReceiptDraft> {
  return Object.fromEntries(lines.map((line) => {
    const outstanding = getOutstandingReceiptQuantity(line);
    return [line.id, { received: outstanding, restock: line.inventoryTracked ? outstanding : 0 }];
  }));
}

/** A typed quantity as a whole number of at least 0; more than expected is kept so it can be flagged. */
function typedQuantity(value: number | null): number {
  return clampQuantity(value, Number.MAX_SAFE_INTEGER);
}

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
  // Pre-filled with what is expected back; the merchant lowers it for anything missing or damaged.
  const [draft, setDraft] = useState<Record<string, ReceiptDraft>>(() => defaultReceiptDraft(orderReturn?.lines ?? []));
  const [notes, setNotes] = useState("");
  const mutation = useReceiveOrderReturn();
  const commandKey = useRef(new StableReturnCommandKey(createReturnCommandKey));
  if (!orderReturn) return <Dialog open={false} onOpenChange={onOpenChange} />;
  const lines = buildReceiptLines(orderReturn.lines, draft);
  const received = lines.reduce((sum, line) => sum + line.receivedQuantity, 0);
  const tooMany = orderReturn.lines.some((line) => {
    const current = draft[line.id];
    return current !== undefined && (current.received > getOutstandingReceiptQuantity(line) || current.restock > current.received);
  });

  const submit = () => {
    if (lines.length === 0 || tooMany || mutation.isPending) return;
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
              const receivedError = current.received > outstanding ? t("returns.receiveTooMany", { count: outstanding }) : null;
              const restockError = !receivedError && current.restock > current.received ? t("returns.restockTooMany") : null;
              const errorId = `receipt-${line.id}-error`;
              // Back in stock follows Received until the merchant sets it apart.
              const setReceived = (value: number | null) => {
                const next = typedQuantity(value);
                setDraft((existing) => {
                  const previous = existing[line.id] ?? { received: 0, restock: 0 };
                  const restock = !line.inventoryTracked ? 0
                    : previous.restock === previous.received ? Math.min(next, outstanding) : Math.min(previous.restock, next);
                  return { ...existing, [line.id]: { received: next, restock } };
                });
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
                          aria-invalid={Boolean(receivedError) || undefined}
                          aria-describedby={receivedError ? errorId : undefined}
                          value={current.received}
                          disabled={mutation.isPending}
                          onValueChange={setReceived}
                        />
                      </Label>
                      <Label className="grid">
                        <span>{t("returns.restock")}</span>
                        <NumberInput
                          integer
                          aria-label={t("returns.restockQty", { name })}
                          aria-invalid={Boolean(restockError) || undefined}
                          aria-describedby={restockError ? errorId : undefined}
                          disabled={current.received === 0 || mutation.isPending}
                          value={current.restock}
                          onValueChange={(value) => setDraft((existing) => ({
                            ...existing,
                            [line.id]: { ...current, restock: typedQuantity(value) },
                          }))}
                        />
                      </Label>
                      <div className="grid gap-1 font-medium">
                        <span>{t("returns.damaged")}</span>
                        <p className="py-2 font-normal tabular-nums" aria-label={t("returns.damagedQty", { count: Math.max(0, current.received - current.restock) })}>
                          {formatNumber(Math.max(0, current.received - current.restock))}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <Label className="grid max-w-40">
                      <span>{t("returns.received")}</span>
                      <NumberInput
                        integer
                        aria-label={t("returns.receivedQty", { name })}
                        aria-invalid={Boolean(receivedError) || undefined}
                        aria-describedby={receivedError ? errorId : undefined}
                        value={current.received}
                        disabled={mutation.isPending}
                        onValueChange={setReceived}
                      />
                    </Label>
                  )}
                  {receivedError || restockError ? <p id={errorId} className="text-destructive">{receivedError ?? restockError}</p> : null}
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
          <Button type="button" onClick={submit} disabled={lines.length === 0 || tooMany} loading={mutation.isPending}>
            {received > 0 ? t("returns.receiveCount", { count: received }) : t("returns.receiveSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
