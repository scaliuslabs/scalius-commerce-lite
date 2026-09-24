import { useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { resourceMessages } from "~/i18n/resource";
import { openCancellationRequest } from "./primary-action";
import type { Order } from "./types";

type Step = "confirm" | "send";

/**
 * While the customer asks to cancel, confirming or sending the order needs a
 * second yes. `guard(step, run)` runs at once when no request is open.
 */
export function useCancelRequestGuard(order: Pick<Order, "supportRequests">) {
  const t = useMessages(orderDetailMessages);
  const r = useMessages(resourceMessages);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("confirm");
  const run = useRef<() => void>(() => undefined);
  const requested = openCancellationRequest(order) !== null;

  const guard = (next: Step, action: () => void) => {
    if (!requested) return action();
    run.current = action;
    setStep(next);
    setOpen(true);
  };

  const dialog = (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("cancelRequest.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t(step === "confirm" ? "cancelRequest.confirm" : "cancelRequest.send")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{r("cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => run.current()}>
            {t(step === "confirm" ? "primary.confirm" : "fulfill.submit")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { guard, dialog };
}
