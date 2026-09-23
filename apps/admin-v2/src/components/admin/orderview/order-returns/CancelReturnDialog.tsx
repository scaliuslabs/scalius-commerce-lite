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
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { useCancelOrderReturn } from "~/lib/api-mutations/orders";
import { StableReturnCommandKey, type OrderReturnDto } from "~/lib/order-return-workflow";
import { createReturnCommandKey } from "./shared";

export function CancelReturnDialog({
  orderReturn,
  open,
  onOpenChange,
}: {
  /** The return being acted on; the dialog stays mounted without one. */
  orderReturn: OrderReturnDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(orderDetailMessages);
  const [notes, setNotes] = useState("");
  const mutation = useCancelOrderReturn();
  const commandKey = useRef(new StableReturnCommandKey(createReturnCommandKey));
  if (!orderReturn) return <Dialog open={false} onOpenChange={onOpenChange} />;
  const submit = () => {
    const intent = { expectedVersion: orderReturn.version, notes: notes.trim() || null };
    mutation.mutate(
      { orderId: orderReturn.orderId, returnId: orderReturn.id, commandKey: commandKey.current.get("cancel", intent), ...intent },
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
          <DialogTitle>{t("returns.cancelTitle")}</DialogTitle>
          <DialogDescription>{t("returns.cancelHelp")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={`cancel-return-notes-${orderReturn.id}`}>{t("returns.reason")}</Label>
          <Textarea id={`cancel-return-notes-${orderReturn.id}`} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>{t("returns.keep")}</Button>
          <Button type="button" variant="destructive" onClick={submit} disabled={mutation.isPending}>
            {t("returns.cancelTitle")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
