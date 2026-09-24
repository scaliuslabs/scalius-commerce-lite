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
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { resourceMessages } from "~/i18n/resource";
import { orderErrorMessage, useApproveOrderReturn } from "~/lib/api-mutations/orders";
import { StableReturnCommandKey, type OrderReturnDto } from "~/lib/order-return-workflow";
import type { OrderItem } from "../types";
import { createReturnCommandKey, getOrderItemName, parseReturnQuantity } from "./shared";

/** Approve or reject each requested unit. The decision never changes stock. */
export function ApproveReturnDialog({
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
  const [approved, setApproved] = useState<Record<string, number>>(() =>
    Object.fromEntries((orderReturn?.lines ?? []).map((line) => [line.id, line.requestedQuantity])),
  );
  const [notes, setNotes] = useState("");
  const mutation = useApproveOrderReturn();
  const commandKey = useRef(new StableReturnCommandKey(createReturnCommandKey));
  if (!orderReturn) return <Dialog open={false} onOpenChange={onOpenChange} />;
  const lines = orderReturn.lines.map((line) => ({
    lineId: line.id,
    approvedQuantity: approved[line.id] ?? line.requestedQuantity,
    rejectedQuantity: line.requestedQuantity - (approved[line.id] ?? line.requestedQuantity),
  }));
  const rejectAll = lines.every((line) => line.approvedQuantity === 0);

  const submit = () => {
    const intent = { expectedVersion: orderReturn.version, notes: notes.trim() || null, lines };
    mutation.mutate(
      { orderId: orderReturn.orderId, returnId: orderReturn.id, commandKey: commandKey.current.get("approve", intent), ...intent },
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
          <DialogTitle>{t("returns.reviewTitle")}</DialogTitle>
          <DialogDescription>{t("returns.reviewHelp")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {mutation.isError ? <Alert variant="destructive">{orderErrorMessage(mutation.error)}</Alert> : null}
          <ul className="divide-y rounded-md border">
            {orderReturn.lines.map((line) => {
              const name = getOrderItemName(itemsById.get(line.orderItemId));
              const value = approved[line.id] ?? line.requestedQuantity;
              return (
                <li key={line.id} className="flex items-center justify-between gap-3 px-3 py-2 text-body">
                  <div className="min-w-0">
                    <p className="font-medium">{name}</p>
                    <p className="text-muted-foreground">
                      {t("returns.qtyRequested", { count: line.requestedQuantity })} · {t("returns.qtyRejected", { count: line.requestedQuantity - value })}
                    </p>
                  </div>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={line.requestedQuantity}
                    className="w-20 shrink-0"
                    aria-label={t("returns.approveQty", { name })}
                    value={value}
                    onChange={(e) => setApproved((current) => ({
                      ...current,
                      [line.id]: parseReturnQuantity(e.target.value, line.requestedQuantity),
                    }))}
                  />
                </li>
              );
            })}
          </ul>
          <div className="space-y-2">
            <Label htmlFor={`approval-notes-${orderReturn.id}`}>{t("returns.notes")}</Label>
            <Textarea id={`approval-notes-${orderReturn.id}`} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>{r("cancel")}</Button>
          <Button type="button" variant={rejectAll ? "destructive" : "default"} onClick={submit} loading={mutation.isPending}>
            {rejectAll
              ? t("returns.reject")
              : t("returns.approveSummary", {
                  approved: lines.reduce((sum, line) => sum + line.approvedQuantity, 0),
                  rejected: lines.reduce((sum, line) => sum + line.rejectedQuantity, 0),
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
