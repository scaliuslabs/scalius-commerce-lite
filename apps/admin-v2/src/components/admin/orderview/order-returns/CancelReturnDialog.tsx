import { useRef, useState } from "react";
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
import { Textarea } from "~/components/ui/textarea";
import { useMessages } from "~/i18n";
import { orderReturnMessages } from "~/i18n/order-returns";
import { orderErrorMessage, useCancelOrderReturn } from "~/lib/api-mutations/orders";
import { StableReturnCommandKey, type OrderReturnDto } from "~/lib/order-return-workflow";
import { createReturnCommandKey } from "./shared";
import { Field } from "~/components/ui/field";

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
  const t = useMessages(orderReturnMessages);
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
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("returns.cancelTitle")}</DialogTitle>
          <DialogDescription>{t("returns.cancelHelp")}</DialogDescription>
        </DialogHeader>
        {mutation.isError ? <Alert variant="destructive"><AlertDescription>{orderErrorMessage(mutation.error)}</AlertDescription></Alert> : null}
        <Field id={`cancel-return-notes-${orderReturn.id}`} label={t("returns.reason")}>
          <Textarea id={`cancel-return-notes-${orderReturn.id}`} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>{t("returns.keep")}</Button>
          <Button type="button" variant="destructive" onClick={submit} loading={mutation.isPending}>
            {t("returns.cancelTitle")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
