import { useMemo, useRef, useState } from "react";
import { Loader2, Plus } from "lucide-react";
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
import { useCreateOrderReturn } from "@/lib/api-mutations/orders";
import {
  StableReturnCommandKey,
  getRemainingReturnableQuantities,
  type OrderReturnDto,
} from "@/lib/order-return-workflow";
import type { Order } from "../types";
import {
  createReturnCommandKey,
  getOrderItemName,
  parseReturnQuantity,
} from "./shared";

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
  const remaining = useMemo(
    () => getRemainingReturnableQuantities(order.items, returns),
    [order.items, returns],
  );
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
    const intent = {
      expectedOrderVersion: order.version,
      reason: reason.trim(),
      notes: notes.trim() || null,
      lines,
    };
    mutation.mutate(
      {
        orderId: order.id,
        commandKey: commandKey.current.get("create", intent),
        ...intent,
      },
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Request a return</DialogTitle>
          <DialogDescription>
            Select shipped or delivered items. Requesting a return does not refund payment or change stock.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="return-reason" className="text-sm">Reason</Label>
            <Input
              id="return-reason"
              className="text-sm"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Wrong size, damaged item, or another customer reason"
              maxLength={500}
            />
          </div>
          <div className="overflow-hidden rounded-md border border-border">
            <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3 border-b border-border bg-muted/40 px-3 py-2 text-sm font-medium">
              <span>Item</span>
              <span>Quantity</span>
            </div>
            {eligibleItems.map((item) => {
              const max = remaining.get(item.id) ?? 0;
              return (
                <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
                  <div className="min-w-0 text-sm">
                    <p className="truncate font-medium">{getOrderItemName(item)}</p>
                    <p className="text-muted-foreground">{max} available to return</p>
                  </div>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={max}
                    className="h-9 text-sm"
                    aria-label={`Return quantity for ${getOrderItemName(item)}`}
                    value={quantities[item.id] ?? 0}
                    onChange={(event) => setQuantities((current) => ({
                      ...current,
                      [item.id]: parseReturnQuantity(event.target.value, max),
                    }))}
                  />
                </div>
              );
            })}
          </div>
          <div className="space-y-2">
            <Label htmlFor="return-notes" className="text-sm">Internal notes <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Textarea id="return-notes" className="min-h-20 text-sm" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>Close</Button>
          <Button type="button" onClick={submit} disabled={!canSubmit}>
            {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
            Request return
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
