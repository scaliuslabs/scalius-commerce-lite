import { useRef, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
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
import { useApproveOrderReturn } from "@/lib/api-mutations/orders";
import { StableReturnCommandKey, type OrderReturnDto } from "@/lib/order-return-workflow";
import type { OrderItem } from "../types";
import {
  createReturnCommandKey,
  getOrderItemName,
  parseReturnQuantity,
} from "./shared";

export function ApproveReturnDialog({
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
  const [approved, setApproved] = useState<Record<string, number>>(() =>
    Object.fromEntries(orderReturn.lines.map((line) => [line.id, line.requestedQuantity])),
  );
  const [notes, setNotes] = useState("");
  const mutation = useApproveOrderReturn();
  const commandKey = useRef(new StableReturnCommandKey(createReturnCommandKey));
  const lines = orderReturn.lines.map((line) => ({
    lineId: line.id,
    approvedQuantity: approved[line.id] ?? line.requestedQuantity,
    rejectedQuantity: line.requestedQuantity - (approved[line.id] ?? line.requestedQuantity),
  }));
  const isFullRejection = lines.every((line) => line.approvedQuantity === 0);

  const submit = () => {
    const intent = { expectedVersion: orderReturn.version, notes: notes.trim() || null, lines };
    mutation.mutate(
      {
        orderId: orderReturn.orderId,
        returnId: orderReturn.id,
        commandKey: commandKey.current.get("approve", intent),
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review return request</DialogTitle>
          <DialogDescription>Approve or reject every requested unit. This decision does not change stock.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="overflow-hidden rounded-md border border-border">
            <div className="hidden grid-cols-[minmax(0,1fr)_5.5rem_5.5rem] gap-2 border-b border-border bg-muted/40 px-3 py-2 text-sm font-medium sm:grid">
              <span>Return line</span><span>Approve</span><span>Reject</span>
            </div>
            {orderReturn.lines.map((line) => {
              const approvedQuantity = approved[line.id] ?? line.requestedQuantity;
              const name = getOrderItemName(itemsById.get(line.orderItemId));
              return (
                <div key={line.id} className="grid items-center gap-2 border-b border-border px-3 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_5.5rem_5.5rem] sm:py-2">
                  <div className="min-w-0 text-sm">
                    <p className="truncate font-medium">{name}</p>
                    <p className="text-muted-foreground">{line.requestedQuantity} requested</p>
                    {line.reason ? <p className="truncate text-muted-foreground">{line.reason}</p> : null}
                  </div>
                  <label className="grid grid-cols-[1fr_5.5rem] items-center gap-2 text-sm sm:block">
                    <span className="sm:sr-only">Approve</span>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={line.requestedQuantity}
                      className="h-9 text-sm"
                      aria-label={`Approved quantity for ${name}`}
                      value={approvedQuantity}
                      onChange={(event) => setApproved((current) => ({
                        ...current,
                        [line.id]: parseReturnQuantity(event.target.value, line.requestedQuantity),
                      }))}
                    />
                  </label>
                  <div className="grid grid-cols-[1fr_5.5rem] items-center gap-2 text-sm sm:block">
                    <span className="sm:sr-only">Reject</span>
                    <div className="flex h-9 items-center rounded-md border border-border bg-muted/30 px-3 text-sm" aria-label={`Rejected quantity ${line.requestedQuantity - approvedQuantity}`}>
                      {line.requestedQuantity - approvedQuantity}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="space-y-2">
            <Label htmlFor={`approval-notes-${orderReturn.id}`} className="text-sm">Decision notes <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Textarea id={`approval-notes-${orderReturn.id}`} className="min-h-20 text-sm" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>Cancel</Button>
          <Button type="button" variant={isFullRejection ? "destructive" : "default"} onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : isFullRejection ? <X className="mr-2 h-4 w-4" /> : <Check className="mr-2 h-4 w-4" />}
            {isFullRejection ? "Reject return" : "Save decision"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
