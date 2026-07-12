import { useRef, useState } from "react";
import { Loader2, PackageCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useReceiveOrderReturn } from "@/lib/api-mutations/orders";
import {
  StableReturnCommandKey,
  getOutstandingReceiptQuantity,
  type OrderReturnDto,
} from "@/lib/order-return-workflow";
import type { OrderItem } from "../types";
import {
  createReturnCommandKey,
  getOrderItemName,
  parseReturnQuantity,
} from "./shared";

interface ReceiptDraft { received: number; restock: number }

export function ReceiveReturnDialog({
  orderReturn,
  itemsById,
  open,
  onOpenChange,
}: {
  orderReturn: OrderReturnDto;
  itemsById: ReadonlyMap<string, OrderItem>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState<Record<string, ReceiptDraft>>(() =>
    Object.fromEntries(orderReturn.lines.map((line) => [line.id, { received: 0, restock: 0 }])),
  );
  const [notes, setNotes] = useState("");
  const mutation = useReceiveOrderReturn();
  const commandKey = useRef(new StableReturnCommandKey(createReturnCommandKey));
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

  const submit = () => {
    if (lines.length === 0) return;
    const intent = { expectedVersion: orderReturn.version, notes: notes.trim() || null, lines };
    mutation.mutate(
      {
        orderId: orderReturn.orderId,
        returnId: orderReturn.id,
        commandKey: commandKey.current.get("receive", intent),
        ...intent,
      },
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Receive returned items</DialogTitle>
          <DialogDescription>
            Record only items physically received. Restock adds sellable inventory; damaged units do not.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="overflow-hidden rounded-md border border-border">
            <div className="hidden grid-cols-[minmax(10rem,1fr)_6rem_6rem_6rem] gap-2 border-b border-border bg-muted/40 px-3 py-2 text-sm font-medium sm:grid">
              <span>Return line</span><span>Received</span><span>Restock</span><span>Damaged</span>
            </div>
            {orderReturn.lines.map((line) => {
              const outstanding = getOutstandingReceiptQuantity(line);
              const current = draft[line.id] ?? { received: 0, restock: 0 };
              const damaged = current.received - current.restock;
              const name = getOrderItemName(itemsById.get(line.orderItemId));
              return (
                <div key={line.id} className="grid items-center gap-2 border-b border-border px-3 py-3 last:border-b-0 sm:grid-cols-[minmax(10rem,1fr)_6rem_6rem_6rem] sm:py-2">
                  <div className="min-w-0 text-sm">
                    <p className="truncate font-medium">{name}</p>
                    <p className="text-muted-foreground">{outstanding} awaiting receipt</p>
                    <p className="truncate text-muted-foreground">{line.inventoryTracked ? "Inventory tracked" : "Not inventory tracked"}</p>
                  </div>
                  <label className="grid grid-cols-[1fr_6rem] items-center gap-2 text-sm sm:block">
                    <span className="sm:sr-only">Received</span>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={outstanding}
                      className="h-9 text-sm"
                      aria-label={`Received quantity for ${name}`}
                      value={current.received}
                      onChange={(event) => {
                        const received = parseReturnQuantity(event.target.value, outstanding);
                        setDraft((existing) => ({
                          ...existing,
                          [line.id]: {
                            received,
                            restock: line.inventoryTracked ? Math.min(existing[line.id]?.restock ?? 0, received) : 0,
                          },
                        }));
                      }}
                    />
                  </label>
                  <label className="grid grid-cols-[1fr_6rem] items-center gap-2 text-sm sm:block">
                    <span className="sm:sr-only">Restock</span>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={current.received}
                      className="h-9 text-sm"
                      aria-label={`Restock quantity for ${name}`}
                      disabled={!line.inventoryTracked || current.received === 0}
                      value={current.restock}
                      onChange={(event) => setDraft((existing) => ({
                        ...existing,
                        [line.id]: { ...current, restock: parseReturnQuantity(event.target.value, current.received) },
                      }))}
                    />
                  </label>
                  <div className="grid grid-cols-[1fr_6rem] items-center gap-2 text-sm sm:block">
                    <span className="sm:sr-only">Damaged</span>
                    <div className="flex h-9 items-center rounded-md border border-border bg-muted/30 px-3 text-sm" aria-label={`Damaged quantity ${damaged}`}>
                      {damaged}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-sm text-muted-foreground">Every received unit must be classified. Set Restock to the quantity safe to sell again; the remainder is recorded as damaged.</p>
          <div className="space-y-2">
            <Label htmlFor={`receipt-notes-${orderReturn.id}`} className="text-sm">Receipt notes <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Textarea id={`receipt-notes-${orderReturn.id}`} className="min-h-20 text-sm" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>Close</Button>
          <Button type="button" onClick={submit} disabled={lines.length === 0 || mutation.isPending}>
            {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PackageCheck className="mr-2 h-4 w-4" />}
            Record receipt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
