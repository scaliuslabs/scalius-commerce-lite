import { useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCancelOrderReturn } from "@/lib/api-mutations/orders";
import { StableReturnCommandKey, type OrderReturnDto } from "@/lib/order-return-workflow";
import { createReturnCommandKey } from "./shared";

export function CancelReturnDialog({
  orderReturn,
  open,
  onOpenChange,
}: {
  orderReturn: OrderReturnDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [notes, setNotes] = useState("");
  const mutation = useCancelOrderReturn();
  const commandKey = useRef(new StableReturnCommandKey(createReturnCommandKey));
  const submit = () => {
    const intent = { expectedVersion: orderReturn.version, notes: notes.trim() || null };
    mutation.mutate(
      {
        orderId: orderReturn.orderId,
        returnId: orderReturn.id,
        commandKey: commandKey.current.get("cancel", intent),
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel return</DialogTitle>
          <DialogDescription>This closes the case without receiving inventory. The audit record remains.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor={`cancel-return-notes-${orderReturn.id}`} className="text-sm">Reason <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Textarea id={`cancel-return-notes-${orderReturn.id}`} className="min-h-20 text-sm" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>Keep return</Button>
          <Button type="button" variant="destructive" onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <X className="mr-2 h-4 w-4" />}
            Cancel return
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
